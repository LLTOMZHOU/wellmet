# Operator review: options A, B, C

Lens: the person on call who did not design it. Here that is Tom, alone, with no dashboard (K3), who sees the system only through owner MCP tools and email, plus an AI agent that builds it in one pass (K8). No winner is picked.

Read: `frame.md`, `capacity.md`, `options/a.md`, `options/b.md`, `options/c.md` and the three `*.assumptions.json`. Nothing else under the design directory.

## Platform facts checked for this review (fetched with curl, 2026-11-15)

| Claim | Result | Source |
|---|---|---|
| Entra client secrets expire | Confirmed: "limited to two years (24 months) or less"; Microsoft recommends under 12 months. An expired secret returns `AADSTS7000222` under OAuth error `invalid_client`, not `invalid_grant` | learn.microsoft.com `entra/identity-platform/how-to-add-credentials`, `reference-error-codes` |
| Registering an Entra app from a personal account | Prerequisites are "an Azure account that has an active subscription" and "a workforce or external tenant" | learn.microsoft.com `entra/identity-platform/quickstart-register-app` |
| Free-zone WAF rate-limiting rule can be scoped to a hostname | **Refuted.** On Free the rule expression may use only Path and Verified Bot; Host needs Pro. Counting and mitigation periods are 10 s only | developers.cloudflare.com `waf/rate-limiting-rules` (plan table) |
| Workers spending limit | Confirmed: account-wide, error 1103, covers Workers requests and CPU only. Durable Objects have a separate limit and separate alerts. Minimum amount is any value above zero. Email alerts fire at 80% and 100% of the threshold, which is counted after included usage | `workers/platform/spend-management`, `billing/manage/spend-management` |
| `wrangler rollback` | One command, but "rollbacks will not be allowed if a Durable Object class lifecycle change has occurred" between the two versions. A version captures code, assets, bindings and compatibility settings; storage state is not rolled back | `workers/versions-and-deployments/rollbacks`, `workers/versions-and-deployments` |
| Service Binding calls are not billed as requests | Confirmed | `workers/platform/pricing`, "Service bindings" |
| Durable Object billing | Each RPC session is one billed request; overage is rounded up to the next million ($0.15) | `durable-objects/platform/pricing` |
| OAuth library shapes and helpers | Confirmed: split `OAuthAuthorizationServer` + `OAuthResourceServer` is "the recommended shape", `OAuthProvider` "remains fully supported", both roles may share one Worker. `beginConsent`, `approveConsent`, `describeConsent`, `beginUpstream`, `finishUpstream`, `clientRegistrationCallback`, `purgeExpiredData`, `refreshTokenIdleTTL` and an `onError` hook all exist | github.com/cloudflare/workers-oauth-provider `README.md`, `docs/*.md` |
| Google refresh tokens | Confirmed: 7-day expiry only in "Testing"; six months unused; `meetings.space.created` is a Sensitive scope | developers.google.com `identity/protocols/oauth2`, Meet API "authenticate-authorize" |
| Graph `transactionId` is readable | The event resource says it "is only returned in a response payload if an app has set it". Graph list results are paged | learn.microsoft.com `graph/api/resources/event`, `graph/paging` |

Not verified: anything about how Claude, ChatGPT or Grok behave as OAuth clients, and Graph behaviour on a personal mailbox.

---

## Option A

Parts to keep running: 1 Worker, 1 D1, 1 KV, 1 cron, 2 rate-limit bindings, Email Routing, 3 Worker secrets, 1 Entra app, 1 Google Cloud project, the Workers Paid plan and its spending limit.

### Option A / Entra client secret expires and the calendar goes dark with no alert
- **Severity:** breaks a must scenario
- **Scenario:** A4 (also F1)
- **What happens:** (1) Tom creates the Entra secret at setup; it expires in at most 24 months (verified). (2) On the day it expires, cron's refresh-token call returns `invalid_client`. The option's detection and its "store everything as `pending`" mode are keyed to `invalid_grant`; what `invalid_client` does is not specified. (3) Within about an hour the last access token dies. The snapshot cannot refresh, so slot pages answer 503 "calendar not reachable"; a booking fails at `advance()` step 2 as `calendar_unreachable`, so nothing gets stuck and the 15-minute stuck-booking mail never fires. (4) Owner sign-in uses the same secret at `/oauth/microsoft/callback`, so Tom cannot authorise a new client, and `/connect/microsoft` fails the same way. (5) The only fix is the Entra portal plus `wrangler secret put`, by hand. Nothing reminds him: the option lists it as a "routine chore".
- **Evidence:** Failure behaviour, "Microsoft connection revoked (`invalid_grant` on refresh)"; The three OAuth flows, flow 1; Operations, "Routine chores".
- **Cheapest fix:** Detail only. Treat any non-transient refresh failure as a broken connection (same mail, same pending mode); record the secret's expiry date at setup, show it in `get_health`, mail Tom 30 days ahead.

