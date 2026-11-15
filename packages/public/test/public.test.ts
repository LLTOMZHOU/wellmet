import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route, type RouteDeps } from '../src/routes.ts';
import { publicApi } from '../../core/src/api.ts';
import { createEventType } from '../../core/src/catalog.ts';
import { at, setup } from '../../core/test/support/fakes.ts';
import type { PublicCore } from '../src/core.ts';

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
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

  it('offers three tools and books through them', async () => {
    const w = await world();
    const list = (await (await w.postJson('/mcp', rpc('tools/list'))).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['list_event_types', 'find_slots', 'request_booking']);
    const found = (await (await w.postJson('/mcp', rpc('tools/call', { name: 'find_slots', arguments: { event_type: 'intro', timezone: 'Asia/Tokyo' } }))).json()) as { result: { structuredContent: { slots: { start: string }[] } } };
    const start = found.result.structuredContent.slots[0]!.start;
    const booked = (await (await w.postJson('/mcp', rpc('tools/call', { name: 'request_booking', arguments: { event_type: 'intro', start, name: 'Agent', email: 'a@example.com', timezone: 'Asia/Tokyo', retry_token: 'mcp-token-1' } }))).json()) as { result: { isError: boolean; structuredContent: { outcome: string; manage_url: string } } };
    expect(booked.result.isError).toBe(false);
    expect(booked.result.structuredContent.outcome).toBe('confirmed');
    expect(booked.result.structuredContent.manage_url).toMatch(/^https:\/\/meet\.example\/b\//);
  });

  it('publishes no sign-in metadata, so no client prompts a login', async () => {
    const w = await world();
    expect((await w.get('/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await w.get('/.well-known/oauth-authorization-server')).status).toBe(404);
  });
});

void at;
