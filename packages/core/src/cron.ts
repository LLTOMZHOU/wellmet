import type { CoreContext } from './bookings.ts';
import { advance, expireStale, getBooking, unfinished } from './bookings.ts';
import { refreshBusy } from './availability.ts';
import { newId } from './crypto.ts';

const MINUTE = 60_000;

export interface MailSender {
  /** Sends one plain-text mail to Tom's fixed address. */
  send(subject: string, body: string): Promise<void>;
}

/**
 * Runs every minute, in this order (design D): refresh the busy snapshot,
 * drive up to 5 unfinished bookings, expire 72-hour requests, send up to 10
 * queued mails. Each step is independent: one failing doesn't stop the rest.
 */
export async function runCron(ctx: CoreContext, mail: MailSender): Promise<Record<string, string>> {
  const report: Record<string, string> = {};
  const step = async (name: string, work: () => Promise<string>) => {
    try {
      report[name] = await work();
    } catch (err) {
      report[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      await ctx.db
        .prepare(`INSERT INTO log (at, component, level, code, message) VALUES (?, 'core', 'error', ?, ?)`)
        .bind(ctx.clock.now(), `cron_${name}`, report[name]!.slice(0, 300))
        .run();
    }
  };

  await step('busy', async () => {
    // Before Outlook is connected there is nothing to read; that is a state, not an error.
    const connected = await ctx.db.prepare(`SELECT 1 FROM connections WHERE provider = 'microsoft'`).first();
    if (!connected) return 'not connected';
    await refreshBusy(ctx.db, ctx.calendar, ctx.clock.now());
    return 'ok';
  });
  await step('advance', async () => `${await driveUnfinished(ctx)} driven`);
  await step('expire', async () => `${await expireStale(ctx)} expired`);
  await step('mail', async () => `${await sendOutbox(ctx, mail)} sent`);
  await ctx.db
    .prepare(`INSERT INTO state (key, value, updated_at) VALUES ('last_cron', ?1, ?2)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(report), ctx.clock.now())
    .run();
  return report;
}

/** Re-runs the Outlook step for unfinished bookings and settles the ones it can't finish. */
export async function driveUnfinished(ctx: CoreContext, limit = 5): Promise<number> {
  const ids = await unfinished(ctx, limit);
  for (const id of ids) {
    const result = await advance(ctx, id).catch(() => 'unavailable' as const);
    const b = await getBooking(ctx.db, id);
    if (!b || b.status !== 'accepted' || b.rechecked_at !== null) continue;
    const now = ctx.clock.now();
    if (result === 'conflict') {
      // Nothing was promised yet. An approved request goes back to Tom; an instant one fails.
      if (b.decided_by) {
        await ctx.db.batch([
          ctx.db.prepare(`UPDATE bookings SET status = 'pending', decided_by = NULL, updated_at = ?2 WHERE id = ?1`).bind(id, now),
          queueMail(ctx, now, 'approval_conflict', id, 'An approved request clashes with your calendar',
            `You approved ${b.guest_name}'s request, but that time is now busy in Outlook. It is waiting again; decline it or move it.`),
        ]);
      } else {
        await ctx.db.prepare(`UPDATE bookings SET status = 'failed', reason = 'calendar_conflict', retry_key = NULL, updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
      }
    } else if (result === 'unavailable' && now - b.updated_at > 15 * MINUTE && !b.alerted_at) {
      await ctx.db.batch([
        ctx.db.prepare('UPDATE bookings SET alerted_at = ?2 WHERE id = ?1').bind(id, now),
        queueMail(ctx, now, 'stuck', id, 'A booking has been unfinished for 15 minutes',
          `The booking with ${b.guest_name} can't be checked against Outlook yet. It keeps retrying every minute.`),
      ]);
    }
  }
  return ids.length;
}

function queueMail(ctx: CoreContext, now: number, kind: string, bookingId: string | null, subject: string, body: string) {
  return ctx.db
    .prepare('INSERT INTO outbox (id, kind, booking_id, subject, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), kind, bookingId, subject, body, now, now + 3 * 24 * 60 * MINUTE);
}

/** Sends the oldest unsent mails. A failed send is retried next minute until the row expires. */
export async function sendOutbox(ctx: CoreContext, mail: MailSender, limit = 10): Promise<number> {
  const now = ctx.clock.now();
  const { results } = await ctx.db
    .prepare('SELECT id, subject, body FROM outbox WHERE sent_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT ?')
    .bind(now, limit)
    .all<{ id: string; subject: string; body: string }>();
  let sent = 0;
  for (const row of results) {
    try {
      await mail.send(row.subject, row.body);
      await ctx.db.prepare('UPDATE outbox SET sent_at = ?2, attempts = attempts + 1 WHERE id = ?1').bind(row.id, ctx.clock.now()).run();
      sent++;
    } catch {
      await ctx.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    }
  }
  return sent;
}
