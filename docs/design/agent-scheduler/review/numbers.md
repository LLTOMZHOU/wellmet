# Review: Numbers

Lens: whether the numbers hold. No overall opinion and no winner. Reviewed 2026-11-15 against `frame.md`, `capacity.md`, `options/{a,b,c}.md` and the three assumptions files.

## What was rerun and checked

**Capacity script.** `capacity.py` was rerun on each assumptions file at 1x and 10x. Every figure the options quote from it reproduces:

| Option | Booking (T3) | Page (T1) | Slot lookup (T2) | Cancel/reschedule | Owner worst tool (T4) | Public agent | Flood | Peak in flight, 1x / 10x (largest row) | Stored at 5 years, 1x / 10x |
|---|---|---|---|---|---|---|---|---|---|
| A | 2,690 of 3,000 | 440 of 1,000 | 1,120 of 1,500 | 1,610 | 2,720 | 1,140 | 30 | 0.03 / 0.29 | 483.6 MB / 4.8 GB |
| B | 2,750 of 3,000 | 840 of 1,000 | 1,310 of 1,500 | 2,750 | 2,830 | 1,330 | 20 | 0.12 / 1.16 | 483.6 MB / 4.8 GB |
| C | 2,650 of 3,000 | 450 of 1,000 | 1,210 of 1,500 | 2,630 | 2,700 | 1,240 | 30 | 0.03 / 0.28 | 483.6 MB / 4.8 GB |

Cost total is 0 at both scales for all three, as each option says (the flat fee is outside the model). So no option misreports the script. The findings below are about what the hop lists leave out and what the surrounding arithmetic assumes.

**Provider figures checked today** (fetched with `curl` from the `index.md` form of each page, 2026-11-15):

| Figure | Result | Source |
|---|---|---|
| Workers Paid: $5.00 minimum; 10 million requests then $0.30 per million; 30 million CPU-ms then $0.02 per million; no egress charge; static-asset requests free | Confirmed | developers.cloudflare.com/workers/platform/pricing |
| Service Binding and RPC calls: no extra request fee; CPU of both Workers billed | Confirmed | same page, "Service bindings" |
| Paid limits: 30 s default CPU (5 min max); 10,000 subrequests per invocation; 250 Cron Triggers per account; 15 min wall time per cron run; 6 simultaneous connections waiting for headers | Confirmed | developers.cloudflare.com/workers/platform/limits |
| D1: 25 billion rows read, 50 million rows written, 5 GB included; $0.75 per GB-month; 10 GB per database; Time Travel 30 days Paid / 7 days Free; 1,000 queries per invocation; 100 bound parameters per query; one query at a time per database | Confirmed | developers.cloudflare.com/d1/platform/limits, pricing table on the Workers pricing page |
| KV: 10 million reads, 1 million writes included; $0.50 and $5.00 per million | Confirmed | Workers pricing page |
| Durable Objects: 1 million requests then $0.15 per million; 400,000 GB-s then $12.50 per million; every RPC method call and every alarm is one billed request; idle objects eligible for hibernation not billed | Confirmed. New: overage is "rounded up to the next billable unit", so the first request past 1 million bills a whole $0.15 | Workers pricing page, Durable Objects section |
| Email to a verified destination address is free on every plan | Confirmed | developers.cloudflare.com/email-service/platform/pricing and /limits |
| Rate-limit binding: period 10 or 60 s; approximate; per Cloudflare location | Confirmed. The page also advises against keying on IP addresses because they are shared | developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit |
| WAF rate limiting on a Free zone: 1 rule, 10 s counting period, 10 s mitigation, counted per IP | Confirmed. **New: on Free the rule expression may use only Path and Verified Bot. Host is available from Pro up** | developers.cloudflare.com/waf/rate-limiting-rules, "Availability" |
| Workers spending limit: covers request and CPU charges past included usage, account-wide; rejects with error 1103; rejected requests not billed; not an exact cap; does not cover KV, D1 or Durable Objects | Confirmed. New: the amount must be "greater than zero, with up to two decimal places", so the lowest threshold is $0.01 (answers the unknown in A and B). Durable Objects have their own separate limit and alert | developers.cloudflare.com/workers/platform/spend-management, /billing/manage/spend-management |
| Placement: Smart Placement "requires consistent traffic to the Worker from multiple locations"; placement "only affects the execution of fetch event handlers. It does not affect RPC methods or named entrypoints" | New, affects A and B | developers.cloudflare.com/workers/configuration/placement |
| Graph Outlook limits: 10,000 requests per 10 minutes and 4 concurrent requests per app and mailbox | Confirmed (A labels the first "assumed"; it is stated) | learn.microsoft.com/graph/throttling-limits |
| Graph `transactionId` | Confirmed as described | learn.microsoft.com/graph/api/resources/event |
| Meet API: `spaces.create` 10 per minute per user, 100 per minute per project; reads 600 per minute per user | Confirmed | developers.google.com/workspace/meet/api/guides/limits |

Not checkable from documentation, so still assumed in every option: p99 latency of Graph, the Meet API, D1 and KV.

One fact used in several findings, calculated from the frame: at L2 the slot-reading requests arrive on average once every 43 to 58 s (1,500 to 2,000 a day), which is longer than B's 45 s and C's 30 s cache lives. Roughly half of those requests therefore find the cache expired (about e^(-45/58) = 46% for B, e^(-30/43) = 50% for C, at the average rate; still 6 to 7% at the 20x peak), so the p95 of any path behind those caches is the cache-miss path, not the hit path. A is not affected because its snapshot is refreshed by cron, not by requests.

