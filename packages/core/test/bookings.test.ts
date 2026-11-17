import { describe, expect, it } from 'vitest';
import { advance, cancelBooking, decide, expireStale, getBooking, requestBooking, rescheduleBooking, LIMITS } from '../src/bookings.ts';
import { driveUnfinished, runCron, sendOutbox } from '../src/cron.ts';
import { CoreError } from '../src/errors.ts';
import { ownerApi } from '../src/api.ts';
import type { TokenDeps } from '../src/tokens.ts';
import { verifyLink } from '../src/crypto.ts';
import { at, iso, request, setup } from './support/fakes.ts';

const web = { address: '203.0.113.7', via: 'web' as const };

async function errorOf(work: Promise<unknown>): Promise<CoreError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof CoreError) return err;
    throw err;
  }
  throw new Error('expected a CoreError');
}

describe('instant booking', () => {
  it('confirms, creates one Outlook event with the guest, and makes one Meet room', async () => {
    const { ctx, calendar, meet } = await setup();
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    expect(r.outcome).toBe('confirmed');
    expect(calendar.live()).toHaveLength(1);
    expect(calendar.created[0]!.attendee!.name).toBe('Maya Lindqvist');
    expect(meet.rooms).toBe(1);
    const b = await getBooking(ctx.db, r.bookingId);
    expect(b!.meeting_url).toBe('https://meet.google.com/room-1');
  });

  it('returns a manage link only this booking can verify', async () => {
    const { ctx } = await setup();
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    const [id, mac] = r.manageUrl.split('/b/')[1]!.split('.') as [string, string];
    expect(id).toBe(r.bookingId);
    expect(await verifyLink(ctx.keys, 'manage', id, mac)).toBe(true);
    expect(await verifyLink(ctx.keys, 'approve', id, mac)).toBe(false);
  });

  it('refuses a time the rules do not offer', async () => {
    const { ctx } = await setup();
    const err = await errorOf(requestBooking(ctx, request('intro', '2026-11-16T07:00'), web));
    expect(err.code).toBe('slot_taken');
  });

  it('requires answers to required questions', async () => {
    const { ctx } = await setup();
    const { updateEventType } = await import('../src/catalog.ts');
    await updateEventType(ctx.db, ctx.clock.now(), { slug: 'intro', changes: { questions: [{ id: 'topic', label: 'Topic', required: true }] } });
    const err = await errorOf(requestBooking(ctx, request('intro', '2026-11-16T10:00'), web));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toMatch(/Topic/);
  });
});

