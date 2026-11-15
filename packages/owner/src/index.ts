import { OAuthProvider, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from '@wellmet/contracts/mcp';
import { handlePage, OWNER_SCOPE, type PageCore } from './pages.ts';
import { ownerTools, OWNER_INSTRUCTIONS, type OwnerCore } from './tools.ts';

/**
 * wellmet-owner at meet-mcp.<domain>: the OAuth authorization server and the
 * owner MCP endpoint in one Worker (the library's single-Worker mode), plus
 * the few pages Tom opens in a browser. Holds no secret and never sees a
 * provider token: the code exchange happens in wellmet-core.
 */

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  CORE: OwnerCore & PageCore;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  RL_OWNER: RateLimit;
  OWNER_URL: string;
  OWNER_NAME: string;
  MS_CLIENT_ID: string;
  GOOGLE_CLIENT_ID: string;
}

const SERVER = { name: 'wellmet-owner', title: 'Wellmet (owner)', version: '1.0.0', instructions: OWNER_INSTRUCTIONS };

function options(env: Env): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const props = ctx.props as { owner?: boolean } | undefined;
        if (props?.owner !== true) return new Response('Forbidden', { status: 403 });
        const tools = ownerTools(env.CORE, {
          connectLinks: () => ({ outlook: `${env.OWNER_URL}/connect/microsoft`, google_meet: `${env.OWNER_URL}/connect/google` }),
          revokeAllAccess: async () => {
            const oauth = getOAuthApi(options(env), env);
            let revoked = 0;
            let cursor: string | undefined;
            do {
              const page = await oauth.listUserGrants('owner', cursor ? { cursor } : {});
              for (const grant of page.items) {
                await oauth.revokeGrant(grant.id, 'owner');
                revoked++;
              }
              cursor = page.cursor;
            } while (cursor);
            return { revoked };
          },
        });
        return handleMcp(request, SERVER, tools, {
          maxBodyBytes: 64 * 1024,
          onError: (err) => ctx.waitUntil(env.CORE.reportError('owner_tool', String(err))),
        });
      },
    },
    defaultHandler: {
      async fetch(request: Request, env: Env) {
        const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
        if (!(await env.RL_OWNER.limit({ key: source })).success) return new Response('Too many requests', { status: 429 });
        return handlePage(request, env);
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [OWNER_SCOPE, 'offline_access'],
    resourceMetadata: {
      resource: `${env.OWNER_URL}/mcp`,
      authorization_servers: [env.OWNER_URL],
      bearer_methods_supported: ['header'],
      resource_name: 'Wellmet (owner)',
    },
    requiredScopes: [OWNER_SCOPE],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenIdleTTL: 60 * 60 * 24 * 30,
    clientRegistrationCallback: async () => {
      const budget = await env.CORE.spendAnonBudget('register');
      if (budget.ok && !budget.value.allowed) return { code: 'access_denied', description: 'Too many new clients today. Try again tomorrow.', status: 429 };
    },
  };
}

let provider: { url: string; instance: OAuthProvider<Env> } | null = null;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!provider || provider.url !== env.OWNER_URL) provider = { url: env.OWNER_URL, instance: new OAuthProvider<Env>(options(env)) };
    return provider.instance.fetch(request, env, ctx);
  },

  /** Watchdog and cleanup: report a silent core, and prune expired grants daily. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const ping = await env.CORE.ping().catch((err: unknown) => ({ ok: false as const, error: { code: 'unreachable', message: String(err) } }));
    if (!ping.ok) console.error('wellmet-core did not answer ping', ping.error);
    if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 10) {
      await getOAuthApi(options(env), env).purgeExpiredData().catch((err: unknown) => console.error('purge failed', err));
    }
  },
};
