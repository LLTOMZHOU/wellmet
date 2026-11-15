# Re-check of the revised options (Revision 2) against review.md and frame revision 2

Written 2026-11-15 by a re-reviewer who wrote none of the options, reviews or the verification. Inputs: `frame.md`, `review.md`, `options/a.md`, `b.md`, `c.md` as they stand. No winner is picked and the options are not ranked. Nothing was built or run; every verdict is a reading of the option text.

Verdicts:

- **fixed**: the failure sequence in review.md no longer follows from the option text.
- **partly fixed**: part of the sequence still follows; what remains is stated.
- **not fixed**: the sequence still follows.

The counts in section 4 are not a ranking. An option whose text is more specific gives a reviewer more to follow step by step, so it collects more findings; C also changed the most, so more of it was in scope.

---

## 1. Fix check

### Option A

| Finding | Verdict | Where, and what remains |
|---|---|---|
| A1 (must, S3): repeat call handed another guest's manage link | fixed | `requestBooking()` step 2: the only match is `retry_key = SHA-256(retry_token + event_type + start + email)`; Security table row "Caller repeating a booking call". A repeat without the token gets `slot_taken` or a separate waiting request. A side effect is new finding A-2 |
| A2 (must, S5): uncounted reschedules and cancels | fixed | "Abuse limits": 2 guest reschedules per booking (`WHERE reschedule_count < 2`), 40 mails a day ceiling; `advance()` 2e: guest answers not in the event body. The ceiling counts guest moves only; Tom's own moves are his decision |
| A3 (must, S4): 100 tool calls in one POST | fixed | Routes table (`/public/mcp` refuses arrays with 400), 16 KB cap, "Tool calls per public MCP request: 1" |
| A4 (must, F4/A2): "booked" chosen by a timer | fixed | `requestBooking()` step 4: 409, 503 or "booked" is chosen by the re-check state; the 2.8 s timer applies only after `rechecked_at` is stored. Status page now lists `failed` |
| A5 (must, A4): failures other than `invalid_grant` | fixed | "Failure behaviour", row "Microsoft connection broken": `invalid_client` at once, anything else after 30 minutes, same mail and hold mode; `MS_SECRET_EXPIRES_ON` in `get_health` and mailed 30 days ahead. The expiry date is a hand-maintained var |
| A6 (must, F7): mail owed but not recorded | fixed | "Mail to Tom": `outbox` row in the same D1 batch, cron is the only sender, retried until the row expires |
| A7 (must, R3): reschedule without an Outlook read | fixed | `reschedule()`: fresh `calendarView` ignoring the booking's own event before the conditional update |
| A8 (should, A1): cap of 30 waiting requests refused everyone | partly fixed | Cap 100, eviction, bulk decline ("Abuse limits"; `decide_booking`). The ordinary-volume route is closed (60 at L2 against 100). The hostile route remains: eviction applies only to `downgraded` rows, so 20 sources each filing 5 requests on an approval-mode event type fill the cap with rows that are never evicted, and "only if there is none is the new request refused with 429". The rollout starts every event type in approval mode |
| A9 (should, A3): Meet never retried; no event until a link | fixed | `advance()` 2e creates the event with or without a link; step 3 adds it; cron selects `calendar_dirty` rows |
| A10 (should, L3): crawler refused 29% of the time | fixed | `RL_READ` 40 per 60 s against 28.1 |
| Disputed (R3): re-check before a late create | fixed | `advance()` 2a to 2d: every create is preceded by a fresh `calendarView` in the same run |
| Rev 2: a waiting request reserves nothing | fixed | States table (`pending` holds nothing); step 3 of `requestBooking()` |
| Rev 2: approving one declines overlapping waiters | fixed | `advance()` 2c, in the batch that stores `rechecked_at`, after the Outlook check has passed. It runs for every committed booking, instant ones included |
| Rev 2: R5 | fixed | `decide()`: one conditional update with `NOT EXISTS (committed overlap)`; four stated outcomes including "already approved" |
| Rev 2: relaxed A3 | fixed | `advance()` 2e and 3; after 15 minutes one mail and one attempt every 10 minutes, with no end |
| Rev 2: Outlook re-check at commit | fixed | `advance()` 2c; also on approval and on every move |

