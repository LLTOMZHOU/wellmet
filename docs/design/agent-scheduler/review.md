# Verification of the four reviews against frame revision 2

Written 2026-11-15 by an independent verifier who wrote none of the options or reviews. Scope: every finding that any of `review/security.md`, `failure.md`, `operator.md`, `numbers.md` rates "breaks a must scenario" or "breaks a should scenario", re-rated against `frame.md` as it stands after "Frame revision 2", then checked against the option text. No winner is picked and the options are not ranked.

Terms used below:

- **confirmed**: the described sequence follows from what the option file says (section named in the table).
- **disputed**: the outcome depends on something the option does not say; the open question is given.
- **dropped**: the option already handles it.
- **moot under revision 2**: the scenario was relaxed so the described outcome is now acceptable.

## 1. Counts

Findings are merged first: when several lenses raised the same root cause for one option it is one entry. The raw must-or-should findings were 14 for A, 9 for B and 8 for C; merged they are 11, 7 and 7.

| | Option A | Option B | Option C |
|---|---|---|---|
| Confirmed, breaks a must | 7 | 2 | 3 |
| Confirmed, breaks a should | 3 | 2 | 3 |
| Disputed | 1 (see note) | 1 | 1 |
| Dropped | 0 | 0 | 0 |
| Moot under revision 2 | 1 | 2 | 0 |
| Unverified degrades-or-minor (raw findings, all four lenses, after removing those merged into an entry above) | 27 | 31 | 29 |

Notes on reading the table:

- **Option A's columns add to 12, not 11.** One failure finding (the Meet-outage path) is split: its A3 part is confirmed at "should", and its R3 part is disputed. It is listed in both places.
- **The counts are not a ranking.** A finding lands in "confirmed" when the option text is specific enough to follow the sequence step by step, and in the unverified degrades when the text is silent. Several of B's and C's equivalents of A's confirmed findings sit in their unverified column for that reason (for example B's reschedule mail, B's expired client secret, C's stale re-check).
- **No "degrades" finding is promoted to a must or should by revision 2.** The ones examined for this were: every finding that touches approval (none describes a double approval that produces two events; all three options make a second approval of the same request a no-op), the pending-cap findings (merged into the lockout entries below), and C's "drift audit acts on absence" (revision 2 makes Outlook the record of confirmed meetings, and this is the one mechanism in any option that cancels a meeting on its own, but D1's stimulus is a damaged database, not a wrong Graph read, so it stays where the reviewers put it).
- **Each option's unverified column includes one K8 finding** ("hands-on time is over 30 minutes"). K8 is now "about an hour", which very likely makes all three moot. Not verified.
- Two of the confirmed musts (the reschedule mail loop in A and C) break S5 by its stimulus ("make Tom's Outlook send invites to strangers"); the letter of S5's measure counts instant bookings only and is still met. They are counted as musts and flagged where they appear.

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

## 2a. Option A

### Confirmed