### Option A / Reschedule never re-checks Outlook
- **Severity:** breaks a must scenario
- **Scenario:** R3 on the F8 path (also F3 `reschedule_booking`)
- **What happens:** (1) Tom adds a meeting at 14:00 directly in Outlook. (2) Within the snapshot's age (up to 31 s, 50 s at worst) a guest opens the reschedule page and still sees 14:00. (3) The reschedule is a D1 conditional update that checks other D1 bookings only, sets `calendar_dirty`, and `advance()` step 5 PATCHes the event. (4) The fresh `calendarView` re-check lives in step 2 and runs only "if `rechecked_at` is null", which is false for a confirmed booking. Outlook now has two meetings at 14:00 and has mailed the guest the update. If `reschedule()` were to reset `rechecked_at` (not specified), a conflict in step 2 sets `failed`, which kills a confirmed booking whose event still sits at the old time. Neither reading works.
- **Evidence:** Booking write: order and recovery, `advance()` steps 2 and 5; `a.assumptions.json`, "guest cancel or reschedule" hops (no `calendarView` hop; 1,610 ms).
- **Cheapest fix:** Detail only. Give reschedule its own fresh `calendarView` for the new interval before the PATCH; on conflict leave the booking as it was. Costs about 900 ms of the 1,390 ms headroom.

### Option A / Restoring the database discards bookings confirmed since, with no way to get them back
- **Severity:** breaks a must scenario
- **Scenario:** D1
- **What happens:** (1) A migration at 10:00 damages rows. (2) It is noticed at 13:00 and Tom (or Claude Code) runs `wrangler d1 time-travel restore` to 09:59. (3) Three bookings confirmed between 10:00 and 13:00 are gone from D1, and so are their `log` rows. (4) Their Outlook events and invites still exist and Outlook busy time still blocks the slots, but each guest's `/b/{id}.{mac}` link now finds nothing, `list_bookings` does not show them, and no tool imports them back. Tom cannot even list what was lost. The option does not mention this window.
- **Evidence:** Data, "Backup"; Operations, "Rollback"; scorecard row D1.
- **Cheapest fix:** Detail only. Have the deploy script record a Time Travel bookmark before each migration, and add an owner tool that re-adopts Outlook events carrying a booking id (`transactionId`) after a restore.

### Option A / Daily caps on registration and `/authorize` can lock Tom out of his only console
- **Severity:** degrades
- **Scenario:** F1, S8, O1
- **What happens:** (1) Anyone sends 10 `POST /oauth/register` calls, or 100 `/authorize` loads using a client-metadata URL they host; the per-IP limiter (5 per 60 s) allows the 100 within 20 minutes. (2) The day's counters in `state` are spent. (3) Tom runs `revoke_all_access` after a suspected token theft, or adds a new client: sign-in is refused until the counter rolls over. (4) With no working grant he cannot call `get_health` to see why. The same cap is likely to trip without an attacker on the first deploy: debugging a connector that fails to add in ChatGPT or Grok burns one registration per attempt, and after ten the day is over. Resetting the counter needs `wrangler d1 execute`.
- **Evidence:** Abuse limits, rows "DCR registrations" and "`/authorize` page loads"; Security, "Abuse of OAuth endpoints".
- **Cheapest fix:** Detail only. Keep `/authorize` state in a signed cookie until Microsoft sign-in succeeds so anonymous loads write nothing, and put the DCR cap on a rolling hour, not a day.

### Option A / When the Worker or its cron is the thing that broke, nothing tells Tom
- **Severity:** degrades
- **Scenario:** O1, A1, A4
- **What happens:** (1) A release whose `scheduled` handler throws is deployed (or the account spending limit trips). (2) Token refresh, revocation detection, retries of unfinished bookings, 72-hour expiry and every alert mail stop together, because all run in that handler. (3) The only watchdog is "a request that sees `state.cron` older than 10 minutes mails Tom": it needs a public request to arrive (about 200 a day at L1), the `fetch` handler and D1 to be healthy, and the `EMAIL` binding to work. If `fetch` is broken by the same release, nothing is sent. (4) `get_health` is served by the same Worker. Separately, errors raised inside the OAuth library's own routes (token, register, authorize) and uncaught exceptions go to Workers Logs, which Tom cannot read through MCP; the option does not wire them into `log`.
- **Evidence:** Operations, "What reaches Tom unprompted" and "Monitored"; Failure behaviour, rows "Cron" and "Cloudflare Workers".
- **Cheapest fix:** Detail only. Wrap each cron job separately so one failure does not skip the rest, wire the library's `onError` hook and a top-level catch into `log`, and add one external heartbeat check (outside the Worker) that mails on silence.