### Option B

| Finding | Verdict | Where, and what remains |
|---|---|---|
| B1 (must, S4): 100 tool calls in one POST | fixed | `sched-public` row and routes table (array refused with 400; 16 KB cap); core limiter split into `RL_PUBLIC_READ_ALL` and `RL_PUBLIC_WRITE_ALL` |
| B2 (must, R3): event created long after the only check | fixed | "Booking write order and recovery": an attempt is check plus create with nothing persisted between; a retry starts from a fresh read |
| B3 (should, A1): global caps close booking for everyone | partly fixed | `RL_ALL_WRITE` deleted; `pending:all` 120 with displacement instead of refusal ("Abuse limits" layer 3). What remains, stated and accepted by the option: `requests:all` (500 a day, never refunded) still refuses everyone, and is reached by 50 sources at their daily limit of 10. A source is an IPv4 address or an IPv6 /64. Removing `RL_ALL_WRITE` also removed the only global bound on reschedules (new finding B-1) |
| B4 (should, T3/T4): budgets left out required writes | fixed | "Critical path" lists two writes and no vault write; T3 and T4 scored unknown |
| Disputed (O1): no error route from three Workers | fixed | `reportError(code, message)` on `PublicApi`, `OwnerApi`, `ApprovalApi`; component set from the entrypoint |
| Rev 2: a waiting request reserves nothing | fixed | "Approval mode": step 0 inserts no cells |
| Rev 2: approving one declines overlapping waiters | fixed | Deciding, step 2: same batch as the cell claim. Note it runs before the Outlook check (new finding B-4) |
| Rev 2: R5 | fixed | Deciding, steps 1 and 2: conditional update to `approving`; primary key on `slot_cells` |
| Rev 2: relaxed A3 | fixed | Hops 6 and 7; "Meet follow-up" with `attachMeetingLink`. Automatic retries stop at 15 minutes; after that only `retry_booking_sync` |
| Rev 2: Outlook re-check at commit | fixed | Step 1 of every attempt |

### Option C

| Finding | Verdict | Where, and what remains |
|---|---|---|
| C1 (must, S4/C1): every lookup a billed Durable Object request | fixed | "Abuse limits": lookups are edge cache then one D1 read; arrays refused; 16 KB cap; booking attempts counted in D1 before the Durable Object. On Free nothing is billed |
| C2 (must, S5): uncounted reschedules and cancels | fixed | "Abuse limits", "Guest changes": 3 per booking, 20 a day overall, one cancel; notes not in the event. The global 20 is itself a small lockout (new finding C-7) |
| C3 (must, A4): failures other than `invalid_grant` | fixed | "Failure behaviour", rows for the calendar refresh and for revoked connections: `degraded` on any failure, mail at once or after 30 minutes, mail when the refresh or audit could not run, secret expiry stored, requests kept as waiting requests |
| C4 (should, A1): cap of 20 waiting requests refused everyone | partly fixed | Cap 100, mail at 80, `decline_bookings`, digest, settable caps. Ordinary-volume route closed. Hostile route remains: "beyond it the request is refused", and 34 sources at 3 open each fill it; it stays full until Tom acts on the 80% mail |
| C5 (should, T1): page call returned slots | fixed | Routes table: `/api/v1/page/{slug}` is details only |
| C6 (should, L3): crawler exhausted the lookup budget | fixed | Budget removed. Margin is thinner than the scorecard says (section 3) |
| Disputed (O3): WAF rule on a Free zone | fixed | No rule is created; no claim rests on one |
| Rev 2: a waiting request reserves nothing | fixed | "Waiting requests (F7)"; `slot_claims` notes |
| Rev 2: approving one declines overlapping waiters | fixed | "Approval (R5)": in the approving booking's finalize batch |
| Rev 2: R5 | fixed | Compare-and-swap plus primary key; `force` removed |
| Rev 2: relaxed A3 | partly fixed | Step 5 confirms without a link and retries for 15 minutes. After that nothing retries and the retry tool was removed (new finding C-2) |
| Rev 2: Outlook re-check at commit | fixed | Step 2a, also on approval and reschedule |

