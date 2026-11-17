import { RequestBookingInput, type EventTypeSettings } from '@wellmet/contracts';
import { Temporal } from 'temporal-polyfill';
import type { Clock, Db } from './db.ts';
import { CoreError, invalid } from './errors.ts';
import { newId, sha256Hex, signLink, sourceHash, type Keys } from './crypto.ts';
import { getEventType, requireEventType } from './catalog.ts';
import { findSlots } from './availability.ts';
import { weekKeyOf } from './slots/engine.ts';
import { ProviderUnavailable, withTimeout, type CalendarProvider, type MeetProvider } from './providers.ts';

/**
 * The booking state machine (design D, "Booking sequence and recovery").
 *
 *   pending   waiting for Tom; holds nothing, several may wait on one time
 *   accepted  instant or approved; holds its time; no Outlook event yet
 *   confirmed the Outlook event exists and the invite went out
 *   declined, expired, cancelled, failed: terminal, hold nothing
 *
 * Every rule that two requests could race on (overlap, caps, abuse limits) is
 * a condition inside one SQL statement, so the database decides the winner.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  instantPerSourcePerDay: 5,
  instantAllPerDay: 10,
  pendingPerSource: 10,
  pendingAll: 200,
  guestReschedules: 2,
  pendingTtlMs: 72 * HOUR,
  /** How long the emailed approval link works. It needs no sign-in, so it is kept short. */
  approvalLinkTtlMs: 48 * HOUR,
  leaseMs: 90_000,
} as const;

const TIMEOUTS = { inlineDeadline: 2_800, outlookCheck: 2_500, meet: 1_500, create: 4_000 } as const;

export interface CoreContext {
  db: Db;
  keys: Keys;
  clock: Clock;
  calendar: CalendarProvider;
  meet: MeetProvider;
  config: { publicUrl: string; ownerUrl: string; ownerName: string; ownerTimezone: string };
  /** Keeps work alive after a response is sent (Workers' ctx.waitUntil). */
  background?: (work: Promise<unknown>) => void;
}

export interface BookingRow {
  id: string;
  event_type: string;
  length_min: number;
  status: 'pending' | 'accepted' | 'confirmed' | 'declined' | 'expired' | 'cancelled' | 'failed';
  mode_applied: 'instant' | 'approval' | 'downgraded' | 'held';
  reason: string | null;
  start_ms: number;
  end_ms: number;
  block_start_ms: number;
  block_end_ms: number;
  local_date: string;
  week_key: string;
  guest_name: string;
  guest_email: string;
  guest_tz: string;
  answers: string;
  via: 'web' | 'api' | 'mcp' | 'owner';
  source_hash: string;
  retry_key: string | null;
  meeting_url: string | null;
  calendar_event_id: string | null;
  rechecked_at: number | null;
  calendar_dirty: 'move' | 'cancel' | null;
  reschedule_count: number;
  attempts: number;
  lease_until: number | null;
  alerted_at: number | null;
  expires_at: number | null;
  decided_by: string | null;
  created_at: number;
  updated_at: number;
}

export async function getBooking(db: Db, id: string): Promise<BookingRow | null> {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>();
}

async function requireBooking(db: Db, id: string): Promise<BookingRow> {
  const row = await getBooking(db, id);
  if (!row) throw new CoreError('not_found', 'There is no such booking.');
  return row;
}

export async function manageUrl(ctx: CoreContext, id: string): Promise<string> {
  return `${ctx.config.publicUrl}/b/${id}.${await signLink(ctx.keys, 'manage', id)}`;
}

export async function approvalUrl(ctx: CoreContext, id: string): Promise<string> {
  return `${ctx.config.ownerUrl}/a/${id}.${await signLink(ctx.keys, 'approve', id)}`;
}

/**
 * When the emailed approval link stops working: 48 hours after the request,
 * or at the meeting's start if that comes first. The link is the only proof of
 * who is clicking, so it is short-lived; after it, Tom decides through his
 * assistant, which is signed in.
 */
export function approvalLinkExpiry(b: Pick<BookingRow, 'created_at' | 'start_ms'>): number {
  return Math.min(b.created_at + LIMITS.approvalLinkTtlMs, b.start_ms);
}

// --- Mail to Tom ---------------------------------------------------------------------

/** Queues a mail to Tom; the cron sends it. Returns the statement, so callers can put it in their batch. */
function mailStatement(db: Db, now: number, kind: string, bookingId: string | null, subject: string, body: string, onlyIfBookingExists = false, expiresAt = now + 3 * DAY) {
  const sql = `INSERT INTO outbox (id, kind, booking_id, subject, body, created_at, expires_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 ${onlyIfBookingExists ? 'WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?3)' : ''}`;
  return db.prepare(sql).bind(newId(), kind, bookingId, subject, body, now, expiresAt);
}

