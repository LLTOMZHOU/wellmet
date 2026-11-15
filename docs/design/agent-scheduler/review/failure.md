# Failure review: options A, B, C

Lens: failure behaviour only (down, slow, wrong data, overloaded; duplicates, replays, out-of-order; A1 to A4, D1, R1 to R4). No overall opinion and no winner.

Read: `frame.md`, `capacity.md`, `options/a.md`, `options/b.md`, `options/c.md` and the three assumptions files. Nothing was built or run; every sequence below is derived from the option text.

Severity rule applied to all three: "breaks a must scenario" is used only where the text as written leads there under every reading I could find. Where one reading is safe and the option simply does not say, the finding is "degrades" and the dependence is stated.

Platform facts checked for this review (fetched with `curl`, 2026-11-15):

| Fact | Result | Source |
|---|---|---|
| `ctx.waitUntil()` lifetime | Up to 30 s after the response is sent; unfinished promises are cancelled | Cloudflare Workers "Context (ctx)", developers.cloudflare.com/workers/runtime-apis/context/ |
| Worker-to-Worker RPC when the caller ends | "if the client disconnects, the server's execution context is canceled immediately... A client that is itself another Worker is considered to have disconnected when its own execution context ends"; extendable with `ctx.waitUntil()` | Cloudflare Workers RPC "Lifecycle", developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ |
| Durable Object in-memory state | A hibernateable object is removed from memory after 10 s without a request; "the in-memory state is discarded". Pending outbound I/O prevents eviction for up to 15 minutes per operation | Cloudflare "Lifecycle of a Durable Object" |
| Durable Object `waitUntil` | "prevents eviction until it settles or for up to 15 minutes... This lets work continue after the client disconnects" | Cloudflare Durable Objects "State" API |
| Durable Object alarms | One alarm per object; at-least-once; retried only 6 times with backoff if the handler throws | Cloudflare Durable Objects "Alarms" API |
| Graph limits per app and mailbox | 10,000 requests per 10 minutes and "Four concurrent requests" | Microsoft Graph throttling limits, Outlook service limits |
| Graph list results | Paged; "Different APIs might have different default and maximum page sizes". The `calendarView` page states no default. Outlook's default of 10 per page is from memory, not confirmed here | Microsoft Graph "Paging" and "List calendarView" |
| Graph `transactionId` | Documented purpose only ("to avoid redundant POST operations in case of client retries"); no statement on how long the guard lasts or on two requests in flight at once | Microsoft Graph `event` resource |
| Expired Entra client secret | AADSTS7000222, an `invalid_client` failure, not `invalid_grant` | Microsoft Entra "Authentication and authorization error codes" |
| OAuth library, validator failure | The resource server "answers `503` when the validator throws"; only a `null` result is a `401` | `workers-oauth-provider` `docs/resource-servers.md` |
| OAuth library, lost refresh response | "The newly issued token and the immediately previous token can both recover a refresh whose response was lost" | `workers-oauth-provider` `docs/advanced-configuration.md` |
| D1 Time Travel | Restore to any minute in the last 30 days | Cloudflare D1 "Time Travel" |

---

## Option A

### Option A / "You are booked" is sent before the Outlook re-check has answered
- **Severity:** breaks a must scenario
- **Scenario:** F4, A2 (also T3)
- **What happens:** (1) `POST /api/bookings`; the insert commits as `accepted` at about 230 ms (p99 of hops 1 to 3). (2) `advance()` starts the Graph re-check, timeout 2.5 s; Graph hangs. (3) The re-check gives up at about 2,730 ms and the `failed` write needs one more D1 round trip (80 ms p99), so about 2,810 ms. (4) The 2.8 s timer has already fired: the visitor gets 202 "you are booked; the invite is on its way". (5) In `waitUntil`, still on "the first, in-request attempt", `advance()` sets `failed (calendar_unreachable)` and releases the slot. (6) No invite ever arrives. A has no mail path to guests, an agent that got 202 has no reason to poll, and the status page's listed states do not include `failed`. The margin is 70 ms minus one D1 write on the option's own numbers. It stops being a tail event when D1 is slow: each D1 call may take up to 3 s, so at 2.8 s the re-check may not have started, and a `calendar_conflict` found after 2.8 s ends the same way.
- **Evidence:** "Booking write: order and recovery", `requestBooking()` step 5 and `advance()` step 2; Failure behaviour, Graph row (2.5 s, 2.8 s) and D1 row (3 s); Critical path hops 1 to 3.
- **Cheapest fix:** Do not say "booked" until `rechecked_at` is stored: before that, answer "received, not yet confirmed". Or cut the re-check timeout to about 2 s and choose 503 or 202 from the re-check state, not from the timer. Detail only.

