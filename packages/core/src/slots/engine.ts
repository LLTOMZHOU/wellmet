import { Temporal } from 'temporal-polyfill';
import type { DateOverride, EventTypeSettings, Hours, Schedule, Weekday } from '@wellmet/contracts';

/**
 * Turns an event type's rules into open start times. Pure: no I/O, no clock.
 *
 * Wall-clock times come from the schedule's timezone. Daylight saving is
 * handled by generating wall-clock starts and converting each one:
 *  - a start that falls in a spring-forward gap does not exist and is skipped;
 *  - an ambiguous start in a fall-back hour takes its first occurrence.
 * A slot must fit inside its range measured in real elapsed time.
 */

export interface Interval {
  /** Epoch milliseconds, UTC. */
  start: number;
  end: number;
}

export interface SlotQuery {
  slug: string;
  settings: EventTypeSettings;
  /** One of settings.lengths. */
  lengthMin: number;
  schedule: Schedule;
  overrides: readonly DateOverride[];
  /**
   * Time that cannot overlap a new booking's buffered interval: Tom's busy
   * Outlook time plus every committed booking, each already including that
   * booking's own buffers.
   */
  busy: readonly Interval[];
  /** Start times of committed bookings of this type, for the daily and weekly caps. */
  bookedStarts: readonly number[];
  now: number;
  /** Only slots starting in [from, to) are returned. */
  from: number;
  to: number;
}

export interface OpenSlot {
  start: number;
  end: number;
  /** YYYY-MM-DD in the schedule's timezone. */
  localDate: string;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function openSlots(q: SlotQuery): OpenSlot[] {
  const { settings, schedule } = q;
  if (!settings.lengths.includes(q.lengthMin)) {
    throw new Error(`Length ${q.lengthMin} is not offered by "${q.slug}".`);
  }
  const tz = schedule.timezone;
  const lower = Math.max(q.from, q.now + settings.min_notice_min * MINUTE);
  const upper = Math.min(q.to, q.now + settings.window_days * DAY);
  if (lower >= upper) return [];

  const perDay = countBy(q.bookedStarts, (t) => localDateOf(t, tz));
  const perWeek = countBy(q.bookedStarts, (t) => weekKeyOf(localDateOf(t, tz)));
  const length = q.lengthMin * MINUTE;
  const before = settings.buffer_before_min * MINUTE;
  const after = settings.buffer_after_min * MINUTE;

  // Walk local dates covering [lower, upper), with a day of margin either side.
  let date = Temporal.Instant.fromEpochMilliseconds(lower).toZonedDateTimeISO(tz).toPlainDate().subtract({ days: 1 });
  const lastDate = Temporal.Instant.fromEpochMilliseconds(upper).toZonedDateTimeISO(tz).toPlainDate().add({ days: 1 });

  const out: OpenSlot[] = [];
  const seen = new Set<number>();
  for (; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
    const iso = date.toString();
    if (settings.limits.per_day !== undefined && (perDay.get(iso) ?? 0) >= settings.limits.per_day) continue;
    if (settings.limits.per_week !== undefined && (perWeek.get(weekKeyOf(iso)) ?? 0) >= settings.limits.per_week) continue;

    for (const range of hoursFor(date, q)) {
      const rangeStart = toInstant(date, range.start, tz);
      const rangeEnd = toInstant(date, range.end, tz);
      const firstMin = minutesOf(range.start);
      const lastMin = minutesOf(range.end);
      for (let m = firstMin; m < lastMin; m += settings.slot_step_min) {
        const wall = Temporal.PlainTime.from({ hour: Math.floor(m / 60), minute: m % 60 });
        const zdt = date.toZonedDateTime({ timeZone: tz, plainTime: wall });
        // Skipped by a spring-forward gap: the wall time does not exist that day.
        if (!zdt.toPlainTime().equals(wall)) continue;
        const start = zdt.epochMilliseconds;
        const end = start + length;
        if (start < rangeStart || end > rangeEnd) continue;
        if (start < lower || start >= upper) continue;
        if (seen.has(start)) continue;
        const blockStart = start - before;
        const blockEnd = end + after;
        if (q.busy.some((b) => b.start < blockEnd && b.end > blockStart)) continue;
        seen.add(start);
        out.push({ start, end, localDate: iso });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The bookable hours on one date: a matching override, otherwise the weekly hours. */
export function hoursFor(date: Temporal.PlainDate, q: Pick<SlotQuery, 'slug' | 'schedule' | 'overrides'>): Hours[] {
  const iso = date.toString();
  const onDate = q.overrides.filter((o) => o.date === iso && o.schedule === q.schedule.id);
  // An override naming this type wins over one for all types.
  const override =
    onDate.find((o) => Array.isArray(o.scope) && o.scope.includes(q.slug)) ??
    onDate.find((o) => o.scope === 'all');
  if (override) return override.kind === 'closed' ? [] : override.hours;
  return q.schedule.weekly[WEEKDAYS[date.dayOfWeek - 1]!];
}

function minutesOf(wall: string): number {
  const [h, m] = wall.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** A range boundary as an instant; "24:00" is the next day's midnight. */
function toInstant(date: Temporal.PlainDate, wall: string, tz: string): number {
  if (wall === '24:00') return date.add({ days: 1 }).toZonedDateTime({ timeZone: tz }).epochMilliseconds;
  return date.toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from(wall) }).epochMilliseconds;
}

export function localDateOf(epochMs: number, tz: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(tz).toPlainDate().toString();
}

/** The Monday that starts the date's week, as YYYY-MM-DD. */
export function weekKeyOf(isoDate: string): string {
  const d = Temporal.PlainDate.from(isoDate);
  return d.subtract({ days: d.dayOfWeek - 1 }).toString();
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
