import { GOOGLE, MICROSOFT } from '@wellmet/contracts';
import type { Db } from './db.ts';
import { idTokenClaims, saveConnection, tokenRequest, type Provider, type TokenDeps } from './tokens.ts';

/**
 * The secret leg of a connect or sign-in: the owner Worker has done the
 * browser redirects and hands over the code and PKCE verifier. Only the
 * owner's own accounts are ever stored (S1): the first connection must match
 * the configured address, and after that the account id is pinned.
 */

export interface OwnerAccounts {
  microsoftEmail: string;
  googleEmail: string;
}

export type ConnectResult = { owner: true; email: string } | { owner: false; reason: string };

export async function finishConnect(
  deps: TokenDeps,
  owner: OwnerAccounts,
  provider: Provider,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<ConnectResult> {
  const client = deps.clients[provider];
  const tokens = await tokenRequest(deps, provider, client, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    ...(provider === 'microsoft' ? { scope: MICROSOFT.scope } : {}),
  });
  if (!tokens.id_token) return { owner: false, reason: 'No ID token was returned.' };
  const claims = idTokenClaims(tokens.id_token);

  const issuerOk = provider === 'microsoft' ? claims.iss === MICROSOFT.issuer : (GOOGLE.issuers as readonly unknown[]).includes(claims.iss);
  if (!issuerOk) return { owner: false, reason: 'Sign in with a personal account.' };
  if (claims.aud !== client.clientId) return { owner: false, reason: 'The token was issued to a different app.' };
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
  if (!sub || !email) return { owner: false, reason: 'The account has no email address.' };
  if (provider === 'google' && claims.email_verified !== true) return { owner: false, reason: 'The Google email is not verified.' };

  const pinned = await pinnedSub(deps.db, provider);
  // A Microsoft account can have several aliases (e.g. an outlook.com address on
  // an account first made with another address), so the setting is a list and
  // either the email or the sign-in name may match.
  const expected = (provider === 'microsoft' ? owner.microsoftEmail : owner.googleEmail).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const presented = provider === 'microsoft'
    ? [claims.email, claims.preferred_username].map((v) => String(v ?? '').toLowerCase()).filter(Boolean)
    : [email];
  const isOwner = pinned ? pinned === sub : presented.some((e) => expected.includes(e));
  if (!isOwner) return { owner: false, reason: 'This scheduler belongs to someone else.' };

  await saveConnection(deps, provider, { sub, email }, tokens);
  if (!pinned) await pinSub(deps.db, provider, sub, deps.clock.now());
  return { owner: true, email };
}

async function pinnedSub(db: Db, provider: Provider): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM state WHERE key = ?').bind(`owner_sub:${provider}`).first<{ value: string }>();
  return r?.value ?? null;
}

async function pinSub(db: Db, provider: Provider, sub: string, now: number): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO state (key, value, updated_at) VALUES (?, ?, ?)').bind(`owner_sub:${provider}`, sub, now).run();
}
