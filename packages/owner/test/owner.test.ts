import { describe, expect, it, vi } from 'vitest';
import { handleMcp, ToolError, type McpTool } from '@wellmet/contracts/mcp';
import { ownerTools, type OwnerCore } from '../src/tools.ts';
import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { handlePage, type PageEnv } from '../src/pages.ts';

const SERVER = { name: 'test', title: 'Test', version: '1', instructions: 'hi' };
const post = (body: unknown) => new Request('https://meet-mcp.example/mcp', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('MCP protocol', () => {
  const echo: McpTool = {
    name: 'echo', title: 'Echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    run: async (a) => { if (a.fail) throw new ToolError('Refused for a reason', { code: 'x' }); if (a.crash) throw new Error('secret detail'); return { got: a }; },
  };

  it('initializes with a version both sides speak', async () => {
    const r = await (await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeDefined();
    const unknown = await (await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(unknown.result.protocolVersion).toBe('2026-07-28');
  });

  it('lists tools and runs one', async () => {
    const list = await (await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(list.result.tools[0]).toMatchObject({ name: 'echo', annotations: { readOnlyHint: true } });
    const r = await (await handleMcp(post(call('echo', { a: 1 })), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(r.result).toMatchObject({ isError: false, structuredContent: { got: { a: 1 } } });
  });

  it('returns refusals as readable tool errors, and hides unexpected ones', async () => {
    const refused = await (await handleMcp(post(call('echo', { fail: true })), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(refused.result).toMatchObject({ isError: true, content: [{ text: 'Refused for a reason' }] });
    const onError = vi.fn();
    const crashed = await (await handleMcp(post(call('echo', { crash: true })), SERVER, [echo], { maxBodyBytes: 1e5, onError })).json();
    expect(JSON.stringify(crashed)).not.toContain('secret detail');
    expect(onError).toHaveBeenCalled();
  });

  it('refuses batches, oversize bodies and other methods; acknowledges notifications', async () => {
    expect((await handleMcp(post([call('echo', {}), call('echo', {})]), SERVER, [echo], { maxBodyBytes: 1e5 })).status).toBe(400);
    expect((await handleMcp(post('x'.repeat(200)), SERVER, [echo], { maxBodyBytes: 100 })).status).toBe(413);
    expect((await handleMcp(new Request('https://x/mcp'), SERVER, [echo], { maxBodyBytes: 1e5 })).status).toBe(405);
    expect((await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), SERVER, [echo], { maxBodyBytes: 1e5 })).status).toBe(202);
    const unknown = await (await handleMcp(post({ jsonrpc: '2.0', id: 3, method: 'resources/list' }), SERVER, [echo], { maxBodyBytes: 1e5 })).json();
    expect(unknown.error.code).toBe(-32601);
  });
});

describe('owner tools', () => {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const core = new Proxy({}, { get: () => vi.fn(() => ok({ done: true })) }) as unknown as OwnerCore;
  const tools = ownerTools(core, { connectLinks: () => ({ outlook: 'o', google_meet: 'g' }), revokeAllAccess: async () => ({ revoked: 2 }) });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  it('offers every planned tool, each with a description and hints', () => {
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

  it('shows the agent every event-type setting in create_event_type', () => {
    const props = Object.keys((byName('create_event_type').inputSchema as { properties: object }).properties);
    for (const k of ['lengths', 'limits', 'schedule', 'confirmation', 'questions', 'location', 'visibility']) expect(props).toContain(k);
  });

  it('turns bad arguments into a message the agent can fix', async () => {
    await expect(byName('create_event_type').run({ slug: 'Bad Slug', title: 'x' })).rejects.toThrow(/lowercase/);
  });

  it('passes a core refusal through with its code', async () => {
    const refusing = new Proxy({}, { get: () => () => Promise.resolve({ ok: false, error: { code: 'slot_taken', message: 'Taken.', details: { alternatives: [1] } } }) }) as unknown as OwnerCore;
    const t = ownerTools(refusing, { connectLinks: () => ({ outlook: '', google_meet: '' }), revokeAllAccess: async () => ({ revoked: 0 }) });
    const err = await t.find((x) => x.name === 'reschedule_booking')!.run({ id: 'b', new_start: '2026-11-17T10:00:00-08:00' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).data).toMatchObject({ code: 'slot_taken', alternatives: [1] });
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
          id: 'b', title: 'Intro call', when: 'Monday, November 16 at 10:00 AM PST', status: 'pending', length_min: 30, expires_at: null,
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
