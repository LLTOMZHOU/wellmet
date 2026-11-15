# Verified review findings for option C

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

## 2c. Option C

### Confirmed

| # | Short title | Scenario | Severity under the current frame | Lenses | Component it hits | Cheapest fix | Architecture or detail |
|---|---|---|---|---|---|---|---|
| C1 | Every slot lookup is a billed Durable Object request before any per-source budget is applied, and one POST to `/mcp` can carry 100 of them (shared, see S1) | S4, C1 | must. Unlike A and B this does not rest on a CPU guess: the frame's 10,000 requests a day become 1,000,000 Gate requests a day against 1,000,000 included a month, about $4.35 over C1, and no spending limit covers Durable Objects. Without batching the frame's stimulus stays at 37% and S4 passes; one source at 22 lookups a minute for a month still exceeds the allowance | security (must); operator, numbers (degrades, the non-batch variant) | "Abuse limits": request rate counted per HTTP request; "Lookup budget ... `CalendarGate` memory"; scorecard S4's "at most 600 a day per source reach the Gate" contradicts where the budget is enforced; no body cap stated | Reject array bodies, cap the body, weight the limiter per message, count the per-source budget in the Worker before the Gate, add a Durable Objects spend alert | Detail |
| C2 | Guest reschedules and cancels are not counted, so one instant booking with a victim's address makes Tom's Outlook mail that address up to about 7,200 times a day per source | S5 | must by S5's stimulus; the letter of its measure is still met. Rests on C's own statement that "the guest is notified by Outlook" on each change | security | "Abuse limits" table (no reschedule row); "How a booking is written", Reschedule (PATCH); Security, "Invites to strangers" names only step 3 and Tom's approval | Cap reschedules per booking; count update and cancellation mail in `quota_counters`; keep guest notes out of the event body | Detail |
| C3 | A provider failure that is not `invalid_grant` (an expired Entra client secret) mails nobody; the page then offers nothing and no request is held | A4 | must. One unstated path could save the mail half: whether a drift audit that cannot read Outlook counts as an "audit finding" | failure, operator | "Failure behaviour", row "Microsoft or Google connection revoked or expired" (`invalid_grant` only); "Operations", what reaches Tom unprompted; `connections.status` has `degraded` with nothing said about what sets it; secret expiry is not mentioned anywhere. Owner sign-in uses the same Entra app | Mail on `degraded` lasting 30 minutes and on an audit that could not run; store the secret's expiry, show it in `get_health`, mail ahead | Detail |
| C4 | The global cap of 20 open approval requests refuses everyone once seven sources (or 1 to 2 days of ordinary L2 volume with no decision) have filled it; no cap or digest on the approval mail it generates (shared, see S2) | A1 | should. The held-granules half is removed by revised F7; see section 4 | security (should); failure, operator, numbers (degrades) | "Abuse limits": "Open approval requests: 3 per source and 20 overall ... beyond it the request is refused"; `update_settings` does not cover limits | Bulk decline by source; size the cap from L2 x 72 h; digest approval mail | Detail |
| C5 | The page budget prices `GET /api/v1/page/{slug}` as one D1 read, but that call returns a week of slots, which come from the Gate and, on a cache miss, from Graph | T1 | should. On C's own slot-lookup hops the miss path is 150 + 1,210 = 1,360 ms against 1,000 (p99 sums of assumed figures). At L2 about half of Gate calls miss a 30 s cache, so the p95 is the miss path | numbers | "Public HTTP routes" (`/api/v1/page/{slug}`: "plus the first week of slots"); `CalendarGate` "computes slots"; `c.assumptions.json` page-view hops (150 + 300) | Return event-type details at once and load slots in a second call, or refresh the busy cache from cron. Revised R3 now allows a busy cache of up to 5 minutes, which would also cut the miss rate | Detail |
| C6 | One crawler at the L3 rate uses the 600-a-day per-source lookup budget in 22 to 43 minutes and is refused for the rest of the hour | L3 | should, on the same single-source reading as A10 | numbers | "Abuse limits", "Lookup budget" row; scorecard row L3 tests concurrency only | Raise the budget to about 2,000 a day or make it hourly | Detail |

### Disputed

- **"The launch WAF rule cannot be limited to the scheduler's hostname on a Free zone" (O3, must; operator; rated degrades by numbers).** The platform fact is confirmed: C's "one WAF rate rule on the hostname" cannot be created as written on a Free zone. Open question: since Host is unavailable, is the launch rule dropped, written on path prefixes, or applied to the whole zone? Only the last reaches the personal website, and only then is O3 broken. Also not known: whether the zone is on the Free plan (the options assume it) and whether its one free rule is already in use. What is certain either way: the claims that lean on this rule ("the WAF rule holds one address to at most 2 requests a second", "a blocked request is not a billed invocation") have no basis as written. S4 at the frame's stated size passes without the rule.

### Dropped and moot

- Moot under revision 2: none. None of C's must-or-should findings cites a relaxed scenario.
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

### Option C

Could delete or loosen:

- **R2:** the Meet room pool exists "because the Meet API cannot deduplicate a retried create", so that "one room is a uniqueness constraint": the `meeting_rooms` table, the room claim in the claim batch, the 5-minute refill job, the `spaces.get` check (step 2b), returning or retiring rooms in compensation, and "about a dozen Meet rooms sit idle". The premise's "one Meet room" is now stricter than the frame. (The room created at Google connection also measures U1; that purpose is unaffected.) Three unverified findings are about this pool (a room returned to the pool after its link went out, raised by two lenses; the pool rewound by a restore).
- **R3:** the 30 s busy cache in `CalendarGate`. The re-check at step 2a stays.
- **A3:** "the invite step cannot start without a checked room"; `needs_attention` after 15 minutes of Google being unreachable; "Worst at": "it refuses to confirm when either Microsoft or Google cannot be reached". For Google that is now contrary to A3; for Microsoft it is still what A2 and R3 require.
- **D1:** "Hard to reverse" says the Free plan's 7 days "fails the D1 scenario"; it now passes. C's own fact table lists what else Revision 1 stopped designing around on Free: 500 MB per database, 100,000 Durable Object requests and 13,000 GB-s a day, 10 ms CPU, 50 subrequests. The post-restore `run_audit` re-adoption of bookings from Outlook goes beyond what D1 now asks.
- **K8:** 29 of 30, now against about an hour.

Newly required, not in the text:

- **F7:** "Every non-terminal state holds its slot claims", and approval mode "runs step 1 with state `pending_approval`".
- **R5 and F7:** on approval "a compare-and-swap moves the booking to `held` and claims a room"; the slot claims were made at request time. If the re-check finds a conflict, "the approval is refused with the reason and Tom can decline or call `approve_booking` with `force`". R5 says the second overlapping request is declined, not left open, and `force` is a stated way to approve over the only conflict test that runs at approval (the Outlook one, which is where the first approved request would appear).
- **F7:** nothing declines other waiting requests when one is approved.
- **A3:** no path creates the event without a room; the reschedule PATCH carries start and end only, and "the Meet room stays the same for the life of the booking".