### Option A / A handful of addresses can fill the pending cap and stop bookings for everyone
- **Severity:** degrades
- **Scenario:** F4, F7 (under the S5 stimulus)
- **What happens:** (1) Six source addresses (IPv6 /64s are cheap) each post 5 requests. (2) The global "30 open pending, then 429" cap is full; the 30 slots are held. (3) Every later visitor gets 429 until Tom declines them or 72 hours pass. (4) Tom's tools: `decide_booking` one request at a time. There is no tool to decline in bulk, change a cap or block a source; a block needs the Cloudflare dashboard. The attacker refills at 5 posts a minute. A limit exists, but it is global, so it stops the victim as well as the attacker.
- **Evidence:** Abuse limits table; MCP tools, owner list.
- **Cheapest fix:** Detail only. Let `decide_booking` take a list or a source filter, and count pending per event type rather than globally so one flooded type does not close the rest.

### Option A / Tom's hands-on time is over 30 minutes once the omitted steps are added
- **Severity:** degrades
- **Scenario:** K8
- **What happens:** The estimate is 29 of 30 minutes. (1) Microsoft's own prerequisites for app registration are an Azure account with an active subscription and a tenant (verified), which a personal Outlook.com user does not have; signing up needs phone and card verification. The option says this "overruns" if it applies. (2) Enabling Email Routing on the zone and adding the destination address are dashboard steps not in the list (only the verification click is). One minute of slack does not cover either.
- **Evidence:** Build and rollout, "Tom's hands-on time".
- **Cheapest fix:** Detail only. Check whether Tom already has an Azure tenant before choosing; script Email Routing with an API token he creates once.

### Option A / Rotating `MASTER_KEY` takes the system down until Tom re-consents twice
- **Severity:** degrades
- **Scenario:** none (S7 and F8 are affected)
- **What happens:** One key derives the token-encryption key, the link key and the source-hash key, with no key version. (1) The key must be replaced (leak, or a lost secret). (2) Both stored provider tokens become undecryptable, so the calendar and Meet connections are dead until Tom opens both connect links. (3) Every manage link already sent inside an invite and every open approval link stops verifying. There is no re-encrypt step and no tool for it.
- **Evidence:** Components, bindings table (`MASTER_KEY`); Hard to reverse.
- **Cheapest fix:** Detail only. Two secrets (tokens, links) and a `key_version` column, so the token key can rotate without touching links.

### Option A / Revocation is found only when a refresh is attempted, and the cadence is not stated
- **Severity:** minor
- **Scenario:** A4
- **What happens:** The option says a revoked Microsoft connection is "detected by cron within about 1 minute". Cron "refreshes them before they expire", so, unless it forces a refresh-token call every run (not specified), a revoked refresh token is discovered only when the current access token is nearly spent, up to about an hour later. The 1-hour measure is then borderline.
- **Evidence:** Failure behaviour, "Microsoft connection revoked"; Critical path, "cron refreshes them before they expire".
- **Cheapest fix:** Detail only. Force a refresh-token grant every 15 minutes.

### Option A / No warning before included usage runs out, and the first response step is not available as described
- **Severity:** minor
- **Scenario:** C1, S4
- **What happens:** `get_health` shows today's abuse counters but no month-to-date usage. Cloudflare's alert fires at 80% and 100% of a threshold that starts counting after included usage (verified), so with the limit at the lowest amount the first signal is effectively the 1103 outage. The planned first response, "the zone's one free WAF rate-limiting rule for `meet.yuxingzhou.me`", cannot be scoped to a hostname on a Free zone (verified); it would apply by path across the whole zone, website included (O3).
- **Evidence:** Scaling, "What is done then"; Operations, "Account settings".
- **Cheapest fix:** Detail only. Count requests per day in `state` and report month-to-date in `get_health`; scope the WAF rule by path prefix.

### Option A / Reschedule on an approval-mode event type is not specified
- **Severity:** minor
- **Scenario:** F8, K9
- **What happens:** A guest books an approval-mode type, Tom approves 10:00 Tuesday, the guest then uses the manage link to move to any open slot. Nothing says whether that needs Tom's approval again; as written it goes straight to the PATCH.
- **Evidence:** Public HTTP routes (`/b/{id}.{mac}/reschedule`); Booking write: order and recovery.
- **Cheapest fix:** Detail only. Decide and state the rule.

### Option A / The half-minute snapshot refresh is not something a cron trigger does
- **Severity:** minor
- **Scenario:** T2, R3
- **What happens:** Cron Triggers fire once a minute at most. "Second 0 and second 30" needs the handler to stay alive and sleep 30 s, which is not described. If it is left out, the snapshot reaches 60 s, so every lookup in the last ten seconds of each minute takes the inline Graph path (1,120 ms, still inside T2) and leans on Graph being up.
- **Evidence:** Data, "Consistency".
- **Cheapest fix:** Detail only. State the sleep, or accept a 60 s snapshot with the 50 s inline rule.

