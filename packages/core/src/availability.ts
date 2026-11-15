import { Temporal } from 'temporal-polyfill';
import { applySettingsChanges, type EventTypeSettings } from '@wellmet/contracts';
import type { Db } from './db.ts';
import { CoreError, invalid } from './errors.ts';
import { getSchedule, listOverrides, requireEventType } from './catalog.ts';
import { openSlots, type Interval, type OpenSlot } from './slots/engine.ts';
import type { CalendarProvider } from './providers.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** How long a busy snapshot is trusted before a read refreshes it (R3 allows 5 minutes). */
export const BUSY_MAX_AGE_MS = 4 * MINUTE;
/** How far ahead the snapshot covers. */
export const BUSY_HORIZON_MS = 120 * DAY;

interface BusySnapshot {
  fetchedAt: number;
  from: number;
  to: number;
  intervals: [number, number][];
}

/** Re-reads Outlook and stores only the start and end of busy events. */
export async function refreshBusy(db: Db, calendar: CalendarProvider, now: number): Promise<BusySnapshot> {
  const from = now - DAY;
  const to = now + BUSY_HORIZON_MS;
  const events = await calendar.listEvents(from, to);
  const snapshot: BusySnapshot = {
    fetchedAt: now,
    from,
    to,
    intervals: events.filter((e) => e.busy).map((e) => [e.start, e.end]),
  };
  await db
    .prepare(`INSERT INTO state (key, value, updated_at) VALUES ('busy', ?, ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(snapshot), now)
    .run();
  return snapshot;
}

/**
 * Tom's busy Outlook time. Uses the stored snapshot while it's fresh;
 * otherwise refreshes it, and if Outlook can't be read, refuses rather than
 * offering times that might clash (A2).
 */
export async function busyIntervals(db: Db, calendar: CalendarProvider, now: number): Promise<Interval[]> {
  const row = await db.prepare("SELECT value FROM state WHERE key = 'busy'").first<{ value: string }>();
  let snapshot = row ? (JSON.parse(row.value) as BusySnapshot) : null;
  if (!snapshot || now - snapshot.fetchedAt > BUSY_MAX_AGE_MS) {
    try {
      snapshot = await refreshBusy(db, calendar, now);
    } catch {
      throw new CoreError('calendar_unavailable', "Tom's calendar can't be read right now, so no times are being offered. Try again in a few minutes.");
    }
  }
  return snapshot.intervals.map(([start, end]) => ({ start, end }));
}

/** Committed bookings' buffered intervals overlapping [from, to), optionally leaving one booking out. */
async function committedBlocks(db: Db, from: number, to: number, excludeId?: string): Promise<Interval[]> {
  const { results } = await db
    .prepare(`SELECT block_start_ms AS start, block_end_ms AS end FROM bookings
              WHERE status IN ('accepted', 'confirmed') AND block_end_ms > ?1 AND block_start_ms < ?2 AND id IS NOT ?3`)
    .bind(from, to, excludeId ?? null)
    .all<Interval>();
  return results;
}

export interface FindSlotsOptions {
  slug: string;
  from: number;
  to: number;
  now: number;
  lengthMin?: number;
  /** Ignore this booking's own time, when moving it. */
  excludeBookingId?: string;
  /** Proposed changes to try without saving (preview_event_type). */
  changes?: Partial<EventTypeSettings>;
  /** Archived types normally offer nothing; previews may still look. */
  allowArchived?: boolean;
}

export async function findSlots(db: Db, calendar: CalendarProvider, o: FindSlotsOptions): Promise<OpenSlot[]> {
  const type = await requireEventType(db, o.slug);
  if (!type.active && !o.allowArchived) {
    throw new CoreError('not_bookable', `"${o.slug}" is archived and takes no bookings.`);
  }
  let settings = type.settings;
  if (o.changes) {
    const merged = applySettingsChanges(settings, o.changes);
    if (!merged.success) throw invalid(merged.error.issues);
    settings = merged.data;
  }
  const lengthMin = o.lengthMin ?? settings.lengths[0]!;
  if (!settings.lengths.includes(lengthMin)) {
    throw new CoreError('invalid_input', `"${o.slug}" offers ${settings.lengths.join(', ')} minute meetings, not ${lengthMin}.`);
  }
  const schedule = await getSchedule(db, settings.schedule);
  const tz = schedule.timezone;
  const dateOf = (t: number) => Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(tz).toPlainDate();
  const overrides = await listOverrides(db, dateOf(o.from - DAY).toString(), dateOf(o.to + DAY).toString(), schedule.id);

  const margin = (settings.buffer_before_min + settings.buffer_after_min + 480) * MINUTE;
  const [outlook, committed] = await Promise.all([
    busyIntervals(db, calendar, o.now),
    committedBlocks(db, o.from - margin, o.to + margin, o.excludeBookingId),
  ]);
  const { results: booked } = await db
    .prepare(`SELECT start_ms FROM bookings WHERE event_type = ?1 AND status IN ('accepted', 'confirmed')
              AND start_ms >= ?2 AND start_ms < ?3 AND id IS NOT ?4`)
    .bind(o.slug, o.from - 8 * DAY, o.to + 8 * DAY, o.excludeBookingId ?? null)
    .all<{ start_ms: number }>();

  return openSlots({
    slug: o.slug,
    settings,
    lengthMin,
    schedule,
    overrides,
    busy: [...outlook, ...committed],
    bookedStarts: booked.map((b) => b.start_ms),
    now: o.now,
    from: o.from,
    to: o.to,
  });
}