---

## 2. New findings

### Shared by all three (counted once per option in section 4)

### Options A, B, C / On the Free plan one source can switch the service off until midnight UTC
- **Severity:** breaks a should scenario
- **Scenario:** A1 (and the "cannot exhaust quotas" half of S4 at ten times its stimulus)
- **What happens:** (1) All three revisions moved to Workers Free, where the account has 100,000 requests a day and a request refused by the in-Worker limiter still counts. (2) One source sends about 70 requests a minute for a day, or a few sources send faster; almost all are refused, all are counted. (3) The cap is reached; every dynamic route answers error 1027 until 00:00 UTC, as does any other Free-plan Worker on Tom's account. (4) The stated remedy is to move to Paid after it has happened twice in a month. One such day is 3.3% of a month against A1's 0.5%. The frame's S4 stimulus (10,000 a day) passes in all three.
- **Evidence:** A "Scaling", first bottleneck, and "Worst at"; B "Scaling", first bottleneck, and row "Daily request quota reached"; C "Scaling", first bottleneck. All three disclose it and score A1 unknown.
- **Cheapest fix:** Decide the plan at the decision step with this in view (Paid plus a spending limit trades the outage for a capped bill). Detail, not architecture.

### Options A, B, C / An approval can be declined against a hold that then evaporates
- **Severity:** minor
- **Scenario:** R5, F7
- **What happens:** (1) An instant booking, or another approval, has claimed time T but has not yet passed its Outlook check. (2) Tom approves an overlapping request; it loses to the claim and is set to declined. (3) The first booking's Outlook check then fails for a reason that does not rule out the second (Graph unreachable; a conflict that covers only part of the interval), so the first is released. (4) The declined request is terminal and its guest is not told. Needs two decisions inside about 3 seconds.
- **Evidence:** A `decide()` third bullet with `advance()` 2c; B deciding step 2 with attempt step 1; C "Approval (R5)", second bullet, with step 2a.
- **Cheapest fix:** Answer "try again in a moment" instead of declining when the overlapping holder has not yet passed its Outlook check. Detail.

### Option A

### Option A / "Try again shortly" followed by the same retry token can never succeed
- **Severity:** degrades
- **Scenario:** A2, R2
- **What happens:** (1) An instant request with `retry_token` X is inserted as `accepted`. (2) The Outlook re-check times out; step 2c sets the booking `failed` and the caller gets 503 "try again shortly". (3) The caller does what the page's instructions say and repeats the call with the same token. (4) Step 2 of `requestBooking()` finds a booking with that `retry_key` and "returns that booking's answer", which is the failure. `retry_key` also has a unique index, so no new row can be inserted for it. The slot is free but this caller cannot book it until it changes its token.
- **Evidence:** `requestBooking()` step 2 (no restriction to live bookings); `advance()` 2c; `bookings` unique partial index on `retry_key`; the copyable-line section ("send the same one if you repeat the call").
- **Cheapest fix:** Clear `retry_key` when a booking goes to `failed`, or match only non-failed rows. Detail.

### Option A / The retry token is optional, so a retry without one is told "slot taken" about its own booking
- **Severity:** degrades
- **Scenario:** R2 (its letter holds: one booking, one invite)
- **What happens:** (1) An agent posts without `retry_token`; its HTTP client times out before the server answers; the booking completes. (2) The agent repeats the call. There is no other matching, so it gets 409 `slot_taken` with alternatives. (3) The agent cannot tell this from losing the slot and may book an alternative: two meetings for one intent. The same happens if the Worker dies after the insert and cron confirms the booking 90 seconds later. The option does not say whether the public MCP tool or the API requires the token.
- **Evidence:** `requestBooking()` step 2; "Failure behaviour", row "Visitor's agent repeats a call"; recovery table, first row.
- **Cheapest fix:** Make `retry_token` required on `POST /api/bookings` and `request_booking`. Detail.

