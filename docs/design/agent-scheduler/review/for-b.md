# Verified review findings for option B

Extracted from the merged review. Findings were checked against your option file and re-rated against frame revision 2.

### Platform facts re-checked today (fetched with `curl`, 2026-11-15)

| Fact a finding hinges on | Result | Source |
|---|---|---|
| The public MCP handler accepts several tool calls in one HTTP POST | **Confirmed.** `createMcpHandler` in `cloudflare/agents` wraps the MCP SDK's `createMcpHandler`. By default (`legacy: 'stateless'`) a body without the per-request envelope is served by `WebStandardStreamableHTTPServerTransport`, which accepts a JSON array of up to `MAX_BATCH_SIZE = 100` messages and a 4 MB body. Checked on the `main` branch of both repos; the newer envelope path was not checked for arrays | `modelcontextprotocol/typescript-sdk`: `packages/server/src/server/requestBody.ts`, `streamableHttp.ts`, `createMcpHandler.ts`; `cloudflare/agents`: `packages/agents/src/mcp/server/handler-stateless.ts` |
| Every RPC call to a Durable Object is a billed request | **Confirmed.** "Every RPC method call on a Durable Objects stub is its own RPC session and therefore a single billed request"; 1 million a month included, then $0.15 per million, rounded up to the next million | developers.cloudflare.com/durable-objects/platform/pricing |
| The Workers spending limit does not cover Durable Objects or KV, and is account-wide | **Confirmed.** "applies to the whole account"; "Durable Objects, Workers KV, R2, and other products have separate charges"; "not an exact maximum bill" | developers.cloudflare.com/workers/platform/spend-management |
| A Free-zone WAF rate-limiting rule cannot be scoped to a hostname | **Confirmed.** Fields available in the rule expression on Free: "Path, Verified Bot". Host starts at Pro. One rule, 10 s period, counted per IP | developers.cloudflare.com/waf/rate-limiting-rules (availability table) |
| An expired Entra client secret is not an `invalid_grant` | **Confirmed in substance.** The page lists `AADSTS7000222` ("The provided client secret keys are expired") and defines `invalid_client` as "Client authentication failed. The client credentials aren't valid"; `invalid_grant` is for bad codes and refresh tokens. The page does not print the pairing on one line. Secret lifetime is "limited to two years (24 months) or less"; Microsoft recommends under 12 months | learn.microsoft.com `entra/identity-platform/reference-error-codes`, `how-to-add-credentials` |
| Registering an Entra app needs more than a personal account | **Confirmed.** Prerequisites: "An Azure account that has an active subscription" and "A workforce or external tenant" | learn.microsoft.com `entra/identity-platform/quickstart-register-app` |
| D1 Time Travel window | **Confirmed.** 30 days on Workers Paid, 7 days on Free | developers.cloudflare.com/d1/platform/limits, `d1/reference/time-travel` |
| Graph `transactionId` | Purpose only ("to avoid redundant POST operations in case of client retries"); nothing on how long the guard lasts or on two creates in flight at once | learn.microsoft.com `graph/api/resources/event` |
| Outlook mails the attendee when an event's time is changed through Graph | **Not confirmed from the page.** The update-event page describes meeting updates for attendee changes and recurring series, not the plain time change. Each option states it itself (A: "Outlook sends the update"; B: "Outlook sends the update"; C: "the guest is notified by Outlook"), and the reschedule-loop findings (A2, C2) rest on those statements. Not measured on a personal mailbox | learn.microsoft.com `graph/api/event-update` |
| Option A's reschedule path has no Graph read | **Confirmed in the option's own inputs.** `a.assumptions.json`, "guest cancel or reschedule": D1 read, D1 conditional update, Graph PATCH or cancel, D1 write. B's and C's lists both carry a "fresh busy check (reschedule only)" hop | `options/a.assumptions.json`, `b.assumptions.json`, `c.assumptions.json` |

---

## 2b. Option B

### Confirmed