---

## Option A

### Option A / A single crawler at the L3 rate is refused by A's own read limiter
- **Severity:** breaks a should scenario
- **Scenario:** L3
- **What happens:** L3's stimulus is "the link is shared widely, or a crawler finds it"; the measure is 20 times the average rate for an hour "served without errors". At L2 the public requests are 500 + 1,000 + 20 + 5 + 500 = 2,025 a day, 84.4 an hour; 20 times that is 1,688 in the hour, 28.1 a minute. A crawler is one source. `RL_READ` allows 20 per 60 s per source, so about 8 of every 28 requests (29%) get 429. The scorecard's pass ("peak in flight 0.03; about 1,850 requests") tests concurrency only and never applies the limiter. The many-sources half of L3 does pass.
- **Evidence:** Components, bindings table (`RL_READ` 20 per 60 s per key) and Abuse limits ("Public reads per source, 20 per 60 s"); scorecard row L3.
- **Cheapest fix:** Raise `RL_READ` to at least 40 per 60 s (S4's 10,000 a day is 7 a minute, so S4 is untouched), or score L3 as failing for a single source. Detail only.

### Option A / The booking budget leaves out the lease write and half the D1 calls the option counts elsewhere
- **Severity:** degrades
- **Scenario:** T3, T4
- **What happens:** The critical-path table has four D1 hops (read 100, insert 100, write 80, write 80). `advance()` step 1 is a fifth: "Take a lease: `UPDATE bookings SET lease_until …`", a D1 write before the Graph and Meet calls. At the option's own 80 ms that makes 2,770, leaving 230 ms against 3,000 and 30 ms against the 2.8 s timer, not 310. The Scaling table says "at most 8 D1 calls and 4 fetches in a booking"; eight calls at 80 ms each would be 2,690 + 4 x 80 = 3,010. The owner approve path (T4, 2,720) omits both the lease and the `meeting_url` write that the booking path carries: 2,720 + 160 = 2,880. Effect: more bookings answer 202 "still working" than the 310 ms figure implies. The option does not say which of the eight calls are on the happy path.
- **Evidence:** Booking write: order and recovery (`advance()` steps 1 to 4); Critical path table; Scaling table, row "D1 queries and subrequests per invocation".
- **Cheapest fix:** Set the lease inside the conditional insert (one statement), batch the log row with the state writes, and restate the budget. Detail only.

### Option A / Pending-request caps fill in 1.5 to 3 days at L2 volume
- **Severity:** degrades
- **Scenario:** L2, F7
- **What happens:** L2 is 20 booking requests a day. S5 caps instant bookings at 10 a day overall, so with instant event types at least 10 a day are stored as `pending`; with an approval-mode event type all 20 are. A pending row lives until Tom decides or 72 hours pass. "Open pending requests overall: 30, then 429" is reached after 3 days of instant-mode spill or 1.5 days of approval-mode requests; steady state if Tom is away is 30 and 60. After that, ordinary visitors get 429 and nothing is stored. F7 gives Tom 72 hours; the cap gives him less. Separately, "Pending requests per source: 5 per 24 h" and "Instant bookings per source: 5" are keyed on IP, and whether visitors' agents share egress addresses is not known (U5).
- **Evidence:** Abuse limits table; frame L2, S5, F7.
- **Cheapest fix:** Size the open-pending cap from L2 x 72 h (60 or more), or let Tom set it by tool. Detail, but it trades against how much of the calendar a script can hold.

### Option A / D1 hop figures rest on Smart Placement, which needs traffic A may not have
- **Severity:** degrades
- **Scenario:** T3, T1
- **What happens:** The 80 to 100 ms D1 figures assume the Worker "runs next to D1" through Smart Placement. Cloudflare says Smart Placement "requires consistent traffic to the Worker from multiple locations" and otherwise reports `INSUFFICIENT_INVOCATIONS`; it also applies to `fetch` handlers only. At L1 (203 requests a day) it may never place the Worker. Then each D1 call costs the round trip from the visitor's edge location to the database region. For a visitor 150 ms away, five D1 calls cost about 750 ms against 440 budgeted (with the lease), taking the booking path to about 3,080. Depends on where visitors are, which nothing specifies.
- **Evidence:** Components, "What is deployed" ("Smart Placement on, so it runs next to D1"); Critical path hops 2, 3, 5, 7.
- **Cheapest fix:** Use an explicit placement hint (`placement.region`) next to the D1 region instead of Smart Placement. Detail only.

### Option A / Cron advancing 20 bookings a run exceeds two provider limits
- **Severity:** minor
- **Scenario:** A3
- **What happens:** After a Meet outage with more than 10 bookings waiting, one cron run calls `spaces.create` up to 20 times in a minute; Google allows 10 per minute per user, so the rest get 429 and wait a further minute. If the 20 `advance()` calls run in parallel (not specified) they also exceed Graph's 4 concurrent requests per mailbox. Self-healing within a few runs.
- **Evidence:** Revision 1 note ("cron now advances up to 20 unfinished bookings per run"); Booking write: order and recovery.
- **Cheapest fix:** Cap at 8 per run and run them in series. Detail only.

### Option A / The fallback WAF rule cannot be scoped to the hostname on a Free zone
- **Severity:** minor
- **Scenario:** S4
- **What happens:** Scaling step 1 is "add the zone's one free WAF rate-limiting rule for `meet.yuxingzhou.me`". On a Free zone the rule expression accepts only Path and Verified Bot, so the rule applies to every hostname in `yuxingzhou.me`, including the personal website, wherever the path matches. Not in the launch build, so nothing breaks at launch.
- **Evidence:** Scaling, "What is done then", step 1.
- **Cheapest fix:** Write the rule on path prefixes only the scheduler serves (`/api/`, `/public/mcp`, `/b/`), or note that host scoping needs the Pro zone plan. Detail only.

### Option A / Workers Logs is switched on but absent from the cost table
- **Severity:** minor
- **Scenario:** C1
- **What happens:** Workers Logs on Paid includes 20 million events a month, then $0.60 per million. At 10x with a daily flood there are about 3.7 million invocation logs a month plus custom lines, so it stays inside unless the code logs more than about 4 lines per request. Inside the allotment, but it is a metered item with no row.
- **Evidence:** Operations ("Workers Logs is switched on"); Cost table.
- **Cheapest fix:** Add the row, or set `head_sampling_rate` below 1. Detail only.

### Survived (A)
- Script rerun: every quoted budget, in-flight and storage figure reproduces; hop lists in the text match the JSON.
- Fan-out: 2 on one hop, 2.0% tail note; the target is a p95 and the budget sums p99s, so fan-out does not break it.
- `service_ms` and `concurrency_per_instance` (10 per isolate): conservative, and immaterial at 0.03 to 0.29 in flight.
- Request and CPU arithmetic: 409,950 and 3,710,700 requests; 0.85 and 6.55 million CPU-ms; the 89x and 149x thresholds; all recompute.
- First bottleneck (included usage, then the 310 ms of latency headroom): placed where the option says.
- S4 at the stated stimulus even if all 10,000 requests are paced under the limiter and served: 2.05 million CPU-ms (6.8%), no Graph calls. One source at the limiter's ceiling all month (28,800 a day) is 0.97 million requests and 4.9 million CPU-ms; it takes about 7 such sources to leave the included usage.
- T2: the normal path (140 ms) does not touch Graph, so it does not depend on Graph latency.
- T4 as a p95 over all owner calls: passes on the option's figures with the two missing hops added (2,880).
- R3: one cache layer with a 50 s cut-off.
- Per-invocation limits on the heaviest path (a cron run advancing 20 bookings: about 100 D1 queries, about 65 fetches) against 1,000 and 10,000.
- Platform quotas and prices quoted: all match. The spending-limit behaviour is as described; lowest threshold is $0.01, so the worst-case bill under an extreme flood is $5.01 plus enforcement lag.
- C1: $5.00 at L2, with no margin. C2: fails, as the option says.

---

## Option B

### Option B / Two stacked 45 s caches let a slot be offered for up to 90 s
- **Severity:** breaks a must scenario
- **Scenario:** R3
- **What happens:** R3 requires that a meeting Tom adds in Outlook stops being offered within 60 s. B has two caches with independent ages: `busy_cache` per week (refreshed when older than 45 s) and `slot_cache` per event type and week (recomputed when older than 45 s, from `busy_cache`). Sequence: t = 0, a lookup for event type X refreshes `busy_cache` for week W. t = 1, Tom adds a meeting in week W. t = 44, a lookup for event type Y (or for X after a booking write deleted its `slot_cache` rows) recomputes `slot_cache` from `busy_cache`, which is 44 s old and so not refreshed. t = 88, a lookup for Y is served from `slot_cache` (44 s old) and still offers the slot, 87 s after Tom blocked it. It needs two event types or an intervening booking write, both ordinary. The commit-time re-check still prevents a double booking, so only the "within 60 s" half of R3 fails.
- **Evidence:** Data, "How data moves", second bullet ("A bucket older than 45 s is recomputed from … `busy_cache`; a `busy_cache` bucket older than 45 s is refreshed"); scorecard row R3 ("45 s cache + commit re-check").
- **Cheapest fix:** Stamp each `slot_cache` row with the `fetched_at` of the busy data it was built from and expire on that, or cut both lives to 25 s. Detail only.

### Option B / The booking and approve budgets omit D1 writes the saga requires; with them the sum passes 3,000
- **Severity:** breaks a should scenario
- **Scenario:** T3, T4
- **What happens:** The critical path has four D1 round trips (counters and claim 300, vault token read 150, finalize 150). The recovery design adds more, none budgeted: (a) "every step is persisted before the next starts", so at least one write to `sched-core-db` between verify/meet and event; (b) "the vault writes `op_log(opKey, 'started')` before the Google call and the result after it", two writes to `sched-vault-db` on the Meet branch of hop 6; (c) the vault may "update or cancel only event refs present in the vault's own `op_log`", so `createEvent` writes at least one more row. At B's own 150 ms per D1 round trip: 2,750 + 150 (a) + 150 (c) = 3,050, already over the target the scorecard marks "pass (budget), thin". If hop 6's 900 ms is the Meet call alone, (b) adds 300 more: 3,350. The same omissions take the worst owner tool from 2,830 to 3,130 or more. Separately, the in-request deadline is 2.6 s, below the 2,750 budget, so a booking that uses its full budget already gets `still_working`. Placement cannot shorten the D1 hops for `sched-core` and `sched-vault`, because they are reached only through RPC entrypoints and placement "does not affect RPC methods or named entrypoints"; they run wherever `sched-public` was invoked. `approve_booking` "accepts a list of ids"; whether it runs each saga inside the call is not specified, and if it does, ten approvals in series are about 25 s.
- **Evidence:** Critical path table and "Booking write order and recovery" (steps 2 and 3, first sentence); Security, hop table row "`sched-core` → `sched-vault`"; scorecard rows T3, T4.
- **Cheapest fix:** Fold step persistence into the vault RPC result and one core write, make the Meet `op_log` 'started' write the only extra one, restate the budget, and score T3 unknown. Put a placement hint on the three routed Workers. Detail only; the hops themselves come from the premise.

### Option B / Lookups wider than two weeks exceed Graph's concurrency limit or the 1.5 s cut-off
- **Severity:** degrades
- **Scenario:** T2
- **What happens:** The slot-lookup hop is "Graph `calendarView`, up to 2 week buckets in parallel, 800 ms". `agent.md` carries "the open slots for the next 14 days", which spans three ISO-week buckets on six start days out of seven. The API and `find_slots` take a free `from`/`to` range with no stated clamp. At L2 rates buckets beyond the current week are almost always expired. A 30-day range is 5 or 6 buckets: fetched in parallel that is 5 or 6 concurrent requests against Graph's limit of 4 per app and mailbox (plus any booking in flight), so some are throttled; fetched 4 at a time it is two waves, 2 x 800 + 510 = 2,110 ms, past the 1.5 s point at which B answers "unreachable". Whether the vault limits concurrency is not specified.
- **Evidence:** `b.assumptions.json`, slot-lookup hops; "The one copyable line" (14 days); Public HTTP routes (`slots?from=&to=`); Failure behaviour, Graph row ("A lookup that would exceed 1.5 s is cut off").
- **Cheapest fix:** Clamp ranges to two buckets per call with a next-page link, and put a 3-permit limiter in the vault. Detail only.

### Option B / Pending-request caps fill in 1.5 to 3 days at L2 volume
- **Severity:** degrades
- **Scenario:** L2, F7
- **What happens:** Same arithmetic as option A: at 20 requests a day with S5's 10 instant a day, 10 to 20 requests a day become `pending_approval`. `pending:all` (30 open) is reached after 3 days (instant event types) or 1.5 days (approval mode) without a decision, inside F7's 72 hours; further requests get 429 and store nothing. `pending:src` is 3 open per source, tighter than A's 5 per 24 h, and the option itself notes visitors behind a shared agent address are pushed to approval sooner.
- **Evidence:** Security, "Abuse limits", layer 3 (`pending:all`, `pending:src`); Worst at, last sentence.
- **Cheapest fix:** As for A: size `pending:all` from L2 x 72 h or expose it in `update_settings` (the tool already lists "abuse limits"). Detail only.

### Option B / One source pacing itself under the read limit uses 90 to 130% of the included CPU
- **Severity:** minor
- **Scenario:** S4, C1
- **What happens:** The flood rows price refused requests at 1 ms. A source that stays under `RL_SRC_READ` (60 per 60 s) is served: 86,400 lookups a day. At B's own 5 ms per invocation that is 10 ms a lookup on a cache hit (public and core) or 15 ms with the vault: 25.9 to 38.9 million CPU-ms a month on top of 1.2 million, against 30 million included. At 15 ms the included CPU is passed at 63,961 served requests a day, one source at 44 a minute; at the full 60 a minute the bill is about $5.20. The stated S4 stimulus (10,000 a day, all served) is 5.7 million CPU-ms (19%) and passes; the margin over it is about 6 to 9 times, not the 24 times the Scaling section derives from refused requests.
- **Evidence:** Scaling, allotment table (CPU row assumptions) and "First bottleneck"; Components (`RL_SRC_READ` 60/60 s).
- **Cheapest fix:** Lower `RL_SRC_READ` to 30 per 60 s (L3's single-source rate is 28.1 a minute), or add a per-source daily read counter in `sched-core`. Detail only.

### Option B / The fallback WAF rule cannot be "scoped to the three hostnames" on a Free zone
- **Severity:** minor
- **Scenario:** S4
- **What happens:** As for A: Free-plan rate-limiting rules match on Path and Verified Bot only, so the rule named as step 1 after the included allotments are passed would apply zone-wide, including the personal website. Not part of the launch build.
- **Evidence:** Scaling, "First bottleneck", step (1).
- **Cheapest fix:** Path-prefix expression (`/api/v1/`, `/mcp`, `/oauth/`), or the Pro zone plan. Detail only.

### Option B / Workers Logs on five Workers is absent from the cost table
- **Severity:** minor
- **Scenario:** C1
- **What happens:** "Workers Logs is on for all five." Each Worker in the chain logs its own invocation, so a request is up to 3 invocation logs. At 10x with a 10x flood that is about 5.1 million a month plus custom lines, inside the 20 million included ($0.60 per million after). No row in the cost table.
- **Evidence:** Operations, "Monitored"; Cost table.
- **Cheapest fix:** Add the row or sample. Detail only.

### Survived (B)
- Script rerun: every quoted budget, in-flight and storage figure reproduces; hop lists in the text match the JSON.
- Fan-out: 2.0% tail note on four workloads; does not break a p95 target budgeted as p99 sums.
- `service_ms` and `concurrency_per_instance` (50 per isolate): immaterial at 0.12 to 1.16 in flight. The 500 ms mean for a slot lookup is consistent with most lookups missing the cache at L2.
- Request, CPU, KV and Graph arithmetic: 109,950 / 409,950 / 710,700 / 3,710,700 requests; 1,217,250 to 13,228,500 CPU-ms; 1,084 KV writes a day; about 17,000 Graph reads a day; the 2.3x, 2.7x and 24x ratios; all recompute.
- First bottleneck (included CPU, then requests, then D1 storage at 97% at 10x): placed where the option says, subject to the minor finding on served versus refused requests.
- L3 including the single-crawler case: 28.1 a minute against 60 per 60 s per source.
- T1 on the option's own figures (840, with 500 of it for the visitor's network): the HTML does not wait on Graph.
- T2 on the option's own figures for one or two buckets (1,310). It sits on the cache-miss path at p95, which the budget already assumes.
- Provider tokens are not refreshed on the booking path, given the 15-minute probe.
- Per-invocation limits: nothing near 1,000 D1 queries, 10,000 subrequests or 30 s CPU.
- Platform quotas and prices quoted, including the appendix: all match.
- C1: $5.00 at L2, with no margin. C2: fails, as the option says.

---

## Option C

### Option C / The page budget leaves out the Gate and the Graph call its one API request makes
- **Severity:** breaks a should scenario
- **Scenario:** T1
- **What happens:** The page is a static shell plus one call, `GET /api/v1/page/{slug}`, which returns "public event-type details plus the first week of slots". The T1 budget prices that call as "Worker and one D1 read, 300 ms". Slots come from `CalendarGate`, so the call also carries the Gate hop (100) and, when the 30 s busy cache has expired, a Graph `calendarView` (900) and the D1 refresh (150). On C's own slot-lookup hops that is 1,210 ms, so the page is 150 + 1,210 = 1,360 ms on a miss against a 1,000 ms target. At L2 about half of Gate calls miss (2,000 a day against a 30 s life), and at L1 nearly all do, so the p95 is the miss path. On a hit the page is about 410 ms and passes. The budget also allows 150 ms for the visitor's whole network leg where A allows 300 and B 500. If T1 is read as "the shell is visible", it passes; the shell shows nothing until the call returns.
- **Evidence:** Public HTTP routes (`/api/v1/page/{slug}`); Components (`CalendarGate` "computes slots"); `c.assumptions.json`, page-view and slot-lookup hops; scorecard row T1.
- **Cheapest fix:** Return event-type details at once and load slots in a second call (T2 then covers them), or refresh the current week's busy cache from the minute cron so page loads never miss. Detail only.

### Option C / A single crawler at the L3 rate exhausts the 600-a-day lookup budget in 22 to 43 minutes
- **Severity:** breaks a should scenario
- **Scenario:** L3
- **What happens:** At 20 times the L2 average for an hour, slot lookups alone are 1,000 / 24 x 20 = 833 in the hour; with page and agent calls that reach the Gate, 1,667. From one crawler that passes the per-source lookup budget of 600 a day after 22 to 43 minutes, and the rest of the hour's lookups are refused. The request-rate limiter (30 per 60 s against 28.1 a minute) passes with 7% to spare. The scorecard's pass tests concurrency only. The many-sources half of L3 passes.
- **Evidence:** Abuse limits table, "Lookup budget" row; scorecard row L3.
- **Cheapest fix:** Raise the budget to about 2,000 a day or make it per hour. Detail only, but see the next finding: the budget does not protect what it appears to.

### Option C / Under paced hostile traffic the first allowance to go is Durable Object requests, ten times sooner than stated
- **Severity:** degrades
- **Scenario:** S4, C1
- **What happens:** The 600-a-day lookup budget is enforced "in `CalendarGate` memory", so a request has to reach the Gate to be counted; each one is a billed Durable Object request. The scorecard's "at most 600 a day per source reach the Gate" contradicts that. A source that stays under the rate-limit binding (30 per 60 s) and the WAF rule (20 per 10 s) sends up to 43,200 lookups a day to the Gate: 1.30 million Durable Object requests a month against 1 million included. The allowance is passed at (1,000,000 - 66,000) / 30 = 31,133 a day, one source at 22 a minute. Scaling names Worker requests at 333,000 a day as the hostile-traffic bottleneck and leaves the flood out of the Durable Object row. Overage is billed in whole units, so the first extra request costs $0.15; the Workers spend alert and spending limit do not count Durable Object charges. At the frame's stated stimulus (10,000 a day) the total is 366,000 (37%) and S4 passes; the margin is 3.1 times, not 33. At 10x with C's own 100,000-a-day flood row the Durable Object line is about 1.96 million if the flood is one source (more if several) and the bill is over $5.00.
- **Evidence:** Abuse limits table ("Lookup budget … `CalendarGate` memory"); Scaling table (Durable Object requests row) and "First bottleneck", second bullet; scorecard row S4; Abuse limits "Spend" row.
- **Cheapest fix:** Count the per-source budget before the Gate (a D1 counter, or the Cache API in front of the Gate that Scaling already proposes), and add a Durable Objects email alert. Detail only.

### Option C / The booking budget omits the write-ahead `intent` write and the second Durable Object hop, and already exceeds the 2.5 s inline cut-off
- **Severity:** degrades
- **Scenario:** T3, T4
- **What happens:** Step 3 is "step row marked `intent`, then one `POST /me/events`": a D1 write before the Graph call, which is the premise, and not in the hop table. Every Graph call goes through `CalendarGate`, a second Durable Object reached from `BookingSaga`; the budget has one Durable Object hop (100 ms) although "Worst at" says "two Durable Object hops". At C's own figures: 2,650 + 100 (intent) + 100 (Saga to Gate for the create) = 2,850, or 2,950 if the Gate hop for the re-check is not inside the 900. Headroom is 50 to 150 ms, not 350. The request stops waiting at 2.5 s, which is below even the unadjusted 2,650, so a booking that uses its budget returns `processing`. The same two items take the owner approve path from 2,700 to about 2,900. Where the Saga's Durable Object is created relative to the D1 primary is not specified; each of its four D1 round trips pays that distance.
- **Evidence:** "How a booking is written and recovered", step 3 and the last paragraph (inline up to 2.5 s); Components (`CalendarGate` "the only code that calls Microsoft Graph"); Critical path table; Worst at.
- **Cheapest fix:** Write `intent` for step 3 inside the claim batch (it is known then), give both Durable Objects the D1 region as a location hint, restate the budget. Detail only.

### Option C / The launch WAF rule cannot be placed "on the hostname" on a Free zone
- **Severity:** degrades
- **Scenario:** S4, O3
- **What happens:** C is the one option that turns the rule on by default: "one WAF rate rule on the hostname … 20 requests per 10 s per IP". On a Free zone the expression may use only Path and Verified Bot, so as written the rule cannot be created. Created without a host condition it applies to all of `yuxingzhou.me`: a visitor to the personal website whose page load makes more than 20 requests in 10 s is blocked for 10 s. The zone's single free rule may also already be in use by the website (not known). The Scaling claim that "it takes at least two addresses flooding all month" rests on this rule.
- **Evidence:** Abuse limits table, "Edge" row; Operations, "Deployed"; Scaling, "By hostile traffic".
- **Cheapest fix:** Scope by path prefixes only the scheduler serves (`/api/v1/`, `/mcp`, `/agent/`, `/owner/`), and check the rule slot is free. Detail only; host scoping needs a paid zone plan, which is over C1.

### Option C / Lookups wider than two weeks queue behind two read permits and pass 1.5 s
- **Severity:** degrades
- **Scenario:** T2
- **What happens:** The busy cache is per week bucket and lookups hold one of 2 read permits. The budget prices one Graph read (900 ms). A `find_slots` call for 30 days is 5 or 6 buckets, nearly all expired at L2 rates: three waves of two, 3 x 900 + 310 = 3,010 ms against 1,500. "Lookups beyond 2 waiting are refused", so a second caller in that window gets "try again shortly". The 7-day agent document and the page's first week are one or two buckets and fit.
- **Evidence:** Components (`CalendarGate`, 4 permits, 2 reserved); Abuse limits ("at most 2 per minute per week bucket"); Public HTTP routes ("ranges are clamped to whole weeks inside the booking window"); `c.assumptions.json`, slot-lookup hops.
- **Cheapest fix:** Clamp a single call to two weeks with a next-page link. Detail only.

### Option C / The open-approval cap of 20 fills in 1 to 2 days at L2 volume
- **Severity:** degrades
- **Scenario:** L2, F7
- **What happens:** Same arithmetic as A and B with a lower cap: 10 to 20 requests a day become `pending_approval`; "open approval requests: 3 per source and 20 overall; beyond it the request is refused". The overall cap is reached after 2 days (instant event types) or 1 day (approval mode) without a decision, against F7's 72 hours. On an L3 day (17 booking requests in the hour, on top of the day's spill) it is reached within the hour.
- **Evidence:** Abuse limits table, "Open approval requests" row.
- **Cheapest fix:** Size the cap from L2 x 72 h, or make it a setting. Detail only.