### Option A / Bulk approval runs the whole commit path per id inside one Free-plan invocation
- **Severity:** degrades
- **Scenario:** T4, F3
- **What happens:** (1) `decide_booking` takes up to 50 ids to approve. (2) Each approval is `decide()` then `advance()`: about three D1 calls and two or three provider calls, about 2.3 s by the option's own hops. (3) The Free plan allows 50 D1 queries and 50 subrequests per invocation (the option's own Scaling table), so the call fails around the 12th to 16th id. (4) Requests already set `accepted` are finished by cron at 3 a minute; the rest stay waiting. Nothing is lost, but the tool result is an error part-way through. The option does not say whether list approvals are run inline.
- **Evidence:** MCP tools, `decide_booking`; "Scaling", row "D1 queries and subrequests per invocation"; Recovery ("up to 3 rows").
- **Cheapest fix:** For a list, do only the conditional updates in the request and leave `advance()` to cron, or cap an approve list at 5. Detail.

### Option A / Cron's work per run has no stated order or cap for mail and dirty rows
- **Severity:** minor
- **Scenario:** A3, A4
- **What happens:** Depends on details the option does not give. (1) Cron advances "up to 3 rows" with no ordering; during a long Google outage every confirmed booking is `calendar_dirty`, and those rows can take the three places ahead of an `accepted` booking that still needs its event. (2) The outbox sender has no per-run cap; after a mail outage a backlog of more than about 20 rows would pass 50 D1 queries in one run on Free.
- **Evidence:** Recovery paragraph; "Mail to Tom"; "Scaling" table.
- **Cheapest fix:** Order by `accepted` first; send at most 10 mails per run. Detail.

### Option A / A waiting request can be stored over a time that is already committed
- **Severity:** minor
- **Scenario:** F7
- **What happens:** The insert of a `pending` row is conditional on the caps only; the overlap test is stated for `accepted` inserts. A request that validated its slot just before another booking committed, or an S5-downgraded request, is stored after the commit batch that would have declined it. Tom is mailed about a request that can only be declined (`decide()` does decline it, so R5 holds).
- **Evidence:** `requestBooking()` step 3; `advance()` 2c.
- **Cheapest fix:** Insert it as `declined (time_taken)` when a committed booking overlaps. Detail.

### Option B

### Option B / Guest reschedules are still uncounted, and the revision removed the only global limiter in front of them
- **Severity:** breaks a must scenario by S5's stimulus, on the same basis as A2 and C2 were rated; conditional on two things the option leaves open
- **Scenario:** S5
- **What happens:** (1) One instant booking is made with a victim's address. (2) The holder of the manage token calls `rescheduleBooking` repeatedly. The revision deleted `RL_ALL_WRITE` (20 writes a minute over all sources) and says cancel and reschedule "pass only the per-source limiter": 5 a minute per source, up to the core's 120 a minute. (3) Each move is `updateEvent`. There is no per-booking reschedule cap, `RL_VAULT_CREATE` covers creations only, and the option does not say whether `invites:all` (50 a day) counts updates. (4) If it does not, and if Outlook mails the attendee on a time change (the option says this is unconfirmed), that is 7,200 mails a day from one source. If `invites:all` does count them, 49 moves instead stop every invite for the day. This was an unverified "degrades" in the security review; A and C fixed their equivalents, B's revision loosened it.
- **Evidence:** "Abuse limits" layers 1 to 3; revision note row B3; "Cancel" and "Reschedule" paragraph; `CalendarApi.updateEvent`.
- **Cheapest fix:** A per-booking reschedule cap (as A and C now have) and a stated counter for update and cancel mail. Detail.

