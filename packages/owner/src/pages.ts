import { GOOGLE, MICROSOFT, type OwnerBooking, type Result } from '@wellmet/contracts';
import { html, type SafeHtml } from '@wellmet/contracts/html';
import { ROBOTS_DIRECTIVES } from '@wellmet/contracts/robots';
import { AuthorizationError, authorizationErrorRedirect, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * The browser pages on Tom's owner hostname. None runs script (CSP
 * default-src 'none'), and nothing is authorised by a cookie alone: consent
 * uses the library's browser-bound handle, connects use a state cookie checked
 * against the callback, and approval links carry their own MAC.
 */

export interface PageCore {
  ping(): Promise<Result<{ contract: number }>>;
  peekApproval(token: string): Promise<Result<OwnerBooking & { title: string; when: string }>>;
  decideByLink(token: string, action: 'approve' | 'decline'): Promise<Result<{ result: string; status?: string; detail?: string }>>;
  finishConnect(provider: 'microsoft' | 'google', code: string, codeVerifier: string, redirectUri: string): Promise<Result<{ owner: true; email: string } | { owner: false; reason: string }>>;
  spendAnonBudget(kind: 'register' | 'authorize'): Promise<Result<{ allowed: boolean }>>;
  reportError(code: string, message: string): Promise<Result<void>>;
}

/** The slice of KV the pages use: remembering a consent answer for a minute. */
export interface ReplayStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export interface PageEnv {
  CORE: PageCore;
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV?: ReplayStore;
  OWNER_URL: string;
  OWNER_NAME: string;
  MS_CLIENT_ID: string;
  GOOGLE_CLIENT_ID: string;
}

export const OWNER_SCOPE = 'wellmet:owner';

const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Same mark as packages/public/static/favicon.svg (scripts/make-favicon.py). */
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffd400"/><polygon points="6,14 17,14 23,37 28,21 36,21 41,37 47,14 58,14 47,51 37,51 32,34 27,51 17,51" fill="#111111"/></svg>';
/**
 * Browsers apply form-action to every redirect that follows a form post. The
 * consent form's chain runs through Microsoft (login.microsoftonline.com, then
 * login.live.com for personal accounts) and ends at the MCP client's own
 * redirect address, which can be any https site, a loopback port or a custom
 * scheme. So that one form is left unrestricted; the page runs no script and
 * escapes everything it shows, so no other form can be injected into it.
 */