function formatForTom(ctx: CoreContext, ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(ctx.config.ownerTimezone)
    .toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// --- Requesting a booking ---------------------------------------------------------------

export type RequestOutcome =
  | { outcome: 'confirmed' | 'accepted' | 'pending'; bookingId: string; status: BookingRow['status']; manageUrl: string; repeated: boolean };

export interface Caller {
  address: string;
  via: 'web' | 'api' | 'mcp';
}

export async function requestBooking(ctx: CoreContext, raw: unknown, caller: Caller): Promise<RequestOutcome> {
  const parsed = RequestBookingInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const b = parsed.data;
  const now = ctx.clock.now();

  const type = await requireEventType(ctx.db, b.event_type);
  if (!type.active) throw new CoreError('not_bookable', `"${b.event_type}" isn't taking bookings.`);
  const s = type.settings;
  const lengthMin = b.length_min ?? s.lengths[0]!;
  if (!s.lengths.includes(lengthMin)) {
    throw new CoreError('invalid_input', `This meeting is offered at ${s.lengths.join(', ')} minutes, not ${lengthMin}.`);
  }
  const questions = s.questions;
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const a = b.answers[q.id]?.trim() ?? '';
    if (q.required && !a) throw new CoreError('invalid_input', `"${q.label}" needs an answer (answers.${q.id}).`);
    if (a) answers[q.id] = a;
  }

  const start = Date.parse(b.start);
  const end = start + lengthMin * MINUTE;

  // A repeat of an earlier call gets that call's answer, whatever it was.
  const retryKey = await sha256Hex([b.retry_token, b.event_type, start, b.email].join('|'));
  const earlier = await ctx.db.prepare('SELECT * FROM bookings WHERE retry_key = ?').bind(retryKey).first<BookingRow>();
  if (earlier) return answerFor(ctx, earlier, true);

  // The start must be one the rules offer right now.
  const offered = await findSlots(ctx.db, ctx.calendar, { slug: b.event_type, from: start, to: start + 1, now, lengthMin });
  const slot = offered.find((o) => o.start === start);
  if (!slot) throw await slotTaken(ctx, b.event_type, start, lengthMin, now, 'That time isn\'t open.');

  const row: Omit<BookingRow, 'status' | 'mode_applied' | 'reason' | 'meeting_url' | 'calendar_event_id' | 'rechecked_at' | 'calendar_dirty' | 'reschedule_count' | 'attempts' | 'alerted_at' | 'decided_by'> = {
    id: newId(),
    event_type: b.event_type,
    length_min: lengthMin,
    start_ms: start,
    end_ms: end,
    block_start_ms: start - s.buffer_before_min * MINUTE,
    block_end_ms: end + s.buffer_after_min * MINUTE,
    local_date: slot.localDate,
    week_key: weekKeyOf(slot.localDate),
    guest_name: b.name,
    guest_email: b.email,
    guest_tz: b.timezone,
    answers: JSON.stringify(answers),
    via: caller.via,
    source_hash: await sourceHash(ctx.keys, caller.address),
    retry_key: retryKey,
    lease_until: null,
    expires_at: null,
    created_at: now,
    updated_at: now,
  };

  const outlookBroken = await connectionBroken(ctx.db, 'microsoft');
  if (s.confirmation === 'instant' && !outlookBroken) {
    if (await insertAccepted(ctx, row, s, now)) return runInline(ctx, row.id);
    // Not inserted: find out why. A clash or a full day refuses; an abuse limit downgrades to a request.
    if (await committedOverlap(ctx.db, row.block_start_ms, row.block_end_ms)) {
      throw await slotTaken(ctx, b.event_type, start, lengthMin, now, 'Someone booked that time a moment ago.');
    }
    if (await capReached(ctx.db, b.event_type, s, row.local_date, row.week_key)) {
      throw await slotTaken(ctx, b.event_type, start, lengthMin, now, 'That day just filled up.');
    }
    return insertPending(ctx, row, 'downgraded', type.settings.title, now);
  }
  return insertPending(ctx, row, outlookBroken && s.confirmation === 'instant' ? 'held' : 'approval', type.settings.title, now);
}

const INSERT_COLUMNS = `id, event_type, length_min, status, mode_applied, start_ms, end_ms, block_start_ms, block_end_ms,
  local_date, week_key, guest_name, guest_email, guest_tz, answers, via, source_hash, retry_key, lease_until, expires_at, created_at, updated_at`;

function insertValues(row: Parameters<typeof insertAccepted>[1], status: string, mode: string, leaseUntil: number | null, expiresAt: number | null) {
  return [
    row.id, row.event_type, row.length_min, status, mode, row.start_ms, row.end_ms, row.block_start_ms, row.block_end_ms,
    row.local_date, row.week_key, row.guest_name, row.guest_email, row.guest_tz, row.answers, row.via, row.source_hash,
    row.retry_key, leaseUntil, expiresAt, row.created_at, row.updated_at,
  ];
}