### Option B / Displacement at the queue cap can push out honest requests
- **Severity:** degrades
- **Scenario:** F7
- **What happens:** (1) When 120 requests wait, a new one is accepted and "the oldest waiting request of whichever source holds the most" is set to expired. (2) An attacker uses many sources with one request each. (3) An honest source with two open requests now "holds the most", so its oldest request is displaced; with all sources level the tie rule is not stated. (4) The displaced guest is not told. Needs on the order of 120 sources, which is one IPv6 /56.
- **Evidence:** "Abuse limits" layer 3, third bullet.
- **Cheapest fix:** Displace `downgraded` requests first, then the newest of the most recent burst, never a request older than an hour. Detail.

### Option B / Other waiting requests are declined before the approved one has passed its Outlook check
- **Severity:** degrades
- **Scenario:** F7
- **What happens:** (1) Tom approves request X. Step 2 claims X's cells and declines every overlapping waiting request in the same batch. (2) Step 3 reads Outlook and finds a conflict; X ends `rejected_conflict`. (3) The others are already terminal. Where they overlapped X only partly, or the conflict is something Tom then moves, requests that could have been approved are gone and their guests are not told. A and C decline the others only after the check has passed.
- **Evidence:** "Approval mode", deciding steps 2 and 3.
- **Cheapest fix:** Move the decline of the others into the finalize batch. Detail.

### Option B / The new per-source cap of 10 requests a day meets agents that share an address
- **Severity:** degrades
- **Scenario:** F5 at L2
- **What happens:** (1) The revision adds `requests:src` at 10 a day, never refunded, with 429 beyond it. (2) Hosted agents reach the endpoint from a small set of shared addresses. (3) L2 is 20 booking requests a day; if most come through one such address, the eleventh is refused. Depends on how visitors' agents egress, which is U5.
- **Evidence:** "Abuse limits" layer 3, first and third bullets; "Worst at" mentions the instant-to-approval effect but not the 429.
- **Cheapest fix:** Downgrade to a waiting request instead of 429, or raise the cap; it is already settable. Detail.

### Option B / Minor items in the changed parts
- **Severity:** minor (four items, counted separately in section 4)
- **Scenario:** A3, F7, F8, O1
- **What happens:** (a) The Meet follow-up stores the URL after `attachMeetingLink`; a crash between the two makes the next run create a second room and attach a different link, so a guest may hold two links. (b) An instant claim does not decline overlapping waiting requests (only an approval does), so Tom is mailed about, and can try to approve, requests that can only end `slot_taken`. (c) A guest's reschedule on an approval-mode type is a new waiting request with `reschedule_of`; the text does not say which row owns the event, cells and manage link after approval, and a new time that overlaps the booking's own cells cannot be claimed. (d) Each component may log 100 error rows a day; an anonymous caller who can provoke errors in `sched-public` can use them up, after which that Worker's real errors are not recorded.
- **Evidence:** "Meet follow-up" row; step 0 claim against deciding step 2; "Reschedule by a guest on an approval-mode event type"; "Error reporting".
- **Cheapest fix:** Store before attach; decline overlapping waiters in the finalize batch of any booking; specify the row swap; keep the last 100 rather than the first 100. All details.

### Option C

### Option C / Guests cannot reschedule a booking on an approval-mode event type
- **Severity:** breaks a must scenario on its letter, for approval-mode event types only
- **Scenario:** F8
- **What happens:** (1) A guest holds a confirmed booking on an approval-mode type and opens the manage link. (2) Reschedule is not offered: "on an approval-mode type the guest cancels and asks again". (3) To move the meeting the guest must give up the confirmed time, and Outlook mails a cancellation, before Tom has agreed to a new one. F8's measure is "can cancel or reschedule"; if that is read as either-or the scenario passes. The rollout starts every event type in approval mode. A and B both keep a reschedule path here.
- **Evidence:** "Reschedule" paragraph; public tool `reschedule_booking` ("instant event types only"); revision note, row "Shared, unverified".
- **Cheapest fix:** File the move as a waiting request that leaves the existing booking in place until approved. Detail.