| # | Short title | Scenario | Severity under the current frame | Lenses | Component it hits | Cheapest fix | Architecture or detail |
|---|---|---|---|---|---|---|---|
| A1 | A booking call that repeats another guest's event type, start and email is handed that guest's manage link | S3 (S2) | must | security | `requestBooking()` step 2: "If an active booking has it, return that booking"; `POST /api/bookings` form post "answers 303 to the status page"; `/b/{id}.{mac}` is the "status and manage page"; public `request_booking` "returns status, the status-and-manage URL" | On a dedupe hit return the status only; give the manage URL back only against a caller-chosen secret from the first call, stored hashed; make the hit and `slot_taken` look the same | Detail |
| A2 | Guest reschedules and cancels are not counted, so one instant booking with a victim's address makes Tom's Outlook mail that address up to 7,200 times a day per source | S5 | must by S5's stimulus; the letter of its measure (number of instant bookings) is still met. Rests on A's own statement that Outlook mails the attendee on each move | security | "Abuse limits" table (no row for reschedule or cancel; `RL_WRITE` 5 per 60 s covers "manage POSTs"); `advance()` step 5 PATCH; guest text goes "in the Outlook event body" | Cap reschedules per booking; count update and cancellation mail against the daily invite counters; keep guest answers out of the event body | Detail |
| A3 | One POST to `/public/mcp` can carry 100 tool calls and `RL_READ` counts it as one (shared, see S1) | S4 | must. The cost half rests on A's own assumed 5 ms of CPU per served request (about 150 million CPU-ms a month against 30 million included); at 1 ms it lands on the allowance | security | "Components": `RL_READ` covers "public GETs and public MCP", applied "before any D1 access"; `createMcpHandler`; no body cap stated | Reject array bodies on the public endpoint, cap the body, weight the limiter per tool call | Detail |
| A4 | The "you are booked" answer is chosen by a 2.8 s timer, not by whether the Outlook re-check has answered; the booking can then be set `failed` with nobody told | F4, A2 | must, as a tail event: it needs Graph to hang to its 2.5 s timeout (or answer "conflict" late) while the request's own D1 calls take more than about 300 ms together. The option allows 3 s per D1 call | failure | `requestBooking()` step 5 ("raced against a 2.8 s timer ... respond 202 `accepted` ('you are booked; the invite is on its way')"); `advance()` step 2 ("set `failed` ... nothing was promised"); status page lists no `failed` state; no mail path to guests | Do not say "booked" until `rechecked_at` is stored; choose 503 or 202 from the re-check's state, not from the timer | Detail |
| A5 | A provider failure that is not `invalid_grant` (an expired Entra client secret) mails nobody and refuses requests rather than holding them | A4 | must | failure, operator | "Failure behaviour", row "Microsoft connection revoked (`invalid_grant` on refresh)"; "Operations", the list of what reaches Tom unprompted (a connection revoked, a booking stuck 15 minutes, cron not seen); bookings fail fast as `calendar_unreachable`, so the stuck-booking mail does not fire; secret rotation is a "routine chore". Owner sign-in uses the same secret | Treat any refresh failure lasting about 30 minutes as a broken connection (same mail, same pending mode); record the secret's expiry, show it in `get_health`, mail 30 days ahead | Detail |
| A6 | Approval and alert mail is sent from `waitUntil` with no record that it is owed, and failed sends are retried for one hour only | F7 (also A4) | must, narrow: it needs the isolate to die between the insert and the send, or a mail outage longer than an hour | failure | `requestBooking()` step 4; "Failure behaviour", `EMAIL` row ("retried by cron for an hour"); "Data" has no outbox table; a revoked-connection alert is "mailed once" | An outbox row written with the state change and retried until sent or the request expires | Detail (one table) |
| A7 | A reschedule moves the Outlook event without a fresh Outlook read | R3, on the F8 and F3 paths | must. The window is the snapshot's age (50 s at most as written) | failure, operator | `advance()` step 2 runs only "if `rechecked_at` is null", which is false for a confirmed booking; step 5 PATCHes; `a.assumptions.json` reschedule hops have no Graph read | A fresh `calendarView` for the new interval, ignoring the booking's own event, before the conditional update; on conflict leave the booking as it was | Detail |
| A8 | The global cap of 30 open pending requests answers 429 to everyone once six sources (or 1.5 to 3 days of ordinary L2 volume with no decision) have filled it (shared, see S2) | A1 | should. Revision 2 removes the other half of this finding, the held slots, by changing F7; see section 4 | security (should); failure, operator, numbers (degrades) | "Abuse limits": "Open pending requests overall: 30, then 429"; owner tool `decide_booking` takes one request | Bulk decline by list or source; evict the oldest S5-downgraded request instead of refusing the new one; size the cap from L2 x 72 h | Detail |
| A9 | When the first Meet create fails, step 2 as written never retries it, and no Outlook event is made until a link exists | A3 | should (was must: A3 is now a should and asks for the opposite order). The R3 part of the same finding is disputed, below | failure | `advance()` step 2 gates both the re-check and the Meet create on "`rechecked_at` is null" and then stores `rechecked_at`; step 3 "stop here"; the recovery table says "Cron retries each minute", which the steps do not do | Gate the re-check and the Meet create separately. Under revised A3: create the event after the re-check and add the link when it arrives | Detail (step order; revision 2 asks for the reorder anyway) |
| A10 | One crawler at the L3 rate (28.1 requests a minute) is refused by `RL_READ` (20 per 60 s) about 29% of the time | L3 | should, on the reading that L3's crawler is one source producing the whole 20x. The many-sources half of L3 passes. Arithmetic recomputed: 2,025 a day / 24 x 20 / 60 = 28.1 | numbers | "Components", `RL_READ`; scorecard row L3 tests concurrency only | Raise `RL_READ` to 40 per 60 s (S4's 10,000 a day is 7 a minute) | Detail |

### Disputed

- **Stale Outlook check when the event is created late (R3, must; part of A9).** Open question: when a failed Meet create is retried minutes or days later, is the Outlook re-check repeated immediately before `POST /me/events`? The steps as written store `rechecked_at` once; the recovery table implies a retry but does not say what is re-run. If A adopts revised A3 (event first, link later) the question disappears.

### Dropped and moot

- **Moot under revision 2: "A restore leaves D1 behind Outlook with nothing to reconcile them" / "Restoring the database discards bookings confirmed since" (D1; failure, operator).** D1 now counts Outlook as the record of confirmed meetings and says losing the scheduler's row and manage link for a booking made after the restore point is acceptable. Residual, not verified: a row that was mid-flight at the restore point is re-driven by cron and re-posts with the same `transactionId`; whether Graph still deduplicates it days later is undocumented (R2).
- Dropped: none.

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

### Option A

Could delete or loosen:

- **R3 (5 minutes):** the cron refresh of the busy snapshot "at second 0 and second 30 of every minute" and the 50 s cut-off with its inline Graph refresh (the "fallback only" hops, 980 ms, on slot lookups and public agent calls) were sized for 60 s. The commit re-check in `advance()` step 2 is still required. Note that A7's window is the snapshot age, so a longer snapshot widens it.
- **A3:** `advance()` step 3 ("If `meeting_url` is still null, stop here. Nothing has been sent") and the rule "no Outlook event, and so no invite, exists until a link does".
- **R2:** nothing to delete. The orphan-room window A already accepts in its recovery table is now inside the measure.
- **D1 (7 days, Outlook is the record):** "Data, Backup" gives the 30-day window as "the main reason this option is on Paid". That reason is gone. Revision 1 also dropped the Free-plan accommodations (cron advances 20 bookings a run instead of 3; no guard for the 10 ms CPU cap, the 50-query cap or the daily request cap), and "Hard to reverse" says moving back means re-adding them.
- **K8:** the 29-of-30 estimate now sits against about an hour.

Newly required, not in the text:

- **F7:** `pending` is defined as "waiting for Tom; holds the slot", the conditional insert refuses any overlap with an active booking, and the pending caps live in the same statement.
- **R5 and F7:** approval is a status update followed by `advance()`. The overlap test exists only in the request-time insert. After two overlapping requests are approved, the only check between them is the Outlook re-check in `advance()` step 2, which sees the first booking only once its event has been created.
- **F7:** nothing declines other waiting requests when one is approved.
- **A3:** no step creates the event without `meeting_url`, and step 5's PATCH is for moves and cancels, not for adding a link. The 15-minute mail to Tom already exists.

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
