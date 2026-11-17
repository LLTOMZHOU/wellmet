import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildServer, defineTool, serveMcp, ToolError } from '@wellmet/contracts/mcp';
import { ownerServer, type LocalTools, type OwnerCore } from '../src/tools.ts';
import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { handlePage, type PageEnv } from '../src/pages.ts';
import { CAN_ASK, MODERN, mcpClient } from '../../../test-support/mcp-client.ts';

const URL_ = 'https://meet-mcp.example/mcp';

describe('MCP protocol (official SDK, both eras)', () => {
  const echo = defineTool({
    name: 'echo', title: 'Echo', description: 'Echo the arguments back.', annotations: { readOnlyHint: true },
    input: z.object({ text: z.string().optional(), fail: z.boolean().optional(), crash: z.boolean().optional() }),
    run: async (a) => {
      if (a.fail) throw new ToolError('Refused for a reason', { code: 'x' });
      if (a.crash) throw new Error('secret detail');
      return { got: a };
    },
  });
  const onError = vi.fn();
  const SERVER = { name: 'test', title: 'Test', version: '1', instructions: 'hi' };
  const serve = (r: Request) => serveMcp(r, () => buildServer(SERVER, [echo], onError), { maxBodyBytes: 4096, onError });
  const client = () => mcpClient(URL_, serve);

  it('still serves 2025 clients: initialize, list, call', async () => {
    const c = client();
    const init = await c.legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.instructions).toBe('hi');
    const list = await c.legacy('tools/list');
    expect(list.body.result.tools[0]).toMatchObject({ name: 'echo', annotations: { readOnlyHint: true } });
    const r = await c.legacy('tools/call', { name: 'echo', arguments: { text: 'a' } });
    expect(r.body.result).toMatchObject({ isError: false, structuredContent: { got: { text: 'a' } } });
  });

  it('serves 2026-07-28 clients, starting with server/discover', async () => {
    const c = client();
    const d = await c.modern('server/discover');
    expect(d.body.result.supportedVersions).toContain(MODERN);
    expect(d.body.result.capabilities.tools).toBeDefined();
    const r = await c.modern('tools/call', { name: 'echo', arguments: { text: 'b' } });
    expect(r.body.result).toMatchObject({ isError: false, structuredContent: { got: { text: 'b' } } });
    expect((await c.modern('nope/nope')).status).toBe(404);
  });

  it('checks that headers match the body on 2026-07-28 requests', async () => {
    const c = client();
    const res = await c.raw(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'something_else' },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it('returns refusals as readable tool errors, and hides unexpected ones', async () => {
    const c = client();
    const refused = await c.legacy('tools/call', { name: 'echo', arguments: { fail: true } });
    expect(refused.body.result).toMatchObject({ isError: true, content: [{ text: 'Refused for a reason' }], structuredContent: { details: { code: 'x' } } });
    const crashed = await c.legacy('tools/call', { name: 'echo', arguments: { crash: true } });
    expect(JSON.stringify(crashed.body)).not.toContain('secret detail');
    expect(crashed.body.result.isError).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('refuses batches and oversize bodies, and offers no GET stream', async () => {
    const c = client();
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await c.raw([call, { ...call, id: 2 }], {})).status).toBe(400);
    expect((await c.raw('x'.repeat(5000), {})).status).toBe(413);
    expect((await serve(new Request(URL_))).status).toBe(405);
  });
});

describe('owner tools', () => {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const local = (over: Partial<LocalTools> = {}): LocalTools => ({
    connectLinks: () => ({ outlook: 'https://meet-mcp.example/connect/microsoft', google_meet: 'https://meet-mcp.example/connect/google' }),
    revokeAllAccess: async () => ({ revoked: 2 }),
    timezone: 'America/Los_Angeles',
    ...over,
  });
  const pending = (id: string, name: string) => ({ id, event_type: 'chat', created_at: '2026-11-15T10:00:00Z', start: '2026-11-18T03:00:00Z', guest_supplied: { name } });
  function owner(over: Partial<Record<keyof OwnerCore, unknown>> = {}) {
    const calls: Record<string, ReturnType<typeof vi.fn>> = {};
    const core = new Proxy({}, {
      get: (_t, key: string) => (calls[key] ??= vi.fn((..._args: unknown[]) => (key in over ? over[key as keyof OwnerCore] : ok({ done: true })))),
    }) as unknown as OwnerCore;
    const client = mcpClient(URL_, (r) => serveMcp(r, () => ownerServer(core, local()), { maxBodyBytes: 65536 }));
    return { client, calls };
  }

  it('offers every planned tool, each with a description and an object schema', async () => {
    const { client } = owner();
    const tools = (await client.legacy('tools/list')).body.result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'archive_event_type', 'block_time', 'cancel_booking', 'create_event_type', 'decide_bookings', 'duplicate_event_type',
      'get_availability', 'get_booking', 'get_connect_links', 'get_health', 'list_blocks', 'list_bookings', 'list_date_overrides',
      'list_event_types', 'list_schedules', 'preview_event_type', 'remove_date_override', 'reschedule_booking', 'revoke_all_access',
      'set_date_override', 'unblock_time', 'update_event_type', 'upsert_schedule',
    ]);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('shows the agent every event-type setting in create_event_type, with defaults not required', async () => {
    const { client } = owner();
    const tools = (await client.legacy('tools/list')).body.result.tools as { name: string; inputSchema: { properties: object; required?: string[] } }[];
    const create = tools.find((t) => t.name === 'create_event_type')!.inputSchema;
    for (const k of ['lengths', 'limits', 'schedule', 'confirmation', 'questions', 'location', 'visibility']) expect(Object.keys(create.properties)).toContain(k);
    expect((create.required ?? []).sort()).toEqual(['slug', 'title']);
    const listTypes = tools.find((t) => t.name === 'list_event_types')!.inputSchema;
    expect(listTypes.required ?? []).toEqual([]);
  });

  it('turns bad arguments into a message the agent can fix', async () => {
    const { client } = owner();
    const r = await client.legacy('tools/call', { name: 'create_event_type', arguments: { slug: 'Bad Slug', title: 'x' } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/lowercase/i);
  });

  it('passes a core refusal through with its code', async () => {
    const { client } = owner({ rescheduleBooking: Promise.resolve({ ok: false, error: { code: 'slot_taken', message: 'Taken.', details: { alternatives: [1] } } }) });
    const r = await client.legacy('tools/call', { name: 'reschedule_booking', arguments: { id: 'b', new_start: '2026-11-17T10:00:00-08:00' } });
    expect(r.body.result).toMatchObject({ isError: true, content: [{ text: 'Taken.' }], structuredContent: { details: { code: 'slot_taken', alternatives: [1] } } });
  });

  describe('get_connect_links', () => {
    it('returns both links to clients that cannot open a page for Tom', async () => {
      const { client } = owner();
      const r = await client.legacy('tools/call', { name: 'get_connect_links', arguments: { service: 'google_meet' } });
      expect(r.body.result.structuredContent).toEqual({ outlook: 'https://meet-mcp.example/connect/microsoft', google_meet: 'https://meet-mcp.example/connect/google' });
    });

    it('offers to open the one page when the client can ask Tom', async () => {
      const { client } = owner();
      const ask = await client.modern('tools/call', { name: 'get_connect_links', arguments: { service: 'google_meet' } }, CAN_ASK);
      expect(ask.body.result.resultType).toBe('input_required');
      expect(ask.body.result.inputRequests.connect).toMatchObject({ method: 'elicitation/create', params: { mode: 'url', url: 'https://meet-mcp.example/connect/google' } });

      const opened = await client.modern('tools/call', { name: 'get_connect_links', arguments: { service: 'google_meet' }, inputResponses: { connect: { action: 'accept' } } }, CAN_ASK);
      expect(opened.body.result.structuredContent).toMatchObject({ opened: true, service: 'google_meet' });

      const declined = await client.modern('tools/call', { name: 'get_connect_links', arguments: { service: 'google_meet' }, inputResponses: { connect: { action: 'decline' } } }, CAN_ASK);
      expect(declined.body.result.structuredContent).toMatchObject({ opened: false });
    });
  });

  describe('decide_bookings', () => {
    const waiting = ok([pending('b1', 'Ada'), pending('b2', 'Grace'), pending('b3', 'Linus')]);
    const decline = { ids: ['b1', 'b2'], approve: false };

    it('asks Tom before acting on more than one request, and acts only on a yes', async () => {
      const { client, calls } = owner({ listBookings: waiting });
      const ask = await client.modern('tools/call', { name: 'decide_bookings', arguments: decline }, CAN_ASK);
      expect(ask.body.result.resultType).toBe('input_required');
      const q = ask.body.result.inputRequests.confirm.params;
      expect(q.message).toMatch(/^Decline 2 waiting requests\? Ada \(chat, .+\); Grace/);
      expect(calls.decideBookings).toBeUndefined();

      const no = await client.modern('tools/call', { name: 'decide_bookings', arguments: decline, inputResponses: { confirm: { action: 'accept', content: { confirm: false } } } }, CAN_ASK);
      expect(no.body.result.structuredContent).toMatchObject({ changed: false });
      expect(calls.decideBookings).toBeUndefined();

      const yes = await client.modern('tools/call', { name: 'decide_bookings', arguments: decline, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } }, CAN_ASK);
      expect(yes.body.result.isError).toBe(false);
      expect(calls.decideBookings).toHaveBeenCalledWith(decline);
    });

    it('counts a filter by what it would match', async () => {
      const { client } = owner({ listBookings: waiting });
      const ask = await client.modern('tools/call', { name: 'decide_bookings', arguments: { approve: false, filter: { event_type: 'chat' } } }, CAN_ASK);
      expect(ask.body.result.inputRequests.confirm.params.message).toMatch(/^Decline 3 waiting requests\?/);
    });

    it('does not ask about a single request, or when the client cannot ask', async () => {
      const one = owner({ listBookings: waiting });
      await one.client.modern('tools/call', { name: 'decide_bookings', arguments: { ids: ['b1'], approve: true } }, CAN_ASK);
      expect(one.calls.decideBookings).toHaveBeenCalledTimes(1);
      const old = owner({ listBookings: waiting });
      await old.client.legacy('tools/call', { name: 'decide_bookings', arguments: decline });
      expect(old.calls.decideBookings).toHaveBeenCalledTimes(1);
    });
  });
});

describe('owner pages', () => {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  function env(over: Partial<PageEnv['CORE']> = {}, oauth: Partial<PageEnv['OAUTH_PROVIDER']> = {}): PageEnv {
    return {
      OWNER_URL: 'https://meet-mcp.example',
      OWNER_NAME: 'Tom Zhou',
      MS_CLIENT_ID: 'ms-client',
      GOOGLE_CLIENT_ID: 'g-client',
      CORE: {
        ping: async () => ok({ contract: 1 }),
        peekApproval: async () => ok({
          link: 'live', id: 'b', title: 'Intro call', when: 'Monday, November 16 at 10:00 AM PST', status: 'pending', length_min: 30, expires_at: null,
          request_ends: 'Monday, November 16 at 10:00 AM PST', link_expires: 'Monday, November 16 at 10:00 AM PST',
          guest_supplied: { warning: 'w', name: '<script>alert(1)</script>', email: 'm@x.com', timezone: 'UTC', answers: { topic: '<img src=x onerror=1>' } },
        } as never),
        decideByLink: async () => ok({ result: 'approved' }),
        finishConnect: async () => ok({ owner: true as const, email: 'tom@outlook.com' }),
        spendAnonBudget: async () => ok({ allowed: true }),
        reportError: async () => ok(undefined),
        ...over,
      },
      OAUTH_PROVIDER: oauth as PageEnv['OAUTH_PROVIDER'],
    };
  }

  it('shows an approval request with guest text escaped and no script allowed', async () => {
    const res = await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env());
    const body = await res.text();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // The approval form posts to itself and redirects nowhere else.
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<img src=x');
    expect(body).toMatch(/Typed by the guest/);
    expect(body).toContain('method="post"');
  });

  it('warns Tom not to share the approval link, and says when it stops working', async () => {
    const body = await (await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env())).text();
    expect(body).toMatch(/Don't share this page's address/);
    expect(body).toContain('stops working on Monday, November 16 at 10:00 AM PST');
  });

  it('explains that the time has passed, without a form or the guest\'s details', async () => {
    const peek = async () => ok({ link: 'time_passed', title: 'Intro call', when: 'Monday, November 16 at 10:00 AM PST', status: 'declined' } as never);
    const res = await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env({ peekApproval: peek }));
    const body = await res.text();
    expect(res.status).toBe(410);
    expect(body).toContain('Time has passed');
    expect(body).toMatch(/declined automatically/);
    expect(body).not.toContain('method="post"');
    expect(body).not.toMatch(/Typed by the guest/);
  });

  it('says an expired link no longer works and points a waiting request to the assistant', async () => {
    const peek = async () => ok({ link: 'expired', title: 'Intro call', when: 'Friday, November 20 at 10:00 AM PST', status: 'pending' } as never);
    const res = await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env({ peekApproval: peek }));
    const body = await res.text();
    expect(res.status).toBe(410);
    expect(body).toContain('Link expired');
    expect(body).toMatch(/Ask your assistant/);
    expect(body).not.toContain('method="post"');
    expect(body).not.toMatch(/Typed by the guest/);
  });

  it('serves its favicon and lets pages show it', async () => {
    const res = await handlePage(new Request('https://meet-mcp.example/favicon.ico'), env());
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toContain('<polygon');
    const page = await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env());
    expect(page.headers.get('content-security-policy')).toContain("img-src 'self'");
    expect(await page.text()).toContain('rel="icon"');
  });

  it('decides only on POST', async () => {
    const decide = vi.fn(async () => ok({ result: 'approved' }));
    await handlePage(new Request('https://meet-mcp.example/a/b.mac'), env({ decideByLink: decide }));
    expect(decide).not.toHaveBeenCalled();
    const res = await handlePage(new Request('https://meet-mcp.example/a/b.mac', { method: 'POST', body: new URLSearchParams({ action: 'approve' }) }), env({ decideByLink: decide }));
    expect(decide).toHaveBeenCalledWith('b.mac', 'approve');
    expect(await res.text()).toContain('Approved.');
  });

  it('starts a connect with PKCE and a state cookie, and refuses a callback without the matching cookie', async () => {
    const start = await handlePage(new Request('https://meet-mcp.example/connect/google'), env());
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location')!);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('access_type')).toBe('offline');
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-wm-connect-google=.+; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);

    const finish = vi.fn(async () => ok({ owner: true as const, email: 'tom@gmail.com' }));
    const state = location.searchParams.get('state')!;
    const forged = await handlePage(new Request(`https://meet-mcp.example/connect/google/callback?code=c&state=${state}`), env({ finishConnect: finish }));
    expect(forged.status).toBe(400);
    expect(finish).not.toHaveBeenCalled();

    const value = cookie.split(';')[0]!.split('=').slice(1).join('=');
    const good = await handlePage(new Request(`https://meet-mcp.example/connect/google/callback?code=c&state=${state}`, { headers: { cookie: `__Host-wm-connect-google=${value}` } }), env({ finishConnect: finish }));
    expect(good.status).toBe(200);
    expect(finish).toHaveBeenCalledWith('google', 'c', value.split('.')[1], 'https://meet-mcp.example/connect/google/callback');
  });

  it('lets the consent form redirect through Microsoft to any client address, with no script', async () => {
    const authRequest = { clientId: 'c', redirectUri: 'http://127.0.0.1:8765/cb', scope: ['wellmet:owner'], state: 's', responseType: 'code' };
    const oauth = {
      parseAuthRequest: vi.fn(async () => authRequest),
      describeConsent: vi.fn(async () => ({ clientName: 'Claude', clientDomain: 'claude.ai', redirectHost: '127.0.0.1', redirectIsLoopback: true })),
      beginConsent: vi.fn(async () => ({ handle: 'h', headers: new Headers() })),
    };
    const res = await handlePage(new Request('https://meet-mcp.example/authorize?client_id=c'), env({}, oauth as never));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    // A form-action list here would block login.live.com and the client's callback.
    expect(csp).not.toContain('form-action');
    expect(csp).toContain("default-src 'none'");
  });

  describe('a consent form posted twice (double-click)', () => {
    const authRequest = { clientId: 'c', redirectUri: 'http://localhost:5000/callback', scope: ['wellmet:owner'], state: 's', responseType: 'code' };
    const memoryKv = () => {
      const m = new Map<string, string>();
      return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) };
    };
    const used = () => { throw new AuthorizationError('access_denied', { description: 'This authorization expired or was already used; start again' }); };
    const post = () => new Request('https://meet-mcp.example/authorize', { method: 'POST', body: new URLSearchParams({ handle: 'h', decision: 'approve' }) });

    it('sends the second post to the same Microsoft address as the first', async () => {
      let calls = 0;
      const oauth = {
        approveConsent: vi.fn(async () => (calls++ === 0 ? { request: authRequest, headers: new Headers() } : used())),
        beginUpstream: vi.fn(async () => ({ state: 'upstream-state', headers: new Headers({ 'set-cookie': 'bind=1; Path=/; Secure; HttpOnly' }) })),
      };
      const e = { ...env({}, oauth as never), OAUTH_KV: memoryKv() };
      const first = await handlePage(post(), e);
      const second = await handlePage(post(), e);
      expect(first.status).toBe(302);
      expect(second.status).toBe(302);
      expect(second.headers.get('location')).toBe(first.headers.get('location'));
      expect(second.headers.get('set-cookie')).toContain('bind=1');
    });

    it('shows "Start again" instead of crashing when there is nothing to replay', async () => {
      const oauth = { approveConsent: vi.fn(async () => used()) };
      // Real timers: it looks for the first post's answer for about 1.5 s first.
      const res = await handlePage(post(), { ...env({}, oauth as never), OAUTH_KV: memoryKv() });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Start again');
    });
  });

  it('signs in through Microsoft after consent, and finishes only for the owner', async () => {
    const authRequest = { clientId: 'c', redirectUri: 'https://claude.ai/cb', scope: ['wellmet:owner'], state: 'client-state', responseType: 'code' };
    const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=xyz' }));
    const oauth = {
      approveConsent: vi.fn(async () => ({ request: authRequest, headers: new Headers() })),
      beginUpstream: vi.fn(async () => ({ state: 'upstream-state', headers: new Headers() })),
      finishUpstream: vi.fn(async () => ({ request: authRequest, data: { verifier: 'v' }, headers: new Headers() })),
      completeAuthorization,
    };
    const approve = await handlePage(new Request('https://meet-mcp.example/authorize', { method: 'POST', body: new URLSearchParams({ handle: 'h', decision: 'approve' }) }), env({}, oauth as never));
    const to = new URL(approve.headers.get('location')!);
    expect(to.origin).toBe('https://login.microsoftonline.com');
    expect(to.searchParams.get('state')).toBe('upstream-state');
    expect(to.searchParams.get('redirect_uri')).toBe('https://meet-mcp.example/oauth/microsoft/callback');

    const done = await handlePage(new Request('https://meet-mcp.example/oauth/microsoft/callback?code=c&state=upstream-state'), env({}, oauth as never));
    expect(done.headers.get('location')).toBe('https://claude.ai/cb?code=xyz');
    expect(completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', props: { owner: true } }));

    completeAuthorization.mockClear();
    const stranger = await handlePage(new Request('https://meet-mcp.example/oauth/microsoft/callback?code=c&state=s'),
      env({ finishConnect: async () => ok({ owner: false as const, reason: 'This scheduler belongs to someone else.' }) }, oauth as never));
    expect(new URL(stranger.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
