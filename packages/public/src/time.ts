import { Temporal } from 'temporal-polyfill';

/** Display helpers. Everything is shown in the visitor's timezone. */

export const zoned = (iso: string | number, tz: string) =>
  (typeof iso === 'number' ? Temporal.Instant.fromEpochMilliseconds(iso) : Temporal.Instant.from(iso)).toZonedDateTimeISO(tz);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const hhmm = (z: Temporal.ZonedDateTime) => `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
export const weekdayLong = (d: Temporal.PlainDate | Temporal.ZonedDateTime) => WEEKDAYS[d.dayOfWeek - 1]!;
export const weekdayShort = (d: Temporal.PlainDate | Temporal.ZonedDateTime) => weekdayLong(d).slice(0, 3);
export const dayMonth = (d: Temporal.PlainDate | Temporal.ZonedDateTime) => `${d.day} ${MONTHS[d.month - 1]}`;
export const monthLabel = (ym: Temporal.PlainYearMonth) => `${MONTHS[ym.month - 1]} ${ym.year}`;
export const monthShort = (ym: Temporal.PlainYearMonth) => MONTHS[ym.month - 1]!.slice(0, 3);

/** The visitor's start time as ISO with their offset, e.g. "2026-11-17T14:30:00-08:00". */
export const isoWithOffset = (z: Temporal.ZonedDateTime) => z.toString({ timeZoneName: 'never', smallestUnit: 'second' });

/** First and last instant of a month in a timezone, as epoch ms [start, end). */
export function monthBounds(ym: Temporal.PlainYearMonth, tz: string): [number, number] {
  const start = ym.toPlainDate({ day: 1 }).toZonedDateTime({ timeZone: tz }).epochMilliseconds;
  const end = ym.add({ months: 1 }).toPlainDate({ day: 1 }).toZonedDateTime({ timeZone: tz }).epochMilliseconds;
  return [start, end];
}

export function validTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TIMEZONE_CHOICES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];
