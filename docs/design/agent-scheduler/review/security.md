# Security review: options A, B and C

Lens: security only. No overall opinion and no winner. Nothing is built, so every finding is a reading of the option files, checked against platform documentation where an option leans on it.

## Platform facts checked for this review

| Fact | Result | Source (fetched 2026-11-15) |
|---|---|---|
| The MCP server transport accepts a JSON array of up to 100 JSON-RPC messages in one HTTP POST, with a 4 MB default body limit | True. `MAX_BATCH_SIZE = 100`, `DEFAULT_MAX_REQUEST_BODY_SIZE = 4 * 1024 * 1024`; the Cloudflare worker transport also treats an array body as several messages | `modelcontextprotocol/typescript-sdk`, `packages/server/src/server/requestBody.ts` and `streamableHttp.ts`; `cloudflare/agents`, `packages/agents/src/mcp/server/worker-transport.ts` |
| A Workers spending limit exists, is account-wide, and does not cover KV or Durable Object charges | True. "applies to the whole account"; "Durable Objects, Workers KV, R2, and other products have separate charges. A Workers spending limit does not apply to those charges"; "not an exact maximum bill" | developers.cloudflare.com/workers/platform/spend-management/ |
| Every RPC call to a Durable Object, and every alarm, is a billed request; 1 million a month included, then $0.15 per million | True | developers.cloudflare.com/durable-objects/platform/pricing/ |
| KV writes: 1 million a month included, then $5.00 per million; 1 GB stored included | True | developers.cloudflare.com/kv/platform/pricing/ |
| Rate-limit bindings count per Cloudflare location, can be exceeded, and accept a `delta` weight per call | True | developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Free-zone WAF rate limiting: 1 rule, counted per IP, 10 s period, 10 s block | True | developers.cloudflare.com/waf/rate-limiting-rules/ |
| OAuth library: tokens and codes stored as hashes; consent page helpers bind the handle to the browser with a `__Host-` cookie and forbid framing; dynamically registered clients expire after 90 days by default; `clientRegistrationCallback` exists; grants can be listed and revoked | True | `cloudflare/workers-oauth-provider` README, `docs/authorization-server.md`, `docs/consent-page.md`, `docs/upstream-sign-in.md`, `storage-schema.md` |
| A Service Binding can be fixed to one named entrypoint | True | developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ |

Not checked: whether Claude, ChatGPT and Grok bind the OAuth `state` to the signed-in user's browser session (it matters for the consent finding in each option), and Outlook.com's own sending limits.

---

## Option A

### Option A / A retried booking call returns another guest's manage link
- **Severity:** breaks a must scenario
- **Scenario:** S3 (and S2)
- **What happens:** `requestBooking()` step 2 computes `dedupe_key = SHA-256(event_type | start_utc | lower(email))` and, if an active booking has it, returns that booking. The return value of `POST /api/bookings` and of the `request_booking` tool includes the status-and-manage URL; a form post is answered with a 303 to `/b/{id}.{mac}`. So: (1) the attacker knows or guesses that alice@example.com has a call with Tom, and sees which start times have vanished from the open-slot list; (2) the attacker posts `{event_type, start: <a taken start>, email: "alice@example.com", name: anything}`; (3) the dedupe check runs before the conflict check, matches Alice's row, and the response hands over Alice's manage URL; (4) the attacker opens the status page, which shows the booking and, once confirmed, its Meet link, and can cancel or reschedule it. A wrong guess costs nothing: it falls through to step 3, gets `slot_taken`, and writes no row, so one source can try 5 pairs a minute (7,200 a day) under `RL_WRITE`. Step 1 cannot stop this, because a real retry must also pass it while its own booking holds the slot.
- **Evidence:** "Booking write: order and recovery", `requestBooking()` step 2; "Public HTTP routes" (`POST /api/bookings` answers 303 to the status page); public tool `request_booking` ("returns status, the status-and-manage URL").
- **Cheapest fix:** A detail. On a dedupe hit return the status only, never the manage URL, unless the caller presents a secret from the first call (a client-chosen idempotency key of at least 128 bits, stored hashed). Give the hit and `slot_taken` the same response shape so the hit is not an oracle either.

### Option A / A reschedule loop makes Tom's Outlook mail a stranger without limit
- **Severity:** breaks a must scenario
- **Scenario:** S5
- **What happens:** (1) The attacker makes one instant booking with a victim's address as the guest email and up to 2,000 characters of chosen text in the answers, which the option writes into the Outlook event body. That is 1 of the 10 daily instant bookings. (2) The response gives the attacker the manage link. (3) The attacker posts `/b/{id}.{mac}/reschedule` to another open slot, again and again. Each one sets `calendar_dirty`, `advance()` sends a `PATCH`, and Outlook mails the victim an update from Tom's address. The only limit on this route is `RL_WRITE`, 5 per 60 s per source, so one source produces up to 7,200 mails a day to a stranger, and a cancel adds one more. Nothing in the abuse table counts reschedules or cancels, and the line "Graph calls: independent of request volume ... plus 2 per accepted booking" does not hold for them. Separately, the option does not say whether the "5 per rolling 24 h" subquery counts cancelled rows; if it counts only active ones, book-then-cancel also loops without limit.
- **Evidence:** "Abuse limits (S4, S5)" table (no reschedule or cancel row); "Booking write", `advance()` step 5; "Public HTTP routes" (`POST /b/{id}.{mac}/reschedule`); Security, "Guest text ... HTML-escaped ... in the Outlook event body".
- **Cheapest fix:** A detail. Cap guest reschedules per booking (2, say), count every update and cancellation mail against the same daily overall counter as invites, add a per-recipient-address daily cap (B has one), count cancelled rows in the quota, and keep guest answers out of the invite body.