const CSP_OPEN_FORMS = CSP;
const CSP_SELF_FORMS = `${CSP}; form-action 'self'`;

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP_SELF_FORMS,
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function page(title: string, body: SafeHtml, status = 200, extra?: Headers, options: { openForms?: boolean } = {}): Response {
  const headers = new Headers(extra);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (options.openForms) headers.set('content-security-policy', CSP_OPEN_FORMS);
  headers.set('content-type', 'text/html; charset=utf-8');
  const doc = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="robots" content="${ROBOTS_DIRECTIVES}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/owner.css"></head>
<body><main class="sheet"><p class="wordmark">Wellmet</p>${body}</main></body></html>`;
  return new Response(doc.toString(), { status, headers });
}

export const OWNER_CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Helvetica Neue",Arial,sans-serif;color:#111;background:#fff}
.sheet{max-width:560px;margin:0 auto;padding:36px 24px 56px}.wordmark{font-weight:700;margin:0;padding-bottom:12px;border-bottom:2px solid #111}
h1{font-size:40px;line-height:1;letter-spacing:-.03em;margin:28px 0 12px}p{margin:0 0 14px}.muted{color:#555}
dl{border-top:2px solid #111;margin:20px 0}dl>div{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #ddd}dt{color:#555}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.guest{background:#f4f4f2;padding:12px 14px;margin:18px 0}.guest h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 6px;color:#555}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}button{font:700 15px/1 "Helvetica Neue",Arial,sans-serif;min-height:48px;padding:0 24px;border:2px solid #111;background:#111;color:#fff;cursor:pointer}
button.quiet{background:#fff;color:#111}.warn{border-left:4px solid #c4161c;padding:8px 12px;background:#fff6f5}`;

// --- Small helpers ---------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const connectCookie = (provider: string) => `__Host-wm-connect-${provider}`;

function redirect(location: string, headers = new Headers()): Response {
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function microsoftAuthorizeUrl(env: PageEnv, state: string, challenge: string, redirectUri: string): string {
  const u = new URL(MICROSOFT.authorizeUrl);
  u.search = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

function googleAuthorizeUrl(env: PageEnv, state: string, challenge: string, redirectUri: string): string {
  const u = new URL(GOOGLE.authorizeUrl);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return u.toString();
}

// --- Routes ------------------------------------------------------------------------------

export async function handlePage(request: Request, env: PageEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    // Awaited here: returning the route's promise unawaited would let its
    // rejection escape this catch and surface as a Cloudflare 1101 page.
    return await route(request, env, path);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return page('Start again', html`<h1>Start again</h1><p>This sign-in page has expired or was opened in another browser. Go back to your assistant and connect again.</p>`, 400);
    }
    await env.CORE.reportError('owner_page', `${path}: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    return page('Something went wrong', html`<h1>Something went wrong</h1><p>It has been logged. Try again in a moment.</p>`, 500);
  }
}

async function route(request: Request, env: PageEnv, path: string): Promise<Response> {
  if (path === '/favicon.svg' || path === '/favicon.ico') {
    // Browsers ask for /favicon.ico on their own; the SVG answers both.
    return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
  }
  if (path === '/owner.css') return new Response(OWNER_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  if (path === '/healthz') {
    const r = await env.CORE.ping();
    return Response.json({ owner: 'ok', core: r.ok ? r.value : r.error }, { status: r.ok ? 200 : 503 });
  }
  if (path === '/authorize') return request.method === 'POST' ? approveSignIn(request, env) : showConsent(request, env);
  if (path === '/oauth/microsoft/callback') return finishSignIn(request, env);
  const connect = path.match(/^\/connect\/(microsoft|google)(\/callback)?$/);
  if (connect) {
    const provider = connect[1] as 'microsoft' | 'google';
    return connect[2] ? finishConnectPage(request, env, provider) : startConnect(env, provider);
  }
  const approval = path.match(/^\/a\/([A-Za-z0-9-]+\.[A-Za-z0-9_-]+)$/);
  if (approval) return request.method === 'POST' ? decideApproval(request, env, approval[1]!) : showApproval(env, approval[1]!);
  if (path === '/') return page('Wellmet', html`<h1>Owner endpoint</h1><p class="muted">This address is for ${env.OWNER_NAME}'s assistant. To book a time, use the booking page instead.</p>`);
  return page('Not found', html`<h1>Not found</h1>`, 404);
}

// Sign-in for an MCP client: consent, then Microsoft, then back to the client.

async function showConsent(request: Request, env: PageEnv): Promise<Response> {
  const budget = await env.CORE.spendAnonBudget('authorize');
  if (budget.ok && !budget.value.allowed) return page('Try later', html`<h1>Try later</h1><p>Too many sign-in attempts today.</p>`, 429);
  const oauth = env.OAUTH_PROVIDER;
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return redirect(err.redirectTo);
    return page('Can\'t sign in', html`<h1>Can't sign in</h1><p>The app that sent you here made a request this scheduler doesn't accept.</p>`, 400);
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const origin = details.clientDomain
    ? html`Published by <strong>${details.clientDomain}</strong>.`
    : html`This app registered itself, so its name is not verified.`;
  return page(`Allow ${details.clientName}?`, html`
    <h1>Allow ${details.clientName} to manage your scheduler?</h1>
    <p>${origin} Access goes to <strong>${details.redirectHost}</strong>.</p>
    ${details.redirectIsLoopback ? html`<p class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>` : ''}
    <p class="muted">It will be able to change meeting types, hours and bookings. You'll sign in with Microsoft next; only ${env.OWNER_NAME}'s account is accepted.</p>
    <form method="post" action="/authorize">
      <input type="hidden" name="handle" value="${consent.handle}">
      <div class="actions"><button name="decision" value="approve">Continue to Microsoft</button><button class="quiet" name="decision" value="deny">Deny</button></div>
    </form>`, 200, consent.headers, { openForms: true });
}

async function approveSignIn(request: Request, env: PageEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return redirect(denied.redirectTo, denied.headers);
  }
  // A double-click posts the same handle twice; the browser shows only the
  // second answer. The handle is single-use, so the second post replays the
  // first one's redirect instead of failing.
  const replayKey = `consent-replay:${await s256(handle)}`;
  let approved;
  try {
    approved = await oauth.approveConsent(request, handle, { scope: [OWNER_SCOPE, 'offline_access'] });
  } catch (err) {
    const replay = err instanceof AuthorizationError && env.OAUTH_KV ? await awaitReplay(env.OAUTH_KV, replayKey) : null;
    if (replay) return replay;
    throw err;
  }
  const verifier = randomToken();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  const location = microsoftAuthorizeUrl(env, state, await s256(verifier), `${env.OWNER_URL}/oauth/microsoft/callback`);
  await env.OAUTH_KV?.put(replayKey, JSON.stringify({ location, cookies: headers.getSetCookie() }), { expirationTtl: 60 });
  return redirect(location, headers);
}

/** The first post may still be finishing; look for its answer for about a second and a half. */
async function awaitReplay(store: ReplayStore, key: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const saved = await store.get(key);
    if (saved) {
      const { location, cookies } = JSON.parse(saved) as { location: string; cookies: string[] };
      const headers = new Headers();
      for (const c of cookies) headers.append('set-cookie', c);
      return redirect(location, headers);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function finishSignIn(request: Request, env: PageEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (params.get('error') || !code) return redirect(authorizationErrorRedirect(original, 'access_denied'), headers);
  const result = await env.CORE.finishConnect('microsoft', code, data.verifier, `${env.OWNER_URL}/oauth/microsoft/callback`);
  if (!result.ok) {
    return page('Can\'t sign in', html`<h1>Can't sign in</h1><p>${result.error.message}</p>`, 502, headers);
  }
  if (!result.value.owner) {
    return redirect(authorizationErrorRedirect(original, 'access_denied', result.value.reason), headers);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: 'owner',
    metadata: { email: result.value.email },
    scope: original.scope.filter((s) => s === OWNER_SCOPE || s === 'offline_access').concat(original.scope.includes(OWNER_SCOPE) ? [] : [OWNER_SCOPE]),
    props: { owner: true },
  });
  return redirect(redirectTo, headers);
}

// Connecting or reconnecting a calendar account, outside any MCP client.

async function startConnect(env: PageEnv, provider: 'microsoft' | 'google'): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const redirectUri = `${env.OWNER_URL}/connect/${provider}/callback`;
  const target = provider === 'microsoft'
    ? microsoftAuthorizeUrl(env, state, await s256(verifier), redirectUri)
    : googleAuthorizeUrl(env, state, await s256(verifier), redirectUri);
  const headers = new Headers();
  headers.append('set-cookie', `${connectCookie(provider)}=${state}.${verifier}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return redirect(target, headers);
}

async function finishConnectPage(request: Request, env: PageEnv, provider: 'microsoft' | 'google'): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const saved = cookie(request, connectCookie(provider));
  const clear = new Headers({ 'set-cookie': `${connectCookie(provider)}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax` });
  const [state, verifier] = (saved ?? '').split('.');
  const name = provider === 'microsoft' ? 'Outlook' : 'Google Meet';
  if (!state || !verifier || params.get('state') !== state) {
    return page('Start again', html`<h1>Start again</h1><p>This link expired or was opened in another browser. Open the ${name} connect link again.</p>`, 400, clear);
  }
  const code = params.get('code');
  if (!code) return page('Not connected', html`<h1>Not connected</h1><p>${name} was not connected.</p>`, 400, clear);
  const result = await env.CORE.finishConnect(provider, code, verifier, `${env.OWNER_URL}/connect/${provider}/callback`);
  if (!result.ok) return page('Not connected', html`<h1>Not connected</h1><p>${result.error.message}</p>`, 502, clear);
  if (!result.value.owner) return page('Not connected', html`<h1>Not connected</h1><p>${result.value.reason}</p>`, 403, clear);
  return page(`${name} connected`, html`<h1>${name} connected.</h1><p>Connected as <strong>${result.value.email}</strong>. You can close this tab.</p>`, 200, clear);
}

// Approve or decline a request from the link in Tom's email.

async function showApproval(env: PageEnv, token: string): Promise<Response> {
  const r = await env.CORE.peekApproval(token);
  if (!r.ok) return page('Not found', html`<h1>Not found</h1><p>${r.error.message}</p>`, 404);
  const b = r.value;
  const g = b.guest_supplied;
  const waiting = b.status === 'pending';
  return page(`${b.title}: request`, html`
    <h1>${waiting ? 'Booking request' : statusWord(b.status)}</h1>
    <dl>
      <div><dt>Meeting</dt><dd>${b.title}</dd></div>
      <div><dt>When</dt><dd>${b.when}</dd></div>
      <div><dt>Length</dt><dd>${b.length_min} min</dd></div>
      ${b.expires_at && waiting ? html`<div><dt>Lapses</dt><dd>${new Date(b.expires_at).toUTCString()}</dd></div>` : ''}
    </dl>
    <section class="guest"><h2>Typed by the guest, not verified</h2>
      <p><strong>${g.name}</strong> &lt;${g.email}&gt;</p>
      ${Object.entries(g.answers).map(([k, v]) => html`<p><span class="muted">${k}:</span> ${v}</p>`)}
    </section>
    ${waiting
      ? html`<form method="post"><div class="actions"><button name="action" value="approve">Approve</button><button class="quiet" name="action" value="decline">Decline</button></div></form>`
      : html`<p class="muted">Nothing left to decide.</p>`}`);
}

async function decideApproval(request: Request, env: PageEnv, token: string): Promise<Response> {
  const form = await request.formData();
  const action = form.get('action') === 'approve' ? 'approve' : 'decline';
  const r = await env.CORE.decideByLink(token, action);
  if (!r.ok) return page('Not done', html`<h1>Not done</h1><p>${r.error.message}</p>`, 400);
  const messages: Record<string, string> = {
    approved: 'Approved. The guest gets a calendar invite.',
    declined: 'Declined.',
    already_approved: 'This was already approved; nothing changed.',
    already_decided: `This was already ${r.value.status ?? 'decided'}; nothing changed.`,
    time_taken: 'That time has since been booked, so this request was declined.',
    try_again: 'Another booking for that time is being checked right now. Try again in a minute.',
    calendar_problem: r.value.detail === 'conflict'
      ? 'Your Outlook calendar now shows something at that time, so it was not approved. The request is still waiting.'
      : 'Outlook did not answer, so it was not approved. The request is still waiting; try again shortly.',
  };
  return page('Done', html`<h1>${r.value.result === 'approved' ? 'Approved.' : 'Done.'}</h1><p>${messages[r.value.result] ?? r.value.result}</p>`);
}

function statusWord(status: string): string {
  return ({ accepted: 'Approved', confirmed: 'Approved', declined: 'Declined', expired: 'Lapsed', cancelled: 'Cancelled', failed: 'Failed' } as Record<string, string>)[status] ?? status;
}

