import { z } from 'zod';
import { FindSlotsInput, GuestBooking, RequestBookingInput, RequestResult, type Caller, type Result } from '@wellmet/contracts';
import { STATUS, type Config, type PublicCore } from './core.ts';
import { ApiError, EventTypeList, SlotList, eventTypeList, slotList, slotWindow } from './shapes.ts';

/**
 * The JSON API under /api, as one table. The router dispatches from it and
 * /openapi.json is generated from it, so a route can't exist without being
 * documented, and its documented inputs are the schemas it actually parses.
 * Tests check every response against the published document.
 */

export const API_VERSION = '1.0.0';

export interface ApiDeps {
  core: PublicCore;
  config: Config;
  caller: (via: 'api') => Caller;
}

/** `{token}` in a path template becomes `{ token: string }`. */
type PathParams<P extends string> = P extends `${string}{${infer Name}}${infer Rest}` ? { [K in Name]: string } & PathParams<Rest> : {};

/** What a route's `run` receives: its path parameters, and its query and body already checked against its schemas. */
interface RunInput<P extends string, Q extends z.ZodObject | undefined, B extends z.ZodType | undefined> {
  params: PathParams<P>;
  query: Q extends z.ZodObject ? z.output<Q> : undefined;
  body: B extends z.ZodType ? z.output<B> : undefined;
}

interface OperationDef<P extends string, Q extends z.ZodObject | undefined, B extends z.ZodType | undefined> {
  method: 'GET' | 'POST';
  /** OpenAPI path template, e.g. /api/bookings/{token}. */
  path: P;
  operationId: string;
  summary: string;
  description: string;
  query?: Q;
  /** Short names accepted in the query for documented ones (not published). */
  aliases?: Record<string, string>;
  body?: B;
  /** Success responses by status. */
  ok: Record<number, { description: string; schema: z.ZodType }>;
  /** Error statuses this route can answer, besides 413, 429 and 500 which any can. */
  errors: number[];
  run(input: RunInput<P, Q, B>, deps: ApiDeps): Promise<Response>;
}

/** A route with its own types erased, so routes of different shapes fit in one table. */
export type Operation = OperationDef<string, z.ZodObject | undefined, z.ZodType | undefined>;

/**
 * Keeps each route's parameter, query and body types while building the
 * table, so `run` is checked against the route's own schemas (as
 * defineTool does for MCP tools).
 */
function defineOperation<P extends string, Q extends z.ZodObject | undefined = undefined, B extends z.ZodType | undefined = undefined>(
  op: OperationDef<P, Q, B>,
): Operation {
  return op as unknown as Operation;
}

const TOKEN = '[A-Za-z0-9-]+\\.[A-Za-z0-9_-]+';
const PARAMS: Record<string, { pattern: string; description: string }> = {
  token: { pattern: TOKEN, description: 'The booking_token from the booking\'s result. It is the guest\'s private key to the booking.' },
};

/** Query strings carry text; numbers are converted before checking. */
const SlotsQuery = FindSlotsInput.extend({
  length_min: z.coerce.number().int().positive().optional().describe('For types with several lengths.'),
});
const CancelBody = z.object({ reason: z.string().max(300).optional().describe('Passed on to the host.') });
const RescheduleBody = z.object({ start: z.string().describe('A new start copied exactly from GET /api/slots.') });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', link: '</openapi.json>; rel="service-desc"' } });
}

function reply<T>(r: Result<T>, status = 200, shape: (v: T) => unknown = (v) => v): Response {
  return r.ok ? json(shape(r.value), status) : json({ error: r.error }, STATUS[r.error.code] ?? 500);
}

