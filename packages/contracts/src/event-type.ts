import { z } from 'zod';

/**
 * The single definition of an event type. The owner MCP tools' input schemas
 * and descriptions are generated from this, and the core validates against it,
 * so adding a setting here is the whole change.
 */

/** Paths the public site serves itself; an event type there would be unreachable. */
const RESERVED_SLUGS = new Set(['api', 'mcp', 'healthz', 'privacy', 'assets']);

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Use 2 to 40 lowercase letters, digits and hyphens, for example "intro" or "project-call".')
  .refine((s) => !RESERVED_SLUGS.has(s), 'That address is used by the site itself; pick another.')
  .describe('The page address: meet.<domain>/<slug>.');

const Minutes = (max: number) => z.number().int().min(0).max(max);

export const Question = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,30}$/, 'Lowercase letters, digits and underscores.'),
    label: z.string().min(1).max(200),
    required: z.boolean().default(false),
    multiline: z.boolean().default(false),
  })
  .describe('An intake question shown on the confirm form.');
export type Question = z.infer<typeof Question>;

export const Location = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('google_meet').describe('A new Google Meet room is created for each booking.') }),
    z.object({
      kind: z.literal('phone').describe('The guest calls Tom. There are no types where Tom calls the guest.'),
      number: z.string().min(5).max(40).describe('Tom\'s number, as it should appear in the invite.'),
    }),
    z.object({
      kind: z.literal('in_person'),
      address: z.string().min(3).max(300).describe('Where to meet, as it should appear in the invite.'),
    }),
  ])
  .describe('Where the meeting happens.');
export type Location = z.infer<typeof Location>;

const settingsShape = {
  title: z.string().min(1).max(80).describe('Shown to visitors, for example "Intro call".'),
  description: z.string().max(500).default('').describe('One short paragraph shown on the booking page.'),
  lengths: z
    .array(z.number().int().min(5).max(480))
    .min(1)
    .max(4)
    .default([30])
    .refine((l) => new Set(l).size === l.length, { message: 'Each length can appear once.' })
    .describe('Meeting lengths in minutes. With several, the visitor picks one.'),
  slot_step_min: z.number().int().min(5).max(240).default(30).describe('How often start times are offered, in minutes.'),
  buffer_before_min: Minutes(240).default(0).describe('Minutes kept free before each booking.'),
  buffer_after_min: Minutes(240).default(0).describe('Minutes kept free after each booking.'),
  min_notice_min: Minutes(60 * 24 * 30).default(240).describe('How soon a booking can start, in minutes from now.'),
  window_days: z.number().int().min(1).max(365).default(30).describe('How many days ahead can be booked.'),
  limits: z
    .object({
      per_day: z.number().int().min(1).max(50).optional().describe('Most bookings of this type on one day.'),
      per_week: z.number().int().min(1).max(200).optional().describe('Most bookings of this type in one week, Monday to Sunday.'),
    })
    .default({})
    .describe('Caps for this type. Leave out for no cap.'),
  schedule: z.string().default('default').describe('Id of the named schedule whose hours this type uses.'),
  confirmation: z.enum(['instant', 'approval']).default('approval').describe('"instant" books straight away; "approval" waits for Tom.'),
  questions: z.array(Question).max(10).default([]).describe('Intake questions on the confirm form.'),
  location: Location.default({ kind: 'google_meet' }),
  visibility: z.enum(['listed', 'unlisted']).default('listed').describe('"unlisted" types are reachable only by their link.'),
};

export const EventTypeSettings = z
  .object(settingsShape)
  .superRefine((s, ctx) => {
    const ids = s.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Each question needs a different id.' });
    }
    if (s.limits.per_day && s.limits.per_week && s.limits.per_day > s.limits.per_week) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'per_day'], message: 'A daily cap above the weekly cap has no effect.' });
    }
  });
export type EventTypeSettings = z.infer<typeof EventTypeSettings>;

export const EventType = z.object({
  slug: Slug,
  active: z.boolean().default(true),
  settings: EventTypeSettings,
});
export type EventType = z.infer<typeof EventType>;

// --- Owner tool inputs ----------------------------------------------------------

/** create_event_type: slug and title are required; everything else has a default. */
export const CreateEventTypeInput = z
  .object({ slug: Slug, ...settingsShape })
  .describe('Create a new kind of meeting. Only slug and title are required; every other setting has a sensible default.');

/** update_event_type: change only the fields given. */
export const UpdateEventTypeInput = z
  .object({
    slug: Slug.describe('The type to change.'),
    changes: z
      .object(Object.fromEntries(Object.entries(settingsShape).map(([k, v]) => [k, v.optional()])) as {
        [K in keyof typeof settingsShape]: z.ZodOptional<(typeof settingsShape)[K]>;
      })
      .describe('Only the settings to change. Anything left out stays as it is.'),
  })
  .describe('Change some settings of an existing type, leaving the rest alone.');

export const DuplicateEventTypeInput = z
  .object({
    from: Slug.describe('The type to copy.'),
    slug: Slug.describe('The new type\'s page address.'),
    changes: UpdateEventTypeInput.shape.changes.optional(),
  })
  .describe('Copy an existing type as a starting point, optionally changing some settings.');

/**
 * Applies partial changes to stored settings and re-validates the result as a
 * whole, so cross-field rules (such as daily cap versus weekly cap) still hold.
 */
export function applySettingsChanges(current: EventTypeSettings, changes: Partial<EventTypeSettings>) {
  const merged = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
  return EventTypeSettings.safeParse(merged);
}
