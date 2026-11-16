import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route, type RouteDeps } from '../src/routes.ts';
import { publicApi } from '../../core/src/api.ts';
import { createEventType } from '../../core/src/catalog.ts';
import { at, setup } from '../../core/test/support/fakes.ts';
import type { PublicCore } from '../src/core.ts';
import { CAN_ASK, mcpClient } from '../../../test-support/mcp-client.ts';
import { Validator } from '@cfworker/json-schema';
import { compileErrors, validate as validateOpenApi } from '@readme/openapi-parser';
import { OPERATIONS } from '../src/api.ts';

const BASE = 'https://meet.example';
const headers = { 'cf-connecting-ip': '203.0.113.7' };

async function world(options: { limited?: boolean } = {}) {
  const s = await setup();
  // The public Worker formats "now" with the system clock; pin it to the core's clock.
  vi.setSystemTime(s.clock.now());
  const deps: RouteDeps = {
    core: publicApi(s.ctx) as unknown as PublicCore,
    config: { publicUrl: BASE, ownerName: 'Tom Zhou' },
    limitRead: async () => !options.limited,
    limitWrite: async () => !options.limited,
  };
  const get = (path: string) => route(new Request(`${BASE}${path}`, { headers }), deps);
  const post = (path: string, form: Record<string, string>) =>
    route(new Request(`${BASE}${path}`, { method: 'POST', headers, body: new URLSearchParams(form) }), deps);
  const postJson = (path: string, body: unknown) =>
    route(new Request(`${BASE}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps);
  return { ...s, deps, get, post, postJson };
}

const hrefs = (html: string, pattern: RegExp) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&')).filter((h) => pattern.test(h));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('a visitor booking through the pages, with no JavaScript', () => {
  it('lists meeting types, then shows open times as plain links', async () => {
    const w = await world();
    const index = await (await w.get('/')).text();
    expect(index).toContain('Intro call');
    expect(index).toContain('<link rel="icon" href="/favicon.svg"');
    const page = await w.get('/intro?tz=America/Los_Angeles');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    const times = hrefs(html, /^\/intro\/book\?/);
    expect(times.length).toBeGreaterThan(5);
    expect(html).toContain('All open times, next 7 days');
    expect(html).toContain('meet.example/mcp');
  });

  it('puts every open day of the month on the page, so a date click needs no request', async () => {
    const w = await world();
    const html = await (await w.get('/intro?tz=America/Los_Angeles')).text();
    const shown = [...html.matchAll(/<section class="day" data-day="([0-9-]+)"[^>]*?( hidden)?>/g)];
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.filter((m) => !m[2])).toHaveLength(1);
    const linked = [...html.matchAll(/data-date="([0-9-]+)"/g)].map((m) => m[1]);
    for (const [, key] of shown) expect(linked).toContain(key);
    expect(html).toContain('/assets/days.js');
  });

  it('books from a time link, then shows the receipt; a second visitor gets nearby times', async () => {
    const w = await world();
    const html = await (await w.get('/intro?tz=America/Los_Angeles')).text();
    const link = hrefs(html, /^\/intro\/book\?/)[0]!;
    const form = await (await w.get(link)).text();
    expect(form).toContain('name="retry_token"');
    const start = new URL(`${BASE}${link}`).searchParams.get('start')!;

    const booked = await w.post(link, { start, timezone: 'America/Los_Angeles', retry_token: 'tok-aaaaaaaa', name: 'Maya', email: 'maya@example.com' });
    expect(booked.status).toBe(303);
    const receiptUrl = booked.headers.get('location')!;
    expect(receiptUrl).toMatch(/^\/b\/[^/]+\.[^/]+\?new=1$/);
    const receipt = await (await w.get(receiptUrl)).text();
    expect(receipt).toContain('Booked.');
    expect(receipt).toContain('Join the meeting');

    const second = await w.post(link, { start, timezone: 'America/Los_Angeles', retry_token: 'tok-bbbbbbbb', name: 'Sam', email: 'sam@example.com' });
    expect(second.status).toBe(409);
    const page = await second.text();
    expect(page).toContain('No longer open');
    expect(hrefs(page, /^\/intro\/book\?/).length).toBeGreaterThan(0);
  });

  it('keeps what the visitor typed when a field is wrong', async () => {
    const w = await world();
    const html = await (await w.get('/intro?tz=America/Los_Angeles')).text();
    const link = hrefs(html, /^\/intro\/book\?/)[0]!;
    const start = new URL(`${BASE}${link}`).searchParams.get('start')!;
    const res = await w.post(link, { start, timezone: 'UTC', retry_token: 't-cccccccc', name: 'Maya <b>', email: 'maya@' });
    const page = await res.text();
    expect(page).toContain('Check the email address');
    expect(page).toContain('value="Maya &lt;b&gt;"');
  });

  it('lets a guest move and then cancel from the receipt', async () => {
    const w = await world();
    const html = await (await w.get('/intro?tz=America/Los_Angeles')).text();
    const [first, , third] = hrefs(html, /^\/intro\/book\?/);
    const start = new URL(`${BASE}${first}`).searchParams.get('start')!;
    const token = (await w.post(first!, { start, timezone: 'UTC', retry_token: 't-dddddddd', name: 'Maya', email: 'maya@example.com' })).headers.get('location')!.split('/b/')[1]!.split('?')[0]!;

    const pick = await (await w.get(`/intro?reschedule=${token}&tz=America/Los_Angeles`)).text();
    expect(pick).toContain('New time for your booking');
    const moveLink = hrefs(pick, /\/reschedule\?start=/)[1]!;
    const confirm = await (await w.get(moveLink)).text();
    expect(confirm).toContain('Move your booking?');
    const newStart = new URL(`${BASE}${moveLink}`).searchParams.get('start')!;
    expect((await w.post(`/b/${token}/reschedule`, { start: newStart })).status).toBe(303);
    expect(w.calendar.live()[0]!.start).toBe(Date.parse(newStart));
    void third;

    expect((await w.post(`/b/${token}/cancel`, { reason: '' })).status).toBe(303);
    const after = await (await w.get(`/b/${token}`)).text();
    expect(after).toContain('Cancelled.');
    expect(w.calendar.live()).toHaveLength(0);
  });

  it('serves unlisted types by link only', async () => {
    const w = await world();
    await createEventType(w.db, w.clock.now(), { slug: 'friends', title: 'Friends', visibility: 'unlisted', min_notice_min: 0 });
    expect(await (await w.get('/')).text()).not.toContain('Friends');
    expect((await w.get('/friends')).status).toBe(200);
  });

  it('serves a privacy page that names the owner', async () => {
    const w = await world();
    const res = await w.get('/privacy');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Tom Zhou');
  });

  it('answers a failing core with a logged 500 page, not a crash', async () => {
    const w = await world();
    const reported: string[] = [];
    const broken = { ...w.deps, core: { ...w.deps.core, listEventTypes: async () => { throw new Error('core down'); }, reportError: async (_c: string, m: string) => { reported.push(m); return { ok: true as const, value: undefined }; } } } as RouteDeps;
    const res = await route(new Request(`${BASE}/`, { headers }), broken);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
    expect(reported[0]).toContain('core down');
  });

  it('answers a forged manage link with not found', async () => {
    const w = await world();
    expect((await w.get('/b/abc.def')).status).toBe(404);
  });
});

describe('the JSON API', () => {
  it('lists slots and books with clear status codes', async () => {
    const w = await world();
    const slots = (await (await w.get('/api/slots?type=intro&tz=Europe/Berlin')).json()) as { slots: { start: string; local: string }[] };
    expect(slots.slots.length).toBeGreaterThan(5);
    expect(slots.slots[0]!.local).toMatch(/\+01:00$/);
    const body = { event_type: 'intro', start: slots.slots[0]!.start, name: 'Agent Guest', email: 'g@example.com', timezone: 'Europe/Berlin', retry_token: 'api-token-1' };
    const created = await w.postJson('/api/bookings', body);
    expect(created.status).toBe(201);
    const repeat = await w.postJson('/api/bookings', body);
    expect(((await repeat.json()) as { repeated: boolean }).repeated).toBe(true);
    const clash = await w.postJson('/api/bookings', { ...body, retry_token: 'api-token-2', email: 'h@example.com' });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { details: { alternatives: number[] } } }).error.details.alternatives.length).toBeGreaterThan(0);
    expect((await w.postJson('/api/bookings', { event_type: 'intro' })).status).toBe(400);
  });

  it('answers 429 when a visitor is rate limited', async () => {
    const w = await world({ limited: true });
    expect((await w.get('/api/slots?type=intro')).status).toBe(429);
  });
});

describe('the no-login agent endpoint', () => {
  const agent = (w: Awaited<ReturnType<typeof world>>) => mcpClient(`${BASE}/mcp`, (r) => route(r, w.deps), headers);
  const firstSlot = async (c: ReturnType<typeof agent>, type = 'intro') =>
    (await c.legacy('tools/call', { name: 'find_slots', arguments: { event_type: type, timezone: 'Asia/Tokyo' } })).body.result.structuredContent.slots[0].start as string;

  it('offers three tools and books through them (2025 clients)', async () => {
    const w = await world();
    const c = agent(w);
    const list = await c.legacy('tools/list');
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_event_types', 'find_slots', 'request_booking']);
    const start = await firstSlot(c);
    const booked = await c.legacy('tools/call', { name: 'request_booking', arguments: { event_type: 'intro', start, name: 'Agent', email: 'a@example.com', timezone: 'Asia/Tokyo', retry_token: 'mcp-token-1' } });
    expect(booked.body.result.isError).toBe(false);
    expect(booked.body.result.structuredContent.outcome).toBe('confirmed');
    expect(booked.body.result.structuredContent.manage_url).toMatch(/^https:\/\/meet\.example\/b\//);
  });

  it('still needs a name and email from clients that cannot ask the guest', async () => {
    const w = await world();
    const c = agent(w);
    const r = await c.legacy('tools/call', { name: 'request_booking', arguments: { event_type: 'intro', start: await firstSlot(c), timezone: 'Asia/Tokyo', retry_token: 'mcp-token-2' } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/name/i);
  });

  it('asks the guest to confirm their own details when the client can show a form', async () => {
    const w = await world();
    const c = agent(w);
    const start = await firstSlot(c);
    const args = { event_type: 'intro', start, timezone: 'Asia/Tokyo', retry_token: 'mcp-token-3', name: 'Made Up' };

    const ask = await c.modern('tools/call', { name: 'request_booking', arguments: args }, CAN_ASK);
    expect(ask.body.result.resultType).toBe('input_required');
    const form = ask.body.result.inputRequests.guest.params;
    expect(form.mode).toBe('form');
    expect(form.message).toMatch(/^Book "Intro call" with Tom Zhou on .+\? Check your details\.$/);
    expect(form.requestedSchema.required).toEqual(['name', 'email']);
    expect(form.requestedSchema.properties.name.default).toBe('Made Up');
    expect(form.requestedSchema.properties.email.format).toBe('email');

    const declined = await c.modern('tools/call', { name: 'request_booking', arguments: args, inputResponses: { guest: { action: 'decline' } } }, CAN_ASK);
    expect(declined.body.result.structuredContent.outcome).toBe('not_booked');

    const done = await c.modern('tools/call', { name: 'request_booking', arguments: args, inputResponses: { guest: { action: 'accept', content: { name: 'Ada Lovelace', email: 'ada@example.com' } } } }, CAN_ASK);
    expect(done.body.result.structuredContent.outcome).toBe('confirmed');
    const token = String(done.body.result.structuredContent.manage_url).split('/b/')[1]!;
    const booking = await w.deps.core.getBooking(token);
    expect(booking.ok && booking.value).toMatchObject({ guest_name: 'Ada Lovelace' });
  });

  it('puts the intake questions on the guest form and saves the answers', async () => {
    const w = await world();
    await createEventType(w.db, w.clock.now(), {
      slug: 'advice', title: 'Advice', confirmation: 'instant', min_notice_min: 0,
      questions: [{ id: 'topic', label: 'What would you like to talk about?', required: true }, { id: 'link', label: 'Anything to read first?' }],
    });
    const c = agent(w);
    const args = { event_type: 'advice', start: await firstSlot(c, 'advice'), timezone: 'Asia/Tokyo', retry_token: 'mcp-token-5', answers: { link: 'https://example.com/deck' } };
    const ask = await c.modern('tools/call', { name: 'request_booking', arguments: args }, CAN_ASK);
    const schema = ask.body.result.inputRequests.guest.params.requestedSchema;
    expect(schema.required).toEqual(['name', 'email', 'q_topic']);
    expect(schema.properties.q_topic.title).toBe('What would you like to talk about?');
    expect(schema.properties.q_link.default).toBe('https://example.com/deck');

    const done = await c.modern('tools/call', {
      name: 'request_booking', arguments: args,
      inputResponses: { guest: { action: 'accept', content: { name: 'Ada', email: 'ada@example.com', q_topic: 'Scheduling agents' } } },
    }, CAN_ASK);
    expect(done.body.result.structuredContent.outcome).toBe('confirmed');
    const row = await w.db.prepare('SELECT answers FROM bookings WHERE guest_email = ?').bind('ada@example.com').first<{ answers: string }>();
    expect(JSON.parse(row!.answers)).toEqual({ link: 'https://example.com/deck', topic: 'Scheduling agents' });
  });

  it('asks again when the form comes back invalid', async () => {
    const w = await world();
    const c = agent(w);
    const args = { event_type: 'intro', start: await firstSlot(c), timezone: 'Asia/Tokyo', retry_token: 'mcp-token-4' };
    const bad = await c.modern('tools/call', { name: 'request_booking', arguments: args, inputResponses: { guest: { action: 'accept', content: { name: 'Ada', email: 'not-an-email' } } } }, CAN_ASK);
    expect(bad.body.result.resultType).toBe('input_required');
  });

  it('answers server/discover and refuses batches', async () => {
    const w = await world();
    const c = agent(w);
    const d = await c.modern('server/discover');
    expect(d.body.result.supportedVersions).toContain('2026-07-28');
    expect(d.body.result.instructions).toMatch(/Book time with Tom Zhou/);
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await c.raw([call, { ...call, id: 2 }], {})).status).toBe(400);
  });

  it('publishes no sign-in metadata, so no client prompts a login', async () => {
    const w = await world();
    expect((await w.get('/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await w.get('/.well-known/oauth-authorization-server')).status).toBe(404);
  });
});

describe('the published API description (/openapi.json)', () => {
  type Doc = { paths: Record<string, Record<string, { responses: Record<string, { content?: { 'application/json': { schema: object } } }> }>>; components: object };
  const docOf = async (w: Awaited<ReturnType<typeof world>>) => (await (await w.get('/openapi.json')).json()) as Doc;

  /** Checks a real response against what the document says that route returns with that status. */
  async function conforms(doc: Doc, method: string, path: string, res: Response) {
    const op = doc.paths[path]?.[method.toLowerCase()];
    expect(op, `${method} ${path} is documented`).toBeDefined();
    const documented = op!.responses[String(res.status)];
    expect(documented, `${method} ${path} documents status ${res.status}`).toBeDefined();
    const body = await res.json();
    const result = new Validator({ ...documented!.content!['application/json'].schema, components: doc.components } as never, '2020-12', false).validate(body);
    expect(result.errors, `${method} ${path} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`).toEqual([]);
    return body as Record<string, any>;
  }

  it('is a valid OpenAPI 3.1 document listing every API route', async () => {
    const w = await world();
    const res = await w.get('/openapi.json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const doc = (await res.json()) as Doc & { openapi: string; servers: { url: string }[] };
    const result = await validateOpenApi(structuredClone(doc) as never);
    expect(result.valid, result.valid ? '' : compileErrors(result)).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]!.url).toBe(BASE);
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)).sort();
    expect(documented).toEqual(OPERATIONS.map((o) => `${o.method} ${o.path}`).sort());
  });

  it('describes what every route really returns', async () => {
    const w = await world();
    const doc = await docOf(w);
    await conforms(doc, 'GET', '/api/event-types', await w.get('/api/event-types'));
    const slots = await conforms(doc, 'GET', '/api/slots', await w.get('/api/slots?event_type=intro&timezone=Asia/Tokyo'));
    expect(slots.slots[0].local).toMatch(/\+09:00$/);
    await conforms(doc, 'GET', '/api/slots', await w.get('/api/slots?type=intro&tz=Asia/Tokyo&length=30'));
    await conforms(doc, 'GET', '/api/slots', await w.get('/api/slots?type=nope'));
    await conforms(doc, 'GET', '/api/slots', await w.get('/api/slots?type=intro&length=-3'));

    const body = (start: string, n: number, type = 'intro') => ({ event_type: type, start, name: 'Ada', email: `ada${n}@example.com`, timezone: 'Asia/Tokyo', retry_token: `openapi-token-${n}` });
    const booked = await conforms(doc, 'POST', '/api/bookings', await w.postJson('/api/bookings', body(slots.slots[0].start, 1)));
    expect(booked.outcome).toBe('confirmed');
    await conforms(doc, 'POST', '/api/bookings', await w.postJson('/api/bookings', body(slots.slots[0].start, 2)));
    await conforms(doc, 'POST', '/api/bookings', await w.postJson('/api/bookings', { event_type: 'intro' }));
    const projectSlots = (await (await w.get('/api/slots?type=project')).json()) as { slots: { start: string }[] };
    const requested = await conforms(doc, 'POST', '/api/bookings', await w.postJson('/api/bookings', body(projectSlots.slots[0]!.start, 3, 'project')));
    expect(requested.outcome).toBe('pending');

    const token = booked.booking_token as string;
    await conforms(doc, 'GET', '/api/bookings/{token}', await w.get(`/api/bookings/${token}`));
    await conforms(doc, 'GET', '/api/bookings/{token}', await w.get('/api/bookings/nope.nope'));
    await conforms(doc, 'POST', '/api/bookings/{token}/reschedule', await w.postJson(`/api/bookings/${token}/reschedule`, { start: slots.slots[3].start }));
    await conforms(doc, 'POST', '/api/bookings/{token}/reschedule', await w.postJson(`/api/bookings/${token}/reschedule`, {}));
    const cancelled = await conforms(doc, 'POST', '/api/bookings/{token}/cancel', await w.postJson(`/api/bookings/${token}/cancel`, { reason: 'Clash' }));
    expect(cancelled.status).toBe('cancelled');
  });

  it('points lost callers to the description', async () => {
    const w = await world();
    const missing = await w.get('/api/nothing');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain('/openapi.json');
    expect((await w.get('/api/bookings')).status).toBe(405);
    expect((await w.get('/api/event-types')).headers.get('link')).toBe('</openapi.json>; rel="service-desc"');
  });

  it('matches what the MCP tools return', async () => {
    const w = await world();
    const doc = await docOf(w);
    const schemaFor = (path: string) => ({ ...doc.paths[path]!.get!.responses['200']!.content!['application/json'].schema, components: doc.components });
    const c = mcpClient(`${BASE}/mcp`, (r) => route(r, w.deps), headers);
    const types = await c.legacy('tools/call', { name: 'list_event_types', arguments: {} });
    expect(new Validator(schemaFor('/api/event-types') as never, '2020-12', false).validate(types.body.result.structuredContent).errors).toEqual([]);
    const slots = await c.legacy('tools/call', { name: 'find_slots', arguments: { event_type: 'intro', timezone: 'Asia/Tokyo' } });
    expect(new Validator(schemaFor('/api/slots') as never, '2020-12', false).validate(slots.body.result.structuredContent).errors).toEqual([]);
    const tools = (await c.legacy('tools/list')).body.result.tools as { name: string; outputSchema?: object }[];
    expect(tools.find((t) => t.name === 'find_slots')!.outputSchema).toBeDefined();
    // A refusal is still a readable tool error, even though the tool declares an output shape.
    const refused = await c.legacy('tools/call', { name: 'find_slots', arguments: { event_type: 'nope' } });
    expect(refused.body.result.isError).toBe(true);
  });
});

void at;