const COMMITTED_OVERLAP = `EXISTS (SELECT 1 FROM bookings WHERE status IN ('accepted', 'confirmed') AND block_start_ms < ?9 AND block_end_ms > ?8)`;

async function insertAccepted(
  ctx: CoreContext,
  row: { id: string; event_type: string; length_min: number; start_ms: number; end_ms: number; block_start_ms: number; block_end_ms: number; local_date: string; week_key: string; guest_name: string; guest_email: string; guest_tz: string; answers: string; via: string; source_hash: string; retry_key: string | null; created_at: number; updated_at: number },
  s: EventTypeSettings,
  now: number,
): Promise<boolean> {
  const sql = `INSERT INTO bookings (${INSERT_COLUMNS})
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
    WHERE NOT ${COMMITTED_OVERLAP}
      AND (?23 IS NULL OR (SELECT COUNT(*) FROM bookings WHERE event_type = ?2 AND status IN ('accepted', 'confirmed') AND local_date = ?10) < ?23)
      AND (?24 IS NULL OR (SELECT COUNT(*) FROM bookings WHERE event_type = ?2 AND status IN ('accepted', 'confirmed') AND week_key = ?11) < ?24)
      AND (SELECT COUNT(*) FROM bookings WHERE source_hash = ?17 AND mode_applied = 'instant' AND created_at > ?25) < ?26
      AND (SELECT COUNT(*) FROM bookings WHERE mode_applied = 'instant' AND via != 'owner' AND created_at > ?25) < ?27`;
  const r = await ctx.db
    .prepare(sql)
    .bind(
      ...insertValues(row, 'accepted', 'instant', now + LIMITS.leaseMs, null),
      s.limits.per_day ?? null, s.limits.per_week ?? null, now - DAY, LIMITS.instantPerSourcePerDay, LIMITS.instantAllPerDay,
    )
    .run();
  return r.meta.changes === 1;
}

async function insertPending(
  ctx: CoreContext,
  row: Parameters<typeof insertAccepted>[1],
  mode: 'approval' | 'downgraded' | 'held',
  title: string,
  now: number,
): Promise<RequestOutcome> {
  const attempt = async () => {
    const insert = ctx.db
      .prepare(`INSERT INTO bookings (${INSERT_COLUMNS})
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
        WHERE NOT ${COMMITTED_OVERLAP}
          AND (SELECT COUNT(*) FROM bookings WHERE status = 'pending' AND source_hash = ?17) < ?23
          AND (SELECT COUNT(*) FROM bookings WHERE status = 'pending') < ?24`)
      .bind(...insertValues(row, 'pending', mode, null, now + LIMITS.pendingTtlMs), LIMITS.pendingPerSource, LIMITS.pendingAll);
    const answers = JSON.parse(row.answers) as Record<string, string>;
    const linkExpiry = approvalLinkExpiry(row);
    const why = mode === 'approval' ? '' : mode === 'held'
      ? '\nThis type normally confirms instantly; it is waiting because the Outlook connection is broken.\n'
      : '\nThis type normally confirms instantly; it is waiting because the instant-booking limit for the day was reached.\n';
    const body = [
      `${title} on ${formatForTom(ctx, row.start_ms)} (${row.length_min} min).`,
      why,
      'Typed by the guest (not verified):',
      `  Name: ${row.guest_name}`,
      `  Email: ${row.guest_email}`,
      ...Object.entries(answers).map(([k, v]) => `  ${k}: ${v}`),
      '',
      `Approve or decline: ${await approvalUrl(ctx, row.id)}`,
      `Don't forward or share this link: anyone who has it can approve or decline this request without signing in. It stops working on ${formatForTom(ctx, linkExpiry)}.`,
      '',
      row.start_ms <= now + LIMITS.pendingTtlMs
        ? 'You can also ask your assistant. A request still undecided when the meeting time arrives is declined automatically.'
        : 'After that, ask your assistant. This request lapses in 72 hours.',
    ].join('\n');
    // A mail that could only arrive after its link died is not worth sending.
    const mail = mailStatement(ctx.db, now, 'approval', row.id, `Booking request: ${title}, ${formatForTom(ctx, row.start_ms)}`, body, true, linkExpiry);
    const [r] = await ctx.db.batch([insert, mail]);
    return r!.meta.changes === 1;
  };

  if (!(await attempt())) {
    if (await committedOverlap(ctx.db, row.block_start_ms, row.block_end_ms)) {
      throw await slotTaken(ctx, row.event_type, row.start_ms, row.length_min, now, 'Someone booked that time a moment ago.');
    }
    const mine = await ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND source_hash = ?").bind(row.source_hash).first<{ n: number }>();
    if ((mine?.n ?? 0) >= LIMITS.pendingPerSource) {
      throw new CoreError('too_many_requests', 'There are already several open requests from here. Wait for an answer before asking again.');
    }
    // The queue is full. Make room by lapsing the oldest request that was only waiting because of a limit.
    const evicted = await ctx.db
      .prepare(`UPDATE bookings SET status = 'expired', reason = 'queue_full', retry_key = NULL, updated_at = ?1
                WHERE id = (SELECT id FROM bookings WHERE status = 'pending' AND mode_applied = 'downgraded' ORDER BY created_at LIMIT 1)`)
      .bind(now)
      .run();
    if (evicted.meta.changes === 0 || !(await attempt())) {
      await ctx.db.batch([mailStatement(ctx.db, now, 'queue_full', null, 'Booking requests are piling up', 'There are 200 undecided requests, so new ones are being refused. Ask your assistant to list pending bookings and decline or approve them.')]);
      throw new CoreError('too_many_requests', 'Tom has too many requests waiting right now. Please try again later.');
    }
  }
  const saved = await requireBooking(ctx.db, row.id);
  return answerFor(ctx, saved, false);
}