### Option A / Meet outage: step 2 is gated on `rechecked_at`, and every reading of it breaks something
- **Severity:** breaks a must scenario
- **Scenario:** A3, R3, F4 (which one depends on the reading)
- **What happens:** The guest already holds 202 "you are booked". The re-check passes, Meet fails. Step 2 says the re-check and the Meet create both run only "if `rechecked_at` is null" and then "store `rechecked_at` and `meeting_url`". The option does not say what is stored in this case. (i) `rechecked_at` is stored: every later run skips step 2, `meeting_url` stays null, step 3 stops; Meet is never retried and the booking is `accepted` forever, which contradicts the recovery table and fails A3. (ii) `rechecked_at` is not stored until Meet succeeds: the re-check repeats each minute. No Outlook event exists yet, so Tom's Outlook shows the slot free; he puts a meeting there; the next run sets `failed (calendar_conflict)`. The guest was told "booked" and is never told otherwise. (iii) Meet is retried without a fresh re-check: when Google returns (15 minutes, or days when the Google connection is revoked and "reconnecting re-queues the waiting bookings") the event is created on top of whatever Tom added meanwhile. R3's "re-checks Outlook at commit" is not met and nothing detects the overlap.
- **Evidence:** `advance()` steps 2 to 4; recovery table row "Meet create fails or times out"; Failure behaviour rows "Google Meet unreachable" and "Google connection revoked".
- **Cheapest fix:** Gate the re-check and the Meet create separately; re-run the re-check (ignoring the booking's own `transactionId`) immediately before step 4 whenever it is older than about 60 s; and stop promising "booked" before the event exists. Detail only.

### Option A / A restore leaves D1 behind Outlook with nothing to reconcile them
- **Severity:** breaks a must scenario
- **Scenario:** D1 (on the strict reading of "no confirmed booking is lost"; if an Outlook event alone counts as "not lost", this is "degrades")
- **What happens:** (1) A bad migration runs at time D and is noticed later. (2) `wrangler d1 time-travel restore` to T before D. (3) Every booking confirmed after T has no row: `list_bookings` omits it, `/b/{id}.{mac}` finds nothing, and neither guest nor Tom can cancel or reschedule it through the system (F8, F3). The slot stays blocked only because the Outlook event feeds the busy snapshot. (4) Nothing in A reads Outlook events back into D1: the only Graph read selects `start,end,showAs,isCancelled`, and there is no audit tool. (5) Rows that were `accepted` at T but confirmed later are re-driven by cron: with `rechecked_at` null the re-check sees the booking's own event as busy and sets `failed`; otherwise it re-POSTs with the same `transactionId` days later, and how long Graph's guard lasts is undocumented, so a second event and invite are possible. (6) Bookings cancelled or declined after T come back as `confirmed` or `pending`; a declined request's approval link works again.
- **Evidence:** Data, "Backup" ("There is no second copy outside D1, apart from the Outlook events themselves"); Operations, Rollback; scorecard row D1; `advance()` step 2 (no exclusion of the booking's own event).
- **Cheapest fix:** A reconcile tool run after any restore: list Outlook events carrying a scheduler `transactionId` and re-adopt, cancel or flag each; pause cron while restoring. One new tool; no architecture change.

### Option A / A provider failure that is not `invalid_grant` never reaches Tom
- **Severity:** breaks a must scenario
- **Scenario:** A4
- **What happens:** (1) The Entra client secret expires (24 months at most; the option lists rotating it as a chore Tom must remember). (2) Cron's token refresh fails with AADSTS7000222, an `invalid_client` error. (3) The stated detection rule is "`invalid_grant` on refresh", so `status` is not `revoked` and no mail is sent. (4) Once the access token expires every Graph call fails: after 50 s no slots are offered and each booking attempt is set `failed` and answered 503. (5) Because new bookings fail fast, no row sits in `accepted` for 15 minutes, so the stuck-booking alert does not fire; cron is running, so the cron alert does not fire. (6) The page says "try again shortly" indefinitely, requests are refused not held, and Tom finds out only if he calls `get_health`. The same holds for any persistent refresh failure other than `invalid_grant`.
- **Evidence:** Failure behaviour, rows "Microsoft connection revoked (`invalid_grant` on refresh)" and "Microsoft Graph unreachable"; Operations, "What reaches Tom unprompted" and "Routine chores".
- **Cheapest fix:** Alert on any refresh or Graph failure lasting more than about 30 minutes, and warn 30 days before the secret's expiry. Detail only.

### Option A / Approval and alert mail has no durable record and stops retrying after an hour
- **Severity:** breaks a must scenario
- **Scenario:** F7, A4
- **What happens:** Two sequences. (a) An approval-mode request inserts `pending`; the mail is sent afterwards in `waitUntil`; the isolate dies between the two. No table records that a mail is owed (Data has no outbox; only failed sends are "logged as failed"), so Tom is never mailed, the request holds its slot for 72 hours and expires. (b) The Email Service is down for more than an hour. Mails are "retried by cron for an hour" and then dropped. When mail comes back nothing re-sends them: a revoked-connection alert is "mailed once", so Tom is never told, and every approval request from that hour ages out unseen. A acknowledges A4 is missed while mail is down; it does not say the mail is lost for good.
- **Evidence:** "Approval email"; `requestBooking()` step 4; Failure behaviour, `EMAIL` row; Data (no outbox table).
- **Cheapest fix:** Write an outbox row in the same statement as the state change and retry until delivered or the request expires. One table; detail only.

### Option A / Reschedule has no Outlook re-check at commit
- **Severity:** breaks a must scenario
- **Scenario:** R3 (narrow window)
- **What happens:** (1) Tom adds a meeting in Outlook at 10:00:05. (2) The snapshot is from 10:00:00 and is valid for up to 50 s. (3) A guest reschedules into that slot at 10:00:20: the path is a D1 conditional update with `calendar_dirty = 1`, then a Graph `PATCH`. There is no Graph read on it, and `advance()` only re-checks when `rechecked_at` is null, which it is not for a confirmed booking. (4) Outlook moves the event on top of Tom's meeting and sends the update. If reschedule instead cleared `rechecked_at` (not stated), a move of less than one duration plus buffers would see the booking's own event as a conflict and set a confirmed booking to `failed`.
- **Evidence:** `a.assumptions.json`, "guest cancel or reschedule" hops (no re-check hop); "Booking write" (`calendar_dirty`, `advance()` steps 2 and 5).
- **Cheapest fix:** Add a fresh `calendarView` for the new interval, ignoring the booking's own event, before the conditional update. About 900 ms of the 1,390 ms headroom on that path. Detail only.

### Option A / Cancel arriving while `advance()` is in flight
- **Severity:** degrades
- **Scenario:** F8
- **What happens:** (1) A booking is `accepted`; `advance()` holds the lease and is in step 4, `POST /me/events`. (2) The guest, who was given the status-and-manage link with the 202, presses Cancel. `cancel()` is not described as taking the lease. (3) Step 4 returns and "sets `confirmed`". The option does not say whether that write is conditional on the status. If unconditional, the cancelled booking is confirmed again and the guest's cancel is lost. If conditional, the event and invite exist but the row is `cancelled` with no `calendar_event_id`, and cron's next run, which creates an event whenever `calendar_event_id` is null, either re-posts or leaves a live event for a cancelled booking.
- **Evidence:** "Booking write", states paragraph and `advance()` steps 1, 4, 5; public route `POST /b/{id}.{mac}/cancel`.
- **Cheapest fix:** Make cancel and reschedule take the same lease (or queue behind it) and make every `advance()` write conditional on the status it read. Detail only.

### Option A / Stale snapshot turns every lookup into its own Graph call
- **Severity:** degrades
- **Scenario:** T2, A1 (A2 itself still holds)
- **What happens:** (1) Graph slows; cron's refresh times out; the snapshot passes 50 s. (2) Every lookup now "refreshes it inline". No single-flight lease is described for this (the token refresh has one) and a failed refresh is not remembered. (3) Each lookup holds a Graph request until its timeout, then answers 503. At 20 reads a minute per source, a handful of sources keeps more than four requests open against a mailbox limited to four concurrent. (4) Graph answers 429, which also fails cron's refresh, the commit re-check (the booking is set `failed`) and event creation. The claim "Graph calls: independent of request volume" is true only while cron is succeeding, and the retries land on the dependency that is already struggling.
- **Evidence:** Data, "Consistency"; Abuse limits row "Graph calls" ("Structure, not a limiter"); Failure behaviour, Cron and Graph rows.
- **Cheapest fix:** Take a short D1 lease for the inline refresh and store the last failure time so lookups refuse without calling Graph for 15 to 30 s. Detail only.

### Option A / A D1 insert that times out may still commit
- **Severity:** degrades
- **Scenario:** none (touches R2)
- **What happens:** (1) D1 is slow; the conditional insert takes 3.2 s. (2) The 3 s timeout fires and the visitor gets 503 "try again shortly". (3) The insert commits as `accepted`. (4) Cron runs `advance()` within a minute: Meet room, Outlook event, invite. (5) The guest was told to try again. The same slot returns the existing booking, which is fine. But the page now shows that slot as taken, by their own ghost booking, so a person picks another time and ends with two bookings and two invites. The table's "nothing is half-done" does not cover an insert whose outcome is unknown.
- **Evidence:** Failure behaviour, D1 row; `requestBooking()` step 3; recovery table row 1.
- **Cheapest fix:** After a timed-out insert, re-read by `dedupe_key` in `waitUntil` and mark the row `failed` if nobody was answered. Detail only.

### Option A / Pending cap is a global queue that only Tom or 72 hours can drain
- **Severity:** degrades
- **Scenario:** A1 (overload case of S5)
- **What happens:** (1) Six sources each submit five approval-mode requests (or overflow past the instant quota). (2) Open pending reaches 30. (3) Every further request that needs approval gets 429, and instant event types follow once the day's 10 instant bookings are used. (4) It stays that way until Tom declines the junk or the requests expire at 72 hours; each junk request also holds a real slot.
- **Evidence:** Abuse limits, rows "Pending requests per source" and "Open pending requests overall".
- **Cheapest fix:** Expire unreviewed requests from sources that hit their per-source cap sooner (for example 6 hours), or let one owner call decline them in bulk. Detail only.

### Option A / Concurrent duplicate is told "slot taken" about its own booking
- **Severity:** minor
- **Scenario:** R2
- **What happens:** (1) A double-click or an agent firing twice sends two identical POSTs within about 100 ms. (2) Both pass the step 2 dedupe read before either inserts. (3) The first insert commits. (4) The second's conditional insert finds an active booking overlapping the interval, its own twin, so zero rows change and it answers 409 `slot_taken` with alternatives; the unique-index branch is never reached. (5) A browser shows the second response. There is still one booking, but the visitor is told the slot went to someone else and may book another.
- **Evidence:** `requestBooking()` steps 2 and 3.
- **Cheapest fix:** On zero rows changed, re-read by `dedupe_key` before answering `slot_taken`. Detail only.

### Option A / Busy snapshot may be a truncated first page
- **Severity:** minor
- **Scenario:** A2, R3
- **What happens:** Cron reads the whole booking window in what the option counts as one Graph call per refresh. Graph list results are paged. The option does not mention `$top` or following `@odata.nextLink`. If neither is done, events past the first page are missing from the snapshot and their slots are offered. The commit re-check, which reads a short interval, still refuses the booking, so the cost is slots offered that cannot be booked.
- **Evidence:** Abuse limits row "Graph calls: 2 per minute from cron"; Data, `state.busy`.
- **Cheapest fix:** `$top` at the documented maximum, follow `nextLink`, and treat an unfinished page walk as a failed refresh. Detail only.

### Option A / Recovery loop details that are not pinned down
- **Severity:** minor
- **Scenario:** none
- **What happens:** (a) A Worker that dies after taking the lease blocks cron for the 90 s lease, so "within about 1 minute" is up to about 150 s. (b) `accepted` has no terminal rule: after a long outage cron creates events, and sends invites, for start times already past. (c) Cron takes "up to 20 rows" with no stated order or backoff; a `calendar_dirty` row whose event Tom deleted in Outlook (a gap A names) gets 404 every minute for ever, and 20 such rows starve real work. (d) 72-hour expiry is done only by cron; whether the approve statement itself checks `expires_at` is not stated.
- **Evidence:** `advance()` step 1; recovery table and the sentence after it; "Known gaps" paragraph; "Approval email".
- **Cheapest fix:** Release the lease on a clean stop; fail `accepted` rows at start time; order by `lease_until` with backoff and treat 404 on cancel as done; check `expires_at` in the decide statement. Details only.

### Option A: Survived
- R1: one conditional `INSERT` on a single-writer D1; two simultaneous requests cannot both hold a slot.
- R2, sequential retry: `dedupe_key` returns the existing booking; Graph create retries carry the same `transactionId`; the 90 s lease exceeds the sum of stated timeouts (about 13 s), so two drivers do not overlap.
- R3, lookups: snapshot at most about 31 s old normally, refused past 50 s.
- R4: no failure path found that changes stored UTC times or drops an offset.
- A1: nothing at frame load trips a limit; no availability figure exists to test against.
- A2, Graph failing fast: no slots after 50 s, booking refused with its hold released (the slow case is the first finding).
- A3, link before invite: no Outlook event is created without a `meeting_url`.
- Worker dies between Meet's answer and the D1 write: one orphan room, never sent.
- D1 down: nothing accepted; 503.
- Cron missed: snapshot and tokens refresh inline; request-path alert after 10 minutes.
- KV down: owner MCP answers 503, not 401 (library behaviour checked), so clients are not told their token is bad; public booking and the approval link (D1 only) keep working.
- Lost refresh response from a chat client: library accepts the new or the immediately previous token (checked).
- Rate-limit binding down: fails open; S5 quotas still exact in D1.
- Approval link fetched by a scanner or used twice: POST only, `WHERE status = 'pending'`.
- Reschedule then cancel, or two reschedules, after confirmation: `calendar_dirty` plus absolute `PATCH` converge.
- `waitUntil` continuation: stated timeouts (2.5 s + 4 s) fit inside the 30 s limit (checked).

---

## Option B

### Option B / Two stacked 45 s caches give up to 90 s of staleness
- **Severity:** breaks a must scenario
- **Scenario:** R3 ("stops being offered within 60 s")
- **What happens:** (1) t = 0: a lookup refreshes `busy_cache` (`fetched_at` 0). (2) t = 1 s: Tom adds a meeting in Outlook. (3) t = 44 s: a booking write deletes the `slot_cache` rows for that week (or a lookup arrives for another event type with no cached bucket). (4) The next lookup recomputes `slot_cache` from `busy_cache`, which is 44 s old and therefore not refreshed; `computed_at` = 44. (5) That bucket is served until t = 89 s. Tom's slot is offered 88 s after he took it. The commit-time check still stops the double booking.
- **Evidence:** Data, "How data moves", second bullet ("45 s plus the commit-time re-check gives R3").
- **Cheapest fix:** Give `slot_cache` the `fetched_at` of the busy data it was built from and expire on that, or use 25 s for both. Detail only.

### Option B / A restore drops every booking confirmed after the restore point
- **Severity:** breaks a must scenario
- **Scenario:** D1 (acknowledged by the option as a caveat; same strict reading as for A)
- **What happens:** (1) `sched-core-db` is restored to T. (2) Bookings confirmed after T have no row; their Outlook events, invites and Meet links survive; manage links stop working and Tom has to change them by hand in Outlook. (3) No tool rebuilds rows from Outlook. (4) Bookings cancelled after T return as `confirmed` and hold their cells against a cancelled event. (5) If `sched-vault-db` is the database restored, `op_log` loses the event refs written after T, and the vault will "update or cancel only event refs present in the vault's own `op_log`", so those bookings can no longer be cancelled or moved at all. One thing does hold: with only the core restored, sagas re-driven from T get their stored results back from `op_log`, so no second room or event is made.
- **Evidence:** Operations, "Restore"; scorecard row D1; Security, hop table row `sched-core` to `sched-vault`.
- **Cheapest fix:** A reconcile tool on `OwnerApi` that asks the vault for events carrying a scheduler `transactionId` and re-adopts them; restore core and vault to the same minute. New tool and one vault method; no change to the shape.

### Option B / The only Outlook check can be 15 minutes old, or older, when the event is created
- **Severity:** breaks a must scenario
- **Scenario:** R3 ("re-checks Outlook at commit"; narrow window)
- **What happens:** (1) Step 1 verifies the interval against Graph and is persisted. (2) Step 2, the Meet room, fails and is retried each minute for up to 15 minutes. No Outlook event exists yet, so Tom's Outlook shows the slot free and he books something there. (3) Meet recovers; step 3 creates the event without another check ("every step is persisted before the next starts"). (4) Tom is double-booked and the guest has an invite; nothing detects it. After `needs_attention`, `retry_booking_sync` re-drives from the stored step, so the gap can be days.
- **Evidence:** "Booking write order and recovery", steps 1 to 3 and the sentence before the table; owner tool `retry_booking_sync`.
- **Cheapest fix:** Repeat the verify step (excluding the booking's own event) immediately before step 3 when the last verify is older than about 60 s. One more Graph read on the retry path only. Detail only.

### Option B / Calendar writes other than create have no stated recovery
- **Severity:** degrades
- **Scenario:** F8 (a must, if the unstated detail goes the wrong way)
- **What happens:** Reschedule: (1) new cells are claimed under the same booking id; (2) the busy check passes; (3) `updateEvent` is sent and times out, or the Worker dies after Graph applied it. The option covers only "any failure before the Graph update". There is no `rescheduling` status, the booking is still `confirmed`, and cron selects by `(status, next_attempt_at)`. If `sync_step` does not track this, the result is: Outlook moved and the guest notified, D1 still on the old time, both sets of cells held. Cancel after an ambiguous create: (1) step 3's POST times out but Graph created the event and sent the invite; (2) the guest cancels through the manage link before a retry succeeds; (3) status `cancelling`, `cancelEvent` has no ref to cancel, status `cancelled`; (4) the event and the invite stay. Unlike a create retry, neither path is described as looking the event up by `transactionId`.
- **Evidence:** "Booking write order and recovery", paragraph after the table (Cancel, Reschedule); Data, `bookings` index on `(status, next_attempt_at)`.
- **Cheapest fix:** Add `rescheduling` as a persisted status that cron resumes (the update is absolute, so repeating it is safe), and make cancel look up the event by `transactionId` when no ref is stored. Detail only.

### Option B / Abuse counters are spent before the claim and never refunded
- **Severity:** degrades
- **Scenario:** S5, R2
- **What happens:** Counters are incremented in round trip (a); the claim batch is round trip (b), a separate transaction. (1) An agent that got `still_working` re-POSTs with the same idempotency key ten times instead of polling. Whether the key is looked up before (a) is not stated; if not, each retry increments `instant:all`, and at 10 every instant booking for the rest of the day is downgraded to approval. (2) A request for a slot that is already taken increments the counters, then the batch aborts on a cell conflict; nothing is stored and nothing is decremented. `pending:all` counts open requests, so 30 such losers leave the cap full with no row for Tom to decline until the day key rolls over. (3) A crash between (a) and (b) leaks one unit of each counter, including the event type's daily cap.
- **Evidence:** Critical path, hop 3 (a) and (b); Security, "Abuse limits", layer 3.
- **Cheapest fix:** Put the counter updates in the claim batch, as the other two options do, or look up the idempotency key first and decrement on abort. Changes one hop of the critical path, not the architecture, and returns about 150 ms.

### Option B / Nothing bounds concurrent Graph calls, and a failed refresh is not remembered
- **Severity:** degrades
- **Scenario:** T2, A1 (A2 still holds)
- **What happens:** (1) A lookup with a wide `from`/`to` (no clamp is stated; a 60-day window is nine week buckets) finds the buckets stale. (2) The vault issues one `calendarView` per bucket in parallel. (3) Graph allows four concurrent requests per app and mailbox and answers the rest with 429. (4) The lookup is reported as "unreachable" with Graph healthy, and a booking's verify or create that overlaps it is throttled into `still_working`. (5) When Graph really is slow, each lookup waits 1.5 s, fails, and leaves the cache stale, so the next lookup calls Graph again. "At most once per bucket per 45 s" holds only for successful refreshes and only if concurrent misses are serialised, which is not described. At L2 arrival rates (about one lookup every 86 s) nearly every lookup is a miss, so this is the normal path, not the exception.
- **Evidence:** Data, "How data moves", second bullet; Scaling, "Provider limits"; Failure behaviour, Graph row; `b.assumptions.json` ("up to 2 week buckets in parallel").
- **Cheapest fix:** A small semaphore in the vault (3 reads, 1 reserved for writes), a clamp on lookup range, and a 15 to 30 s negative cache per bucket. Detail only.

### Option B / A 30 s lease with no stated timeout on vault calls
- **Severity:** degrades
- **Scenario:** R2
- **What happens:** (1) Cron drives a saga at step 3; the vault's `POST /me/events` hangs. No per-call timeout is stated for saga steps, and a `fetch` has none by default. (2) The 30 s lease expires. (3) The next cron tick starts a second driver, which sends the same POST while the first is still in flight. Graph's behaviour for two concurrent creates with one `transactionId` is undocumented; if it does not deduplicate them, there are two events and two invites. Separately (checked against the RPC lifecycle doc): when the core's `waitUntil` is cancelled at 30 s, the vault's execution context is cancelled with it, so the window in which a Meet room exists but `op_log` has no result is the whole in-flight call, not "a few milliseconds". A retry that finds an op key `started` but unfinished is not described.
- **Evidence:** "Booking write order and recovery", first paragraph (30-second lease), step 3, and "One known gap".
- **Cheapest fix:** A timeout of about 8 s on every vault call, the lease renewed per step, and the finalize write conditional on the attempt number; the vault finishes its `op_log` write under its own `waitUntil`. Detail only.

### Option B / The email approval channel has a daily budget anyone can spend
- **Severity:** degrades
- **Scenario:** F7
- **What happens:** (1) `sched-auth` counts "100 approval-link attempts a day" in `sched-auth-db`. It cannot verify a token itself; the key is in the core. (2) An anonymous caller posts 100 junk tokens to `/decide/peek` (20 a minute per source allows this in five minutes). (3) The budget is spent, and Tom's real approve and decline links are refused until the next day. He can still decide through MCP, but both owner routes run through `sched-auth`, so the two decision channels are not independent in the way the bulkhead premise suggests.
- **Evidence:** Security, "Abuse limits", paragraph on the owner plane's budgets; "Approval emails"; Failure behaviour, `sched-auth` row.
- **Cheapest fix:** Have the core verify the MAC first and count only well-formed tokens for a pending request, or drop the daily budget for this endpoint and rely on the per-source limiter. Detail only.

### Option B / A claim in flight at the deadline is answered 503 but may commit
- **Severity:** degrades
- **Scenario:** none (touches R2)
- **What happens:** (1) `sched-core-db` is slow; the claim batch is in flight when the 2.6 s deadline passes. (2) "Before the claim" the answer is 503, so the visitor is told to try again. (3) The batch commits as `claimed`. (4) Cron drives the saga and the guest receives an invite for a request they were told had failed. A retry with the same key is replayed correctly; a person who picks another time, because their first slot now shows as taken, gets two bookings.
- **Evidence:** Failure behaviour, `sched-core` row, Slow column; "Booking write order", step 0.
- **Cheapest fix:** On a deadline during the batch, re-read by idempotency key in `waitUntil` and compensate if nobody was answered. Detail only.

### Option B / Global caps close booking until Tom acts or the day rolls over
- **Severity:** degrades
- **Scenario:** A1 (overload case of S5)
- **What happens:** (1) Ten sources each leave three open approval requests: `pending:all` reaches 30. (2) Further approval requests get 429, and instant event types follow once the day's 10 are used, until Tom declines or 72 hours pass; each junk request holds real cells. (3) Separately, `RL_PUBLIC_ALL` (600 a minute, one key) is reached by ten sources reading at their own allowed 60 a minute, after which every visitor's lookup is refused for as long as they keep going. (`requests:all`, 200 a day, cannot be reached while the other caps hold unless counters leak as in the finding above.)
- **Evidence:** Security, "Abuse limits", layers 2 and 3; Components, `sched-core` bindings.
- **Cheapest fix:** Shorter expiry for unreviewed requests from sources at their cap; a bulk decline on `OwnerApi`. Detail only.

### Option B / Provider failures other than `invalid_grant`
- **Severity:** minor
- **Scenario:** A4
- **What happens:** The failure table defines revocation as `invalid_grant`. Operations says Tom is mailed when a connection "is revoked or expired", `get_health` shows the client secret's age, and a saga older than 15 minutes also mails him. Whether an `invalid_client` failure (an expired secret) changes the provider status is not stated, and with no slots offered there may be no saga to age. B is the least exposed of the three here.
- **Evidence:** Failure behaviour, "Outlook connection revoked"; Operations, "What pages someone" and "Monitored".
- **Cheapest fix:** Treat any refresh failure lasting 30 minutes as a status change. Detail only.

### Option B / Busy buckets may be a truncated first page
- **Severity:** minor
- **Scenario:** A2, R3
- **What happens:** Same as for A, per week bucket: a week with more events than one Graph page, read without `$top` or `nextLink` (neither is mentioned), yields a bucket missing the later events and offers their slots. The commit check still refuses.
- **Evidence:** Data, "How data moves", third bullet.
- **Cheapest fix:** As for A. Detail only.

### Option B / A retry with a fresh idempotency key
- **Severity:** minor
- **Scenario:** R2
- **What happens:** `agent.md` tells the agent to generate an `Idempotency-Key`; it is not said to tell it to reuse the key. (1) An agent unsure of its first call retries with a new key. (2) The partial unique index on `(event_type_id, start_utc, guest_email)` rejects the insert and the batch aborts. (3) The response to that conflict is not specified; only an idempotency-key hit "returns the existing booking". If it is reported as `slot_taken`, the agent books a different time and the guest has two bookings.
- **Evidence:** Critical path, hop 3; "The one copyable line"; Data, `bookings` indexes.
- **Cheapest fix:** Map a natural-key conflict to "already booked" with the booking's state, and say "reuse the key on every retry" in `agent.md`. Detail only.

### Option B: Survived
- R1: `slot_cells` primary key inside one `db.batch()` transaction.
- R2, retry with the same key: stored outcome replayed; create retried with the same `transactionId`; finished Meet op key returns the stored room.
- R4: no failure path found that changes stored UTC times or drops an offset.
- A1: no availability figure to test; the booking path adds two D1 databases and two RPC hops, which the scorecard already says.
- A2: slots withheld once caches age out; `still_working` promises nothing; never confirmed without a check.
- A3: no event without a room; 15 one-minute retries; `needs_attention` and mail.
- Email down: outbox row written in the same batch as the request and retried every minute with no cut-off.
- Cron missed: expiry is also checked on read.
- Tokens: refreshed on demand in the vault, so no dependence on cron.
- `sched-public` down or compromised: owner plane and running sagas unaffected (the bulkhead works in this direction).
- Auth or KV outage: the library answers 503 when validation throws (checked), so the option's "401/503" should be 503 and clients keep their grants.
- Lost refresh response: recoverable with the previous token (checked); 15-minute tokens make this path four times busier than in A or C but not less safe.
- Approval link prefetched by a scanner: token is in the fragment; decision is a conditional update.
- Five-Worker deploy or rollback part-way: named in Operations (deploy callee first, keep old methods one release); no additional failure found.

---

## Option C

### Option C / A provider failure that is not `invalid_grant` never reaches Tom
- **Severity:** breaks a must scenario
- **Scenario:** A4
- **What happens:** (1) The Entra client secret expires. (2) The 15-minute keep-warm refresh fails with AADSTS7000222 (`invalid_client`). (3) The stated rule is that `invalid_grant` sets `revoked` and mails Tom; anything else is at most `degraded`, and mail is sent only on "a revoked connection". (4) When the access token expires every Graph call through the Gate fails: lookups return 503 once the 30 s cache is gone. (5) With no slots shown, no booking is submitted, so nothing reaches `needs_attention`; the drift audit cannot read Outlook, and whether that counts as an "audit finding" is not stated. (6) The page offers nothing indefinitely and Tom learns of it only from `get_health`.
- **Evidence:** Failure behaviour, row "Microsoft or Google connection revoked or expired"; Operations, "What reaches Tom unprompted"; Data, `connections.status`.
- **Cheapest fix:** Mail on `degraded` lasting more than 30 minutes and on an audit that could not run; warn before the secret's expiry. Detail only.

### Option C / The in-memory guard may outlive a run that was cancelled, not killed
- **Severity:** degrades (not verified by running; if it holds, F4 and T3 are at stake on every booking that takes the slow path)
- **Scenario:** T3, F4
- **What happens:** (1) A booking runs inline; at 2.5 s the Worker returns 202 and its execution context ends. (2) Cloudflare's RPC lifecycle doc says a callee's context "is canceled immediately" when a calling Worker's context ends; the Durable Object State doc says passing a promise to `waitUntil` "lets work continue after the client disconnects"; the lifecycle doc says pending outbound I/O keeps an object in memory. The option does not say the saga is passed to `waitUntil`. (3) If the run is cancelled, the instance is still alive, so the guard is still set but its promise will never settle. (4) The alarm at 5 s, the sweeper each minute and `retry_booking` all "join the run in flight" and wait on it. (5) The booking stays `held`, with its slot, room and quota, until the object is reset by a deploy or a runtime update. "The guard is a real lock because it dies with its holder" is true for an evicted instance and not for a cancelled request.
- **Evidence:** "How a booking is written and recovered", last paragraph; Critical path, paragraph after the table.
- **Cheapest fix:** Run the saga under `this.ctx.waitUntil()` in the object, give the guard a start time so a joiner takes over after about 30 s, and add "caller disconnects at 2.5 s" to the fault-injection suite. Detail only.

### Option C / The drift audit acts on absence
- **Severity:** degrades (the consequence is cancelled confirmed bookings, so treat it as near a must; no frame scenario has "Graph returns wrong data" as its stimulus)
- **Scenario:** none (closest: D1's "no confirmed booking is lost", and the option's own premise)
- **What happens:** (1) Every 15 minutes the audit reads the booking window and compares confirmed bookings with events by `transactionId`. (2) The read comes back incomplete: a first page only (no `$top` or `nextLink` handling is described, and a 60-day window has more events than one page), or the ledger is read after a booking was finalised that the Outlook read predates. (3) A confirmed booking has no matching event, so the rule "an event Tom deleted in Outlook cancels the booking and releases the slot" fires. (4) If that uses the normal cancel operation, where "a 404 or an already-cancelled event counts as done", the event that in fact exists is cancelled and Outlook mails the guest a cancellation. If it only updates the ledger, the booking is `cancelled` with a live event and invite, and its room is retired. Either way one wrong read undoes real bookings without Tom's involvement.
- **Evidence:** Data, "How data moves", first bullet ("Outlook wins"); Operations, "Monitored" (invariants); "How a booking is written", Cancel.
- **Cheapest fix:** Never act on one negative read: require the event to be missing from a direct `GET` by `calendar_event_ref` on two consecutive audits, cap automatic cancellations per run (for example 2) and mail Tom above that. Detail only.

### Option C / A room can return to the pool after its link has been sent
- **Severity:** degrades
- **Scenario:** R2 ("one Meet room"), K6, under D1
- **What happens:** (a) Restore. (1) The ledger is restored to T. (2) Room R, free at T and since attached to booking X whose invite is out, is `free` again. (3) The stated procedure re-adopts post-T bookings "by their `transactionId`"; whether that re-claims their rooms, and whether public writes are paused until the audit finishes, is not stated. (4) Booking Y claims R by a database update; `spaces.get` passes; Y's invite carries X's link. The rooms are created with open access, so X's guest can walk into Y's meeting. (b) Give-up after an ambiguous create. (1) Step 3's POST times out after Graph created the event; (2) Graph is then unreachable, for example because the connection was revoked, until the slot's start passes; (3) the booking is "marked `failed` and released" with no final probe possible, and compensation returns the room on the stated ground that "nobody was ever given its link", which is false here.
- **Evidence:** Operations, "Restore"; "How a booking is written", Compensation paragraph; Failure behaviour, Graph row.
- **Cheapest fix:** After any restore retire every `free` room and refill; on give-up after an `intent` step, retire the room, never return it. Detail only.

### Option C / Cron is the only thing shown refreshing provider tokens
- **Severity:** degrades
- **Scenario:** A1
- **What happens:** (1) Cron stops for longer than an access token lives (about an hour). The option's own row says "keep-warm... pause". (2) The Gate keeps using the stored access token; the diagram shows refresh grants from cron only. (3) Graph answers 401; lookups fail and sagas, though woken by alarms, cannot call Graph. (4) Booking is down with Graph and the connection both healthy, until cron returns. Whether the Gate refreshes inline is not stated; `connections.token_version` suggests more than one writer was intended.
- **Evidence:** Components, Cron row; Diagram (the `CRON` to `MSID` and `GID` edges); Failure behaviour, Cron row.
- **Cheapest fix:** Refresh inline in the Gate on expiry or 401, using the existing compare-and-swap. Detail only.

### Option C / With the Microsoft connection revoked the page offers nothing
- **Severity:** degrades
- **Scenario:** A4 ("new requests are held")
- **What happens:** (1) The connection is revoked; Tom is mailed within 15 minutes. (2) Lookups return 503 once the 30 s cache expires, so the page and `/agent/{slug}` show no slots. (3) "Requests are held" applies only to a POST naming a specific time, which a visitor cannot produce without a slot list. (4) Until Tom reconnects, visitors cannot leave a request at all. Not silently dropped, but not held either.
- **Evidence:** Failure behaviour, rows "Microsoft Graph" and "Microsoft or Google connection revoked or expired".
- **Cheapest fix:** While `revoked`, offer rule-based times marked unconfirmed and store them as approval requests. Changes the stated stance on A2 for this one state; detail, not architecture.

### Option C / The Outlook re-check can be up to 15 minutes old at the create
- **Severity:** degrades
- **Scenario:** R3
- **What happens:** (1) Step 2a passes and is recorded; step 2b (`spaces.get`) fails and is retried for up to 15 minutes. (2) Tom's Outlook shows the slot free, and he fills it. (3) 2b passes; step 3 creates the event. Whether 2a is repeated when 2b is retried is not stated. (4) The 60 s post-check finds the overlap and mails Tom, after the invite is out. Detected and told, which the other two options do not do, but not prevented.
- **Evidence:** "How a booking is written", steps 2a, 2b, 3 and 5.
- **Cheapest fix:** Re-run 2a with 2b whenever 2a is older than about 60 s. Detail only.

### Option C / Open approval cap is a global queue only Tom or 72 hours can drain
- **Severity:** degrades
- **Scenario:** A1 (overload case of S5)
- **What happens:** (1) Seven sources leave three open approval requests each: 20 overall. (2) Further approval requests are refused, and instant event types follow once the day's 10 are used. (3) It lasts until Tom declines or the requests expire; each holds real granules. C's cap is the lowest of the three.
- **Evidence:** Abuse limits, row "Open approval requests".
- **Cheapest fix:** As for A. Detail only.

### Option C / The Gate's cache and budgets are lost every 10 idle seconds
- **Severity:** minor
- **Scenario:** T1, T2
- **What happens:** The Gate is described as "in-memory state only and no timers", billed only while handling a call, which means it is hibernateable; a hibernateable object is dropped from memory after 10 s idle and "the in-memory state is discarded" (checked). At L2 the Gate sees roughly one call every 43 s, so most calls arrive cold: reload booking intervals from D1, read Graph. The 30 s cache, the "at most 2 Graph reads per minute per bucket" and the 600-a-day lookup budget hold only while traffic keeps it warm. T2's budget assumes the miss path, so it survives; the page-view budget (450 ms) has no Gate or Graph hop although `/api/v1/page/{slug}` returns a week of slots.
- **Evidence:** Components, `CalendarGate` row; Abuse limits, "Lookup budget"; `c.assumptions.json`, page-view hops.
- **Cheapest fix:** Keep the busy cache in the object's SQLite storage with its fetch time. Detail only.

### Option C / Every refused booking POST leaves a Durable Object and an alarm
- **Severity:** minor
- **Scenario:** S4, C1
- **What happens:** (1) A POST for a taken slot mints a UUID, reaches a new `BookingSaga`, and step 0 sets an alarm "before anything is written". (2) The claim fails; no booking exists. (3) The object, its stored id and its alarm remain; the alarm fires 20 s later as a second billable request. Whether such objects delete their storage is not stated. One source at the write limit (5 a minute) makes 7,200 objects and about 14,400 object requests a day, 432,000 a month against 1,000,000 included; three sources pass it, and the fee is already at C1's limit.
- **Evidence:** "How a booking is written", step 0; Critical path, hops 2 and 3; Scaling, Durable Object requests row.
- **Cheapest fix:** Run the cheap refusals (slot already claimed, source over quota) as a D1 read in the Worker before creating the object, and `deleteAll()` when a claim fails. Detail only.

### Option C / Open client registration is an uncapped anonymous KV write
- **Severity:** minor
- **Scenario:** S4, C1
- **What happens:** "Dynamic registration is open" with no daily cap stated, and the two rate-limit bindings are named for the public surface. Each registration writes to `OAUTH_KV`; the edge rule allows about 2 requests a second per address. KV writes past 1,000,000 a month are billed and no spending limit covers them. A and B both cap this per day.
- **Evidence:** Security, "Client registration"; Abuse limits table (no row for it).
- **Cheapest fix:** A daily cap in `clientRegistrationCallback`, as in A and B. Detail only.

### Option C: Survived
- R1: `slot_claims` primary key inside one atomic batch.
- R2: idempotency key plus natural key in the claim batch; a concurrent duplicate is routed to the winner, not told "slot taken"; the natural-key match does not hand out the manage link.
- R3, lookups: busy data at most 30 s old; stale booking intervals can only cause a refused claim.
- R4: no failure path found that changes stored UTC times or drops an offset.
- A1: no availability figure to test; every lookup depends on one singleton object, which the option states.
- A2: nothing offered past the 30 s cache; `held` and `processing` promise nothing.
- A3: no create step without a checked room; 15 minutes, then `needs_attention` and mail.
- D1: restore plus `run_audit` re-adopts post-restore bookings from Outlook by `transactionId`, the only option with a stated reconcile (subject to the room finding).
- Crash at any saga step: write-ahead step rows and probe-before-repeat; three independent resumers. Alarm retries stop after 6 failures (checked); the cron sweeper covers that.
- D1 write with unknown outcome: re-read by key before repeating.
- Ambiguous Graph create: probe by `transactionId`, then repeat with the same id; the remaining in-flight case is named by the option as its riskiest assumption.
- Out-of-order operations: one running operation per booking (unique index) and one object per booking, so cancel and reschedule cannot interleave with confirm.
- Slow Graph: four permits match Graph's limit of four concurrent requests (checked); lookups are shed first and writes keep two.
- Meet down: no create call on the booking path while the pool has rooms; pool refill just pauses.
- Email down: outbox row in the claim batch, resent every 2 minutes with no cut-off.
- KV down: 503 from the library (checked); public booking and email approval unaffected.
- Redeploy mid-saga: one Worker, so no version skew between the code that wrote a step and the code that resumes it.
- Tom deletes or moves an event: the audit converges on Outlook (subject to the audit finding).
