import { z } from 'zod';

/** "09:00", 24-hour wall-clock time. "24:00" is allowed as an end. */
export const WallTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use 24-hour HH:MM, for example "09:00" or "17:30".')
  .describe('24-hour wall-clock time, HH:MM.');

export const Hours = z
  .object({ start: WallTime, end: WallTime })
  .refine((h) => h.start < h.end, { message: 'Each range must end after it starts.' })
  .describe('One range of bookable hours within a day.');
export type Hours = z.infer<typeof Hours>;

const DayHours = z
  .array(Hours)
  .max(6)
  .default([])
  .refine(noOverlap, { message: 'Ranges on the same day must not overlap.' });

function noOverlap(ranges: Hours[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  return sorted.every((r, i) => i === 0 || sorted[i - 1]!.end <= r.start);
}

/** A valid IANA timezone, checked against the runtime's own list. */
export const TimeZone = z
  .string()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, { message: 'Use an IANA timezone name, for example "America/Los_Angeles".' })
  .describe('IANA timezone name, for example "America/Los_Angeles".');

export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof Weekday>;

export const Schedule = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Lowercase letters, digits and hyphens.').describe('Short id types refer to, such as "default" or "deep-work".'),
    name: z.string().min(1).max(80).describe('A name for Tom, such as "Weekdays" or "Deep work days".'),
    timezone: TimeZone,
    weekly: z
      .object({
        mon: DayHours, tue: DayHours, wed: DayHours, thu: DayHours, fri: DayHours, sat: DayHours, sun: DayHours,
      })
      .describe('Bookable hours for each weekday, in the schedule\'s timezone. An empty list means closed.'),
  })
  .describe('Named weekly hours that any number of event types can share.');
export type Schedule = z.infer<typeof Schedule>;

export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .describe('A calendar date, YYYY-MM-DD, in the schedule\'s timezone.');

export const DateOverride = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('closed').describe('Nothing can be booked on this date.'),
      date: LocalDate,
      schedule: z.string().default('default'),
      scope: z.union([z.literal('all'), z.array(z.string()).min(1)]).default('all'),
      note: z.string().max(200).optional(),
    }),
    z.object({
      kind: z.literal('open').describe('Use these hours on this date instead of the weekly hours.'),
      date: LocalDate,
      schedule: z.string().default('default'),
      scope: z.union([z.literal('all'), z.array(z.string()).min(1)]).default('all'),
      hours: z.array(Hours).min(1).max(6).refine(noOverlap, { message: 'Ranges must not overlap.' }),
      note: z.string().max(200).optional(),
    }),
  ])
  .describe('An exception for one date: closed all day, or open with different hours. Scope is "all" or a list of event-type slugs.');
export type DateOverride = z.infer<typeof DateOverride>;