describe('R1: one winner per time', () => {
  it('lets exactly one of two simultaneous requests for the same time win', async () => {
    const { ctx } = await setup();
    const results = await Promise.allSettled([
      requestBooking(ctx, request('intro', '2026-11-16T10:00'), web),
      requestBooking(ctx, request('intro', '2026-11-16T10:00'), { address: '198.51.100.9', via: 'api' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as CoreError).code).toBe('slot_taken');
  });

  it('offers nearby alternatives with a taken time', async () => {
    const { ctx } = await setup();
    await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    const err = await errorOf(requestBooking(ctx, request('intro', '2026-11-16T10:00'), web));
    expect((err.details!.alternatives as number[]).length).toBeGreaterThan(0);
    expect(err.details!.alternatives).not.toContain(at('2026-11-16T10:00'));
  });
});

describe('R2: retries do not double-book', () => {
  it('returns the first answer to a repeat with the same retry_token', async () => {
    const { ctx, calendar } = await setup();
    const body = request('intro', '2026-11-16T10:00');
    const first = await requestBooking(ctx, body, web);
    const again = await requestBooking(ctx, body, web);
    expect(again.bookingId).toBe(first.bookingId);
    expect(again.repeated).toBe(true);
    expect(calendar.live()).toHaveLength(1);
  });

  it('adopts an event that was created just before a timeout instead of creating another', async () => {
    const { ctx, calendar } = await setup();
    calendar.fail.createThenTimeout = true;
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    expect(r.outcome).toBe('accepted');
    calendar.fail.createThenTimeout = false;
    expect(await advance(ctx, r.bookingId)).toBe('confirmed');
    expect(calendar.live()).toHaveLength(1);
  });
});

describe('Outlook at the commit point', () => {
  it('fails cleanly on a clash found at commit, and frees the retry_token', async () => {
    const { ctx, calendar } = await setup();
    await requestBooking(ctx, request('intro', '2026-11-16T15:00'), web); // fills the busy snapshot
    calendar.addBusy(at('2026-11-16T10:00'), at('2026-11-16T11:00')); // added in Outlook after the snapshot
    const body = request('intro', '2026-11-16T10:00');
    const err = await errorOf(requestBooking(ctx, body, web));
    expect(err.code).toBe('slot_taken');
    const failed = await ctx.db.prepare("SELECT retry_key, reason FROM bookings WHERE status = 'failed'").first<{ retry_key: string | null; reason: string }>();
    expect(failed).toEqual({ retry_key: null, reason: 'calendar_conflict' });
    // Repeating the exact same call runs again rather than replaying the failure.
    calendar.events.clear();
    const retry = await requestBooking(ctx, body, web);
    expect(retry.repeated).toBe(false);
    expect(retry.outcome).toBe('confirmed');
  });

  it('refuses to offer times when Outlook cannot be read and the snapshot is stale', async () => {
    const { ctx, calendar, clock } = await setup();
    calendar.fail.list = true;
    clock.advance(10 * 60_000);
    const err = await errorOf(requestBooking(ctx, request('intro', '2026-11-16T10:00'), web));
    expect(err.code).toBe('calendar_unavailable');
  });

  it('says "try again" and books nothing when Outlook stops answering at commit', async () => {
    const { ctx, calendar } = await setup();
    await requestBooking(ctx, request('intro', '2026-11-16T15:00'), web);
    calendar.fail.list = true; // snapshot still fresh, but the commit check can't run
    const err = await errorOf(requestBooking(ctx, request('intro', '2026-11-16T10:00'), web));
    expect(err.code).toBe('calendar_unavailable');
    const failed = await ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'failed'").first<{ n: number }>();
    expect(failed!.n).toBe(1);
  });
});

describe('A3: Meet link later', () => {
  it('confirms without a link when Meet fails, then adds it', async () => {
    const { ctx, meet, calendar } = await setup();
    meet.fail = true;
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    expect(r.outcome).toBe('confirmed');
    expect((await getBooking(ctx.db, r.bookingId))!.meeting_url).toBeNull();
    meet.fail = false;
    await driveUnfinished(ctx);
    const b = await getBooking(ctx.db, r.bookingId);
    expect(b!.meeting_url).toMatch(/meet.google.com/);
    expect(calendar.events.get(b!.calendar_event_id!)!.location).toBe(b!.meeting_url);
  });
});

describe('approval (F7, R5)', () => {
  it('waits without holding the time, and mails Tom an approval link', async () => {
    const { ctx } = await setup();
    const r = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    expect(r.outcome).toBe('pending');
    const mail = await ctx.db.prepare("SELECT body FROM outbox WHERE kind = 'approval'").first<{ body: string }>();
    expect(mail!.body).toMatch(/https:\/\/meet-mcp\.example\/a\//);
    expect(mail!.body).toMatch(/Typed by the guest/);
    // Another visitor can still book the same time instantly.
    const other = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    expect(other.outcome).toBe('confirmed');
  });

  it('lets several requests wait on one time; approving one declines the rest', async () => {
    const { ctx } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    const b = await requestBooking(ctx, request('project', '2026-11-16T10:00'), { address: '198.51.100.9', via: 'api' });
    expect((await decide(ctx, a.bookingId, true, 'owner')).result).toBe('approved');
    expect((await getBooking(ctx.db, b.bookingId))!.status).toBe('declined');
    expect((await decide(ctx, b.bookingId, true, 'owner')).result).toBe('already_decided');
  });

  it('treats a second approval of the same request as a no-op', async () => {
    const { ctx, calendar } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    await decide(ctx, a.bookingId, true, 'email');
    expect((await decide(ctx, a.bookingId, true, 'agent')).result).toBe('already_approved');
    expect(calendar.live()).toHaveLength(1);
  });

  it('cannot approve two overlapping requests at once', async () => {
    const { ctx } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    const b = await requestBooking(ctx, request('project', '2026-11-16T10:30'), { address: '198.51.100.9', via: 'api' });
    const results = await Promise.all([decide(ctx, a.bookingId, true, 'owner'), decide(ctx, b.bookingId, true, 'owner')]);
    const approved = results.filter((r) => r.result === 'approved');
    expect(approved).toHaveLength(1);
  });

  it('sends an approval back to waiting if Outlook now shows a clash', async () => {
    const { ctx, calendar } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    calendar.addBusy(at('2026-11-16T10:15'), at('2026-11-16T10:45'));
    expect(await decide(ctx, a.bookingId, true, 'owner')).toEqual({ result: 'calendar_problem', detail: 'conflict' });
    expect((await getBooking(ctx.db, a.bookingId))!.status).toBe('pending');
  });

  it('expires undecided requests after 72 hours', async () => {
    const { ctx, clock } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-18T10:00'), web);
    clock.advance(LIMITS.pendingTtlMs + 1);
    expect(await expireStale(ctx)).toBe(1);
    expect((await getBooking(ctx.db, a.bookingId))!.status).toBe('expired');
  });

  it('declines a request still undecided when its meeting time arrives, and refuses a late approval', async () => {
    const { ctx, clock } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    const b = await requestBooking(ctx, request('project', '2026-11-16T11:00'), { address: '198.51.100.9', via: 'api' });
    clock.advance(at('2026-11-16T10:00') - clock.now());
    // Approving before the cron has run still finds the time gone.
    expect(await decide(ctx, a.bookingId, true, 'owner')).toEqual({ result: 'time_passed' });
    const row = (await getBooking(ctx.db, a.bookingId))!;
    expect([row.status, row.reason]).toEqual(['declined', 'time_passed']);
    // A later request is untouched until its own time comes.
    expect((await getBooking(ctx.db, b.bookingId))!.status).toBe('pending');
    clock.advance(60 * 60_000);
    expect(await expireStale(ctx)).toBe(1);
    expect((await getBooking(ctx.db, b.bookingId))!.reason).toBe('time_passed');
  });
});

describe('the emailed approval link', () => {
  const api = (ctx: Parameters<typeof ownerApi>[0]) => ownerApi(ctx, { tokens: {} as TokenDeps, owner: { microsoftEmail: '', googleEmail: '' }, microsoftSecretExpiresOn: null });
  async function linkFor(ctx: Parameters<typeof ownerApi>[0], id: string) {
    const mail = await ctx.db.prepare("SELECT body, expires_at FROM outbox WHERE kind = 'approval' AND booking_id = ?").bind(id).first<{ body: string; expires_at: number }>();
    return { token: mail!.body.match(/\/a\/(\S+)/)![1]!, mail: mail! };
  }
  const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };

  it('warns against sharing and stops working at the meeting time when that is under 48 hours away', async () => {
    const { ctx, clock } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-16T10:00'), web); // 26 hours ahead
    const { token, mail } = await linkFor(ctx, a.bookingId);
    expect(mail.body).toMatch(/Don't forward or share this link/);
    expect(mail.body).toMatch(/declined automatically/);
    expect(mail.expires_at).toBe(at('2026-11-16T10:00'));
    expect(value(await api(ctx).peekApproval(token))).toMatchObject({ link: 'live', status: 'pending' });

    clock.advance(at('2026-11-16T10:00') - clock.now());
    const peek = value(await api(ctx).peekApproval(token));
    expect(peek).toMatchObject({ link: 'time_passed', status: 'declined' });
    expect(peek).not.toHaveProperty('guest_supplied');
    expect(value(await api(ctx).decideByLink(token, 'approve'))).toEqual({ result: 'time_passed' });
    expect((await getBooking(ctx.db, a.bookingId))!.reason).toBe('time_passed');
  });

  it('stops working after 48 hours while the request itself keeps waiting for the assistant', async () => {
    const { ctx, clock, calendar } = await setup();
    const a = await requestBooking(ctx, request('project', '2026-11-18T10:00'), web); // 74 hours ahead
    const { token, mail } = await linkFor(ctx, a.bookingId);
    expect(mail.expires_at).toBe(clock.now() + LIMITS.approvalLinkTtlMs);
    clock.advance(LIMITS.approvalLinkTtlMs - 1);
    expect(value(await api(ctx).peekApproval(token))).toMatchObject({ link: 'live' });
    clock.advance(1);
    const peek = value(await api(ctx).peekApproval(token));
    expect(peek).toMatchObject({ link: 'expired', status: 'pending' });
    expect(peek).not.toHaveProperty('guest_supplied');
    expect(value(await api(ctx).decideByLink(token, 'approve'))).toEqual({ result: 'link_expired', status: 'pending' });
    expect(calendar.live()).toHaveLength(0);
    // Signed in, Tom can still approve.
    expect((await decide(ctx, a.bookingId, true, 'owner_agent')).result).toBe('approved');
  });
});

describe('S5: abuse limits', () => {
  it('downgrades instant bookings to requests after 5 a day from one source', async () => {
    const { ctx, calendar } = await setup();
    const times = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00'];
    const outcomes = [];
    for (const t of times) outcomes.push((await requestBooking(ctx, request('intro', `2026-11-16T${t}`), web)).outcome);
    expect(outcomes.slice(0, 5).every((o) => o === 'confirmed')).toBe(true);
    expect(outcomes[5]).toBe('pending');
    expect(calendar.live()).toHaveLength(5); // the sixth sent nothing
  });

  it('refuses more than 10 open requests from one source', async () => {
    const { ctx } = await setup();
    for (let d = 0; d < LIMITS.pendingPerSource; d++) {
      await requestBooking(ctx, request('project', `2026-11-${16 + Math.floor(d / 5)}T${['09', '10', '11', '13', '14'][d % 5]}:00`), web);
    }
    const err = await errorOf(requestBooking(ctx, request('project', '2026-11-19T09:00'), web));
    expect(err.code).toBe('too_many_requests');
  });
});

describe('cancel and reschedule (F8)', () => {
  it('cancels the Outlook event when a guest cancels, and tells Tom', async () => {
    const { ctx, calendar } = await setup();
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    const b = await cancelBooking(ctx, r.bookingId, 'guest', 'Something came up');
    expect(b.status).toBe('cancelled');
    expect(calendar.live()).toHaveLength(0);
    const mail = await ctx.db.prepare("SELECT body FROM outbox WHERE kind = 'guest_cancelled'").first<{ body: string }>();
    expect(mail!.body).toMatch(/Something came up/);
  });

  it('moves the Outlook event, and lets a guest do it twice at most', async () => {
    const { ctx, calendar } = await setup();
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    await rescheduleBooking(ctx, r.bookingId, iso('2026-11-16T11:00'), 'guest');
    await rescheduleBooking(ctx, r.bookingId, iso('2026-11-16T13:00'), 'guest');
    const [event] = calendar.live();
    expect(event!.start).toBe(at('2026-11-16T13:00'));
    const err = await errorOf(rescheduleBooking(ctx, r.bookingId, iso('2026-11-16T14:00'), 'guest'));
    expect(err.code).toBe('not_allowed');
    await rescheduleBooking(ctx, r.bookingId, iso('2026-11-16T14:00'), 'owner'); // Tom has no limit
  });

  it('checks Outlook fresh before moving (R3)', async () => {
    const { ctx, calendar } = await setup();
    const r = await requestBooking(ctx, request('intro', '2026-11-16T10:00'), web);
    calendar.addBusy(at('2026-11-16T11:00'), at('2026-11-16T12:00'));
    const err = await errorOf(rescheduleBooking(ctx, r.bookingId, iso('2026-11-16T11:00'), 'guest'));
    expect(err.code).toBe('slot_taken');
    expect((await getBooking(ctx.db, r.bookingId))!.start_ms).toBe(at('2026-11-16T10:00'));
  });
});

describe('mail to Tom', () => {
  it('sends queued mail once, and retries a failed send', async () => {
    const { ctx } = await setup();
    await requestBooking(ctx, request('project', '2026-11-16T10:00'), web);
    const sent: string[] = [];
    let failNext = true;
    const mail = { send: async (subject: string) => { if (failNext) { failNext = false; throw new Error('smtp'); } sent.push(subject); } };
    expect(await sendOutbox(ctx, mail)).toBe(0);
    expect(await sendOutbox(ctx, mail)).toBe(1);
    expect(await sendOutbox(ctx, mail)).toBe(0);
    expect(sent[0]).toMatch(/Booking request: Project deep-dive/);
  });
});

describe('the minute cron before Outlook is connected', () => {
  it('reports "not connected" for busy times and logs no error', async () => {
    const s = await setup();
    const report = await runCron(s.ctx, { send: async () => undefined });
    expect(report.busy).toBe('not connected');
    expect(await s.db.prepare(`SELECT * FROM log WHERE code = 'cron_busy'`).first()).toBeNull();
  });
});
