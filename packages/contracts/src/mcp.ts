/**
 * A small, stateless MCP server over Streamable HTTP: one JSON-RPC message per
 * POST, answered with plain JSON. No sessions and no server-sent events, since
 * every method here answers at once. GET and DELETE get 405, which the
 * transport allows for a server that offers neither stream.
 *
 * Shared by the owner endpoint (behind OAuth) and the public endpoint (no login).
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Returns the tool's value, or throws ToolError for a refusal the agent should read. */
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** A refusal with a message written for the agent: "slot taken, here are nearby times". */
export class ToolError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export async function handleMcp(
  request: Request,
  server: McpServerInfo,
  tools: readonly McpTool[],
  options: { maxBodyBytes: number; onError?: (err: unknown) => void },
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('This MCP endpoint takes POST requests only.', { status: 405, headers: { allow: 'POST' } });
  }
  const text = await request.text();
  if (text.length > options.maxBodyBytes) return rpcError(null, -32600, 'Request too large.', 413);

  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error: the body must be one JSON-RPC message.', 400);
  }
  // One message per POST: a batch would let one request carry many tool calls past rate limits.
  if (Array.isArray(message)) return rpcError(null, -32600, 'Send one JSON-RPC message per request; batches are not accepted.', 400);
  if (!message || typeof message !== 'object' || (message as JsonRpcRequest).jsonrpc !== '2.0' || typeof (message as JsonRpcRequest).method !== 'string') {
    return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
  }
  const msg = message as JsonRpcRequest;

  // Notifications and responses from the client need no answer.
  if (msg.id === undefined || msg.method.startsWith('notifications/')) return new Response(null, { status: 202 });

  const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool "${String(name)}".`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || Array.isArray(args)) return rpcError(msg.id, -32602, 'Tool arguments must be an object.');
      try {
        const value = await tool.run(args);
        return reply(toolResult(value, false));
      } catch (err) {
        if (err instanceof ToolError) return reply(toolResult({ error: err.message, ...(err.data !== undefined ? { details: err.data } : {}) }, true, err.message));
        options.onError?.(err);
        return reply(toolResult({ error: 'The tool failed unexpectedly. It has been logged; try again shortly.' }, true, 'The tool failed unexpectedly. It has been logged; try again shortly.'));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method "${msg.method}" is not supported.`);
  }
}

function toolResult(value: unknown, isError: boolean, text?: string) {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(value, null, 2) }],
    structuredContent: structured,
    isError,
  };
}