async function answerFor(ctx: CoreContext, row: BookingRow, repeated: boolean): Promise<RequestOutcome> {
  const outcome = row.status === 'confirmed' ? 'confirmed' : row.status === 'accepted' ? 'accepted' : 'pending';
  return { outcome, bookingId: row.id, status: row.status, manageUrl: await manageUrl(ctx, row.id), repeated };
}

async function committedOverlap(db: Db, blockStart: number, blockEnd: number, excludeId?: string): Promise<boolean> {
  const r = await db
    .prepare(`SELECT 1 AS hit FROM bookings WHERE status IN ('accepted', 'confirmed') AND block_start_ms < ?2 AND block_end_ms > ?1 AND id IS NOT ?3 LIMIT 1`)
    .bind(blockStart, blockEnd, excludeId ?? null)
    .first();
  return r !== null;
}

async function capReached(db: Db, slug: string, s: EventTypeSettings, localDate: string, weekKey: string): Promise<boolean> {
  const count = async (column: 'local_date' | 'week_key', value: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE event_type = ? AND status IN ('accepted', 'confirmed') AND ${column} = ?`).bind(slug, value).first<{ n: number }>())?.n ?? 0;
  if (s.limits.per_day !== undefined && (await count('local_date', localDate)) >= s.limits.per_day) return true;
  if (s.limits.per_week !== undefined && (await count('week_key', weekKey)) >= s.limits.per_week) return true;
  return false;
}

async function connectionBroken(db: Db, provider: 'microsoft' | 'google'): Promise<boolean> {
  const r = await db.prepare('SELECT status FROM connections WHERE provider = ?').bind(provider).first<{ status: string }>();
  return r?.status === 'broken';
}

async function slotTaken(ctx: CoreContext, slug: string, start: number, lengthMin: number, now: number, message: string): Promise<CoreError> {
  let alternatives: number[] = [];
  try {
    const nearby = await findSlots(ctx.db, ctx.calendar, { slug, from: Math.max(now, start - 2 * DAY), to: start + 3 * DAY, now, lengthMin });
    alternatives = nearby
      .filter((n) => n.start !== start)
      .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))
      .slice(0, 4)
      .map((n) => n.start)
      .sort((a, b) => a - b);
  } catch {
    // Alternatives are a courtesy; the refusal stands without them.
  }
  return new CoreError('slot_taken', alternatives.length ? `${message} These nearby times are open.` : message, { alternatives });
}

/** For an instant booking: run the Outlook step now, but answer by the deadline either way. */
async function runInline(ctx: CoreContext, id: string): Promise<RequestOutcome> {
  const work = advance(ctx, id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), TIMEOUTS.inlineDeadline); });
  const first = await Promise.race([work, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  if (first === 'deadline') {
    ctx.background?.(work);
    // The commit check may not have finished. If it later fails, the row ends `failed`;
    // the guest's status page shows it, and Tom is told.
    return answerFor(ctx, await requireBooking(ctx.db, id), false);
  }
  if (first === 'conflict' || first === 'unavailable') {
    const row = await requireBooking(ctx.db, id);
    await ctx.db
      .prepare(`UPDATE bookings SET status = 'failed', reason = ?2, retry_key = NULL, lease_until = NULL, updated_at = ?3 WHERE id = ?1`)
      .bind(id, first === 'conflict' ? 'calendar_conflict' : 'calendar_unavailable', ctx.clock.now())
      .run();
    if (first === 'conflict') {
      throw await slotTaken(ctx, row.event_type, row.start_ms, row.length_min, ctx.clock.now(), 'That time was just taken in Tom\'s calendar.');
    }
    throw new CoreError('calendar_unavailable', "Tom's calendar didn't answer in time, so nothing was booked. Try again in a moment; your retry_token can be reused.");
  }
  return answerFor(ctx, await requireBooking(ctx.db, id), false);
}

// --- The Outlook and Meet step ---------------------------------------------------------------

export type AdvanceResult =
  | 'confirmed' // event exists, invite sent
  | 'conflict' // the commit check found a clash; nothing promised yet
  | 'unavailable' // Outlook didn't answer before the commit check; nothing promised yet
  | 'committed' // passed the commit check; the event will be created on a later run
  | 'busy' // another run holds this booking
  | 'done'; // nothing to do

/**
 * The only code that touches Outlook and Meet for a booking. Idempotent: any
 * number of runs, in any order, end with one event, one invite and at most one
 * spare Meet room (R2).
 */
export async function advance(ctx: CoreContext, id: string): Promise<AdvanceResult> {
  const { db } = ctx;
  const now = ctx.clock.now();
  const lease = await db
    .prepare(`UPDATE bookings SET lease_until = ?2, attempts = attempts + 1, updated_at = ?3
              WHERE id = ?1 AND (lease_until IS NULL OR lease_until <= ?3 OR (status = 'accepted' AND attempts = 0))`)
    .bind(id, now + LIMITS.leaseMs, now)
    .run();
  if (lease.meta.changes === 0) return 'busy';
  try {
    return await advanceHeld(ctx, id);
  } finally {
    await db.prepare('UPDATE bookings SET lease_until = NULL WHERE id = ?').bind(id).run();
  }
}

async function advanceHeld(ctx: CoreContext, id: string): Promise<AdvanceResult> {
  const { db } = ctx;
  let b = await requireBooking(db, id);
  const type = await getEventType(db, b.event_type);
  const location = type?.settings.location ?? { kind: 'google_meet' as const };
  const wantsMeet = location.kind === 'google_meet';
  const title = type?.settings.title ?? b.event_type;

  if (b.status === 'accepted' && !b.calendar_event_id) {
    const [eventsResult, meetResult] = await Promise.allSettled([
      withTimeout('microsoft', TIMEOUTS.outlookCheck, ctx.calendar.listEvents(b.block_start_ms, b.block_end_ms)),
      wantsMeet && !b.meeting_url ? withTimeout('google', TIMEOUTS.meet, ctx.meet.createSpace()) : Promise.resolve(null),
    ]);
    if (eventsResult.status === 'rejected') return b.rechecked_at ? 'committed' : 'unavailable';
    const events = eventsResult.value;
    const meetingUrl = b.meeting_url ?? (meetResult.status === 'fulfilled' ? meetResult.value?.url ?? null : null);

    // A run that died after creating the event: adopt it instead of creating another (R2).
    const mine = events.find((e) => e.transactionId === id);
    if (mine) {
      await db.prepare(`UPDATE bookings SET status = 'confirmed', calendar_event_id = ?2, rechecked_at = COALESCE(rechecked_at, ?3), meeting_url = COALESCE(meeting_url, ?4), updated_at = ?3 WHERE id = ?1`)
        .bind(id, mine.id, ctx.clock.now(), meetingUrl).run();
      return 'confirmed';
    }

    const clash = events.some((e) => e.busy && e.start < b.block_end_ms && e.end > b.block_start_ms);
    if (!b.rechecked_at) {
      if (clash) return 'conflict';
      // The commit point: from here the guest has been told they're booked.
      const now = ctx.clock.now();
      await db.batch([
        db.prepare('UPDATE bookings SET rechecked_at = ?2, meeting_url = COALESCE(meeting_url, ?3), updated_at = ?2 WHERE id = ?1').bind(id, now, meetingUrl),
        // Waiting requests for the same time can no longer be approved (F7, R5).
        db.prepare(`UPDATE bookings SET status = 'declined', reason = 'time_taken', retry_key = NULL, updated_at = ?2
                    WHERE status = 'pending' AND id != ?1 AND block_start_ms < ?4 AND block_end_ms > ?3`)
          .bind(id, now, b.block_start_ms, b.block_end_ms),
      ]);
    } else if (clash && !b.alerted_at) {
      // A clash found on a retry after "booked": keep the booking, tell Tom once.
      await db.batch([
        db.prepare('UPDATE bookings SET alerted_at = ?2 WHERE id = ?1').bind(id, ctx.clock.now()),
        mailStatement(db, ctx.clock.now(), 'conflict_after_booked', id, `Clash: ${title} on ${formatForTom(ctx, b.start_ms)}`,
          `A booking that was already confirmed to ${b.guest_name} now overlaps something else in your Outlook calendar. It has been kept. Check the time and move one of them if needed.`),
      ]);
    }
    b = await requireBooking(db, id);

    try {
      const created = await withTimeout('microsoft', TIMEOUTS.create, ctx.calendar.createEvent({
        transactionId: id,
        subject: `${title} with ${ctx.config.ownerName}`,
        body: await eventBody(ctx, b, location),
        start: b.start_ms,
        end: b.end_ms,
        timezone: ctx.config.ownerTimezone,
        attendee: { name: b.guest_name, email: b.guest_email },
        location: locationText(location, b),
      }));
      await db.prepare(`UPDATE bookings SET status = 'confirmed', calendar_event_id = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'accepted'`)
        .bind(id, created.id, ctx.clock.now()).run();
      b = await requireBooking(db, id);
    } catch (err) {
      if (err instanceof ProviderUnavailable) return 'committed';
      throw err;
    }
  }

  // Add a Meet link that couldn't be made in time (relaxed A3).
  if (b.status === 'confirmed' && wantsMeet && !b.meeting_url && b.calendar_event_id) {
    try {
      const space = await withTimeout('google', TIMEOUTS.meet, ctx.meet.createSpace());
      // Store first, so a crash after creating the room can't make a second one on the next run.
      await db.prepare('UPDATE bookings SET meeting_url = ?2, updated_at = ?3 WHERE id = ?1').bind(id, space.url, ctx.clock.now()).run();
      b = await requireBooking(db, id);
      await ctx.calendar.updateEvent(b.calendar_event_id!, { location: space.url, body: await eventBody(ctx, b, location) });
    } catch {
      await alertOnce(ctx, b, 15 * MINUTE, 'meet_missing', `No Meet link yet: ${title} on ${formatForTom(ctx, b.start_ms)}`,
        `The booking with ${b.guest_name} is confirmed, but Google Meet hasn't given a link for 15 minutes. It keeps retrying; you can also add a link to the event yourself.`);
    }
  }

  // Apply a pending move or cancel to the event.
  if (b.calendar_dirty && b.calendar_event_id) {
    try {
      if (b.calendar_dirty === 'cancel') {
        await ctx.calendar.cancelEvent(b.calendar_event_id, 'This meeting was cancelled.');
      } else {
        await ctx.calendar.updateEvent(b.calendar_event_id, { start: b.start_ms, end: b.end_ms, timezone: ctx.config.ownerTimezone, body: await eventBody(ctx, b, location) });
      }
      await db.prepare('UPDATE bookings SET calendar_dirty = NULL, updated_at = ?2 WHERE id = ?1').bind(id, ctx.clock.now()).run();
    } catch (err) {
      if (!(err instanceof ProviderUnavailable)) throw err;
      return 'committed';
    }
  } else if (b.calendar_dirty && !b.calendar_event_id) {
    await db.prepare('UPDATE bookings SET calendar_dirty = NULL WHERE id = ?').bind(id).run();
  }

  return b.status === 'confirmed' ? 'confirmed' : 'done';
}