### Option C / After 15 minutes nothing ever adds the Meet link
- **Severity:** breaks a should scenario
- **Scenario:** A3
- **What happens:** (1) Google is unreachable or its connection is revoked for more than 15 minutes. (2) Each booking confirmed in that time retries `spaces.create` for 15 minutes, then is set `meet_status = failed` and Tom is mailed. (3) Google comes back, or Tom reconnects it. Nothing retries: the alarm schedule ended, the sweeper covers only `held`, `cancelling` and `rescheduling`, and the revision removed `retry_booking`. (4) Those meetings stay without a link unless Tom edits each Outlook event by hand. A3 asks for the link to be added "when creation succeeds".
- **Evidence:** Confirm table step 5; "Machinery removed"; owner tool list; sweeper description.
- **Cheapest fix:** Have the sweeper retry `meet_status` `pending` or `failed` on future bookings at a slow rate, or restore a retry tool. Detail.

### Option C / The audit can cancel a real booking on one read, and it now shares its read with the 2-minute refresh
- **Severity:** degrades; a must (F4) if the audit's cancel uses the normal cancel operation, which the option does not say
- **Scenario:** none exactly (closest F4, F8, and the option's premise)
- **What happens:** Carried over from the failure review, not addressed by the revision, and tied to a changed part. (1) A cron run starts the calendar refresh and reads Outlook page by page. (2) During or just after that read a booking is finalized. (3) The audit in the same run compares confirmed bookings "with the same read"; the new booking's event is not in it. (4) "An event Tom deleted in Outlook cancels the booking and releases the slot." If that is a ledger change, the guest's manage link is dead while the event and invite stand. If it is the cancel operation, the guest gets a cancellation. A truncated or empty Graph answer does the same to every confirmed booking. Whether bookings newer than the read are skipped is not stated.
- **Evidence:** "How data moves", second bullet; Cancel paragraph; Cron row.
- **Cheapest fix:** Act only on a direct `GET` of the event by reference that returns 404 on two consecutive audits; skip bookings finalized after the read began; cap automatic cancellations per run. Detail.

### Option C / A booking demoted to a waiting request after an ambiguous create can leave a live event behind
- **Severity:** degrades
- **Scenario:** R2, F7
- **What happens:** (1) Step 3 posts the event; the answer is lost. (2) Probes and repeats fail for 15 minutes because Graph is unreachable. (3) The new rule applies: "release the claim, keep as a waiting request, mail Tom". (4) The first POST had in fact succeeded: the event exists and the guest has an invite. (5) Tom declines, or the request expires at 72 hours. Neither path probes Outlook, so the event and invite stay while the status link says declined or expired. If Tom approves instead, the probe adopts the event and all is well. Narrow: needs an unseen success followed by a long outage.
- **Evidence:** Confirm table step 3, last column; "Waiting requests"; decline and expiry descriptions.
- **Cheapest fix:** Mark such a request "create attempted"; on decline or expiry, probe by `transactionId` and cancel what is found. Detail.

### Option C / Every slot shown now depends on one cron job, with no fallback
- **Severity:** degrades
- **Scenario:** A1 (A2 is kept: it fails closed)
- **What happens:** (1) The calendar refresh runs every 2 minutes inside the shared cron invocation and reads the whole booking window page by page; no page size or page limit is given. (2) Two refreshes in a row fail or do not finish: Graph throttles, the cron run dies in an earlier job, or the run passes the Free plan's 50 subrequests or 10 ms of CPU. (3) `busy_times` passes 5 minutes and no slots are offered to anyone, although Graph may be answering single reads. (4) If cron itself has stopped, nothing mails Tom. A falls back to an inline read and B recomputes on demand; C has neither. The option does not say the rewrite is all-or-nothing when a later page fails.
- **Evidence:** "How data moves", first bullet; Consistency, second bullet; "Failure behaviour", rows "Microsoft Graph, for the calendar refresh" and "Cron, or the Worker itself"; facts table (Free limits).
- **Cheapest fix:** An inline refresh, behind a D1 lease, when `fetched_at` is over 4 minutes old; state `$top` and that a partial read is discarded. Detail.

### Option C / Two sources can use up every guest's reschedules for the day
- **Severity:** degrades
- **Scenario:** F8
- **What happens:** (1) Guest reschedules are capped at 20 a day overall. (2) Two sources make 7 instant bookings between them and move each 3 times. (3) The counter is full; every other guest's reschedule is refused until 00:00 UTC. Cancelling still works.
- **Evidence:** "Abuse limits", "Guest changes" row.
- **Cheapest fix:** Keep the per-booking cap and count the global figure per source. Detail.

### Option C / New per-source limits meet agents that share an address
- **Severity:** degrades
- **Scenario:** F5 at L2
- **What happens:** (1) The revision adds 20 booking attempts per source per day, counted before the Durable Object, so retries and `slot_taken` answers count; waiting requests stay at 3 open per source, then refusal. (2) Hosted agents share addresses. (3) On an approval-mode type the fourth visitor through one such address is refused while three wait. Depends on U5.
- **Evidence:** "Abuse limits", rows "Booking attempts" and "Waiting requests".
- **Cheapest fix:** Do not count a repeat of a known idempotency key; raise the open-request figure. Detail.

### Option C / The redirect-host allow-list is filled from a guess
- **Severity:** degrades
- **Scenario:** F1 (Grok is a should; Claude and ChatGPT are musts)
- **What happens:** (1) `/authorize` refuses any client whose redirect host is not in `ALLOWED_REDIRECT_HOSTS`, "filled in at build: assumed". (2) A client uses a host not on the list (Grok's is U3; desktop clients may use a loopback address). (3) Tom cannot add the connector, and the list is a deploy-time var, not something he can change through MCP.
- **Evidence:** OAuth flow 1; Vars list.
- **Cheapest fix:** Record the three clients' redirect hosts in the live check before relying on the list; let a refused host mail Tom a one-time "allow this host" link. Detail.

### Option C / The abuse caps are now settable by the agent that reads guest text
- **Severity:** degrades
- **Scenario:** S5, S6
- **What happens:** (1) `update_settings` now covers "the abuse caps". (2) Tom's agent reads guest text through `get_booking`. (3) Text that persuades the agent to raise the instant-booking caps removes the S5 bound with one tool call; no floor or ceiling is stated. The same point was raised against B in the security review.
- **Evidence:** Owner tools, `update_settings`; revision note row C4.
- **Cheapest fix:** Hard maximums in code for the S5 figures; settings can only lower them. Detail.

### Option C / Minor items in the changed parts
- **Severity:** minor (three items, counted separately in section 4)
- **Scenario:** R3, F7, R4
- **What happens:** (a) Slots are withheld when `busy_times` is over 5 minutes old, but an answer computed just before that is served from the edge cache for 60 s more, so the worst case during a refresh outage is about 6 minutes against R3's 5. The commit re-check still protects the booking. (b) Overlapping waiting requests are declined only in an approval's finalize batch; an instant booking's finalize does not, so Tom is mailed about requests that can only fail the claim. (c) The edge cache is "per event type and week" while the slots call takes `tz`; if `tz` is not in the key a visitor gets another zone's local times (each still carries its offset).
- **Evidence:** Consistency, second bullet; "Approval (R5)" against confirm step 4; "Abuse limits", "Lookups" row and the routes table.
- **Cheapest fix:** Withhold at 4 minutes; decline overlapping waiters in every finalize batch; put `tz` in the cache key or return UTC and convert in the page. All details.

---

## 3. Scorecard honesty

Same unverified fact, different scores:

| Fact | Scored "unknown" by | Scored "pass" by | Note |
|---|---|---|---|
| A personal Gmail account can create Meet rooms (U1) | A: F4, K6. B: F4, K6 | **C: F4 and K6** | C's own basis column says "personal Gmail is U1" and "not measured on a personal mailbox" |
| The three chat clients accept the OAuth setup (K4 is "works as a custom connector in Claude, ChatGPT and grok.com") | B: F1, K4. C: F1, K4. A: F1 | **A: K4** | A scores F1 unknown and K4 pass on the same library facts |
| What a visitor's agent can do with the pasted line (U5) | B: F5 and F6 "pass (design), agent side unknown" | **A and C: F5 and F6 plain pass**, basis "assumed" | |
| The system can be built in one pass (K8) | B: "unknown (one pass)" | **A and C: K8 pass** | All three hands-on figures (43, 39, 42 minutes) are assumed |
| Latency of the approve tool, which runs the whole commit path on guessed provider figures (T4) | B: unknown. C: unknown for approve and reschedule | **A: T4 pass** at 2,800 of 3,000 | A scores T3 unknown at 310 ms of headroom and T4 pass at 200 ms, on the same guesses |
| The account-wide daily request cap can take down other Workers on Tom's account (O3) | A and B: pass with a caveat | **C: plain pass** | C is on the same plan with the same cap |
| Approval mail reaches the inbox, not Junk (F7, A4) | A: "Inbox rather than Junk is assumed". B: "email delivery assumed" | **C: F7 basis "stated (Cloudflare)"** | Cloudflare states the sending, not the placement |

A "pass" that rests on an assumed figure:

- **R2, all three.** One invite on a retried create rests on reading `transactionId` back from `calendarView` on a personal mailbox and on Graph's own guard. C names exactly this as its riskiest assumption and still scores R2 pass; A and B score pass with "by design" and "assumed sufficient".
- **C2, all three.** $0 depends on staying on Free, which depends on every route and the cron fitting in 10 ms of CPU. All three say this is unmeasured and name it as a trigger to move to Paid, at which point C2 fails. Honest score: unknown.
- **T1 and T2, all three.** Sums of assumed hop figures; each option scores T3 unknown for that reason. B's T2 (1,310 of 1,500) includes a fresh Graph read on a cache miss, one of the three figures B calls a guess.
- **D1, all three.** The 7-day window is stated; "within 1 hour" is assumed and not rehearsed. All three say so in the basis column.
- **L3, C.** The scorecard uses 21 a minute (lookups only) against a limiter of 30. On the figure review.md used for A10 (28.1 a minute, all requests) the margin is under 2 a minute against a limiter the option calls approximate.
- **L1, L2, S4, B.** The request counts assume Service Binding calls are not counted against the daily cap ("assumed" in B's Scaling table). At three times the count the scores still hold.
- **S4, all three.** Pass at the frame's 10,000 requests; each option's own Scaling section shows the "cannot exhaust quotas" half failing at about ten times that (shared finding above).
- **S1, C.** Now leans on the redirect allow-list, whose contents are assumed.
- **K8, all three.** The Azure account and tenant step (10 to 15 minutes) is "not timed" in every estimate.

---

## 4. Counts

Fix check covers the confirmed and disputed findings in review.md sections 2a to 2c, then the five items frame revision 2 newly requires.

| | Option A | Option B | Option C |
|---|---|---|---|
| Confirmed and disputed findings checked | 11 | 5 | 7 |
| Fixed | 10 | 4 | 6 |
| Partly fixed | 1 (A8) | 1 (B3) | 1 (C4) |
| Not fixed | 0 | 0 | 0 |
| Revision 2 items: fixed / partly / not | 5 / 0 / 0 | 5 / 0 / 0 | 4 / 1 (A3) / 0 |
| New: breaks a must | 0 | 1 (conditional; S5 by stimulus) | 1 (F8, on its letter) |
| New: breaks a should | 1 (shared: Free-plan cap) | 1 (shared: Free-plan cap) | 2 (A3 retry; shared: Free-plan cap) |
| New: degrades | 3 | 3 | 6 |
| New: minor | 3 (one shared) | 5 (one shared) | 4 (one shared) |

Notes:

- The three "partly fixed" are the same finding (review.md S2). In each the ordinary-volume route to the cap is closed and a multi-source route remains: 20 sources in A (approval-mode rows are not evicted), 50 sources against the daily counter in B (stated and accepted), 34 sources in C.
- B's new must and C's new must each turn on a reading: B's on two facts the option leaves open, C's on whether F8's "cancel or reschedule" means both.
- New findings that depend on a detail the option does not specify say so in their text.