export const OPERATIONS: Operation[] = [
  defineOperation({
    method: 'GET', path: '/api/event-types', operationId: 'listEventTypes',
    summary: 'List meeting types',
    description: 'The kinds of meeting on offer: title, lengths, where, intake questions, and whether booking is instant or by request.',
    ok: { 200: { description: 'Every listed meeting type.', schema: EventTypeList } },
    errors: [],
    run: async (_i, d) => reply(await d.core.listEventTypes(), 200, (types) => eventTypeList(d.config, types)),
  }),
  defineOperation({
    method: 'GET', path: '/api/slots', operationId: 'findSlots',
    summary: 'Find open times',
    description: 'Open start times for one meeting type in a window (7 days by default, at most 62). Each "start" is UTC: send it back unchanged when booking. Same as the MCP tool find_slots.',
    query: SlotsQuery,
    aliases: { type: 'event_type', tz: 'timezone', length: 'length_min' },
    ok: { 200: { description: 'Open times, soonest first.', schema: SlotList } },
    errors: [400, 404],
    run: async ({ query }, d) => {
      const [from, to] = slotWindow(query.from, query.to);
      return reply(await d.core.findSlots(query.event_type, from, to, query.length_min), 200, (slots) => slotList(query.event_type, slots, query.timezone));
    },
  }),
  defineOperation({
    method: 'POST', path: '/api/bookings', operationId: 'requestBooking',
    summary: 'Book a time',
    description: 'Books one open time, or asks the host when the type needs approval. Send a random retry_token; repeating a call with the same one never books twice. Same as the MCP tool request_booking.',
    body: RequestBookingInput,
    ok: {
      201: { description: 'Booked: the time is held and the invite follows.', schema: RequestResult },
      202: { description: 'Requested: waiting for the host\'s approval. Nothing is held until then.', schema: RequestResult },
    },
    errors: [400, 404, 409, 503],
    run: async ({ body }, d) => {
      const r = await d.core.requestBooking(body, d.caller('api'));
      return r.ok ? json(r.value, r.value.outcome === 'pending' ? 202 : 201) : reply(r);
    },
  }),
  defineOperation({
    method: 'GET', path: '/api/bookings/{token}', operationId: 'getBooking',
    summary: 'Get a booking',
    description: 'The booking\'s status, time, place and what the guest can still change.',
    ok: { 200: { description: 'The booking.', schema: GuestBooking } },
    errors: [404],
    run: async ({ params }, d) => reply(await d.core.getBooking(params.token)),
  }),
  defineOperation({
    method: 'POST', path: '/api/bookings/{token}/cancel', operationId: 'cancelBooking',
    summary: 'Cancel a booking',
    description: 'Cancels the booking. The guest and host are told.',
    body: CancelBody,
    ok: { 200: { description: 'The booking, now cancelled.', schema: GuestBooking } },
    errors: [400, 403, 404],
    run: async ({ params, body }, d) => reply(await d.core.cancelBooking(params.token, body.reason)),
  }),
  defineOperation({
    method: 'POST', path: '/api/bookings/{token}/reschedule', operationId: 'rescheduleBooking',
    summary: 'Move a booking',
    description: 'Moves the booking to another open time of the same type. A guest can move a booking a limited number of times (see reschedules_left).',
    body: RescheduleBody,
    ok: { 200: { description: 'The booking at its new time.', schema: GuestBooking } },
    errors: [400, 403, 404, 409],
    run: async ({ params, body }, d) => reply(await d.core.rescheduleBooking(params.token, body.start)),
  }),
];

// --- Dispatch ----------------------------------------------------------------------------

const matchers = OPERATIONS.map((op) => {
  const names: string[] = [];
  const source = op.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    names.push(name);
    return `(${PARAMS[name]!.pattern})`;
  });
  return { op, names, regex: new RegExp(`^${source}$`) };
});

/** The same message and details the core gives for invalid input. */
function invalid(error: z.ZodError | string): Response {
  if (typeof error === 'string') return json({ error: { code: 'invalid_input', message: error } }, 400);
  const lines = error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message));
  return json({ error: { code: 'invalid_input', message: lines.join(' '), details: { issues: lines } } }, 400);
}

