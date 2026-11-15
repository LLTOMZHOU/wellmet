/**
 * A tiny MCP client for tests, speaking both protocol eras against any
 * `(Request) => Promise<Response>`:
 *
 * - `legacy`: the 2025 style (no per-request metadata), as Claude Code and
 *   Codex send today. The SDK answers these as a one-event SSE stream.
 * - `modern`: the 2026-07-28 style, with the version, client info and
 *   capabilities in `_meta` and mirrored into headers.
 */

export const MODERN = '2026-07-28';

export interface RpcReply {
  status: number;
  body: { result?: any; error?: { code: number; message: string; data?: unknown } };
}

/** Reads a JSON-RPC reply sent as plain JSON or as an SSE stream (the last `data:` event). */
export async function readReply(res: Response): Promise<RpcReply> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const events = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]!);
    return { status: res.status, body: events.length ? JSON.parse(events.at(-1)!) : {} };
  }
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

export function mcpClient(url: string, send: (request: Request) => Promise<Response>, baseHeaders: Record<string, string> = {}) {
  let id = 0;
  const post = (body: unknown, headers: Record<string, string>) =>
    send(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...baseHeaders, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

  return {
    raw: post,
    async legacy(method: string, params?: Record<string, unknown>): Promise<RpcReply> {
      return readReply(await post({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }, { 'mcp-protocol-version': '2025-06-18' }));
    },
    async modern(method: string, params: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}): Promise<RpcReply> {
      const _meta = {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      };
      const name = typeof params.name === 'string' ? { 'mcp-name': params.name } : {};
      return readReply(await post({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta } }, { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...name }));
    },
  };
}

/** Capabilities of a client that can show forms and open links. */
export const CAN_ASK = { elicitation: { form: {}, url: {} } };