### Survived (A)
- F2, F3, K3: all nine event-type settings and all seven booking actions map to listed owner tools; no owner task needs a web page beyond consent, connect and approve.
- O2 code rollback: one Worker, no Durable Objects, so `wrangler rollback` has none of the documented restrictions.
- OAuth library claims: `OAuthProvider`, CIMD flag, consent and upstream helpers, `clientRegistrationCallback` all exist (verified); riskiest client behaviour is spiked first.
- Google token lifetime: consent screen set to "In production", cron keeps both tokens used (verified 7-day and six-month rules).
- Spending limit: exists as described; the open question on the minimum is settled (any amount above zero).
- Approval link: GET does nothing, POST decides once; safe against mail scanners.
- F6: slots are in the fetched HTML and the finishing link is a GET that books nothing.
- Which part is at fault: `get_health` names connection status, cron age and stuck bookings in one call when the Worker is up.

---

## Option B

Parts to keep running: 5 Workers, 3 D1 databases, 1 KV, 2 crons, 6 rate-limit bindings, 7 Service Bindings, 3 hostnames, 5 secrets across 3 Workers, Email Routing, 1 Entra app, 1 Google Cloud project with 2 OAuth clients, the Workers Paid plan and its spending limit.

### Option B / Errors from three of the five Workers have no route into the error log
- **Severity:** breaks a must scenario
- **Scenario:** O1
- **What happens:** (1) Operations says "each Worker writes structured errors to the core through its existing binding". (2) The bindings are fixed to `PublicApi` (seven booking methods), `ApprovalApi` (`peek`, `decide`) and `OwnerApi` (one method per tool); the document calls that list "the whole inter-Worker surface", and none is an error-report method. (3) `sched-auth` fails in `/signin/callback`, or `sched-public` throws while rendering. (4) Tom asks `get_health` from a client that still works: the last 50 errors show nothing from those Workers. The record is in Workers Logs for one of five Workers, which he cannot read without the dashboard. (5) If the fault is in `sched-mcp` or `sched-auth`, `get_health` is unreachable anyway, since every owner call passes through both; the client shows the same connector error for a fault in `sched-mcp`, `sched-auth`, KV or `sched-core`.
- **Evidence:** Operations, "Monitored"; Components, "RPC interfaces (the whole inter-Worker surface)"; Failure behaviour, rows `sched-auth` and `sched-mcp`.
- **Cheapest fix:** Detail, with a cost to the premise. Add a write-only `reportError` to each entrypoint (rate-capped in core, since `sched-public` is the untrusted side) and wire the library's `onError` in `sched-auth`.

### Option B / Restore loses bookings, and a vault restore strands live events
- **Severity:** breaks a must scenario
- **Scenario:** D1
- **What happens:** Case 1, core database (acknowledged by the option): restore `sched-core-db` to 09:59 and bookings confirmed since are gone with their `audit` rows; guests' manage links stop working; no tool re-adopts them from Outlook. Case 2, vault database (not acknowledged): (1) `sched-vault-db` is restored to time T. (2) `op_log` rows for events created after T are gone. (3) A guest cancels such a booking; core calls `cancelEvent(eventRef)`. (4) The vault refuses, because it may "update or cancel only event refs present in the vault's own `op_log`". The booking sticks in `cancelling` and the Outlook event stays. Three databases restored by three separate commands also means choosing three timestamps by hand.
- **Evidence:** Operations, "Restore"; Security, hop table row "`sched-core` → `sched-vault`"; scorecard row D1.
- **Cheapest fix:** Detail only. Record bookmarks for all three databases before each migration; add a re-adopt step that rebuilds both the core row and the vault `op_log` entry from Outlook events carrying a booking id.

### Option B / Every alert and every retry hangs on one cron in `sched-core`, with no heartbeat
- **Severity:** degrades
- **Scenario:** A3, A4, F7, A1
- **What happens:** (1) A `sched-core` release throws in `scheduled()`, or a `sched-core-db` migration leaves it failing. (2) Saga retries, 72-hour expiry, outbox drain, the 15-minute provider probe and all alert mail stop: only `sched-core` holds `OWNER_MAIL`. (3) "Cron Trigger missed" assumes the next minute works. No other Worker notices, and unlike option A there is no "cron not seen" mail at all. (4) Tom learns of a revoked connection only if he happens to ask `get_health`.
- **Evidence:** Operations, "What pages someone"; Failure behaviour, row "Cron Trigger missed"; Components (`OWNER_MAIL` on `sched-core` only).
- **Cheapest fix:** Detail only. `sched-auth` already has a daily cron and can call core; make it (or an external check) ask core for last-cron time and mail on silence, which needs a mail binding outside core.