| # | Short title | Scenario | Severity under the current frame | Lenses | Component it hits | Cheapest fix | Architecture or detail |
|---|---|---|---|---|---|---|---|
| B1 | One POST to the public `/mcp` can carry about 100 tool calls; `RL_SRC_READ` counts it as one, and the core's single-key limiter is then saturated for everyone at that location (shared, see S1) | S4 | must. The cost half rests on B's own assumed 5 ms per invocation (about 130 million CPU-ms a month against 30 million); at 1 ms it lands just under. The 16 KB body cap still fits about 100 short calls | security | `sched-public` (`RL_SRC_READ` 60 per 60 s per source, `createMcpHandler`); `sched-core` `RL_PUBLIC_ALL` (600 per 60 s, one key) | Reject array bodies on the public MCP route; weight the limiter per message | Detail |
| B2 | The only Outlook check is saga step 1; if the Meet step is retried, the event is created minutes or days later with no second check | R3 | must, narrow: it needs a Meet outage and Tom adding a meeting in the gap. Nothing detects the overlap afterwards | failure | "Booking write order and recovery": "every step is persisted before the next starts"; step 2 retried for 15 minutes, then `needs_attention` until `retry_booking_sync`; step 3 "only after step 2 has a link" | Repeat the verify step, excluding the booking's own event, before step 3 when the last verify is older than about 60 s. Revised A3 (event first, link later) removes the gap | Detail |
| B3 | Global caps close booking for everyone: `pending:all` at 30 open, and `RL_ALL_WRITE` at 20 writes per 60 s on one key (four sources at their own limit) (shared, see S2) | A1 | should. The held-cells half is removed by revised F7; see section 4. Two further routes in the security finding (200 stored requests a day; counters not refunded) depend on how counters are decremented, which the option does not say | security (should); failure, operator, numbers (degrades) | Security, "Abuse limits" layers 1 and 3; `sched-public` bindings | Take cancel and reschedule out of the global write limiter; size `pending:all` from L2 x 72 h; B already has list decline and `update_settings` for limits | Detail |
| B4 | The booking and approve budgets leave out writes the saga requires; with them the option's own sum passes 3,000 ms | T3, T4 | should, by the option's own method (p99 sums of assumed hop figures against a p95 target), so the honest score is "unknown", not "pass (budget), thin". Recomputed: 2,750 + 150 (step persisted between verify/meet and event) + 150 (`op_log` entry for the created event) = 3,050; the in-request deadline (2.6 s) is already below the 2,750 budget | numbers | "Critical path" table against "every step is persisted before the next starts" and the vault's `op_log` ('started' and result rows; update and cancel allowed only for refs in `op_log`) | Fold step persistence into fewer writes, restate the budget, score T3 unknown. Revised R2 makes the Meet `op_log` rows unnecessary | Detail (the hops themselves come from the premise) |

### Disputed

- **"Errors from three of the five Workers have no route into the error log" (O1, must; operator).** Open question: which RPC method carries errors from `sched-public`, `sched-auth` and `sched-mcp` into the core's `errors` table? "Operations" says each Worker "writes structured errors to the core through its existing binding", but the interface list the option calls "the whole inter-Worker surface" (`PublicApi`, `OwnerApi`, `ApprovalApi`) has no such method. The other half of the finding (a fault in `sched-mcp` or `sched-auth` makes `get_health` unreachable) is true of the owner path in all three options and is not specific to B.

### Dropped and moot

- **Moot under revision 2: "Two stacked 45 s caches give up to 90 s of staleness" (R3; failure, numbers).** R3 now allows displayed slots to be up to 5 minutes stale; 90 s is inside it. The commit-time check was never in question.
- **Moot under revision 2: "A restore drops every booking confirmed after the restore point" / "Restore loses bookings, and a vault restore strands live events" (D1; failure, operator).** The core-database case is exactly the outcome revised D1 accepts, and matches the caveat already in B's scorecard. Residual, not verified: after a restore of `sched-vault-db` alone, the vault refuses to cancel or move events whose refs are no longer in its `op_log`, so those bookings stick in `cancelling` instead of failing cleanly. That is the same class of loss (post-restore bookings cannot be managed through the scheduler) but messier.
- Dropped: none.

---

## 3. Shared by all three

Findings and facts that hit every option in the same way. The first two also appear as a row in each option's table because the component and the cost differ.