function locationText(location: EventTypeSettings['location'], b: BookingRow): string {
  switch (location.kind) {
    case 'google_meet':
      return b.meeting_url ?? 'Google Meet (link to follow)';
    case 'phone':
      return `Phone: call ${location.number}`;
    case 'in_person':
      return location.address;
  }
}

async function eventBody(ctx: CoreContext, b: BookingRow, location: EventTypeSettings['location']): Promise<string> {
  return [
    locationText(location, b),
    '',
    `Change or cancel: ${await manageUrl(ctx, b.id)}`,
    'Booked with Wellmet.',
  ].join('\n');
}

async function alertOnce(ctx: CoreContext, b: BookingRow, after: number, kind: string, subject: string, body: string) {
  const now = ctx.clock.now();
  if (b.alerted_at || now - b.created_at < after) return;
  await ctx.db.batch([
    ctx.db.prepare('UPDATE bookings SET alerted_at = ?2 WHERE id = ?1 AND alerted_at IS NULL').bind(b.id, now),
    mailStatement(ctx.db, now, kind, b.id, subject, body),
  ]);
}

// --- Tom's decisions ------------------------------------------------------------------------

export type DecideResult =
  | { result: 'approved'; status: BookingRow['status'] }
  | { result: 'declined' }
  | { result: 'already_approved' }
  | { result: 'already_decided'; status: BookingRow['status'] }
  | { result: 'time_taken' }
  | { result: 'time_passed' }
  | { result: 'try_again' }
  | { result: 'calendar_problem'; detail: 'conflict' | 'unavailable' };

