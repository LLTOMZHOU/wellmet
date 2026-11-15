# Facts gathered before design

Collected 2026-11-14. There is no existing system; this is a new build. Each fact carries a basis: **measured** (observed in this session), **stated** (a named source says so; not independently checked), **assumed** (from memory, unchecked). Treat stated and assumed facts as things a design may rely on only if it says so in its "Riskiest assumption" or scorecard.

## Tom's environment

| Fact | Basis |
|---|---|
| `yuxingzhou.me` uses Cloudflare nameservers and is served through Cloudflare | measured (`dig`, response headers) |
| Wrangler is logged in to Tom's Cloudflare account with write access to Workers, D1, KV, Queues, R2, email routing, email sending and Turnstile widgets | measured (`wrangler whoami`) |
| Whether the account is on the free or the paid Workers plan | unknown |
| Tom's calendar is a personal Outlook.com account; his Google account is a personal Gmail | stated (Tom) |
| Tom's personal website is a separate repo that must not be modified | stated (Tom) |

## Cloudflare platform

| Fact | Basis |
|---|---|
| Free plan: 100,000 Worker requests a day, 5 GB of D1 storage, 5 million D1 row reads a day | stated (Punctual self-hosting guide) |
| Queues and Cloudflare's own email sending to arbitrary recipients need the paid Workers plan | stated (Punctual self-hosting guide) |
| The paid Workers plan is $5 a month; free-plan CPU time is about 10 ms per request, and time waiting on network calls does not count | assumed |
| Durable Objects with SQLite storage are available on the free plan | assumed |
| D1 offers point-in-time restore (Time Travel) covering the last 30 days | assumed |

## MCP authorization on Cloudflare

Source: Cloudflare Agents docs, "Authorization" page, read 2026-11-14 (https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/). All stated.

- The library is `@cloudflare/workers-oauth-provider`. It implements both sides of MCP authorization.
- **Authorization server:** `new OAuthAuthorizationServer({ issuer, resources, scopesSupported, clientIdMetadataDocumentEnabled, clientRegistrationEndpoint })`. The library serves discovery, client registration and the token endpoint. The `/authorize` page is the application's: it signs the user in, asks for consent, and calls `completeAuthorization({ request, userId, metadata, scope, props })`.
- **Resource server:** `new OAuthResourceServer({ resourceMetadata, requiredScopes, validateToken, handler })` wrapped around `createMcpHandler(createServer)` from `agents/mcp/server`. It publishes protected-resource metadata, answers requests without a valid token with 401, and rejects tokens issued for another resource.
- The docs' example puts the two roles in **separate Workers** joined by a Service Binding, and say "one authorization server can issue tokens for several MCP servers, and each can run in its own Worker". An older single-Worker `OAuthProvider` (1.x) exists and has a migration guide.
- Grants and tokens are stored in a KV namespace bound as `OAUTH_KV`.
- `props` passed to `completeAuthorization()` are encrypted and reach tools through `getMcpAuthContext()`. The docs warn that props often hold upstream tokens and must not be logged or returned.
- Sign-in options at `/authorize`: the application's own page, an upstream provider (`beginUpstream()` / `finishUpstream()` for GitHub, Google and others), or Cloudflare Access. Consent helpers: `describeConsent()`, `beginConsent()`, `approveConsent()`, `denyConsent()`.
- Client ID Metadata Documents need the `global_fetch_strictly_public` compatibility flag. Dynamic Client Registration is optional and described as being for older MCP clients.
- Tools can be registered conditionally per request, so a caller never sees tools it cannot use.

## What the three chat clients need

| Fact | Basis |
|---|---|
| ChatGPT custom connectors discover auth through RFC 9728 protected-resource metadata, then RFC 8414 authorization-server metadata; they prefer Client ID Metadata Documents and fall back to Dynamic Client Registration; only user-consented OAuth is accepted, not API keys | stated (OpenAI developer docs and Zuplo, via search summaries) |
| grok.com has custom connectors (added at grok.com/connectors) that take a server URL and sign in with OAuth, using the same discovery sequence | stated (third-party guides only; no xAI primary source found) |
| Claude custom connectors accept a remote MCP server URL and sign in with OAuth | assumed |
| A single stateless Streamable HTTP endpoint with OAuth 2.1 can serve all three | stated (one third-party comparison) |

## Google Meet

| Fact | Basis |
|---|---|
| `POST https://meet.googleapis.com/v2/spaces` creates a Meet room with no calendar event; the scope is `meetings.space.created`; the join link is `meetingUri` in the response | stated (Google's Meet API reference) |
| This works on a personal Gmail account | stated (two GitHub pull requests by one developer; not in Google's docs) |
| On personal accounts the room defaults to guests knocking and the host admitting them | stated (same pull requests) |
| The API does not deduplicate; a retried create makes a second room | stated (same pull requests) |
| A Google OAuth app left in "testing" status has its refresh tokens expire after 7 days; publishing to production (unverified is acceptable for the owner's own use) avoids this | assumed |

## Microsoft Graph and Outlook

| Fact | Basis |
|---|---|
| Personal Microsoft accounts can grant `Calendars.ReadWrite` and `offline_access` to an app registered for personal accounts, with no admin consent | stated (CloudMeet README) |
| Entra client secrets expire (24 months at most) and need rotating | assumed |
| Whether creating an event with attendees on a personal account sends them an invite automatically, and how long an idle refresh token lasts | unknown (frame U4) |

## Prior art, for reference only

- Calendly's hosted MCP server lists 39 owner-side tools: https://developer.calendly.com/docs/mcp/supported-tools
- Punctual is an open-source scheduler on Cloudflare Workers with five MCP tools behind API keys: https://github.com/CCCrafts/punctual

## Tooling note for anyone researching further

In this session the WebFetch tool fails with a model error. Use WebSearch, or fetch a page with `curl` through Bash.