### Option A / One POST to the public MCP endpoint can carry 100 tool calls, and the limiter counts it as one
- **Severity:** breaks a must scenario
- **Scenario:** S4
- **What happens:** This depends on a detail the option does not specify: whether the public MCP handler rejects JSON-RPC arrays, and whether the limiter counts tool calls or HTTP requests. As written, `RL_READ.limit({ key: ip })` runs once per request "before any D1 access", and the endpoint is built on `createMcpHandler` plus the MCP SDK, whose HTTP transport accepts an array of up to 100 messages per POST (verified, see table above). No body size cap is stated. So the frame's own stimulus, 10,000 requests in a day from one source (7 a minute, well under 20 per 60 s), becomes 1,000,000 `find_slots` computations a day. At the option's own assumed 5 ms of CPU per served request that is about 150 million CPU-ms a month against 30 million included: either about $2.40 of overage (over C1) or the spending limit trips within a week and every Worker on the account answers 1103 until the billing period ends. Even at 1 ms per call it lands on the allowance. Also, `/public/mcp` is listed under `RL_READ`, not `RL_WRITE`, so `request_booking` through MCP is limited at 20 per 60 s times the batch size; the D1 quotas still hold.
- **Evidence:** "Components", bindings table (`RL_READ`: "public GETs and public MCP"); "Abuse limits" table; "Scaling" (30 million CPU-ms included, spending limit behaviour).
- **Cheapest fix:** A detail. Reject array bodies on the public endpoint, cap the body (B uses 16 KB), and charge the limiter per tool call with the binding's `delta`. Put `request_booking` under `RL_WRITE` whichever door it comes through.

