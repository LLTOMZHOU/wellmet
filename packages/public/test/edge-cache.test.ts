import { describe, expect, it, vi } from 'vitest';
import { isCacheable, serveWithCache, type EdgeCache } from '../src/edge-cache.ts';

function memoryCache(): EdgeCache & { size: () => number } {
  const store = new Map<string, Response>();
  return {
    match: async (r) => store.get(r.url)?.clone(),
    put: async (r, res) => void store.set(r.url, res),
    size: () => store.size,
  };
}

function harness() {
  const cache = memoryCache();
  let now = 1_000_000;
  let version = 0;
  const pending: Promise<unknown>[] = [];
  const render = vi.fn(async (r: Request) => {
    if (r.method === 'POST') return new Response(null, { status: 303, headers: { location: '/b/x' } });
    version++;
    return new Response(`page v${version}`, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
  });
  const serve = async (url: string, init?: RequestInit) => {
    const res = await serveWithCache(new Request(`https://meet.example${url}`, init), cache, (p) => pending.push(p), render, { freshMs: 15_000, maxStaleMs: 60_000, now: () => now });
    await Promise.all(pending.splice(0));
    return res;
  };
  return { cache, render, serve, advance: (ms: number) => { now += ms; } };
}

describe('the edge cache', () => {
  it('caches only read-only pages that carry no booking token', () => {
    const get = (path: string) => new Request(`https://meet.example${path}`);
    expect(isCacheable(get('/'))).toBe(true);
    expect(isCacheable(get('/chat?date=2026-11-19'))).toBe(true);
    expect(isCacheable(get('/api/slots?type=chat'))).toBe(true);
    expect(isCacheable(get('/chat?reschedule=abc.def'))).toBe(false);
    expect(isCacheable(get('/b/abc.def'))).toBe(false);
    expect(isCacheable(get('/chat/book?start=x'))).toBe(false);
    expect(isCacheable(get('/mcp'))).toBe(false);
    expect(isCacheable(get('/healthz'))).toBe(false);
    expect(isCacheable(new Request('https://meet.example/chat', { method: 'POST' }))).toBe(false);
  });

  it('serves a fresh copy without building the page, and never lets the browser keep it', async () => {
    const h = harness();
    const first = await h.serve('/chat');
    expect(first.headers.get('x-wellmet-cache')).toBe('miss');
    h.advance(5_000);
    const second = await h.serve('/chat');
    expect(await second.text()).toBe('page v1');
    expect(second.headers.get('x-wellmet-cache')).toBe('fresh');
    expect(second.headers.get('cache-control')).toBe('no-store');
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('serves a stale copy at once and rebuilds it in the background', async () => {
    const h = harness();
    await h.serve('/chat');
    h.advance(20_000);
    const stale = await h.serve('/chat');
    expect(await stale.text()).toBe('page v1');
    expect(stale.headers.get('x-wellmet-cache')).toBe('stale');
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(await (await h.serve('/chat')).text()).toBe('page v2');
  });

  it('builds the page again when the copy is too old', async () => {
    const h = harness();
    await h.serve('/chat');
    h.advance(61_000);
    const res = await h.serve('/chat');
    expect(await res.text()).toBe('page v2');
    expect(res.headers.get('x-wellmet-cache')).toBe('miss');
  });

  it('drops cached pages here after a booking, so the visitor sees their change', async () => {
    const h = harness();
    await h.serve('/chat');
    await h.serve('/chat/book', { method: 'POST', body: 'x' });
    const after = await h.serve('/chat');
    expect(await after.text()).toBe('page v2');
    expect(after.headers.get('x-wellmet-cache')).toBe('miss');
  });

  it('keeps visitors in different timezones apart', async () => {
    const h = harness();
    await h.serve('/chat?tz=Europe/Berlin');
    const tokyo = await h.serve('/chat?tz=Asia/Tokyo');
    expect(tokyo.headers.get('x-wellmet-cache')).toBe('miss');
  });
});
