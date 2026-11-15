import { route } from './routes.ts';
import { DEFAULT_OPTIONS, serveWithCache, type EdgeCache } from './edge-cache.ts';
import type { PublicCore } from './core.ts';
import { robotsTxt, withNoIndex } from '@wellmet/contracts/robots';

/**
 * wellmet-public at meet.<domain>. No database, no KV, no secret: it can only
 * call the core's PublicApi. Static files (styles, fonts, copy script) are
 * served by Cloudflare from ./static before this code runs.
 */

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  CORE: PublicCore;
  RL_READ: RateLimit;
  RL_WRITE: RateLimit;
  PUBLIC_URL: string;
  OWNER_NAME: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const render = (r: Request) => route(r, {
      core: env.CORE,
      config: { publicUrl: env.PUBLIC_URL, ownerName: env.OWNER_NAME },
      limitRead: async (key) => (await env.RL_READ.limit({ key })).success,
      limitWrite: async (key) => (await env.RL_WRITE.limit({ key })).success,
    });
    if (new URL(request.url).pathname === '/robots.txt') return robotsTxt();
    // Read-only pages come from Cloudflare's cache here, refreshed in the background (edge-cache.ts).
    return withNoIndex(await serveWithCache(request, caches.default as unknown as EdgeCache, (p) => ctx.waitUntil(p), render, { ...DEFAULT_OPTIONS, now: Date.now }));
  },
};