/** Approve or decline a waiting request. Safe to call twice (R5). */
export async function decide(ctx: CoreContext, id: string, approve: boolean, by: string): Promise<DecideResult> {
  const { db } = ctx;
  const now = ctx.clock.now();
  const b = await requireBooking(db, id);

  if (!approve) {
    const r = await db.prepare(`UPDATE bookings SET status = 'declined', reason = 'declined_by_owner', decided_by = ?2, retry_key = NULL, updated_at = ?3
                                WHERE id = ?1 AND status = 'pending'`).bind(id, by, now).run();
    if (r.meta.changes === 1) return { result: 'declined' };
    const after = await requireBooking(db, id);
    return after.status === 'accepted' || after.status === 'confirmed' ? { result: 'already_approved' } : { result: 'already_decided', status: after.status };
  }

  const type = await getEventType(db, b.event_type);
  const limits = type?.settings.limits ?? {};
  const r = await db
    .prepare(`UPDATE bookings SET status = 'accepted', decided_by = ?2, updated_at = ?3, lease_until = NULL, attempts = 0
              WHERE id = ?1 AND status = 'pending' AND expires_at > ?3 AND start_ms > ?3
                AND NOT EXISTS (SELECT 1 FROM bookings o WHERE o.status IN ('accepted', 'confirmed') AND o.id != ?1
                                AND o.block_start_ms < bookings.block_end_ms AND o.block_end_ms > bookings.block_start_ms)
                AND (?4 IS NULL OR (SELECT COUNT(*) FROM bookings o WHERE o.event_type = bookings.event_type AND o.status IN ('accepted', 'confirmed') AND o.local_date = bookings.local_date) < ?4)
                AND (?5 IS NULL OR (SELECT COUNT(*) FROM bookings o WHERE o.event_type = bookings.event_type AND o.status IN ('accepted', 'confirmed') AND o.week_key = bookings.week_key) < ?5)`)
    .bind(id, by, now, limits.per_day ?? null, limits.per_week ?? null)
    .run();

  if (r.meta.changes === 1) {
    const result = await advance(ctx, id);
    if (result === 'conflict' || result === 'unavailable') {
      // Outlook says no, or can't say: the request goes back to waiting (design D, decide table).
      await db.prepare(`UPDATE bookings SET status = 'pending', decided_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'accepted' AND rechecked_at IS NULL`)
        .bind(id, ctx.clock.now()).run();
      return { result: 'calendar_problem', detail: result };
    }
    return { result: 'approved', status: (await requireBooking(db, id)).status };
  }

  const after = await requireBooking(db, id);
  if (after.status === 'accepted' || after.status === 'confirmed') return { result: 'already_approved' };
  if (after.status !== 'pending') return { result: 'already_decided', status: after.status };
  if (after.start_ms <= now) {
    await expireStale(ctx);
    return { result: 'time_passed' };
  }
  if (after.expires_at !== null && after.expires_at <= now) {
    await expireStale(ctx);
    return { result: 'already_decided', status: 'expired' };
  }
  // Still pending, so something holds the time (or a cap is reached).
  const holder = await db
    .prepare(`SELECT status, rechecked_at FROM bookings WHERE status IN ('accepted', 'confirmed') AND id != ?1
              AND block_start_ms < ?3 AND block_end_ms > ?2 LIMIT 1`)
    .bind(id, after.block_start_ms, after.block_end_ms)
    .first<{ status: string; rechecked_at: number | null }>();
  if (holder && holder.status === 'accepted' && holder.rechecked_at === null) return { result: 'try_again' };
  await db.prepare(`UPDATE bookings SET status = 'declined', reason = 'time_taken', retry_key = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'pending'`)
    .bind(id, now).run();
  return { result: 'time_taken' };
}

