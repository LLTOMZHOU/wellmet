import { z } from 'zod';
import { PublicEventType, PublicSlot } from '@wellmet/contracts';
import type { Config } from './core.ts';
import { isoWithOffset, validTimeZone, zoned } from './time.ts';

/**
 * Response shapes shared by the HTTP API and the MCP tools, with the one
 * function that builds each. Both surfaces call these, so they return the
 * same thing, and the same schemas describe them in /openapi.json and in
 * the MCP tools' output schemas.
 */

export const EventTypeListing = PublicEventType.extend({
  page_url: z.string().describe('The booking page for people.'),
});

export const EventTypeList = z.object({ event_types: z.array(EventTypeListing) });
export type EventTypeList = z.infer<typeof EventTypeList>;

export const LocalSlot = PublicSlot.extend({
  local: z.string().describe('The same start in the requested timezone, ISO-8601 with its offset.'),
});

export const SlotList = z.object({
  event_type: z.string(),
  timezone: z.string().describe('The timezone "local" is in: the one asked for, or UTC.'),
  count: z.number().int(),
  slots: z.array(LocalSlot),
});
export type SlotList = z.infer<typeof SlotList>;

export const ApiError = z.object({
  error: z.object({
    code: z.string().describe('invalid_input, not_found, not_bookable, not_allowed, slot_taken, too_many_requests, calendar_unavailable or internal.'),
    message: z.string().describe('Readable; safe to show to the person.'),
    details: z.record(z.string(), z.unknown()).optional().describe('For slot_taken: nearby open times.'),
  }),
});

export function eventTypeList(config: Config, types: PublicEventType[]): EventTypeList {
  return { event_types: types.map((t) => ({ ...t, page_url: `${config.publicUrl}/${t.slug}` })) };
}

export function slotList(eventType: string, slots: PublicSlot[], timezone: string | undefined): SlotList {
  const tz = validTimeZone(timezone) ? timezone : 'UTC';
  return { event_type: eventType, timezone: tz, count: slots.length, slots: slots.map((s) => ({ ...s, local: isoWithOffset(zoned(s.start, tz)) })) };
}

/** The default search window: from now (or `from`) for 7 days. */
export function slotWindow(from: string | undefined, to: string | undefined): [string, string] {
  const start = from ?? new Date().toISOString();
  return [start, to ?? new Date(Date.parse(start) + 7 * 86_400_000).toISOString()];
}