### Option A / Thirty held requests lock everyone else out of booking
- **Severity:** breaks a should scenario
- **Scenario:** A1 (stimulus is S5's "fill Tom's calendar")
- **What happens:** (1) From two sources the attacker makes 10 instant bookings, which uses the overall instant quota for 24 hours. (2) From six sources (5 pending each per 24 h) the attacker submits 30 more requests on the nearest slots; they are stored as `pending` and each holds its slot for up to 72 hours. (3) "Open pending requests overall: 30, then 429" is now reached, so every later request from anyone, on any event type, is refused with 429, and the 30 best slots are no longer offered. (4) Tom declines the 30 through his agent; the attacker repeats with fresh sources. A source is an IPv4 address or an IPv6 /64, and one routed /48 holds 65,536 of the latter, so per-source caps do not slow this. S5's literal measure (10 instant a day) still holds; what fails is that the endpoint stays usable.
- **Evidence:** "Abuse limits (S4, S5)" table (pending per source, open pending overall, "A source is ... IPv6 truncated to /64"); "Booking write" (`pending` ... "holds the slot").
- **Cheapest fix:** A detail, and only partial, because K9 rules out guest verification. Requests that were downgraded by the S5 quota should not hold a slot; evict the oldest downgraded request when the pool is full instead of refusing the new one; key IPv6 sources at /48; add an owner tool that declines every pending request from one source.

### Option A / A stolen owner token can swap in the attacker's Google account, and the swap outlives the token
- **Severity:** degrades
- **Scenario:** S8
- **What happens:** (1) The attacker holds a stolen access token (valid up to 1 hour). (2) It calls `get_connect_links` and receives `/connect/google?t=<10-minute HMAC token>`. (3) The attacker opens the link in their own browser and consents with their own Google account. The callback "exchanges the code, encrypts the refresh token into `connections`, records the Google account email for `get_health`"; nothing compares the account with a pinned owner. (4) From then on every Meet room is created under the attacker's Google account, which owns the spaces and can read their conference records. (5) The token expires and Tom runs `revoke_all_access`; the connection is unchanged. Tom finds out only if he reads the Google email in `get_health`. The link token is also not single use.
- **Evidence:** "The three OAuth flows", flow 3 ("Only a link minted by an authenticated owner tool can start this flow"); Security table, row "Tom at `/connect/google`".
- **Cheapest fix:** A detail. Pin the Google `sub` at the first connection and refuse any other afterwards (B and C both pin); make the link single use; mail Tom whenever a provider connection changes.

### Option A / A phished consent click gives an attacker's client the owner tools
- **Severity:** degrades
- **Scenario:** S1
- **What happens:** Dynamic registration is open (it has to be, K4). (1) The attacker registers a client named "Claude" with its own redirect URI, or starts a flow from its own account in a real chat client. (2) It sends Tom the resulting `/authorize` link. (3) Tom sees the consent page; in the second variant the client name and redirect host are exactly what a genuine flow shows. (4) Tom presses Allow; Microsoft signs him in silently because he has consented before; the code goes to the attacker's redirect, or to the attacker's session at the chat client if that client does not tie `state` to the signed-in browser (not checked). (5) The attacker holds a grant with every owner tool, refreshable for 30 idle days. Nothing tells Tom a new grant exists.
- **Evidence:** "The three OAuth flows", flow 1; Security table rows "Tom at `/authorize`" and "Tom's chat client" ("All owner tools").
- **Cheapest fix:** A detail. In `clientRegistrationCallback` and for metadata-document clients, accept only redirect hosts of the three intended clients; mail Tom on every new grant; show live grants in `get_health`. Scopes with a read-only default (as B has) would shrink what one mistaken click gives away.

### Option A / 110 anonymous requests a day stop Tom adding or re-adding a connector
- **Severity:** degrades
- **Scenario:** F1 (and recovery after S8)
- **What happens:** Registration is capped at 10 a day and `/authorize` page loads at 100 a day, both counted before any sign-in. (1) Shortly after the counters reset, a script posts 10 registrations and loads `/authorize` 100 times (20 minutes from one source at 5 per 60 s, seconds from several). (2) For the rest of that day no new client can register and no consent page loads. (3) Repeated daily, Tom cannot add a connector, and after he uses `revoke_all_access` in response to a stolen token he cannot get back in, which leaves email approval links as his only control. The option accepts the one-day version of this in its own text. A non-hostile variant: visitors' MCP clients that connect to `/public/mcp` find authorization-server metadata on the same origin and may register themselves, spending the same budget of 10.
- **Evidence:** "Abuse limits" table (DCR 10 per day, `/authorize` 100 per day); Security, "Abuse of OAuth endpoints"; "Riskiest assumption" (public MCP on the same origin).
- **Cheapest fix:** A detail. Reject registrations whose redirect host is not on the allowlist before counting them; call `describeConsent()` first and count only requests from valid clients; serve the public MCP from a second hostname on the same Worker (the option already names this fallback).

### Option A / Guest text reaches Tom's agent unmarked by two side doors
- **Severity:** degrades
- **Scenario:** S6
- **What happens:** (1) A guest writes instructions in an answer. (2) The owner tools wrap it in `guest_supplied`, as designed. (3) `advance()` also writes it, HTML-escaped but unlabelled, into the Outlook event body. If Tom's agent has any calendar connector, it reads that event with no marking. (4) `get_health` returns "the most recent error-log rows", and `log` has free `message` and `detail` columns that hold booking transitions and provider errors; the option does not say these exclude guest text (a Graph error can echo the attendee name or address).
- **Evidence:** Security, "Guest text aimed at an AI (S6)"; "MCP tools" (`get_health`); "Data", `log` table.
- **Cheapest fix:** A detail. Leave answers out of the Outlook body or put them under a fixed "typed by the guest" line; never copy guest fields into `log`, or return log rows through the same `guest_supplied` wrapper.

### Option A / A large flood stops every Worker on Tom's account
- **Severity:** degrades
- **Scenario:** S4 beyond its stated size; O3
- **What happens:** The spending limit is the option's backstop for floods. (1) An attacker sends more than about 10 million requests in a billing period (4 a second for a month, or 115 a second for a day), from enough addresses that the per-IP limiter does not matter; refused requests still count as invocations. (2) The limit trips. (3) The documentation confirms the block is account-wide and lasts until the limit is raised or the period ends, so any other Worker Tom runs goes down too, and cron stops, so held bookings and expiries wait. Raising the limit to recover means paying over C1. The limit does not cover KV.
- **Evidence:** "Scaling" ("What happens at that point"); "Operations" ("Shared fate").
- **Cheapest fix:** Zone configuration, not architecture. Turn on the free WAF rate rule at launch (C does) so refused requests stop before the Worker, and set the billing alert below the limit.

### Option A / Link tokens sit in URL paths, and approval expiry depends on cron
- **Severity:** minor
- **Scenario:** S3, S9
- **What happens:** Manage and approval links are `/b/{id}.{mac}` and `/a/{id}.{mac}`, and "Workers Logs is switched on for raw request traces", so working tokens are written to the log for anyone with log access on the account. Separately, an approval link dies when cron moves the row to `expired`; the decide statement is `WHERE status = 'pending'` with no expiry test, and the failure table says expiries wait while cron is down, so a forwarded link keeps working past 72 hours in that case.
- **Evidence:** "Public HTTP routes"; "Approval email"; "Operations" (Workers Logs); "Failure behaviour", Cron row.
- **Cheapest fix:** A detail. Carry the token in the fragment and send it as a header (as B does), or redact paths in logs; add `AND expires_at > now` to the decide statement.

### Option A / One root key with no version
- **Severity:** minor
- **Scenario:** S7
- **What happens:** `MASTER_KEY` derives the token-encryption key, the link key and the source-hash key. If it is suspected leaked, the only response is to rotate it, which by the option's own account kills every manage link already sent and needs both provider tokens re-encrypted in the same step; `connections` has no key-version column. The cost of rotating makes it likely to be put off.
- **Evidence:** "Components", secrets row; "Hard to reverse", `MASTER_KEY`.
- **Cheapest fix:** A detail. Separate secrets for token encryption and links, and a `key_version` column (B and C have one).

### Option A / `unblock_time` and the deploy credential
- **Severity:** minor
- **Scenario:** S8; none
- **What happens:** Two unspecified points. (1) `unblock_time` deletes Outlook events "tagged as a scheduler block"; if the tag is not checked server-side on delete, a stolen token can delete any event on Tom's calendar, since the Graph token has `Calendars.ReadWrite` on all of it. (2) A Cloudflare API token that can deploy any Worker on the account (the website's, for example) can redeploy `scheduler` with code that reads `MASTER_KEY` and both client secrets at run time. The `log` table is pruned at 30 days and the option does not say it records which OAuth client made an owner call, so later attribution is limited.
- **Evidence:** "MCP tools" (`block_time`, `unblock_time`); "Data", `log`; "Operations".
- **Cheapest fix:** A detail. Verify the tag before deleting; log the client id on each owner call; keep the deploy token off shared automation.

