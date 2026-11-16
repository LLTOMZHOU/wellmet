/**
 * Stale-while-revalidate for read-only public pages, kept in Cloudflare's
 * cache at the visitor's location.
 *
 * - A copy younger than `freshMs` is served as is.
 * - An older copy is served at once and rebuilt in the background.
 * - A copy older than `maxStaleMs` is not used; the page is built now.
 *
 * Showing slightly old open times is safe: a booking is checked again when
 * it is confirmed, and a taken time gets "No longer open" with nearby times.
 * A booking, cancellation or move made through this Worker bumps a generation
 * number in the same location's cache, so the person who just acted never
 * sees their own change missing.
 *
 * Never cached: anything but GET, booking links (/b/…), the confirm form,
 * rescheduling pages (their URL carries a booking token), the agent endpoint
 * and health checks.
 */

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface EdgeCacheOptions {
  freshMs: number;
  maxStaleMs: number;
  now: () => number;
}

export const DEFAULT_OPTIONS: Omit<EdgeCacheOptions, 'now'> = { freshMs: 15_000, maxStaleMs: 60_000 };

const ORIGIN = 'https://edge-cache.wellmet.internal';
const GEN_KEY = new Request(`${ORIGIN}/__generation`);
const STORED_AT = 'x-wellmet-stored-at';

const TYPE_PAGE = /^\/[a-z0-9][a-z0-9-]{1,39}$/;
const NEVER = new Set(['/mcp', '/healthz']);

/** Whether this request may be answered from the cache. */
export function isCacheable(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (NEVER.has(path)) return false;
  if (url.searchParams.has('reschedule')) return false;
  return path === '/' || path === '/api/event-types' || path === '/api/slots' || TYPE_PAGE.test(path);
}

/** Whether a successful request changed bookings, so cached pages here are out of date. */
export function changesBookings(request: Request, response: Response): boolean {
  return request.method === 'POST' && response.status < 400 && new URL(request.url).pathname !== '/mcp';
}

function keyFor(request: Request, generation: string): Request {
  const url = new URL(request.url);
  const query = new URLSearchParams([...url.searchParams].sort(([a], [b]) => a.localeCompare(b)));
  // Pages without ?tz= (or the API's ?timezone=) use the visitor's own timezone, so it is part of the key.
  if (!query.has('tz') && !query.has('timezone')) {
    const tz = (request as Request & { cf?: { timezone?: string } }).cf?.timezone;
    if (tz) query.set('cf-tz', tz);
  }
  query.set('gen', generation);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return new Request(`${ORIGIN}${path}?${query.toString()}`);
}

async function generation(cache: EdgeCache): Promise<string> {
  const hit = await cache.match(GEN_KEY);
  return hit ? await hit.text() : '0';
}

export async function bumpGeneration(cache: EdgeCache, now: number): Promise<void> {
  await cache.put(GEN_KEY, new Response(String(now), { headers: { 'cache-control': 'public, s-maxage=86400' } }));
}

async function store(cache: EdgeCache, key: Request, response: Response, options: EdgeCacheOptions): Promise<void> {
  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, s-maxage=${Math.ceil(options.maxStaleMs / 1000)}`);
  headers.set(STORED_AT, String(options.now()));
  await cache.put(key, new Response(await response.arrayBuffer(), { status: response.status, headers }));
}

/** What the visitor's browser gets: never cached there, with a note on where it came from. */
function toBrowser(response: Response, state: 'fresh' | 'stale' | 'miss', ageMs: number): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.delete(STORED_AT);
  headers.set('x-wellmet-cache', state);
  headers.set('age', String(Math.floor(ageMs / 1000)));
  return new Response(response.body, { status: response.status, headers });
}

export async function serveWithCache(
  request: Request,
  cache: EdgeCache,
  waitUntil: (promise: Promise<unknown>) => void,
  render: (request: Request) => Promise<Response>,
  options: EdgeCacheOptions,
): Promise<Response> {
  if (!isCacheable(request)) {
    const response = await render(request);
    if (changesBookings(request, response)) waitUntil(bumpGeneration(cache, options.now()).catch(() => undefined));
    return response;
  }

  const key = keyFor(request, await generation(cache));
  const hit = await cache.match(key);
  const age = hit ? options.now() - Number(hit.headers.get(STORED_AT) ?? 0) : Infinity;

  if (hit && age <= options.maxStaleMs) {
    if (age > options.freshMs) {
      waitUntil((async () => {
        const fresh = await render(request.clone());
        if (fresh.status === 200) await store(cache, key, fresh, options);
      })().catch(() => undefined));
      return toBrowser(hit, 'stale', age);
    }
    return toBrowser(hit, 'fresh', age);
  }

  const response = await render(request);
  if (response.status !== 200) return response;
  waitUntil(store(cache, key, response.clone(), options).catch(() => undefined));
  return toBrowser(response, 'miss', 0);
}