export async function serveApi(request: Request, path: string, deps: ApiDeps): Promise<Response> {
  const found = matchers.filter((m) => m.regex.test(path));
  const hit = found.find((m) => m.op.method === request.method);
  if (!hit) {
    if (found.length) return json({ error: { code: 'not_found', message: `Use ${found.map((m) => m.op.method).join(' or ')} here.` } }, 405);
    return json({ error: { code: 'not_found', message: 'No such API route. The full description is at /openapi.json.' } }, 404);
  }
  const { op } = hit;
  const values = hit.regex.exec(path)!.slice(1);
  const params = Object.fromEntries(hit.names.map((n, i) => [n, values[i]!]));

  // Parsed below with this route's own schema; the table entry's `run` sees its exact type.
  let query: Record<string, unknown> | undefined;
  if (op.query) {
    const raw: Record<string, string> = {};
    for (const [k, v] of new URL(request.url).searchParams) raw[op.aliases?.[k] ?? k] ??= v;
    const parsed = op.query.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    query = parsed.data;
  }

  let body: unknown;
  if (op.body) {
    const text = await request.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return invalid('Send a JSON body.');
    }
    // The core checks booking requests again, against the same schema.
    const parsed = op.body.safeParse(body);
    if (!parsed.success) return invalid(parsed.error);
    body = parsed.data;
  }
  return op.run({ query, body, params }, deps);
}

// --- OpenAPI -----------------------------------------------------------------------------

const ERROR_TEXT: Record<number, string> = {
  400: 'The input was not valid; the message says what to fix.',
  403: 'Not allowed for this booking any more.',
  404: 'No such meeting type or booking.',
  409: 'The time was just taken. details.alternatives lists nearby open times.',
  413: 'Request too large.',
  429: 'Too many requests from here. Try again in a minute.',
  500: 'Something went wrong on the server.',
  503: 'The host\'s calendar could not be checked. Try again shortly.',
};

/** The OpenAPI 3.1 description of the API, built from OPERATIONS. */
export function openApiDocument(config: Config): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  const named: [z.ZodType, string][] = [
    [EventTypeList, 'EventTypeList'], [SlotList, 'SlotList'], [RequestBookingInput, 'BookingRequest'],
    [RequestResult, 'BookingResult'], [GuestBooking, 'Booking'], [CancelBody, 'CancelRequest'],
    [RescheduleBody, 'RescheduleRequest'], [ApiError, 'Error'],
  ];
  for (const [schema, id] of named) registry.add(schema, { id });
  const ref = (s: z.ZodType) => ({ $ref: `#/components/schemas/${registry.get(s)!.id}` });
  // Request bodies are described as accepted (defaults optional); responses as sent.
  const schemas = {
    ...clean(z.toJSONSchema(registry, { io: 'input', uri: (id) => `#/components/schemas/${id}`, unrepresentable: 'any' }).schemas, ['BookingRequest', 'CancelRequest', 'RescheduleRequest']),
    ...clean(z.toJSONSchema(registry, { io: 'output', uri: (id) => `#/components/schemas/${id}`, unrepresentable: 'any' }).schemas, ['EventTypeList', 'SlotList', 'BookingResult', 'Booking', 'Error']),
  };

  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const parameters: unknown[] = [];
    for (const name of op.path.match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
      parameters.push({ name, in: 'path', required: true, description: PARAMS[name]!.description, schema: { type: 'string', pattern: `^${PARAMS[name]!.pattern}$` } });
    }
    if (op.query) {
      const q = strip(z.toJSONSchema(op.query, { io: 'input', unrepresentable: 'any' })) as { properties: Record<string, { description?: string }>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties)) {
        const { description, ...rest } = schema;
        parameters.push({ name, in: 'query', required: q.required?.includes(name) ?? false, ...(description ? { description } : {}), schema: rest });
      }
    }
    const responses: Record<string, unknown> = {};
    for (const [status, r] of Object.entries(op.ok)) responses[status] = { description: r.description, content: { 'application/json': { schema: ref(r.schema) } } };
    for (const status of [...op.errors, 413, 429, 500]) responses[status] = { description: ERROR_TEXT[status], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
    (paths[op.path] ??= {})[op.method.toLowerCase()] = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(op.body) } } } } : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `Book time with ${config.ownerName}`,
      version: API_VERSION,
      description: `Find an open time with ${config.ownerName} and book it. No sign-in or key is needed. ` +
        `The same operations are offered over MCP at ${config.publicUrl}/mcp, and as web pages at ${config.publicUrl}.`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: config.publicUrl }],
    paths,
    components: { schemas },
  };
}

/** Drops each schema's own `$schema` and `$id`; inside OpenAPI they are implied. */
function clean(all: Record<string, unknown>, keep: string[]): Record<string, unknown> {
  return Object.fromEntries(keep.map((id) => [id, strip(all[id] as Record<string, unknown>)]));
}

function strip(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}
