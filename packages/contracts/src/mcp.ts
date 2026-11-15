/**
 * MCP serving for both endpoints (the owner's, behind OAuth, and the public
 * one), on the official SDK (@modelcontextprotocol/server).
 *
 * The SDK speaks the current revision (2026-07-28: `server/discover`,
 * per-request version and capabilities, header checks, elicitation by
 * multi round-trip) and falls back to stateless serving for clients that
 * still use the 2025 `initialize` handshake. What it leaves to us:
 *
 * - Batches. Its 2025 fallback takes a JSON-RPC array of up to 100 calls in
 *   one POST, which would count once against our per-request rate limits.
 *   We refuse arrays before the SDK sees the body.
 * - Error wording. A thrown error's message goes to the caller as is, so
 *   tools here throw ToolError for refusals the caller should read, and
 *   anything else is logged and replaced with a generic message.
 * - Asking for input only where it can work. On the 2025 fallback there are
 *   no client capabilities, so the SDK refuses any elicitation. Tools check
 *   `canElicit` first and otherwise behave as they always did.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  createMcpHandler,
  inputRequired,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Result } from './index.ts';

export { inputRequired, McpServer, type ServerContext };

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

/** A refusal the caller should read: its message (and data) go back as the tool's error. */
export class ToolError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
  }
}

/** Unwraps a core Result: a refusal becomes a ToolError the agent reads. */
export async function value<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new ToolError(r.error.message, { code: r.error.code, ...(r.error.details ?? {}) });
}

export interface ToolDefinition<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Return a plain value (sent as text and structured content), or `inputRequired(...)` to ask the user first. */
  run: (args: z.output<S>, ctx: ServerContext) => Promise<unknown>;
}

/** A tool definition with its schema type erased, so tools of different shapes fit in one list. */
export type AnyTool = ToolDefinition<z.ZodObject>;

/** Keeps each tool's argument types while building a list of them. */
export const defineTool = <S extends z.ZodObject>(t: ToolDefinition<S>): AnyTool => t as unknown as AnyTool;

/** Builds a fresh server with these tools. The SDK wants a new one per request. */
export function buildServer(info: McpServerInfo, tools: readonly AnyTool[], onError?: (err: unknown) => void): McpServer {
  const server = new McpServer({ name: info.name, title: info.title, version: info.version }, { instructions: info.instructions });
  for (const t of tools) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations }, async (args, ctx) => {
      try {
        const value = await t.run(args as z.output<z.ZodObject>, ctx);
        return isInputRequiredResult(value) ? value : toolResult(value, false);
      } catch (err) {
        if (err instanceof ToolError) return toolResult({ error: err.message, ...(err.data !== undefined ? { details: err.data } : {}) }, true, err.message);
        onError?.(err);
        return toolResult({ error: UNEXPECTED }, true, UNEXPECTED);
      }
    });
  }
  return server;
}

const UNEXPECTED = 'The tool failed unexpectedly. It has been logged; try again shortly.';

function toolResult(value: unknown, isError: boolean, text?: string): CallToolResult {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return { content: [{ type: 'text', text: text ?? JSON.stringify(value, null, 2) }], structuredContent: structured, isError };
}

/**
 * Serves one HTTP request to an MCP endpoint. `build` makes the server for
 * this request (it may capture per-request things such as the caller).
 */
export async function serveMcp(
  request: Request,
  build: () => McpServer,
  options: { maxBodyBytes: number; onError?: (err: unknown) => void },
): Promise<Response> {
  let forward = request;
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > options.maxBodyBytes) return rpcError(-32600, 'Request too large.', 413);
    // One message per POST: a batch would let one request carry many tool calls past rate limits.
    if (text.trimStart().startsWith('[')) return rpcError(-32600, 'Send one JSON-RPC message per request; batches are not accepted.', 400);
    forward = new Request(request.url, { method: 'POST', headers: request.headers, body: text });
  }
  const handler = createMcpHandler(build, {
    maxRequestBodySize: options.maxBodyBytes,
    ...(options.onError ? { onerror: options.onError } : {}),
  });
  return handler.fetch(forward);
}

const rpcError = (code: number, message: string, status: number) =>
  Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });

// --- Elicitation -------------------------------------------------------------------------

/**
 * Whether this request's client can show the user a form ("form") or ask to
 * open a link ("url"). Only clients on the current revision say so; on the
 * 2025 fallback this is always false.
 */
export function canElicit(ctx: ServerContext, mode: 'form' | 'url'): boolean {
  const envelope = (ctx.mcpReq as { envelope?: Record<string, unknown> }).envelope;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const e = caps?.elicitation;
  if (!e || typeof e !== 'object') return false;
  // An empty object means form mode only (spec: elicitation, capabilities).
  if (mode === 'form') return 'form' in e || Object.keys(e).length === 0;
  return 'url' in e;
}

export type UserAnswer<T> = { action: 'accept'; content: T } | { action: 'decline' | 'cancel' } | undefined;

/**
 * The user's answer to the input request named `key`, if the client is
 * retrying with one. Form content is checked against `schema`; content that
 * fails is treated as no answer, so the tool asks again.
 */
export function userAnswer<T>(ctx: ServerContext, key: string, schema?: z.ZodType<T>): UserAnswer<T> {
  const raw = ctx.mcpReq.inputResponses?.[key] as { action?: unknown; content?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.action === 'decline' || raw.action === 'cancel') return { action: raw.action };
  if (raw.action !== 'accept') return undefined;
  if (!schema) return { action: 'accept', content: undefined as T };
  const parsed = schema.safeParse(raw.content ?? {});
  return parsed.success ? { action: 'accept', content: parsed.data } : undefined;
}

export type { InputRequiredResult };
