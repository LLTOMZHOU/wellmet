import { ProviderBroken, ProviderUnavailable, type CalendarEvent, type CalendarProvider, type NewEvent } from './providers.ts';

/**
 * Tom's Outlook calendar through Microsoft Graph (personal account,
 * Calendars.ReadWrite). Times go in and out as UTC.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 20;

interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

interface GraphEvent {
  id: string;
  start: GraphDateTime;
  end: GraphDateTime;
  showAs?: string;
  isCancelled?: boolean;
  transactionId?: string | null;
}

const toGraph = (ms: number): GraphDateTime => ({ dateTime: new Date(ms).toISOString().replace('Z', ''), timeZone: 'UTC' });
/** Graph returns "2026-11-16T18:00:00.0000000" with timeZone UTC when asked for UTC. */
const fromGraph = (t: GraphDateTime): number => Date.parse(t.dateTime.endsWith('Z') ? t.dateTime : `${t.dateTime}Z`);

/** Free and working-elsewhere don't block; busy, tentative, out of office and unknown do. */
const NOT_BLOCKING = new Set(['free', 'workingElsewhere']);

export function graphCalendar(deps: { fetch: typeof fetch; token: () => Promise<string> }): CalendarProvider {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetch(path.startsWith('https://') ? path : `${GRAPH}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          prefer: 'outlook.timezone="UTC"',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      throw new ProviderUnavailable('microsoft', `Graph unreachable: ${String(err)}`);
    }
    if (res.ok) return res;
    const detail = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) throw new ProviderUnavailable('microsoft', `Graph answered ${res.status}.`);
    if (res.status === 401 || res.status === 403) throw new ProviderBroken('microsoft', `graph_${res.status}: ${detail.slice(0, 200)}`);
    throw new Error(`Graph ${init.method ?? 'GET'} ${path.split('?')[0]} failed with ${res.status}: ${detail.slice(0, 300)}`);
  }

  return {
    async listEvents(from, to) {
      const params = new URLSearchParams({
        startDateTime: new Date(from).toISOString(),
        endDateTime: new Date(to).toISOString(),
        $select: 'id,start,end,showAs,isCancelled,transactionId',
        $top: '200',
      });
      let url: string | null = `/me/calendarView?${params}`;
      const out: CalendarEvent[] = [];
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const body = (await (await call(url)).json()) as { value: GraphEvent[]; '@odata.nextLink'?: string };
        for (const e of body.value) {
          out.push({
            id: e.id,
            transactionId: e.transactionId ?? null,
            start: fromGraph(e.start),
            end: fromGraph(e.end),
            busy: !e.isCancelled && !NOT_BLOCKING.has(e.showAs ?? 'busy'),
          });
        }
        url = body['@odata.nextLink'] ?? null;
      }
      if (url) throw new ProviderUnavailable('microsoft', 'Too many events to read in one go.');
      return out;
    },

    async createEvent(e: NewEvent) {
      const res = await call('/me/events', {
        method: 'POST',
        body: JSON.stringify({
          subject: e.subject,
          body: { contentType: 'text', content: e.body },
          start: toGraph(e.start),
          end: toGraph(e.end),
          location: { displayName: e.location },
          attendees: e.attendee ? [{ type: 'required', emailAddress: { address: e.attendee.email, name: e.attendee.name } }] : [],
          transactionId: e.transactionId,
          showAs: 'busy',
          allowNewTimeProposals: false,
          isReminderOn: true,
          reminderMinutesBeforeStart: 10,
        }),
      });
      const created = (await res.json()) as { id: string };
      return { id: created.id };
    },

    async updateEvent(id, patch) {
      const body: Record<string, unknown> = {};
      if (patch.start !== undefined) body.start = toGraph(patch.start);
      if (patch.end !== undefined) body.end = toGraph(patch.end);
      if (patch.body !== undefined) body.body = { contentType: 'text', content: patch.body };
      if (patch.location !== undefined) body.location = { displayName: patch.location };
      await call(`/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    },

    async deleteEvent(id) {
      try {
        await call(`/me/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof Error && /failed with 404/.test(err.message)) return;
        throw err;
      }
    },

    async cancelEvent(id, comment) {
      // /cancel sends the attendee a cancellation; it only exists for meetings Tom organises.
      try {
        await call(`/me/events/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ comment }) });
      } catch (err) {
        if (err instanceof Error && /failed with 404/.test(err.message)) return; // already gone
        throw err;
      }
    },
  };
}