### Option B / Anonymous callers can spend the owner plane's daily budgets
- **Severity:** degrades
- **Scenario:** F7, F1, S8
- **What happens:** (1) One address posts 100 junk tokens to `/decide/peek`; `RL_AUTH_SRC` (20 per 60 s) lets that through in five minutes. (2) The "100 approval-link attempts a day" budget in `sched-auth-db` is spent before the MAC is ever checked in core. Whether the budget is charged before or after verification is not specified; if before, (3) Tom's emailed approve and decline links fail for the rest of the day and he must decide through his agent. The same applies to 100 authorization starts and 20 registrations a day: after `revoke_all_grants`, or when adding a client, Tom can be locked out until the day rolls over, and first-deploy debugging of three connectors can spend 20 registrations without an attacker.
- **Evidence:** Security, "The owner plane has its own strict budgets"; Approval emails.
- **Cheapest fix:** Detail only. Verify the approval token's MAC in `sched-auth` before charging a budget (needs the link key there, which dents the isolation) or charge only verified attempts in core.

### Option B / A few addresses can close booking, cancel and reschedule for everyone
- **Severity:** degrades
- **Scenario:** F4, F8 (under the S5 stimulus)
- **What happens:** (1) Four addresses each post at their own limit of 5 writes per 60 s. (2) `RL_ALL_WRITE` (20 per 60 s, one global key) is saturated at that location, so other visitors' booking, cancel and reschedule posts get 429. (3) Separately, ten addresses holding 3 pending requests each fill `pending:all` (30), and 200 stored requests exhaust `requests:all` for the day; both answer 429 to everyone. Tom has better tools than in A or C (`update_settings` covers abuse limits, `decline_booking` takes a list), but nothing blocks a source, so the attacker refills.
- **Evidence:** Components, `sched-public` bindings; Security, "Abuse limits".
- **Cheapest fix:** Detail only. Take cancel and reschedule out of the global write limiter and count pending per event type.

### Option B / Hands-on time is over 30 minutes by the option's own count, before the omitted steps
- **Severity:** degrades
- **Scenario:** K8
- **What happens:** The option totals 32 minutes against 30. On top of that: Microsoft's prerequisites for app registration are an Azure account with an active subscription and a tenant (verified), which the estimate does not mention at all; enabling Email Routing is not in the list; the premise adds a second Google client, a second consent link and a third sign-in provider.
- **Evidence:** Build and rollout, "Tom's hands-on time"; scorecard row K8.
- **Cheapest fix:** One Google client for both sign-in and Meet saves about 2 minutes but changes what a compromise of `sched-auth` yields, so it touches the premise.

### Option B / Rollback of five Workers depends on a local file and on rules someone has to remember
- **Severity:** degrades
- **Scenario:** O2
- **What happens:** (1) `npm run deploy` writes five version ids to `deploy-log.json`; where that file lives is not specified. If the deploy ran in an agent session or checkout that is gone, `npm run rollback` has no "previous recorded set" and someone must pick five version ids by hand. (2) If a deploy stops at Worker 3 of 5, what the log holds is not specified, and two Workers run new code against three old ones. (3) A `wrangler secret put` between deploys (for example the Entra secret rotation) creates a Worker version the log does not know; rolling back to the recorded set would bring back the version with the old secret (a version captures bindings; that secrets follow is my inference from the versions page). (4) The rule "deploy the callee first and keep the old method for one release" lives only in this document.
- **Evidence:** Operations, "What is deployed" and "Rollback".
- **Cheapest fix:** Detail only. Commit the log, write it per Worker as each deploy succeeds, and have the rollback script read current versions from Cloudflare instead of trusting the file.

### Option B / Entra secret expiry is shown only if Tom asks
- **Severity:** degrades
- **Scenario:** A4
- **What happens:** `get_health` reports the secret's age, but no mail is listed for it. (1) The secret expires (24 months at most, verified). (2) The vault's 15-minute refresh returns `invalid_client`; the failure table marks `revoked` only on `invalid_grant`, and what happens otherwise is not specified. (3) The fix is the Entra portal plus `wrangler secret put` on `sched-vault`, by hand. Owner sign-in is unaffected here because it uses Google, so Tom can still reach `get_health`.
- **Evidence:** Security, secrets table; Failure behaviour, "Outlook connection revoked (`invalid_grant`)"; Operations, "What pages someone".
- **Cheapest fix:** Detail only. Mail at 30 days before expiry and treat `invalid_client` like a revoked connection.

### Option B / A provider outage longer than 15 minutes leaves bookings parked until Tom acts
- **Severity:** minor
- **Scenario:** A3
- **What happens:** (1) Meet is down 02:00 to 02:30. (2) Bookings made in the first quarter-hour reach `needs_attention` and Tom is mailed. (3) Meet returns at 02:31, but nothing says a parked booking resumes by itself: "`retry_booking_sync` or `cancel_booking` resolves it". Guests see `still_working` until Tom wakes and re-drives each one.
- **Evidence:** Booking write order and recovery, step 2 and step 3.
- **Cheapest fix:** Detail only. Keep retrying parked bookings every 10 minutes and on reconnect.

