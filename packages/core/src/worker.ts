import { WorkerEntrypoint } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import { GOOGLE, MICROSOFT, type Caller, type EventTypeSettings } from '@wellmet/contracts';
import type { Db } from './db.ts';
import { systemClock } from './db.ts';
import { deriveKeys, type Keys } from './crypto.ts';
import { publicApi, ownerApi, logLine } from './api.ts';
import type { CoreContext } from './bookings.ts';
import { ensureDefaultSchedule } from './catalog.ts';
import { runCron } from './cron.ts';
import { graphCalendar } from './graph.ts';
import { googleMeet } from './meet.ts';
import { buildMime } from './mail.ts';
import { accessToken, type TokenDeps } from './tokens.ts';
import type { Provider } from './tokens.ts';

/**
 * wellmet-core: no route of its own. The public Worker binds to `PublicApi`,
 * the owner Worker to `OwnerApi`; each binding can reach only its own
 * entrypoint. Holds the database, the provider secrets and the cron.
 */

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}

export interface Env {
  DB: Db;
  EMAIL: SendEmail;
  RL_PUB_READ_ALL: RateLimit;
  RL_PUB_WRITE_ALL: RateLimit;
  MASTER_KEY: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PUBLIC_URL: string;
  OWNER_URL: string;
  OWNER_NAME: string;
  OWNER_TIMEZONE: string;
  OWNER_EMAIL: string;
  /** Comma-separated Microsoft sign-in addresses accepted as the owner; defaults to OWNER_EMAIL. */
  OWNER_MICROSOFT_LOGINS?: string;
  OWNER_GOOGLE_EMAIL: string;
  MAIL_FROM: string;
  MS_SECRET_EXPIRES_ON?: string;
}

/** The only hosts the core may call. */
const ALLOWED_HOSTS = new Set([
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'oauth2.googleapis.com',
  'meet.googleapis.com',
]);

function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    return Promise.reject(new Error(`Outbound call to ${url.hostname} is not allowed.`));
  }
  return fetch(input, init);
}

let cachedKeys: { master: string; keys: Keys } | null = null;
let defaultsChecked = false;