### Option C / The "still working" poll uses the visitor's whole read allowance
- **Severity:** minor
- **Scenario:** T3
- **What happens:** After a 202 the page "polls the status URL every 2 s": 30 requests a minute. `RL_PUBLIC_READ` is 30 per 60 s per source. Any other request from that visitor, or from anyone behind the same address, in the same minute is refused, and so are some polls; during a Graph outage a held booking's page keeps polling at that rate.
- **Evidence:** Critical path, paragraph after the table; Components, rate limiters row.
- **Cheapest fix:** Poll every 5 s with back-off. Detail only.

### Survived (C)
- Script rerun: every quoted budget, in-flight and storage figure reproduces; hop lists in the text match the JSON. (The file's `system` label was not updated for revision 1; no figure is affected.)
- Fan-out: 2.0% tail note on two workloads; does not break a p95 target budgeted as p99 sums.
- `concurrency_per_instance` of 2 for calendar paths: matches Graph's 4 concurrent requests per mailbox with 2 reserved; the 24x figure recomputes.
- Request and CPU arithmetic: about 110,000 / 410,000 / 711,000 / 3,710,000 requests; 1.15 and 9.6 million CPU-ms; all recompute.
- Durable Object arithmetic without a flood: about 66,000 requests a month at L2; duration ceiling 0.128 GB x 2,592,000 s = 331,776 GB-s; first-by-growth bottleneck at about 15x L2.
- Storage: 119 + 183 + 19 = about 320 MB at L2, 3.2 GB at 10x, inside 5 GB.
- T2 for one or two buckets on the option's own figures (1,210), on the cache-miss path.
- R3: one cache layer, 30 s.
- Meet pool refill against the 10-per-minute `spaces.create` quota; room checks against 600 reads a minute.
- Per-invocation limits: a claim batch of about 50 row writes, statements under 100 bound parameters; nothing near 1,000 D1 queries or 30 s CPU.
- Platform quotas and prices quoted, including the Durable Objects allowances and the facts table: all match, except the host-scoped WAF rule above.
- C1: $5.00 at L2, "with no margin", as the option says. C2: fails, as the option says.

---

## Scorecard passes that depend on assumed or stated figures

"x2" means the figure is worse by a factor of two (twice as slow, half the allowance, twice the volume). Rows marked (verified) were checked today and are listed for completeness.

### Option A

| Scenario | Figure | Basis | Verdict if wrong by x2 |
|---|---|---|---|
| L1, L2 | Frame loads (203 and 2,225 requests a day) | assumed (U6) | Pass: 2.2% of included requests |
| L1, L2, S4, C1 | 10 million requests and 30 million CPU-ms included | stated (verified) | Pass: L2 with the flood is 8.2% and 5.7% of half |
| L3 | 10 concurrent requests per isolate | assumed | Pass: 0.03 in flight |
| L3 | `RL_READ` 20 per 60 s per source | assumed (design value) | Already fails for one crawler (28.1 a minute); passes at 40 |
| T1 | Client network 300 ms | assumed | Pass: 740 of 1,000 |
| T1, T2 | D1 batch read 100 ms p99, resting on Smart Placement | assumed | Pass: 540 and 240 |
| T1, T2, R3 | Cron fires every minute and refreshes again at :30, so the snapshot is at most about 31 s old | assumed | T1 fails on the fallback path (1,420) whenever the snapshot passes 50 s; T2 and R3 still pass |
| T2 | Graph `calendarView` 900 ms p99 (fallback only) | assumed | Pass at p95 while cron is healthy; fallback path 2,020 fails |
| T4 | KV token check 120 ms p99 | assumed | Pass: 2,840; exactly 3,000 with the omitted hops |
| T4 | Graph re-check and Meet 1,000; event create 1,300 | assumed | Worst tool fails (3,720 or more); D1-only tools (340) pass. Verdict turns on the share of approve, cancel and block calls: at L2 at least 10 approvals a day in 200 calls is about 5% |
| S4, C1 | 5 ms CPU per served request, 1 ms per refused | assumed | Pass: 1.7 million at L2, 13.1 million (44%) at 10x |
| C1 | 50 D1 rows read per lookup | assumed | Pass at any plausible multiple (3.5 million of 25 billion). The cron's scan for unfinished bookings has no stated index; a full scan each minute of 36,500 rows at year 5 would be 1.6 billion a month, still inside |
| C1 | 3 KV writes per token refresh | assumed | Pass: 15,000 of 1 million |
| C1 | 483.6 MB after 5 years; 4.8 GB at 10x | calculated from assumed sizes | Pass at L2; at 10x, 9.7 GB unpruned is $3.50 a month over and at the 10 GB cap, 2.5 GB with pruning passes |
| C1 | $5.00 Workers Paid fee | stated (verified) | Not a x2 candidate; any increase fails C1 |
| S4 | Spending limit rejects, unbilled, past the threshold | stated (verified; minimum $0.01, not exact) | Pass at the stated stimulus regardless; it only matters above about 333,000 requests a day |
| S4 | Graph 10,000 requests per 10 minutes | labelled assumed; stated by Microsoft (verified) | Pass: about 20 per 10 minutes used |
| A2, R3 | 50 s snapshot cut-off | assumed (design value) | R3 fails at 100 s |
| A3 | Retry each minute for 15 minutes | assumed (design value) | Pass |
| A4 | Detection within about 1 minute | assumed | Pass: 2 minutes |
| D1 | Time Travel 30 days on Paid | stated (verified) | Fails at 15 days |
| D1 | Restore inside 1 hour | assumed, not rehearsed | Fails at 2 hours |
| S8 | Access token life 3,600 s | stated (library default) | Fails at 7,200 s |
| O2 | Rollback under 1 minute | assumed | Pass |

### Option B

| Scenario | Figure | Basis | Verdict if wrong by x2 |
|---|---|---|---|
| L1, L2 | Frame loads | assumed (U6) | Pass: 2.2% of included requests |
| L1, L2, S4, C1 | 10 million requests and 30 million CPU-ms included | stated (verified) | Pass at L2; 10x with a 10x flood is 74% and 88% of half |
| L3 | 50 concurrent requests per isolate | assumed | Pass: 0.12 in flight |
| L3 | `RL_SRC_READ` 60 per 60 s per source | assumed (design value) | Pass at 30 (28.1 a minute), with 7% to spare |
| T1 | Visitor network 500 ms | assumed | Fails: 1,340 |
| T1 | D1 read 150 ms p99, with no placement possible for `sched-core` | assumed | Pass: 990 |
| T2 | Graph `calendarView` 800 ms p99, at most 2 buckets | assumed | Fails: 2,110. This is the p95 path at L2, not a rare fallback |
| T2 | D1 150 ms p99 x 3 | assumed | Fails: 1,770 |
| T3 | Graph and Meet in parallel 900; event create 1,200; D1 150 | assumed | Scored "pass (budget)"; already 3,050 or more with the omitted writes; any one doubled fails |
| T4 | `validateToken` RPC and KV read 210 ms p99 | assumed | Worst tool fails (3,040); read tools (about 570) pass |
| S4, C1 | 5 ms CPU per invocation, 3 invocations per request, 1 ms per refused | assumed | Pass at the stated stimulus (3.0 million at L2 with the flood; 26.5 million, 88%, at 10x with a 10x flood); a single paced source then exceeds the included CPU at about 31,000 served requests a day |
| C1 | KV: 3 writes per refresh, 96 refreshes a day per client | assumed | Pass: 58,440 of 1 million |
| C1 | D1 rows: 5,200 written and 260,000 read a day | assumed | Pass |
| C1 | 0.48 GB after 5 years; 4.84 GB (97%) at 10x | calculated from assumed sizes | Pass at L2; at 10x, 9.7 GB is $3.50 a month over C1 |
| C1 | $5.00 Workers Paid fee; Service Binding calls not billed as requests | stated (verified) | Not a x2 candidate. If binding calls were billed, requests triple and still pass |
| S4 | Spending limit behaviour | stated (verified; minimum $0.01, not exact) | Pass at the stated stimulus regardless |
| A2, R3 | 45 s cache life | stated (this document) | R3 already fails at 45 + 45; fails outright at 90 |
| A3 | 15 one-minute retries | stated (this document) | Pass |
| A4 | 15-minute probe; email inside 1 hour | assumed | Pass: 30 minutes |
| D1 | Time Travel 30 days on Paid | stated (verified) | Fails at 15 days |
| D1 | Restore inside 1 hour, one command per database, three databases | assumed, rehearsal planned | Fails at 2 hours |
| S8 | 900 s access token; revocation visible in about 60 s | stated (library, KV docs) | Pass: 1,800 s and 120 s |
| O2 | Five rollbacks in about 1 minute | assumed | Pass |
| Provider ceiling | Graph reads at most about 17,000 a day | calculated | Pass: under 240 per 10 minutes at x2 |

### Option C

| Scenario | Figure | Basis | Verdict if wrong by x2 |
|---|---|---|---|
| L1, L2 | Frame loads | assumed (U6) | Pass: 2.2% of included requests |
| L1, L2, S4, C1 | 10 million requests and 30 million CPU-ms included | stated (verified) | Pass |
| L3 | 2 Graph read permits per calendar path; 100 concurrent per isolate | stated (Graph limit, verified) and assumed | Pass on concurrency: 0.03 in flight |
| L3 | `RL_PUBLIC_READ` 30 per 60 s; 600 lookups per source per day | assumed (design values) | Already fails for one crawler on the 600; the 30 per 60 s fails at 15 |
| T1 | Edge and static asset 150 ms as the visitor's whole network leg | assumed | Pass on a cache hit (600); the finding above is the miss path |
| T1 | Details API 300 ms, priced as one D1 read | assumed | Pass on a hit (750); already 1,360 on a miss |
| T2 | Graph `calendarView` 900 ms p99 on a miss | assumed | Fails: 2,110. This is the p95 path at L2 |
| T2 | Worker to Durable Object 100 ms; D1 refresh 150 ms | assumed | Pass: 1,310 and 1,360 |
| T4 (reads and configuration) | KV token check 150; D1 batches 400 | assumed | Pass: under 1,300 |
| A2, R3 | 30 s busy cache | calculated from the design value | R3 borderline at 60 s plus the Graph call |
| A3 | Room check before the invite; 15 minutes of retries | calculated (step order) | Pass |
| A4 | 15-minute keep-warm | calculated (cron interval) | Pass: 30 minutes |
| S4 | 10,000 a day stays at 3% of included Worker requests | calculated | Pass |
| S4 | "At most 600 a day per source reach the Gate" | calculated, but contradicts where the budget is enforced | At the stated stimulus Durable Object requests are 366,000 (37%); at x2 (20,000 a day) 666,000 (67%), pass; fails from 31,133 a day |
| S4, C1 | WAF rule 20 per 10 s per IP on the hostname | stated (verified for 1 rule and 10 s; host scope not available on Free) | The S4 pass does not need the rule; the "two addresses" claim does |
| S4, C1 | 5 ms CPU per served request, 2 ms per refused | assumed | Pass: 2.3 million at L2, 19 million (64%) at 10x |
| C1 | Durable Object requests about 66,000 a month at L2 | calculated from assumed loads | Pass: 132,000. At 10x, 1.32 million exceeds the allowance: $0.15 over C1 |
| C1 | Durable Object duration far below 400,000 GB-s; idle Gate not billed | stated (verified) | Pass: the never-idle ceiling is 83% |
| C1 | KV: 4 writes per token refresh | assumed | Pass: 18,000 of 1 million |
| C1 | About 320 MB at year 5; 3.2 GB at 10x | calculated from assumed sizes (5 KB of journal per booking) | Pass at L2; at 10x, 6.4 GB is about $1.05 a month over C1 |
| C1 | $5.00 Workers Paid fee | stated (verified) | Not a x2 candidate |
| D1 | Time Travel 30 days on Paid | stated (verified) | Fails at 15 days |
| D1 | Restore inside 1 hour | assumed, drill planned | Fails at 2 hours |
| S8 | Access token life 3,600 s | stated (library default) | Fails at 7,200 s |
| K6 | `spaces.create` 10 per minute per user; rooms last 365 days after last use | stated (first verified) | Pass: at 5 a minute a 12-room refill takes 3 minutes |
| O2 | One command, under 5 minutes | assumed | Pass |

T3 is scored unknown by A and C and "pass (budget), thin" by B. In all three it depends on the same assumed provider figures (Graph read 900 to 1,000 ms, Graph create 1,100 to 1,300 ms, Meet 900 to 1,000 ms p99); if any one is twice as slow the budget is over 3,000 in every option and the visitor gets the "still working" answer, which each option handles without a duplicate.