### Option B / The usage figure in `get_health` misses the traffic that would exhaust the plan
- **Severity:** minor
- **Scenario:** C1, S4
- **What happens:** `get_health` shows "the month's request count as seen by the core". A flood is refused in `sched-public` by its rate-limit bindings with no RPC, so core never sees it; each refusal is still a billed request. Tom reads a low number while the account approaches 10 million. Cloudflare's alert counts only after included usage (verified), and the planned WAF rule "scoped to the three hostnames" cannot use Host on a Free zone (verified).
- **Evidence:** Operations, "Monitored"; Scaling, "First bottleneck".
- **Cheapest fix:** Detail only. Label the figure as a lower bound, or have `sched-public` keep a coarse daily count.

### Option B / Reschedule on an approval-mode event type is not specified
- **Severity:** minor
- **Scenario:** F8, K9
- **What happens:** Same as option A: an approved guest can move to any open slot with no second approval, and the option does not say whether that is intended.
- **Evidence:** Booking write order and recovery, "Reschedule".
- **Cheapest fix:** Detail only. Decide and state the rule.

### Option B / `LINK_KEY` has no version, so rotating it kills every manage link in every invite
- **Severity:** minor
- **Scenario:** none (F8 affected)
- **What happens:** The token key has `key_version`; the link key does not. If `LINK_KEY` must change, every outstanding manage and approval link fails at once and there is nothing to migrate from. Acknowledged under Hard to reverse.
- **Evidence:** Data, "Manage and approval tokens are not stored"; Hard to reverse.
- **Cheapest fix:** Detail only. Put a one-character key id in the token and accept the previous key for a grace period.

### Survived (B)
- F2, F3, K3: every setting and action has a tool; operator extras exist that A lacks (`retry_booking_sync`, `disconnect_provider`, `update_settings` for abuse limits).
- OAuth shape: split authorization and resource Workers with `validateToken` over a Service Binding is the library's documented quick start (verified).
- Deploy order vault, core, auth, mcp, public has no binding cycle.
- Reschedule does a fresh busy check excluding the booking's own event, and releases the new cells on failure.
- Service Binding hops add no billed requests (verified).
- Google token lifetime: consent screen published; sign-in client asks for `openid email` only.
- Client-secret expiry does not block owner sign-in, because owner identity is Google.
- Email outage: outbox retries each minute and the backlog shows in `get_health`.
- Lapsed Workers Paid subscription is thought through (falls back inside free limits, exposures named).
- Walking skeleton tests the three connectors before anything else is written.

---

## Option C

Parts to keep running: 1 Worker, 2 Durable Object classes (one singleton, one instance per booking), 1 D1, 1 KV, 1 cron running 6 jobs, static assets, 2 rate-limit bindings, Email Routing, 1 zone WAF rule, 1 spend alert, a pool of Meet rooms, 6 secrets, 1 Entra app, 1 Google Cloud project, the Workers Paid plan.