// --- Cancelling and moving -------------------------------------------------------------------

export async function cancelBooking(ctx: CoreContext, id: string, by: 'guest' | 'owner', reason?: string): Promise<BookingRow> {
  const now = ctx.clock.now();
  const b = await requireBooking(ctx.db, id);
  if (!['pending', 'accepted', 'confirmed'].includes(b.status)) {
    throw new CoreError('not_allowed', `This booking is already ${b.status}.`);
  }
  await ctx.db
    .prepare(`UPDATE bookings SET status = 'cancelled', reason = ?2, retry_key = NULL, updated_at = ?3,
              calendar_dirty = CASE WHEN calendar_event_id IS NOT NULL THEN 'cancel' ELSE NULL END
              WHERE id = ?1 AND status IN ('pending', 'accepted', 'confirmed')`)
    .bind(id, `cancelled_by_${by}${reason ? `: ${reason.slice(0, 300)}` : ''}`, now)
    .run();
  if (by === 'guest' && b.status !== 'pending') {
    await ctx.db.batch([mailStatement(ctx.db, now, 'guest_cancelled', id, `Cancelled: ${b.event_type}, ${formatForTom(ctx, b.start_ms)}`,
      `${b.guest_name} cancelled.${reason ? `\n\nTheir reason, as typed: ${reason.slice(0, 300)}` : ''}`)]);
  }
  await advance(ctx, id).catch(() => undefined); // cron retries a failed Outlook cancel
  return requireBooking(ctx.db, id);
}