- **S1. The public MCP endpoint accepts JSON-RPC arrays, and every option's limiter counts HTTP requests (S4, must; security lens; rows A3, B1, C1).** All three build the public endpoint on `createMcpHandler` and say nothing about arrays or per-call weighting. Verified today: by default the handler accepts up to 100 messages in one POST. The frame's own stimulus (10,000 requests a day from one source, 7 a minute) passes every stated limiter and becomes up to 1,000,000 tool calls a day. What that costs differs: CPU-ms in A and B (over C1 on each option's own 5 ms assumption, borderline at 1 ms), Durable Object requests in C (over C1 regardless). Same fix in all three, a detail.
- **S2. A global cap on waiting requests refuses everyone when it is full (A1, should; all four lenses; rows A8, B3, C4).** 30 open in A and B, 20 in C; a handful of sources fill it, and so do 1 to 3 days of ordinary L2 volume if Tom does not decide. Revision 2 says its F7 change "removes the cheap lockout the security review found". It removes the held slots; it does not remove this cap, and with waiting requests no longer competing for slots the cap becomes the only bound on how many can wait.
- **S3. A waiting request holds its slot in every option.** A: `pending` "holds the slot". B: step 0 inserts `slot_cells` for `pending_approval`. C: "every non-terminal state holds its slot claims". Revised F7 (must) says it reserves nothing. Detailed in section 4.
- **S4. No option creates the Outlook event until a Meet link or room exists.** A: `advance()` step 3. B: saga step 3 "only after step 2 has a link". C: step 2b before step 3. Revised A3 (should) asks for the opposite: confirm, add the link later. The same ordering is what opens the stale-re-check window (A9's disputed part, B2, and an unverified degrade in C).
- **S5. All three chose Workers Paid for the 30-day restore window, and all three fail C2 for that reason alone.** D1 now needs 7 days, which the Free plan gives (confirmed). Each option's Revision 1 also removed its Free-plan guards, so going back is not free; see section 4.
- **S6. A host-scoped WAF rate rule does not exist on a Free zone (confirmed).** C turns it on at launch (disputed entry above); A and B name it as the first response to a flood (minor in both).
- **S7. T3 rests on the same guessed provider latencies in all three** (Graph read 900 to 1,000 ms, Graph create 1,100 to 1,300 ms, Meet 900 to 1,000 ms at p99). If any one is twice as slow every option is over 3,000 ms and answers "still working". All three budgets also omit at least one write their own recovery design requires: confirmed for B as B4; visible in the text for A (the lease write in `advance()` step 1) and C (the `intent` write before step 3) too, where the reviewers rated it degrades because the sums stay under 3,000.
- **S8. Registering the Entra app needs an Azure account and a tenant (confirmed), which no option's minutes include.** K8 is now about an hour, so this is probably absorbed. Not timed.
- **S9. Unverified degrades that the reviews raise against all three in the same words:** a phished consent click gives an attacker's client the owner tools (S1); nothing mails Tom when the cron or the Worker itself is what broke; whether a guest's reschedule on an approval-mode event type needs a second approval is not specified; none mentions paging (`$top`, `@odata.nextLink`) on the Graph busy read.

---

## 4. What frame revision 2 asks each option to change

Strictly from the option text. "Could delete" means the option contains machinery whose only stated reason is a requirement that revision 2 removed. "Newly required" means the revised frame asks for something the option text does not do. Nothing here is a redesign.

### Common to all three

- **R5, same request approved twice: already met as written.** A: "the decision is a D1 update `WHERE status = 'pending'`", shared by the email page and `decide_booking`, and `advance()` is leased and uses `transactionId`. B: "Approve (tool or email link) is a conditional `UPDATE ... WHERE status = 'pending_approval'`". C: "a compare-and-swap from `pending_approval`", with one Durable Object per booking. None says what the second caller is told.
- **R5, two overlapping waiting requests: cannot arise today, because of the hold that revised F7 forbids.** Once waiting requests reserve nothing, each option needs an overlap test at approval time, and none has one there (per option below).
- **F7, automatic decline of the other overlapping requests on approval: no option does it.** A side effect worth knowing: no option can tell a guest that their request was declined. A and C say so (A "Worst at", C "Guest notification gap"); in B the only mail binding is locked to Tom's address. The frame does not require that mail.
- **A frame clarification dated the same day, outside revision 2:** approval requests and alerts must arrive in Tom's Outlook inbox. All three send to "Tom's verified address" through a locked `send_email` binding. A's diagram calls it "Tom's Outlook inbox"; B and C do not say which mailbox (B's `OWNER_EMAIL` is also the Google sign-in identity).

### Option B

Could delete or loosen:

- **R3:** the 45 s lives on `slot_cache` and `busy_cache`. The commit-time verify stays.
- **R2:** `createMeetingSpace(opKey)` writes `op_log(opKey, 'started')` before the Google call and the result after it so that a retry returns the stored room; the "one known gap" (a second, unused room) is now acceptable. `op_log` also serves as the list of event refs the vault may update or cancel, which comes from the premise and is not affected.
- **A3:** step 3 "only after step 2 has a link"; parking in `needs_attention` with the slot held when Meet fails for 15 minutes; "No invite is sent without a link".
- **D1:** Revision 1 removed the journal database and moved to Paid for the 30-day window. The scorecard's D1 caveat (a post-restore booking survives in Outlook but loses its row and manage link) is now the outcome the frame accepts. "Hard to reverse: depending on Workers Paid for restore" no longer follows from D1. The option notes that on Free its 15-minute tokens would write 1,084 KV entries a day against a limit of 1,000.
- **K8:** 32 of 30 by the option's own count, now against about an hour.

Newly required, not in the text:

- **F7:** step 0 inserts `slot_cells` for `pending_approval` rows, including S5-downgraded requests and, while Outlook is revoked, "every request is stored as a held approval request". Decline and expiry "delete the cells".
- **R5 and F7:** approval is the conditional update to `claimed`, then steps 1 to 4. The cells were inserted at request time, so approval has nothing to lose to another request. `approve_booking` "accepts a list of ids" and says nothing about a list whose requests overlap.
- **F7:** nothing declines other waiting requests when one is approved.
- **A3:** `CalendarApi.updateEvent(eventRef, {startUtc, endUtc})` takes times only; the meeting URL is an argument of `createEvent`. No method adds a link to an existing event.