async function contextFor(env: Env, waitUntil?: (p: Promise<unknown>) => void) {
  if (!cachedKeys || cachedKeys.master !== env.MASTER_KEY) cachedKeys = { master: env.MASTER_KEY, keys: await deriveKeys(env.MASTER_KEY) };
  const keys = cachedKeys.keys;
  const tokens: TokenDeps = {
    db: env.DB,
    keys,
    clock: systemClock,
    fetch: guardedFetch as typeof fetch,
    clients: {
      microsoft: { tokenUrl: MICROSOFT.tokenUrl, clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET, scope: MICROSOFT.scope },
      google: { tokenUrl: GOOGLE.tokenUrl, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
    connectUrl: (p: Provider) => `${env.OWNER_URL}/connect/${p}`,
  };
  const ctx: CoreContext = {
    db: env.DB,
    keys,
    clock: systemClock,
    calendar: graphCalendar({ fetch: guardedFetch as typeof fetch, token: () => accessToken(tokens, 'microsoft') }),
    meet: googleMeet({ fetch: guardedFetch as typeof fetch, token: () => accessToken(tokens, 'google') }),
    config: { publicUrl: env.PUBLIC_URL, ownerUrl: env.OWNER_URL, ownerName: env.OWNER_NAME, ownerTimezone: env.OWNER_TIMEZONE },
    ...(waitUntil ? { background: waitUntil } : {}),
  };
  if (!defaultsChecked) {
    await ensureDefaultSchedule(env.DB, systemClock.now(), env.OWNER_TIMEZONE);
    defaultsChecked = true;
  }
  return { ctx, tokens };
}

const limited = { ok: false as const, error: { code: 'too_many_requests', message: 'The scheduler is busy. Try again in a minute.' } };

/** Bound only by wellmet-public. Takes no booking ids and lists no bookings. */
export class PublicApi extends WorkerEntrypoint<Env> {
  private async api() {
    return publicApi((await contextFor(this.env, (p) => this.ctx.waitUntil(p))).ctx);
  }
  private async read() {
    return (await this.env.RL_PUB_READ_ALL.limit({ key: 'all' })).success;
  }
  private async write(key = 'all') {
    return (await this.env.RL_PUB_WRITE_ALL.limit({ key })).success;
  }

  async ping() { return (await this.api()).ping(); }
  async listEventTypes() { return (await this.read()) ? (await this.api()).listEventTypes() : limited; }
  async getEventType(slug: string) { return (await this.read()) ? (await this.api()).getEventType(String(slug)) : limited; }
  async findSlots(slug: string, from: string, to: string, lengthMin?: number) {
    return (await this.read()) ? (await this.api()).findSlots(String(slug), String(from), String(to), lengthMin === undefined ? undefined : Number(lengthMin)) : limited;
  }
  async requestBooking(input: unknown, caller: Caller) {
    if (!(await this.write())) return limited;
    const via = caller?.via === 'api' || caller?.via === 'mcp' ? caller.via : 'web';
    return (await this.api()).requestBooking(input, { address: String(caller?.address ?? 'unknown'), via });
  }
  async getBooking(token: string) { return (await this.read()) ? (await this.api()).getBooking(String(token)) : limited; }
  async cancelBooking(token: string, reason?: string) {
    return (await this.write()) ? (await this.api()).cancelBooking(String(token), reason === undefined ? undefined : String(reason).slice(0, 300)) : limited;
  }
  async rescheduleBooking(token: string, newStart: string) {
    return (await this.write()) ? (await this.api()).rescheduleBooking(String(token), String(newStart)) : limited;
  }
  async reportError(code: string, message: string) {
    return (await this.write('report')) ? (await this.api()).reportError(String(code), String(message)) : limited;
  }
}

/** Bound only by wellmet-owner, which has already checked Tom's access token. */
export class OwnerApi extends WorkerEntrypoint<Env> {
  private async api() {
    const { ctx, tokens } = await contextFor(this.env, (p) => this.ctx.waitUntil(p));
    return ownerApi(ctx, {
      tokens,
      owner: { microsoftEmail: this.env.OWNER_MICROSOFT_LOGINS || this.env.OWNER_EMAIL, googleEmail: this.env.OWNER_GOOGLE_EMAIL },
      microsoftSecretExpiresOn: this.env.MS_SECRET_EXPIRES_ON ?? null,
    });
  }
  async ping() { return (await this.api()).ping(); }
  async getHealth() { return (await this.api()).getHealth(); }
  async listEventTypes(includeArchived?: boolean) { return (await this.api()).listEventTypes(Boolean(includeArchived)); }
  async createEventType(input: unknown) { return (await this.api()).createEventType(input); }
  async updateEventType(input: unknown) { return (await this.api()).updateEventType(input); }
  async duplicateEventType(input: unknown) { return (await this.api()).duplicateEventType(input); }
  async archiveEventType(slug: string, archived: boolean) { return (await this.api()).archiveEventType(String(slug), Boolean(archived)); }
  async previewEventType(slug: string, changes?: Partial<EventTypeSettings>, days?: number) { return (await this.api()).previewEventType(String(slug), changes, days); }
  async listSchedules() { return (await this.api()).listSchedules(); }
  async upsertSchedule(input: unknown) { return (await this.api()).upsertSchedule(input); }
  async listDateOverrides(from: string, to: string) { return (await this.api()).listDateOverrides(String(from), String(to)); }
  async setDateOverride(input: unknown) { return (await this.api()).setDateOverride(input); }
  async removeDateOverride(id: string) { return (await this.api()).removeDateOverride(String(id)); }
  async getAvailability(slug: string, from: string, to: string, lengthMin?: number) { return (await this.api()).getAvailability(String(slug), String(from), String(to), lengthMin); }
  async listBookings(filter?: { status?: string; event_type?: string; from?: string; to?: string; limit?: number }) { return (await this.api()).listBookings(filter ?? {}); }
  async getBooking(id: string) { return (await this.api()).getBooking(String(id)); }
  async decideBookings(input: { ids?: string[]; approve: boolean; filter?: { event_type?: string; created_after?: string } }) { return (await this.api()).decideBookings(input); }
  async cancelBooking(id: string, reason?: string) { return (await this.api()).cancelBooking(String(id), reason); }
  async rescheduleBooking(id: string, newStart: string) { return (await this.api()).rescheduleBooking(String(id), String(newStart)); }
  async blockTime(start: string, end: string, label?: string) { return (await this.api()).blockTime(String(start), String(end), label); }
  async listBlocks(from: string, to: string) { return (await this.api()).listBlocks(String(from), String(to)); }
  async unblockTime(id: string) { return (await this.api()).unblockTime(String(id)); }
  async peekApproval(token: string) { return (await this.api()).peekApproval(String(token)); }
  async decideByLink(token: string, action: 'approve' | 'decline') { return (await this.api()).decideByLink(String(token), action === 'approve' ? 'approve' : 'decline'); }
  async finishConnect(provider: Provider, code: string, codeVerifier: string, redirectUri: string) {
    const p: Provider = provider === 'google' ? 'google' : 'microsoft';
    return (await this.api()).finishConnect(p, String(code), String(codeVerifier), String(redirectUri));
  }
  async spendAnonBudget(kind: 'register' | 'authorize') { return (await this.api()).spendAnonBudget(kind === 'register' ? 'register' : 'authorize'); }
  async reportError(code: string, message: string) { return (await this.api()).reportError(String(code), String(message)); }
}

export default {
  /** No public route: anything reaching this directly gets nothing. */
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: unknown, env: Env, execution: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const { ctx } = await contextFor(env, (p) => execution.waitUntil(p));
    const domain = env.MAIL_FROM.split('@')[1] ?? 'localhost';
    await runCron(ctx, {
      send: async (subject, body) => {
        const raw = buildMime({ from: env.MAIL_FROM, fromName: 'Wellmet', to: env.OWNER_EMAIL, subject, body, now: Date.now(), messageIdDomain: domain });
        await env.EMAIL.send(new EmailMessage(env.MAIL_FROM, env.OWNER_EMAIL, raw));
      },
    }).catch((err) => logLine(ctx, 'core', 'error', 'cron', String(err)));
  },
};
