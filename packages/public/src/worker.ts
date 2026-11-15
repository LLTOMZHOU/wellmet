import { route } from './routes.ts';
import type { PublicCore } from './core.ts';

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
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, {
      core: env.CORE,
      config: { publicUrl: env.PUBLIC_URL, ownerName: env.OWNER_NAME },
      limitRead: async (key) => (await env.RL_READ.limit({ key })).success,
      limitWrite: async (key) => (await env.RL_WRITE.limit({ key })).success,
    });
  },
};