### Option C / The launch WAF rule cannot be limited to the scheduler's hostname on a Free zone
- **Severity:** breaks a must scenario
- **Scenario:** O3 (also S4's cost argument)
- **What happens:** (1) The option deploys "one WAF rate rule on the hostname, on by default: 20 requests per 10 s per IP". (2) On the Free zone plan the rule expression may use only Path and Verified Bot; Host needs Pro (verified). (3) So the rule that can actually be created applies across `yuxingzhou.me`. Matching every path, a visitor whose page load makes more than 20 requests to the zone in 10 s is blocked for 10 s on Tom's personal site (if that hostname is proxied, which the option does not say). Matching path prefixes instead, the website's URL space is tied to the scheduler's (`/api/v1/`, `/mcp`, `/agent/`). Either way it takes the zone's only free rule. (4) The cost argument "the WAF rule holds one address to at most 2 requests a second" rests on this rule. Creating it also needs the dashboard or a zone-level API token; it is not in `wrangler deploy` and not in Tom's minutes.
- **Evidence:** Abuse limits, "Edge" row; Scaling, "By hostile traffic"; Operations, "Deployed".
- **Cheapest fix:** Detail only. Scope by path prefixes the website will never use and record that coupling, or drop the rule from launch as A and B do and rest S4 on the bindings.

### Option C / Entra client secret expiry is not mentioned anywhere
- **Severity:** breaks a must scenario
- **Scenario:** A4 (also F1)
- **What happens:** (1) The secret expires within 24 months (verified); the document has no reminder, no health field and no chore for it. (2) The 15-minute keep-warm refresh returns `invalid_client`. The option mails Tom and switches to holding requests on `invalid_grant`; `connections.status` has a `degraded` value but what sets it and whether it mails is not specified. (3) Within an hour Graph calls fail; once the 30 s cache lapses the page offers no slots, so nobody books, so no booking reaches `needs_attention`, so that mail never fires either. (4) Owner sign-in uses the same Entra app, so new authorisations fail too. (5) Repair is the Entra portal and `wrangler secret put`, by hand.
- **Evidence:** Failure behaviour, "Microsoft or Google connection revoked or expired"; The three OAuth flows, flows 1 and 2; Operations (no mention).
- **Cheapest fix:** Detail only. Same as A: classify any non-transient refresh failure as a broken connection, store the expiry date, show it in `get_health`, mail ahead.

### Option C / The drift audit cancels bookings on the absence of an Outlook event
- **Severity:** degrades
- **Scenario:** F8, F3, D1
- **What happens:** Every 15 minutes the audit reads Outlook for the whole booking window and "an event Tom deleted in Outlook cancels the booking and releases the slot". How "deleted" is established is not specified. If it is "not in the list I just read": (1) the list is paged (verified) and a build that does not follow every page, or one short answer from Graph, makes confirmed events look missing; (2) the audit sets those bookings `cancelled` (terminal), deletes their claims and retires their rooms; (3) the Outlook events and the guests' invites still stand; (4) each guest's manage link now says cancelled, so cancel and reschedule are refused, and `list_bookings` disagrees with the calendar. Tom gets an audit mail, but no tool reverses a terminal state. The same applies if a personal mailbox does not return `transactionId` on read, which the option itself lists as unknown and checks only after deploy.
- **Evidence:** Data, "How data moves"; Operations, "Monitored" (invariants); Riskiest assumption.
- **Cheapest fix:** Detail only. Before acting, confirm by `GET /me/events/{id}` returning 404 on the stored event reference, require two consecutive audits, and park in `needs_attention` instead of cancelling.

### Option C / A revoked or unreachable Outlook connection empties the booking page until Tom acts
- **Severity:** degrades
- **Scenario:** A4, F4
- **What happens:** (1) Tom's Microsoft password changes at 23:00; the keep-warm job marks the connection `revoked` by 23:15 and mails him. (2) From then "no slots are offered once the 30 s cache expires": the page and `find_slots` answer 503. (3) A visitor on the page has nothing to pick, so there is no request to hold; only a caller that posts a specific time blind is stored as `held`. (4) Tom sees the mail at 08:00. For nine hours the page took no requests, where A and B fall back to request-only slots from the rules. A `held` request whose start time passes is marked `failed` and the guest is told nothing.
- **Evidence:** Failure behaviour, rows "Microsoft Graph" and "Microsoft or Google connection revoked or expired", "Guest notification gap".
- **Cheapest fix:** Detail only, though it bends the premise: while revoked, offer rule-based slots marked unconfirmed and store them as `pending_approval`.

### Option C / One source inside the Worker's own rate limit can run Durable Object requests past the included million
- **Severity:** degrades
- **Scenario:** C1, S4
- **What happens:** (1) Each allowed slot lookup is one RPC to `CalendarGate`, one billed Durable Object request (verified). (2) The per-source limiter allows 30 reads per 60 s, which is 43,200 a day; the WAF rule (120 a minute) is looser. (3) The "600 lookups per source per day" budget is enforced in the Gate's memory, so a lookup refused by it has already been billed. (4) Baseline is 66,000 a month; one source at 22 a minute for a month, or four sources each sending the frame's 10,000 a day, passes 1,000,000. (5) Overage is $0.15 per started million (verified), and the option says there is "no margin under C1". (6) The planned alert is on Workers charges; Durable Objects are a separate spend policy (verified), so it would not fire, and `get_health` reports today's booking quotas, not month-to-date Durable Object requests. The frame's exact S4 stimulus (one source, 10,000 a day) stays at 37%, so S4 itself holds.
- **Evidence:** Abuse limits, rows "Request rate", "Lookup budget", "Spend"; Scaling table and "First bottleneck"; Cost, "There is no margin under C1".
- **Cheapest fix:** Detail only. Move the daily per-source lookup budget in front of the Gate (rate-limit binding or Cache API, which the option already plans for growth) and add a Durable Objects email alert.

### Option C / The riskiest piece for F1 is built seventh and tried last
- **Severity:** degrades
- **Scenario:** F1, K8
- **What happens:** (1) Build order puts the OAuth server and owner tools at step 7 of 10, after about 6,500 lines exist. (2) The first time a real client is pointed at it is "live checks after deploy", and that list names only Grok; Claude and ChatGPT, the two musts, are not on it. (3) The public MCP endpoint (`/mcp`, no auth) and the owner endpoint (`/owner/mcp`) share one origin that also publishes authorization-server metadata; option A names this same-origin layout as its riskiest assumption and spikes it first, C does not mention it. (4) If a client refuses, hostnames or the library shape change after everything else is built on them.
- **Evidence:** Build and rollout, "Order" and "Live checks after deploy"; Public HTTP routes.
- **Cheapest fix:** Detail only. Move a throwaway OAuth spike with all three clients to step 1.

### Option C / Tom's 29 minutes leave out four things
- **Severity:** degrades
- **Scenario:** K8
- **What happens:** The list omits: creating the zone WAF rule and the spend alert (dashboard or an API token Tom must mint; neither is reachable from `wrangler deploy`), enabling Email Routing and adding the destination address, and the Azure account and tenant that Microsoft lists as prerequisites for app registration (verified; the option says "may first require creating a free directory, not checked"). One minute of slack does not cover any of them.
- **Evidence:** Build and rollout, "Tom's hands-on steps"; Operations, "Deployed".
- **Cheapest fix:** Detail only. Add the steps and re-time, or drop the WAF rule from launch.

### Option C / If cron stops, nothing is sent; Tom has to ask
- **Severity:** degrades
- **Scenario:** A4, F7, O1, A1
- **What happens:** (1) A release whose `scheduled` handler throws is deployed. (2) Durable Object alarms still resume sagas, which is better than A or B, but keep-warm (the revocation check), approval expiry, pool refill and the audit all stop. (3) The failure table says "`get_health` shows the last run of each job": pull only, no mail on a stale cron. (4) If `fetch` is broken by the same release, `get_health`, `list_errors` and `explain_booking` go with it, as they are the same Worker. Errors from the OAuth library's own routes are not said to reach `error_log`.
- **Evidence:** Failure behaviour, row "Cron"; Operations, "What reaches Tom unprompted".
- **Cheapest fix:** Detail only. Let the singleton `CalendarGate` (or a saga alarm) notice a stale `cron_runs` row and mail, wire the library's `onError` into `error_log`, and add one external heartbeat.

### Option C / Seven addresses can fill the open-approval cap
- **Severity:** degrades
- **Scenario:** F4, F7 (under the S5 stimulus)
- **What happens:** (1) Seven sources each leave 3 open approval requests. (2) "20 overall" is reached; every further approval-mode request, and every instant request past the day's 10, is refused. (3) Tom can decline them one at a time; `update_settings` covers timezone, hours and the line's wording, not limits, and nothing blocks a source. The cap is global, so it stops everyone.
- **Evidence:** Abuse limits, "Open approval requests"; MCP tools, owner list.
- **Cheapest fix:** Detail only. Bulk decline by source, and per-event-type counting.

### Option C / `wrangler rollback` is refused across a Durable Object class change
- **Severity:** minor
- **Scenario:** O2
- **What happens:** A release that adds, renames or deletes a Durable Object class cannot be rolled back with the one command: Cloudflare does not allow rollback across a class lifecycle change (verified). The option's "one command, because there is one Worker" holds for every other release.
- **Evidence:** Operations, "Rollback".
- **Cheapest fix:** Detail only. State the exception and ship class changes as their own release with a fix-forward plan.

### Option C / After a restore the room pool is rewound before the audit re-adopts bookings
- **Severity:** minor
- **Scenario:** D1, K6
- **What happens:** (1) The ledger is restored to T. (2) A room claimed after T by booking X (and already in X's invite) is `free` again. (3) Before `run_audit` re-adopts X, a new booking Y claims that room. (4) X and Y now carry the same Meet link, and re-adopting X trips the one-room invariant. Whether public booking is paused during a restore is not specified; there is no maintenance switch.
- **Evidence:** Operations, "Restore"; Data, `meeting_rooms`.
- **Cheapest fix:** Detail only. Make the audit run before public writes resume, and have it retire any room whose link appears in an Outlook event.

### Option C / Reschedule on an approval-mode event type is not specified
- **Severity:** minor
- **Scenario:** F8, K9
- **What happens:** Same as options A and B: an approved guest can move to any open slot and nothing says whether Tom must approve again.
- **Evidence:** How a booking is written and recovered, "Reschedule".
- **Cheapest fix:** Detail only. Decide and state the rule.

### Option C / `LINK_KEY` has no version
- **Severity:** minor
- **Scenario:** none (F8 affected)
- **What happens:** `TOKEN_KEY` has a key version; `LINK_KEY` does not. Replacing it breaks every manage link already inside an invite and every open approval link. Acknowledged under Hard to reverse.
- **Evidence:** Security, "Provider tokens" and manage-token row; Hard to reverse.
- **Cheapest fix:** Detail only. Key id in the token and a grace period for the previous key.

### Survived (C)
- F2, F3, K3: all settings and actions have tools; the richest inspection surface of the three (`get_health`, `list_errors`, `explain_booking`, `run_audit`, `retry_booking`, `cron_runs`).
- D1 restore of bookings: the only option that reconciles the ledger against Outlook afterwards, records a bookmark before each migration, and schedules a timed restore drill.
- Parked bookings keep being retried every 10 minutes and resume on reconnect; no manual re-drive needed.
- Reschedule claims the new slot first and re-checks Outlook before the PATCH.
- OAuth shape: authorization server and resource server in one Worker with in-process validation is documented by the library (verified).
- Google token lifetime: consent screen in production; the connect step creates and reads back a room, measuring U1 on Tom's account.
- Durable Object duration: even a never-idle Gate stays under the included 400,000 GB-s.
- Email outage and the lack of a second alert channel are stated plainly, and the backlog shows in `get_health`.
- Approval link: only the POST acts; single use by compare-and-swap.
