import { z } from 'zod';
import { RequestBookingInput, Slug, type Caller, type PublicEventType } from '@wellmet/contracts';
import { buildServer, canElicit, defineTool, inputRequired, userAnswer, value, type McpServer } from '@wellmet/contracts/mcp';
import type { Config, PublicCore } from './core.ts';
import { validTimeZone, zoned, isoWithOffset } from './time.ts';

/**
 * The no-login MCP endpoint for visitors' assistants: three tools, rules only.
 * There is no OAuth metadata on this host, so no client will prompt a login.
 */

export const PUBLIC_INSTRUCTIONS = (c: Config) =>
  `Book time with ${c.ownerName}. Call list_event_types, then find_slots for the chosen type, then request_booking with a start copied exactly from find_slots. ` +
  'Use a random retry_token per booking and reuse it if you retry. Some types confirm instantly; others wait for approval, and the guest gets an invite once approved.';

const FindSlots = z.object({
  event_type: Slug,
  from: z.string().optional().describe('ISO-8601 start of the search window. Defaults to now.'),
  to: z.string().optional().describe('ISO-8601 end of the window. Defaults to 7 days after "from"; at most 62 days.'),
  timezone: z.string().optional().describe('IANA timezone to show local times in, e.g. "Europe/Berlin". Does not change which times exist.'),
  length_min: z.number().int().positive().optional().describe('For types with several lengths.'),
});

/**
 * The booking input as the assistant sees it. Name and email may be left out
 * when the client can show the guest a form: the guest then types them
 * (and any intake answers) themselves. Everything is checked again, exactly,
 * against RequestBookingInput in the core.
 */
const BookingArgs = z.object({
  ...RequestBookingInput.shape,
  name: RequestBookingInput.shape.name.optional().describe('The guest\'s name. Required unless your client can show the guest a form, in which case the guest is asked.'),
  email: z.string().optional().describe('The guest\'s email; the calendar invite goes there. Required unless your client can show the guest a form, in which case the guest is asked.'),
});

const GUEST = 'guest';

export function publicServer(core: PublicCore, config: Config, caller: Caller, onError?: (err: unknown) => void): McpServer {
  const info = { name: 'wellmet-public', title: `Book time with ${config.ownerName}`, version: '2.0.0', instructions: PUBLIC_INSTRUCTIONS(config) };
  return buildServer(info, [
    defineTool({
      name: 'list_event_types',
      title: 'List meetings',
      description: `The kinds of meeting ${config.ownerName} offers: slug, title, lengths, where, and whether booking is instant or by request.`,
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => ({ event_types: await value(core.listEventTypes()) }),
    }),
    defineTool({
      name: 'find_slots',
      title: 'Find open times',
      description: 'Open start times for one meeting type. Each has "start" in UTC: pass it unchanged to request_booking.',
      input: FindSlots,
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a) => {
        const from = a.from ?? new Date().toISOString();
        const to = a.to ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
        const slots = await value(core.findSlots(a.event_type, from, to, a.length_min));
        const tz = validTimeZone(a.timezone) ? a.timezone : null;
        return { event_type: a.event_type, count: slots.length, slots: slots.map((s) => ({ ...s, ...(tz ? { local: isoWithOffset(zoned(s.start, tz)) } : {}) })) };
      },
    }),
    defineTool({
      name: 'request_booking',
      title: 'Book a time',
      description: 'Book one open time for the guest. "start" must come from find_slots. If your client can show the guest a form, the guest is asked to confirm their name, email and any intake answers before anything is booked. ' +
        'Returns the outcome (confirmed, or pending if the type needs approval) and the guest\'s manage link. If the time was just taken, the error lists nearby open times.',
      input: BookingArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a, ctx) => {
        let booking: Record<string, unknown> = a;
        if (canElicit(ctx, 'form')) {
          const type = await value(core.getEventType(a.event_type));
          const answer = userAnswer(ctx, GUEST, guestForm(type).schema);
          if (!answer) return inputRequired({ inputRequests: { [GUEST]: guestRequest(type, a, config) } });
          if (answer.action !== 'accept') return { outcome: 'not_booked', note: 'The guest did not confirm, so nothing was booked.' };
          booking = { ...a, ...guestForm(type).merge(answer.content, a.answers) };
        }
        const r = await value(core.requestBooking(booking, caller));
        return { outcome: r.outcome, manage_url: r.manage_url, repeated: r.repeated, note: r.outcome === 'pending' ? `${config.ownerName} confirms this kind of meeting; the guest gets an invite once it's accepted.` : 'The guest gets a calendar invite by email.' };
      },
    }),
  ], onError);
}

/**
 * The form the guest fills in: name, email, and one field per intake
 * question (`q_<id>`), each pre-filled with what the assistant sent.
 */
function guestForm(type: PublicEventType) {
  const fields: Record<string, z.ZodType> = {
    name: z.string().trim().min(1).max(100),
    email: z.email(),
  };
  for (const q of type.questions) fields[`q_${q.id}`] = q.required ? z.string().trim().min(1).max(500) : z.string().max(500).optional();
  return {
    schema: z.object(fields) as z.ZodType<Record<string, string | undefined>>,
    merge(content: Record<string, string | undefined>, earlier: Record<string, string>) {
      const answers = { ...earlier };
      for (const q of type.questions) {
        const v = content[`q_${q.id}`];
        if (v) answers[q.id] = v;
      }
      return { name: content.name, email: content.email, answers };
    },
  };
}

function guestRequest(type: PublicEventType, a: z.output<typeof BookingArgs>, config: Config) {
  const properties: Record<string, Record<string, unknown>> = {
    name: { type: 'string', title: 'Your name', minLength: 1, maxLength: 100, ...(a.name ? { default: a.name } : {}) },
    email: { type: 'string', format: 'email', title: 'Your email', description: 'The calendar invite goes here.', ...(a.email ? { default: a.email } : {}) },
  };
  const required = ['name', 'email'];
  for (const q of type.questions) {
    const earlier = a.answers[q.id];
    properties[`q_${q.id}`] = { type: 'string', title: q.label, maxLength: 500, ...(earlier ? { default: earlier } : {}) };
    if (q.required) required.push(`q_${q.id}`);
  }
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: validTimeZone(a.timezone) ? a.timezone : 'UTC' }).format(new Date(a.start));
  const how = type.confirmation === 'approval' ? ` ${config.ownerName} confirms each request; the invite follows once it's accepted.` : '';
  return inputRequired.elicit({
    mode: 'form',
    message: `Book "${type.title}" with ${config.ownerName} on ${when}? Check your details.${how}`,
    requestedSchema: { type: 'object', properties, required } as never,
  });
}
