import { z } from 'zod';
import { Slug } from './event-type.ts';
import { TimeZone } from './schedule.ts';

/** Strips control characters and trims, so guest text can't smuggle layout or terminal codes. */
const GuestText = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim())
    .pipe(z.string().max(max));

export const RequestBookingInput = z
  .object({
    event_type: Slug,
    start: z
      .string()
      .refine((s) => /[zZ]|[+-]\d{2}:\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)), {
        message: 'Use the exact start from the list of open times: ISO-8601 with an offset, for example "2026-11-17T14:30:00-08:00".',
      })
      .describe('The start time, copied exactly from the list of open times.'),
    length_min: z.number().int().positive().optional().describe('Only for types that offer several lengths; defaults to the first.'),
    name: GuestText(100).pipe(z.string().min(1, 'Give the guest\'s name.')),
    email: z.string().trim().toLowerCase().pipe(z.email('Give a valid email address; the calendar invite goes there.')),
    timezone: TimeZone.describe('The guest\'s IANA timezone, for showing times back to them.'),
    answers: z.record(z.string(), GuestText(500)).default({}).describe('Answers to the intake questions, keyed by question id.'),
    retry_token: z
      .string()
      .min(8)
      .max(100)
      .describe('A random value you make up. If unsure whether a request went through, send it again with the same retry_token; it will not book twice.'),
  })
  .refine((b) => Object.values(b.answers).join('').length <= 2000, { message: 'Answers are too long; keep them under 2,000 characters in total.', path: ['answers'] });
export type RequestBookingInput = z.infer<typeof RequestBookingInput>;

export type BookingStatus = 'pending' | 'accepted' | 'confirmed' | 'declined' | 'expired' | 'cancelled' | 'failed';
