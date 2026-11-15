import { z } from 'zod';
import { RequestBookingInput, Slug, type Caller, type Result } from '@wellmet/contracts';
import { ToolError, type McpTool } from '@wellmet/contracts/mcp';
import type { Config, PublicCore } from './core.ts';
import { validTimeZone, zoned, isoWithOffset } from './time.ts';

/**
 * The no-login MCP endpoint for visitors' assistants: three tools, rules only.
 * There is no OAuth metadata on this host, so no client will prompt a login.
 */

export const PUBLIC_INSTRUCTIONS = (c: Config) =>
  `Book time with ${c.ownerName}. Call list_event_types, then find_slots for the chosen type, then request_booking with a start copied exactly from find_slots. ` +
  'Use a random retry_token per booking and reuse it if you retry. Some types confirm instantly; others wait for approval, and the guest gets an invite once approved.';

async function value<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new ToolError(r.error.message, { code: r.error.code, ...(r.error.details ?? {}) });
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

export function publicTools(core: PublicCore, config: Config, caller: Caller): McpTool[] {
  const FindSlots = z.object({
    event_type: Slug,
    from: z.string().optional().describe('ISO-8601 start of the search window. Defaults to now.'),
    to: z.string().optional().describe('ISO-8601 end of the window. Defaults to 7 days after "from"; at most 62 days.'),
    timezone: z.string().optional().describe('IANA timezone to show local times in, e.g. "Europe/Berlin". Does not change which times exist.'),
    length_min: z.number().int().positive().optional().describe('For types with several lengths.'),
  });
  return [
    {
      name: 'list_event_types',
      title: 'List meetings',
      description: `The kinds of meeting ${config.ownerName} offers: slug, title, lengths, where, and whether booking is instant or by request.`,
      inputSchema: schema(z.object({})),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => ({ event_types: await value(core.listEventTypes()) }),
    },
    {
      name: 'find_slots',
      title: 'Find open times',
      description: 'Open start times for one meeting type. Each has "start" in UTC: pass it unchanged to request_booking.',
      inputSchema: schema(FindSlots),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (args) => {
        const a = FindSlots.safeParse(args);
        if (!a.success) throw new ToolError(a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '));
        const from = a.data.from ?? new Date().toISOString();
        const to = a.data.to ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
        const slots = await value(core.findSlots(a.data.event_type, from, to, a.data.length_min));
        const tz = validTimeZone(a.data.timezone) ? a.data.timezone : null;
        return { event_type: a.data.event_type, count: slots.length, slots: slots.map((s) => ({ ...s, ...(tz ? { local: isoWithOffset(zoned(s.start, tz)) } : {}) })) };
      },
    },
    {
      name: 'request_booking',
      title: 'Book a time',
      description: 'Book one open time for the guest. "start" must come from find_slots. Returns the outcome (confirmed, or pending if the type needs approval) and the guest\'s manage link. If the time was just taken, the error lists nearby open times.',
      inputSchema: schema(RequestBookingInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (args) => {
        const r = await value(core.requestBooking(args, caller));
        return { outcome: r.outcome, manage_url: r.manage_url, repeated: r.repeated, note: r.outcome === 'pending' ? `${config.ownerName} confirms this kind of meeting; the guest gets an invite once it's accepted.` : 'The guest gets a calendar invite by email.' };
      },
    },
  ];
}