**Survived (A)**
- S1, impersonation at sign-in: issuer, audience and pinned Microsoft `sub`; ID token taken from the token endpoint; consent handle bound to the browser and unframeable (library, verified).
- S2, calendar contents: Graph is asked for start, end, show-as and cancelled only; the snapshot stores intervals.
- S5, exact count: quotas are evaluated inside one D1 statement, and the overall cap of 10 holds however many sources are used (subject to the reschedule finding).
- S7: AES-256-GCM under a key held only as a Worker secret; `OAUTH_KV` holds hashes and encrypted props (library, verified).
- S8, literal measure: 3,600 s token life; one tool call revokes every grant (library supports listing and revoking).
- S9: purpose-bound MAC, POST-only action, single use by state change.
- Microsoft reconnect: `/connect/microsoft` can be started by anyone but completes only for the pinned `sub`.
- Mail: the `send_email` binding is fixed to Tom's address, so no code path mails anyone else.
- Authorization at every hop: not applicable inside one process; the only check is the library's route guard, as the option's "Worst at" says. No concrete bypass found.
- Tenant isolation: one owner; guests are separated by the manage MAC (subject to the dedupe finding).

---

## Option B

### Option B / One POST to the public MCP endpoint can carry about 100 tool calls
- **Severity:** breaks a must scenario
- **Scenario:** S4
- **What happens:** This depends on a detail the option does not specify: whether `sched-public` rejects JSON-RPC arrays or counts each message. As written, `RL_SRC_READ` (60 per 60 s per source) counts HTTP requests, and the 16 KB body cap still fits about 100 short `find_slots` calls (150 bytes each, assumed) in one array, which the MCP transport accepts (verified). (1) One source sends the frame's 10,000 requests a day, 7 a minute. (2) That is about 700 `PublicApi` calls a minute, which saturates the core's single-key limiter `RL_PUBLIC_ALL` (600 per 60 s). (3) Because that limiter has one key for everyone, other visitors' calls are refused while it lasts. (4) Up to 864,000 calls a day still reach the core; at the option's assumed 5 ms per invocation that is about 130 million CPU-ms a month against 30 million included, so either about $2 of overage (over C1) or the spending limit trips and all Workers on the account stop. If a cached slot answer really costs 1 ms, usage lands just under the allowance and only the lockout in step 3 remains.
- **Evidence:** "Components", `sched-public` row and "Bodies over 16 KB are rejected"; Security, "Abuse limits" layers 1 and 2; "Scaling" table (CPU assumption).
- **Cheapest fix:** A detail. Reject array bodies on the public MCP route and charge the limiter per message with `delta`.