export async function rescheduleBooking(ctx: CoreContext, id: string, newStartIso: string, by: 'guest' | 'owner'): Promise<BookingRow> {
  const now = ctx.clock.now();
  const b = await requireBooking(ctx.db, id);
  if (!['pending', 'accepted', 'confirmed'].includes(b.status)) throw new CoreError('not_allowed', `This booking is already ${b.status}.`);
  if (by === 'guest' && b.reschedule_count >= LIMITS.guestReschedules) {
    throw new CoreError('not_allowed', 'This booking has been moved as many times as allowed. It can still be cancelled.');
  }
  const type = await requireEventType(ctx.db, b.event_type);
  const s = type.settings;
  const start = Date.parse(newStartIso);
  if (Number.isNaN(start)) throw new CoreError('invalid_input', 'Give the new start exactly as listed in the open times.');
  const slots = await findSlots(ctx.db, ctx.calendar, { slug: b.event_type, from: start, to: start + 1, now, lengthMin: b.length_min, excludeBookingId: id });
  const slot = slots.find((x) => x.start === start);
  if (!slot) throw await slotTaken(ctx, b.event_type, start, b.length_min, now, 'That time isn\'t open.');
  const end = start + b.length_min * MINUTE;
  const blockStart = start - s.buffer_before_min * MINUTE;
  const blockEnd = end + s.buffer_after_min * MINUTE;

  // Committed bookings move only after a fresh look at Outlook (R3).
  if (b.status !== 'pending') {
    let events;
    try {
      events = await withTimeout('microsoft', TIMEOUTS.outlookCheck, ctx.calendar.listEvents(blockStart, blockEnd));
    } catch {
      throw new CoreError('calendar_unavailable', "Tom's calendar didn't answer, so the booking wasn't moved. Try again in a moment.");
    }
    if (events.some((e) => e.busy && e.transactionId !== id && e.start < blockEnd && e.end > blockStart)) {
      throw await slotTaken(ctx, b.event_type, start, b.length_min, now, 'That time was just taken in Tom\'s calendar.');
    }
  }

  const r = await ctx.db
    .prepare(`UPDATE bookings SET start_ms = ?2, end_ms = ?3, block_start_ms = ?4, block_end_ms = ?5, local_date = ?6, week_key = ?7,
                reschedule_count = reschedule_count + ?8, updated_at = ?9,
                calendar_dirty = CASE WHEN calendar_event_id IS NOT NULL THEN 'move' ELSE calendar_dirty END
              WHERE id = ?1 AND status IN ('pending', 'accepted', 'confirmed') AND (?8 = 0 OR reschedule_count < ?10)
                AND (status = 'pending' OR NOT EXISTS (SELECT 1 FROM bookings o WHERE o.status IN ('accepted', 'confirmed') AND o.id != ?1
                                                       AND o.block_start_ms < ?5 AND o.block_end_ms > ?4))`)
    .bind(id, start, end, blockStart, blockEnd, slot.localDate, weekKeyOf(slot.localDate), by === 'guest' ? 1 : 0, now, LIMITS.guestReschedules)
    .run();
  if (r.meta.changes === 0) throw await slotTaken(ctx, b.event_type, start, b.length_min, now, 'Someone booked that time a moment ago.');

  // Waiting requests for the new time can no longer be approved.
  if (b.status !== 'pending') {
    await ctx.db.prepare(`UPDATE bookings SET status = 'declined', reason = 'time_taken', retry_key = NULL, updated_at = ?2
                          WHERE status = 'pending' AND id != ?1 AND block_start_ms < ?4 AND block_end_ms > ?3`)
      .bind(id, now, blockStart, blockEnd).run();
  }
  await advance(ctx, id).catch(() => undefined);
  return requireBooking(ctx.db, id);
}

// --- Housekeeping ------------------------------------------------------------------------------

/**
 * Settles requests Tom never answered: one whose meeting time has arrived is
 * declined, and one that has waited 72 hours lapses. Returns how many changed.
 */
export async function expireStale(ctx: CoreContext): Promise<number> {
  const now = ctx.clock.now();
  const [passed, lapsed] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE bookings SET status = 'declined', reason = 'time_passed', retry_key = NULL, updated_at = ?1
                    WHERE status = 'pending' AND start_ms <= ?1`).bind(now),
    ctx.db.prepare(`UPDATE bookings SET status = 'expired', reason = 'not_decided', retry_key = NULL, updated_at = ?1
                    WHERE status = 'pending' AND expires_at <= ?1`).bind(now),
  ]);
  return passed!.meta.changes + lapsed!.meta.changes;
}

/** Bookings the cron should run `advance` on, most urgent first. */
export async function unfinished(ctx: CoreContext, limit = 5): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(`SELECT id FROM bookings
              WHERE (status = 'accepted')
                 OR (calendar_dirty IS NOT NULL)
                 OR (status = 'confirmed' AND meeting_url IS NULL AND calendar_event_id IS NOT NULL
                     AND event_type IN (SELECT slug FROM event_types WHERE json_extract(settings, '$.location.kind') = 'google_meet'))
              ORDER BY CASE WHEN status = 'accepted' THEN 0 WHEN calendar_dirty IS NOT NULL THEN 1 ELSE 2 END, updated_at
              LIMIT ?`)
    .bind(limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
