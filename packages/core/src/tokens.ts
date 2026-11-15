import type { Clock, Db } from './db.ts';
import { open, seal, type Keys } from './crypto.ts';
import { newId } from './crypto.ts';
import { ProviderBroken, ProviderUnavailable } from './providers.ts';

/**
 * Microsoft and Google tokens: stored encrypted, refreshed before they
 * expire, and classified when refresh fails. A refusal that needs Tom
 * (revoked consent, expired client secret) marks the connection broken and
 * mails him once; a provider outage only marks it failing, and becomes broken
 * after 30 minutes (A4).
 */

export type Provider = 'microsoft' | 'google';

export interface OAuthClient {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Sent on refresh (Microsoft requires it). */
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

export interface TokenDeps {
  db: Db;
  keys: Keys;
  clock: Clock;
  fetch: typeof fetch;
  clients: Record<Provider, OAuthClient>;
  /** Where Tom reconnects, for the alert mail. */
  connectUrl: (provider: Provider) => string;
}

const MINUTE = 60_000;
const FAILING_TO_BROKEN_MS = 30 * MINUTE;

/** POSTs a form to a token endpoint and sorts failures into "retry later" and "needs Tom". */
export async function tokenRequest(deps: Pick<TokenDeps, 'fetch'>, provider: Provider, client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await deps.fetch(client.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...form }).toString(),
    });
  } catch (err) {
    throw new ProviderUnavailable(provider, `Token endpoint unreachable: ${String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof body.access_token === 'string') return body as unknown as TokenResponse;
  if (res.status === 429 || res.status >= 500) throw new ProviderUnavailable(provider, `Token endpoint answered ${res.status}.`);
  const error = typeof body.error === 'string' ? body.error : `http_${res.status}`;
  const description = typeof body.error_description === 'string' ? body.error_description.split('\n')[0]!.slice(0, 200) : '';
  // invalid_grant: consent revoked or refresh token expired. invalid_client: the client secret expired or is wrong.
  throw new ProviderBroken(provider, `${error}${description ? `: ${description}` : ''}`);
}

interface ConnectionRow {
  provider: Provider;
  account_email: string;
  refresh_enc: string;
  access_enc: string | null;
  access_expires: number | null;
  status: 'ok' | 'failing' | 'broken';
  failing_since: number | null;
  last_error: string | null;
}

const ctxFor = (provider: Provider, kind: 'refresh' | 'access') => `connections:${provider}:${kind}`;

export async function saveConnection(
  deps: Pick<TokenDeps, 'db' | 'keys' | 'clock'>,
  provider: Provider,
  account: { sub: string; email: string },
  tokens: TokenResponse,
): Promise<void> {
  if (!tokens.refresh_token) throw new ProviderBroken(provider, 'No refresh token was returned; the connection would not last.');
  const now = deps.clock.now();
  await deps.db
    .prepare(`INSERT INTO connections (provider, account_sub, account_email, refresh_enc, access_enc, access_expires, status, failing_since, last_error, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', NULL, NULL, ?7)
              ON CONFLICT (provider) DO UPDATE SET account_sub = excluded.account_sub, account_email = excluded.account_email,
                refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, access_expires = excluded.access_expires,
                status = 'ok', failing_since = NULL, last_error = NULL, updated_at = excluded.updated_at`)
    .bind(
      provider,
      account.sub,
      account.email,
      await seal(deps.keys, tokens.refresh_token, ctxFor(provider, 'refresh')),
      await seal(deps.keys, tokens.access_token, ctxFor(provider, 'access')),
      now + tokens.expires_in * 1000,
      now,
    )
    .run();
}

/** A valid access token, refreshing it first if it's within a minute of expiring. */
export async function accessToken(deps: TokenDeps, provider: Provider): Promise<string> {
  const { db, keys, clock } = deps;
  const row = await db.prepare('SELECT * FROM connections WHERE provider = ?').bind(provider).first<ConnectionRow>();
  if (!row) throw new ProviderBroken(provider, 'not_connected');
  if (row.status === 'broken') throw new ProviderBroken(provider, row.last_error ?? 'broken');
  const now = clock.now();
  if (row.access_enc && row.access_expires && row.access_expires > now + MINUTE) {
    return open(keys, row.access_enc, ctxFor(provider, 'access'));
  }

  const client = deps.clients[provider];
  try {
    const refreshToken = await open(keys, row.refresh_enc, ctxFor(provider, 'refresh'));
    const tokens = await tokenRequest(deps, provider, client, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(client.scope ? { scope: client.scope } : {}),
    });
    // Microsoft rotates refresh tokens; keep the newest one.
    await db
      .prepare(`UPDATE connections SET access_enc = ?2, access_expires = ?3, refresh_enc = COALESCE(?4, refresh_enc),
                status = 'ok', failing_since = NULL, last_error = NULL, updated_at = ?5 WHERE provider = ?1`)
      .bind(
        provider,
        await seal(keys, tokens.access_token, ctxFor(provider, 'access')),
        now + tokens.expires_in * 1000,
        tokens.refresh_token ? await seal(keys, tokens.refresh_token, ctxFor(provider, 'refresh')) : null,
        now,
      )
      .run();
    return tokens.access_token;
  } catch (err) {
    if (err instanceof ProviderBroken) {
      await markBroken(deps, provider, err.reason);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const since = row.failing_since ?? now;
    if (now - since >= FAILING_TO_BROKEN_MS) {
      await markBroken(deps, provider, `refresh has failed for 30 minutes: ${message}`);
      throw new ProviderBroken(provider, message);
    }
    await db
      .prepare(`UPDATE connections SET status = 'failing', failing_since = ?2, last_error = ?3, updated_at = ?4 WHERE provider = ?1`)
      .bind(provider, since, message.slice(0, 300), now)
      .run();
    throw err instanceof ProviderUnavailable ? err : new ProviderUnavailable(provider, message);
  }
}

async function markBroken(deps: TokenDeps, provider: Provider, reason: string): Promise<void> {
  const now = deps.clock.now();
  const wasBroken = await deps.db.prepare("SELECT 1 FROM connections WHERE provider = ? AND status = 'broken'").bind(provider).first();
  const name = provider === 'microsoft' ? 'Outlook' : 'Google Meet';
  const secretExpired = reason.startsWith('invalid_client');
  const statements = [
    deps.db.prepare(`UPDATE connections SET status = 'broken', last_error = ?2, updated_at = ?3 WHERE provider = ?1`).bind(provider, reason.slice(0, 300), now),
  ];
  if (!wasBroken) {
    const body = secretExpired
      ? `The ${name} app's client secret has expired or is wrong (${reason}). Create a new secret in the ${provider === 'microsoft' ? 'Microsoft Entra' : 'Google Cloud'} console, store it with wrangler secret put, then reconnect: ${deps.connectUrl(provider)}`
      : `Wellmet lost its connection to ${name} (${reason}). Until you reconnect, ${provider === 'microsoft' ? 'new bookings wait for your approval and nothing is sent' : 'bookings confirm without a Meet link'}. Reconnect: ${deps.connectUrl(provider)}`;
    statements.push(
      deps.db
        .prepare('INSERT INTO outbox (id, kind, booking_id, subject, body, created_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
        .bind(newId(), `${provider}_broken`, `${name} connection needs you`, body, now, now + 3 * 24 * 60 * MINUTE),
    );
  }
  await deps.db.batch(statements);
}

/** Reads an ID token's claims. Safe without a signature check only because it came straight from the token endpoint over TLS. */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Malformed ID token.');
  const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (payload.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
}