### Option B / Global caps make locking everyone out cheap
- **Severity:** breaks a should scenario
- **Scenario:** A1 (stimulus is S5's "fill Tom's calendar")
- **What happens:** Three routes, all inside the stated limits. (a) `requests:all` is 200 stored requests a day; one attacker who books and then cancels with the manage token, over and over, reaches 200 and from then on every request from anyone "gets 429 and stores nothing" until the day rolls over. (b) `pending:all` is 30 open at 3 per source: ten sources (IPv6 /64s are free) hold 30 slots for up to 72 hours and every further request is refused. (c) The counters are updated in a D1 round trip before the claim batch; the option does not say they are refunded when the claim then fails, so ten requests aimed at already-taken slots may use up `instant:all` without a single booking and push every real instant booking that day into approval. In the same colo, four sources at 5 writes a minute also saturate `RL_ALL_WRITE` (20 per 60 s, one key).
- **Evidence:** Security, "Abuse limits" layer 3 (counter keys and what each failure returns) and layer 1; "Critical path" hop 3 ("two round trips").
- **Cheapest fix:** A detail, and partial for the same reason as in A. Do not let S5-downgraded requests hold slots; refund counters when the claim fails; make cancelled-by-guest requests count once, not once per cycle; replace the single-key limiters with per-source ones plus a much higher global ceiling.

### Option B / An idempotency key is a bearer secret for the manage link, with no stated strength
- **Severity:** degrades
- **Scenario:** S3
- **What happens:** This depends on details the option does not specify. "A conflict on the idempotency key returns the existing booking", and the stored outcome that is replayed includes the manage link. The header is required but no minimum length is given, and nothing says the replay requires the same request body. Agents choose the key themselves, and a visitor's agent may well use something guessable such as `intro-30-2026-11-20T15:00-alice@example.com`. (1) The attacker posts with that key and any body. (2) The core finds the key hash and replays Alice's outcome, manage link included. (3) The attacker can read, cancel or reschedule her booking. A related gap: the response when a different key collides on the partial unique index `(event_type_id, start_utc, guest_email)` is not specified; if it differs from `slot_taken`, it confirms that this address holds that slot.
- **Evidence:** "Critical path" hop 3 and "Booking write order", step 0 ("Idempotency hit: replay the stored outcome"); "Data", `bookings.idem_key_hash UNIQUE` and the partial unique index; public tool `request_booking`.
- **Cheapest fix:** A detail. Refuse keys shorter than 22 random characters, store a hash of the request with the key and replay only on a match (C does both), and answer a natural-key collision exactly as `slot_taken`.

### Option B / Update and cancellation mail is not clearly counted
- **Severity:** degrades
- **Scenario:** S5
- **What happens:** This depends on a detail the option does not specify: whether `invites:all` (50 a day) counts `updateEvent` and `cancelEvent`. The vault's ceiling of 100 a day is stated for creating events only, and "update or cancel only event refs present in the vault's own `op_log`" has no ceiling. If updates are not counted, the same loop as in A applies: one instant booking with a victim's address, then `rescheduleBooking` through the manage token at 5 per 60 s per source, each sending an update from Tom's Outlook. If they are counted, the attacker instead spends the 50 with 49 reschedules and no further invite, to anyone, can go out that day.
- **Evidence:** Security, hop table row "`sched-core` to `sched-vault`"; "Abuse limits" layer 3 (`invites:all`); `PublicApi.rescheduleBooking`.
- **Cheapest fix:** A detail. Count every call that makes Outlook send mail, cap guest reschedules per booking, and enforce the same ceiling in the vault for update and cancel.

### Option B / A phished consent click gives an attacker's client owner tools
- **Severity:** degrades
- **Scenario:** S1
- **What happens:** Same sequence as in A: an attacker-registered client, or a flow started from the attacker's own account in a real chat client, a link sent to Tom, and a consent page whose facts match a genuine flow. B has two things that limit it: there is no owner session cookie, so Google sign-in is always shown, and Tom can untick `write` and `admin`. But the boxes are ticked unless he acts, and nothing tells him a new grant exists. Whether the chat clients tie `state` to the browser session was not checked.
- **Evidence:** "The three OAuth flows", flow 1; "Owner MCP tools" (scopes and consent checkboxes).
- **Cheapest fix:** A detail. Allowlist redirect hosts in `clientRegistrationCallback` and for metadata-document clients; default `write` and `admin` to unticked; mail Tom on every new grant.

### Option B / Anonymous callers can spend the owner plane's daily budgets, including the approval links
- **Severity:** degrades
- **Scenario:** F1, F7
- **What happens:** `sched-auth-db` allows 20 registrations, 100 authorization starts and 100 approval-link attempts a day, all reachable without signing in. (1) A script posts 100 garbage tokens to `/decide/peek`. `sched-auth` cannot tell a bad token from a good one (the MAC key is in the core), so the budget is spent before validation. (2) For the rest of the day Tom's real approve and decline links fail. (3) The same script spends the 20 and the 100, so Tom also cannot add or re-add a connector that day. If he has just revoked all grants, he has no way to decide requests until the counters reset, and requests expire at 72 hours.
- **Evidence:** Security, "The owner plane has its own strict budgets"; "Approval emails" (`/decide/peek`, `/decide/commit`).
- **Cheapest fix:** A detail. Verify the approval token's MAC in the core before charging the budget (or give `sched-auth` a verify-only path), and count registrations and authorization starts only after the allowlist and client checks pass.

### Option B / The S5 limits are editable through the same agent that reads guest text
- **Severity:** degrades
- **Scenario:** S5 (through S6 or S8)
- **What happens:** `update_settings` (scope `write`) changes "owner display name, default timezone and hours, abuse limits". (1) A guest's notes carry an instruction, or an attacker holds a stolen 15-minute token with `write`. (2) Tom's agent, or the attacker, calls `update_settings` and raises the instant caps. (3) The S5 numbers no longer hold, and the change stays after the token expires. Which limits are editable, and whether `invites:all` and the vault ceiling are among them, is not specified.
- **Evidence:** "Owner MCP tools", `update_settings`; Security, "Abuse limits" layer 3.
- **Cheapest fix:** A detail. Make the S5 ceilings constants that a tool can lower but not raise, or move raising them to `sched.admin` with an email to Tom on every change.

### Option B / The isolation holds at run time but not at build or deploy time
- **Severity:** degrades
- **Scenario:** none (the option's premise)
- **What happens:** (1) All five Workers are packages in one pnpm workspace with shared `contracts` and `domain` packages and are shipped by one `npm run deploy`. A malicious version of any dependency that is bundled into `sched-vault` (or into `domain`) runs inside the vault with `TOKEN_KEK_V1` in scope. (2) The four-host egress rule is "one helper" in the vault's own code; the platform does not enforce it, so that code can call `fetch` directly and send the key anywhere. The same goes for "no outbound `fetch()` anywhere in its code" in the core. (3) The deploy credential is one account-level token: whoever holds it, or any other token on the account that can edit Workers, can redeploy `sched-vault` with code that reads its secrets. The "full compromise" table covers a compromised running Worker, which is the case the split does stop.
- **Evidence:** "Components" (workspace layout, vault row "goes through one helper"); "Operations" (`npm run deploy`); Security, "What a full compromise of each part yields".
- **Cheapest fix:** A detail. Give the vault no third-party run-time dependencies and its own lockfile, say plainly that the egress list is a convention, and keep the deploy token out of any shared automation.

### Option B / A large flood stops every Worker on Tom's account
- **Severity:** degrades
- **Scenario:** S4 beyond its stated size; O3
- **What happens:** Same as in A: past about 10 million requests in a billing period the spending limit rejects every invocation account-wide until it is raised or the period ends, and cron stops with it. B orders its responses better (WAF rule, then block, then alert, then the limit) but the WAF rule is not on at launch. KV writes are outside the limit; B bounds them with the daily budgets above.
- **Evidence:** "Failure behaviour", row "Workers spending limit reached"; "Scaling", first bottleneck.
- **Cheapest fix:** Zone configuration. Turn the WAF rate rule on from the start.

### Option B / The owner MCP limiter runs before the token check and is keyed by source
- **Severity:** minor
- **Scenario:** T4, F3
- **What happens:** `RL_MCP_SRC` is 60 per 60 s per source, "applied before token validation". Tom's calls arrive from the chat provider's egress addresses, which carry other users' traffic too. Anyone who points the same provider at `meet-mcp.yuxingzhou.me/mcp` produces unauthenticated requests from those addresses that spend the same bucket, and Tom's valid calls are then refused. Rate needed: 60 a minute in the same Cloudflare location.
- **Evidence:** "Components", `sched-mcp` row.
- **Cheapest fix:** A detail. Keep the pre-auth limiter for requests without a valid token only, and key the post-auth limit by grant.

### Option B / The Microsoft connection is pinned by email claim only
- **Severity:** minor
- **Scenario:** S1 (calendar connection)
- **What happens:** The vault "requires the ID token's email to equal `OWNER_MS_EMAIL`". No `sub` pin and no issuer or tenant check is stated for this flow (the owner sign-in flow, by contrast, verifies everything). On the `/consumers` endpoint with an Outlook.com address this is very likely sound; it would not be if the app registration ever allowed work accounts, where an administrator can set an arbitrary email on a user.
- **Evidence:** "The three OAuth flows", flow 2.
- **Cheapest fix:** A detail. Check the issuer is the consumer tenant and pin `sub` after the first connection.

**Survived (B)**
- S1, impersonation at sign-in: Google ID token verified against JWKS with `iss`, `aud`, `exp`, `nonce`, `email_verified`, pinned `sub` and email; `__Host-` cookie binds state.
- S2: the vault selects only start, end, show-as, cancelled and all-day; `PublicApi` has no list method and takes no booking id.
- S3, token design: 128-bit MAC over a random UUID, token in the fragment and sent as a header, so it stays out of logs and referrers (subject to the idempotency finding).
- S5, exact count: conditional `UPDATE` on counters, with a per-recipient-address cap as well; the overall cap of 10 holds even if `sched-public` lies about the source.
- S6: guest text only under `guest_supplied`, and explicitly kept out of error messages, logs and tool descriptions.
- S7: ciphertext and key are in different Workers; a database copy, or a compromise of any Worker but the vault, yields no token.
- S8: 15-minute tokens; revoke takes about 60 s to spread (KV); scopes limit a stolen read-only token.
- S9: MAC over booking id and expiry, token in the fragment, single use by conditional update, expiry checked on read.
- Account swap: both provider connections are pinned to Tom's addresses, so a stolen link or token cannot attach another account.
- Authorization at every hop: the core re-validates public input and re-checks scope per owner method; bindings are fixed to one named entrypoint each (verified as a platform feature).
- Repudiation: `audit` rows with actor and client id written in the same batch as each change, kept 90 days.
- Cross-origin: public, sign-in and owner tools are on three origins with a strict CSP on both HTML hosts.

---

## Option C

### Option C / One POST to the public MCP endpoint becomes 100 Durable Object requests
- **Severity:** breaks a must scenario
- **Scenario:** S4 (and C1)
- **What happens:** This depends on a detail the option does not specify: whether the public MCP handler rejects JSON-RPC arrays or counts each message. As written, `RL_PUBLIC_READ` (30 per 60 s) and the WAF rule (20 per 10 s) count HTTP requests; the MCP transport accepts up to 100 messages per POST (verified); no body cap is stated. Every slot lookup is an RPC to `CalendarGate`, and the per-source budget of 600 a day is enforced in the Gate's memory, so a refused lookup is still a billed Durable Object request (the scorecard's "at most 600 a day per source reach the Gate" cannot be true for a check made inside the Gate). (1) One source sends the frame's 10,000 requests a day, each an array of 100 `find_slots` calls. (2) That is 1,000,000 Gate requests a day; the month's included 1,000,000 is gone on day one. (3) A month of it is about 30 million requests, roughly $4.35 over the $5.00 the option says has "no margin". (4) A spending limit would not stop it even if Tom turned it on, because it does not cover Durable Object charges (verified).
- **Evidence:** "Abuse limits" table (request rate, lookup budget "CalendarGate memory"); "Scaling" table (Durable Object requests) and "First bottleneck"; scorecard row S4.
- **Cheapest fix:** A detail. Reject array bodies, cap the body, charge the limiter per message, and count the per-source lookup budget in the Worker before the Gate is called. The cache the option already proposes in front of the Gate would then cover what is left.

### Option C / A reschedule loop makes Tom's Outlook mail a stranger without limit
- **Severity:** breaks a must scenario
- **Scenario:** S5
- **What happens:** Same sequence as in A. (1) One instant booking with a victim's address and up to 1,000 characters of notes, which go into the Outlook event body. (2) The attacker keeps the manage link. (3) `POST /api/v1/manage/{token}/reschedule` in a loop: each one is a `PATCH` and Outlook mails the victim an update. The only limits are the write limiter (5 per 60 s per source) and the WAF rule, so about 7,200 mails a day from one source. The Security section says "The only way the system sends anything to a third party is step 3 of an instant booking or Tom's own approval", which leaves out the reschedule `PATCH` and the cancel call described two sections earlier. Each loop also costs Durable Object requests.
- **Evidence:** "How a booking is written and recovered" (Cancel and Reschedule paragraph); "Abuse limits" table (no reschedule row); Security, "Invites to strangers (S5)".
- **Cheapest fix:** A detail. Cap guest reschedules per booking, count update and cancellation mail in `quota_counters` with the invites, add a per-recipient cap, and keep guest notes out of the invite body.

### Option C / Twenty held requests lock everyone else out of booking
- **Severity:** breaks a should scenario
- **Scenario:** A1 (stimulus is S5's "fill Tom's calendar")
- **What happens:** (1) Two sources use the 10 instant bookings for the day. (2) Seven sources (3 open approvals each) submit 20 requests on the nearest slots; each is `pending_approval` and holds its granules for up to 72 hours. (3) "Open approval requests: 3 per source and 20 overall ... beyond it the request is refused": every later request from anyone is refused. (4) Each of the 20 also sent Tom an approval mail; this option states no cap or digest for those. Tom declines them; the attacker returns from fresh /64s. One unspecified point: these counters live in `quota_counters`, keyed by `day_utc`, but "open" is a level, not a daily count; if the row resets each UTC day, 60 requests can be open inside one 72-hour window.
- **Evidence:** "Abuse limits" table (open approval requests; "Source" definition); "Data", `quota_counters`; "Approval emails".
- **Cheapest fix:** A detail, and partial for the same reason as in A. Do not let quota-downgraded requests hold granules; evict the oldest such request instead of refusing the new one; key IPv6 at /48; digest approval mail after the first few a day.

### Option C / A booking call without a key confirms who holds a slot
- **Severity:** degrades
- **Scenario:** S2
- **What happens:** "A caller that sends no idempotency key is matched on a natural key (event type, start, lower-cased email). A match returns the existing booking's state". (1) The attacker posts `{event, start: <a taken start>, email: "alice@example.com"}` with no key. (2) If Alice holds that slot the answer is her booking's state (confirmed, pending and so on); if not, it is `slot_taken`. (3) The attacker has learned that this address is an attendee at that time, at 5 guesses a minute per source and with no row written on a miss. The option correctly withholds the manage link here; it is the difference between the two answers that leaks. What a fresh idempotency key with the same natural key returns ("duplicate (return the original)") is not specified and should be checked for the same leak, and for whether "the original" includes the manage link.
- **Evidence:** "Critical path", paragraph beginning "A caller that sends no idempotency key"; "How a booking is written", step 1, last column.
- **Cheapest fix:** A detail. Answer a natural-key match exactly as `slot_taken` unless the idempotency key also matches. Agents are already told to send a key, so R2 is unaffected for them.

### Option C / Anonymous OAuth endpoints and plain slot lookups can run up charges nothing caps
- **Severity:** degrades
- **Scenario:** S4 above its stated size; C1
- **What happens:** Two routes, each from one source that stays inside the stated rate limits. (a) "Dynamic registration is open" with no daily cap, and the option does not put `/oauth/register` or `/authorize` under the write limiter. The WAF rule allows 2 requests a second, so one address can make 172,800 registrations a day, each at least one KV write: about 5.2 million a month against 1 million included, about $21 over, plus stored client records for 90 days (library default). At the frame's 10,000 a day it stays inside the allowance (300,000 writes). (b) Without any batching, the read limiter lets one source make 43,200 slot lookups a day, each a Gate request: 1.3 million a month against 1 million included. Three sources at the frame's 10,000 a day do the same. The option's "Scaling" names only the Worker-request route, at 333,000 a day. No blocking limit is on by default, and the one available covers neither KV nor Durable Objects.
- **Evidence:** Security, "Client registration"; "Abuse limits" table; "Scaling", "First bottleneck" (hostile traffic); "Cost" ("no margin under C1").
- **Cheapest fix:** A detail. Allowlist redirect hosts and cap registrations and consent starts per day (as A and B do, with the lockout cost noted there); enforce the lookup budget before the Gate.

### Option C / A phished consent click gives an attacker's client the owner tools
- **Severity:** degrades
- **Scenario:** S1
- **What happens:** Same sequence as in A. The consent page is the only control; a flow started from the attacker's account in a real chat client shows Tom the same client name and redirect host as a genuine one; Microsoft signs him in silently; the grant carries all 23 owner tools, including `approve_booking` with `force`, and nothing tells Tom it exists. Whether the chat clients tie `state` to the browser session was not checked.
- **Evidence:** "The three OAuth flows", flow 1; Security, "Client registration".
- **Cheapest fix:** A detail. Allowlist redirect hosts; mail Tom on every new grant; show live grants in `get_health`.

### Option C / Guest text reaches Tom's agent unmarked through `explain_booking` and the Outlook event
- **Severity:** degrades
- **Scenario:** S6
- **What happens:** (1) A guest writes instructions in the notes. (2) `journal.snapshot` stores "the booking row after the change", which includes name, notes and answers. (3) `explain_booking` returns "the booking's journal as a timeline: every transition, step, retry and external reference"; whether it returns the snapshot, and under what wrapper, is not specified, and the `guest_supplied` rule is stated only for `list_bookings` and `get_booking`. `list_errors` has the same question for provider errors that echo the attendee. (4) The same text is written, escaped but unlabelled, into the Outlook event body, where any calendar connector Tom's agent has will read it.
- **Evidence:** "MCP tools" (`explain_booking`, `list_errors`); "Data", `journal`; Security, "Prompt injection (S6)".
- **Cheapest fix:** A detail. Strip or wrap guest fields in every tool that returns journal or error rows; label or omit guest text in the event body.

### Option C / A room that goes back to the pool may already have been given out
- **Severity:** degrades
- **Scenario:** S2
- **What happens:** This depends on details the option does not specify. Rooms are created with `accessType: OPEN`, so anyone with the link joins without knocking. Compensation returns the claimed room to the pool on the stated ground that "nobody was ever given its link". Two ways that can be false: (a) the room's URL is written to `bookings.meeting_url` in the claim batch, and if the status response for a `held` booking shows it, the guest has it before compensation; (b) at step 3 an event create whose outcome was unknown is probed, not found (Graph read lag), re-posted, and answered with a definite 4xx, which the table maps to "compensate", although the first attempt did create the event and send the invite. In either case the room is later claimed by another guest's booking, and the first person holds a working link into that meeting.
- **Evidence:** "How a booking is written", step 3 and the Compensation paragraph; "Data", `bookings.meeting_url`, `meeting_rooms.state`.
- **Cheapest fix:** A detail. Never return a claimed room to the pool; retire it. Rooms cost nothing and the pool refills every 5 minutes.

### Option C / No browser hardening is stated, and the public page shares an origin with the consent page
- **Severity:** minor
- **Scenario:** S1, S3
- **What happens:** The option names no Content-Security-Policy, `Referrer-Policy` or framing rule for its own pages (the library sets them for the consent page only). The booking page reads `#start=...&name=...&email=...` in script and fills the form. If that script ever writes the fragment into the page unsafely, a crafted link runs script on `meet.yuxingzhou.me`, the same origin as `/authorize`, where it can load the consent page, read its form and submit it in Tom's browser. With no framing rule the pre-filled confirm page can also be framed on another site to collect one-click bookings from that site's visitors' addresses. Neither is a flaw in what is written; both are unguarded.
- **Evidence:** "The one copyable line", fetch-only bullet; Security section (no headers listed); "Public HTTP routes" (all on one host).
- **Cheapest fix:** A detail. The header set B lists (`script-src 'self'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`).

### Option C / One link key for three purposes, and tokens in paths and query strings
- **Severity:** minor
- **Scenario:** S3, S9
- **What happens:** `LINK_KEY` signs manage links (`booking_id, version`), approval links (`booking_id, approval_nonce`) and source keys, with no purpose label stated; a collision between the first two is unlikely but nothing rules it out by construction, and what `version` means is unclear (if it is the booking's version column, links in sent invites break on any change, against the restore claim). Tokens travel in the path (`/m/{token}`, `/approve/{id}.{mac}`, `/api/v1/manage/{token}`) and in a query string (`/status?ref=`), so they reach Workers logs, and `call_log` (kept 90 days) may hold them in D1, which would undo "manage and approval tokens are not stored at all". The decide step is a compare-and-swap on state with no stated expiry test, so a forwarded approval link outlives 72 hours if the sweeper is not running.
- **Evidence:** Security table (manage token, approval link); "Public HTTP routes"; "Data", `call_log`; "Approval emails".
- **Cheapest fix:** A detail. Derive one subkey per purpose (A does), carry tokens in a header or fragment, keep URLs out of `call_log`, test `approval_expires_at` in the decide statement.

### Option C / Account pinning and block deletion are stated loosely; the deploy credential
- **Severity:** minor
- **Scenario:** S1, S8; none
- **What happens:** Unspecified points. (1) Owner sign-in compares the ID token's email and then pins `sub`, but no issuer or tenant check is stated and flow 1 does not name the consumer endpoint; sound if the app registration is personal-accounts-only, as Tom's steps say. (2) The Google callback "pins the Google `sub`"; if it re-pins on each connection instead of comparing, a stolen owner token can attach the attacker's Google account as in A, and the pool would then be created under it. (3) `unblock_time` removes "a busy event in Outlook"; if any event id is accepted, a stolen token can delete any event. (4) As in A, any token that can deploy Workers on the account can replace this Worker and read `TOKEN_KEY` and `LINK_KEY`. (5) The journal's `actor` is one of guest, owner, system, outlook; it does not say which OAuth client acted.
- **Evidence:** "The three OAuth flows", flows 1 and 3; "MCP tools" (`unblock_time`); "Data", `journal`.
- **Cheapest fix:** A detail. State the issuer check, compare against the pin on every later connection, verify the block tag before deleting, record the client id in the journal.

**Survived (C)**
- S1, impersonation at sign-in: pinned Microsoft `sub`; no token exists unless `completeAuthorization` is called; consent and state handling from the library (verified).
- S2, calendar contents: Graph selects start, end, show-as, all-day, cancelled and `transactionId` only.
- S3: 122-bit ids, MAC per booking, wrong token and missing booking give the same 404; the natural-key path withholds the manage link; idempotency keys need 16 characters and a matching request hash.
- S5, exact count: `CHECK (used <= cap)` inside the claim batch; the overall cap of 10 holds however many sources are used (subject to the reschedule finding).
- S7: AES-256-GCM with the provider as associated data and a key version; key held only as a Worker secret; guest data in clear is stated openly.
- S8, literal measure: 3,600 s token life; one tool call revokes every grant.
- S9: MAC over id and a per-request nonce, POST-only action, single use by compare-and-swap.
- Connect tickets: random, single use, 10 minutes, stored hashed; Microsoft connection requires the pinned `sub`.
- S4 at the frame's size without batching: the WAF rule is on from the start and blocks before the Worker.
- Repudiation: a journal row is written in the same batch as every state change and is never pruned.
- Authorization at every hop: not applicable inside one deployable; public and owner surfaces call the same Durable Objects and the only check is in the Worker's routing. No concrete bypass found.
