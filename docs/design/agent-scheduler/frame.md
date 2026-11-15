# Frame: agent-first scheduler

Status: **confirmed by Tom 2026-11-14; revision 2 agreed with Tom 2026-11-15** (see "Frame revision 2" at the end).

Basis labels: **measured** (observed), **calculated** (arithmetic), **stated** (Tom or a named source said so), **assumed** (a guess to keep going).

## 1. Purpose

A self-hosted scheduler for one person (Tom). Tom configures and operates it only by talking to an AI agent (Claude, ChatGPT, Grok) through an MCP server. Other people book time either on a public web page or by handing one copied line to their own AI agent. Bookings land on Tom's Outlook calendar with a unique Google Meet link.

Today Tom has no scheduler; the alternative is Calendly or a self-hosted project such as Punctual, neither of which is operable end to end by an agent or bookable by a stranger's agent without a login.

### Non-goals

- An admin dashboard or any owner-facing web UI (beyond the sign-in/consent page and emailed approve/decline links).
- More than one owner: no teams, round-robin, or multi-tenant hosting.
- An AI negotiator on Tom's side. The public agent endpoint is rules only.
- Calendar providers other than Outlook, and meeting providers other than Google Meet, at launch.
- Payments, routing forms, group polls, meeting notes.
- A guest email-verification step.

## 2. Scenarios

"When *stimulus* under *conditions*, the system *response* within *measure*."

### Function

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| F1 | Tom adds the scheduler to Claude, ChatGPT or Grok by URL and signs in | Connector added and usable with no dashboard and no pasted secrets; works in all three | must (Claude, ChatGPT), should (Grok) | stated |
| F2 | Tom asks his agent to create, change, duplicate, preview or archive any kind of meeting | Every event-type setting is settable by conversation, with no built-in types: length options, buffers, minimum notice, window, daily and weekly caps, named schedules and date overrides, confirmation mode, intake questions, location (Meet, phone, in person) and listed or unlisted. (Widened 2026-11-15) | must | stated |
| F3 | Tom asks his agent about or acts on bookings | Can list, inspect, approve, decline, cancel, reschedule and block time through MCP tools | must | stated |
| F4 | A visitor opens an event link, picks a slot and submits name and email | Booking recorded; calendar invite arrives from Tom's Outlook with a unique Meet link | must | stated |
| F5 | A visitor copies one line from the page into an agent that can connect to MCP servers or make HTTP POST requests | Agent finds slots and requests a booking with no login and no API key | must | stated |
| F6 | A visitor copies the same line into an agent that can only fetch web pages | Agent reads open slots and hands the visitor a link that finishes the booking in one click | should | assumed |
| F7 | A booking is requested on an approval-mode event type | The request waits and reserves nothing, so several requests may wait on the same time. Tom gets an email in his Outlook inbox with approve and decline links and can also decide through his agent; the invite is sent only on approval; approving one request automatically declines the other waiting requests that overlap it; undecided requests expire after 72 hours. (Revised 2026-11-15: a waiting request no longer holds its slot) | must | stated (72 h assumed) |
| F8 | A guest uses the manage link from their confirmation | Can cancel or reschedule; Tom's Outlook event is updated to match | must | assumed |

### Load

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| L1 | Normal use at launch | 50 page views, 100 slot lookups, 3 booking requests, 30 owner MCP calls and 20 public agent calls per day | must | assumed |
| L2 | Normal use in 24 months | 500 page views, 1,000 slot lookups, 20 booking requests, 200 owner MCP calls and 500 public agent calls per day | must | assumed |
| L3 | The link is shared widely, or a crawler finds it | 20 times the average rate for an hour is served without errors | should | assumed |

### Latency

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| T1 | Visitor loads the booking page | p95 under 1 s at the client | should | assumed |
| T2 | Visitor or agent asks for open slots (includes reading Outlook busy times) | p95 under 1.5 s at the server | should | assumed |
| T3 | Visitor or agent submits a booking (includes creating the Outlook event and the Meet link) | p95 under 3 s at the server; a miss shows a "still working" state, never a duplicate | should | assumed |
| T4 | Tom's agent calls an owner tool | p95 under 3 s at the server | should | assumed |

### Availability and durability

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| A1 | Any month | Booking page and endpoints up 99.5% of the time; no window matters more than another | should | assumed |
| A2 | Microsoft Graph is unreachable | No slot is offered that could conflict with Outlook; visitors see "try again shortly", not an error page | must | assumed |
| A3 | Meet link creation fails during a booking | The booking is confirmed anyway and the link is added to the event when creation succeeds; if it still fails after 15 minutes Tom is emailed. (Relaxed 2026-11-15 from "no invite goes out without a working link", and from must to should) | should | stated (Tom) |
| A4 | The Outlook or Google connection is revoked or expires | Tom is emailed within 1 hour; new requests are held, not silently dropped | must | assumed |
| D1 | The database is damaged or a bad migration runs | No confirmed meeting is lost, where Tom's Outlook calendar counts as the record of confirmed meetings. The scheduler's own data can be restored to any point in the last 7 days within 1 hour; losing the scheduler's row and manage link for a booking made after the restore point is acceptable. (Relaxed 2026-11-15 from 30 days and from "no booking row lost") | must | stated (Tom; 1 hour assumed) |

### Correctness

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| R1 | Two requests arrive for the same slot at once | Exactly one succeeds; the other gets "slot taken" with nearby alternatives | must | stated |
| R2 | An agent retries a booking call it is unsure completed | One booking and one invite. A rare spare Meet room is acceptable. (Relaxed 2026-11-15 from "one Meet room") | must | stated |
| R3 | Tom adds a meeting directly in Outlook | Slots shown to visitors may be up to 5 minutes stale; a booking attempt re-checks Outlook at commit and is refused if the time is now taken. (Relaxed 2026-11-15 from 60 s) | must | stated (Tom) |
| R4 | A booking spans a daylight-saving change or the guest is in another timezone | Times stored in UTC; every time shown or returned carries an explicit offset or zone | must | stated |
| R5 | Tom approves the same request twice (email link and agent), or approves two waiting requests whose times overlap | The second approval of the same request does nothing: one event, one invite. The second overlapping request cannot be approved and is declined. (Added 2026-11-15) | must | stated (Tom) |

### Security

A security measure is what the attacker cannot do.

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| S1 | Someone other than Tom tries to sign in to the owner MCP | No token issued; no owner tool reachable | must | stated |
| S2 | An anonymous caller uses the public page or agent endpoint | Learns only open slots and public event-type details; never event titles, attendees, or anything about other guests | must | assumed |
| S3 | A guest tries to view or change a booking that is not theirs | Refused; booking ids cannot be enumerated; manage tokens are unguessable and single-booking | must | assumed |
| S4 | A script floods the public endpoints (10,000 requests in a day from one source) | Rate-limited; cannot exhaust quotas or push cost over C1 | must | assumed |
| S5 | A script submits bookings to fill Tom's calendar or to make Tom's Outlook send invites to strangers | At most 5 instant bookings per source per day and 10 per day overall; beyond that, requests fall back to approval mode and send nothing | must | assumed |
| S6 | A guest puts instructions aimed at an AI in the name or notes field | Text is length-capped, returned to Tom's agent only inside a field marked as guest-supplied, and never causes any server-side action | must | stated |
| S7 | The database contents leak | Microsoft and Google refresh tokens in it are unusable without a key held outside the database | must | assumed |
| S8 | An owner MCP access token is stolen | It expires within 1 hour, and Tom can revoke every grant with one tool call | should | assumed |
| S9 | An approval email is forwarded or intercepted | The link can only approve or decline that one request, once, and expires with the request | must | assumed |

### Cost, operability, change

| Id | Scenario | Measure | Priority | Basis |
|---|---|---|---|---|
| C1 | System runs at L2 load for a month | Total of $5 or less (Tom's words: "up to $5 a month"). Corrected 2026-11-14 from "under $5", which wrongly excluded the $5.00 paid Workers plan; options A and B were authored against the old wording | must | stated |
| C2 | System runs at L1 load for a month | Total $0 | should | assumed |
| O1 | Tom wants to know why something failed | Recent errors and connection health are readable through an owner MCP tool | must | stated (no dashboard) |
| O2 | A bad release is deployed | Rolled back with one command in under 5 minutes | should | assumed |
| O3 | Tom changes the personal website repo | The scheduler is unaffected, and the reverse | must | stated |
| X1 | A second calendar or meeting provider is added later | Added behind an existing interface with no change to the bookings schema | should | assumed |

## 3. Drivers

The three scenarios most likely to shape the architecture, and what they pull against.

1. **F1 against K8.** An OAuth authorization server that satisfies three different chat clients is the largest single piece, and it has to be built in one pass.
2. **F5 against S4 and S5.** Strangers' agents get in with no login and instant bookings send real invites from Tom's Outlook, so abuse limits carry the whole weight that a login or email verification would otherwise carry.
3. **R1, R2 and A3 against T3.** One booking writes to D1, Outlook and Google Meet. Any of the three can fail or be retried, and the result must still be exactly one booking with one working link, within about 3 seconds.

## 4. Constraints

| Id | Constraint | Basis |
|---|---|---|
| K1 | Runs on Cloudflare Workers in Tom's account, served at a subdomain of yuxingzhou.me (name assumed: `meet`) | stated; DNS on Cloudflare measured 2026-11-14 |
| K2 | Lives in its own repo; the personal website repo is not modified | stated |
| K3 | No admin dashboard; the owner surface is MCP plus emailed approve/decline links | stated |
| K4 | Owner MCP works as a custom connector in Claude, ChatGPT and grok.com: Streamable HTTP, OAuth 2.1 with PKCE, RFC 9728 and RFC 8414 discovery, and both Client ID Metadata Documents and Dynamic Client Registration | stated; client requirements from third-party sources |
| K5 | Calendar is one personal Outlook.com account through Microsoft Graph | stated |
| K6 | Each booking gets its own Google Meet link, created through a Google account | stated |
| K7 | The public agent endpoint is rules only; no language model runs on Tom's side | stated |
| K8 | Built by Claude in one pass. Tom's hands-on work is limited to what only he can do (registering the Microsoft and Google apps, consenting, adding the connector): about an hour. (Relaxed 2026-11-15 from 30 minutes, after two reviewers found every option exceeds 30) | stated (Tom) |
| K9 | Each event type confirms either instantly or on Tom's approval; there is no guest email-verification step | stated |

## 5. Open unknowns

| Id | Unknown | How it gets resolved |
|---|---|---|
| U1 | Whether a personal Gmail account can create Meet rooms through the Meet API, and whether guests can join without Tom admitting them | Third-party evidence says creation works and joining defaults to knock-to-join. Candidate for the step 4 measurement |
| U2 | Which Google account Tom will connect (personal Gmail or Workspace) | **Resolved 2026-11-14: personal Gmail** (stated by Tom) |
| U3 | How grok.com registers as an OAuth client (metadata document or dynamic registration) | Only third-party sources found. Designs support both; confirmed by adding the connector after deploy |
| U4 | Whether Graph sends invites to attendees when an event is created on a personal Outlook account, and how long its refresh token survives idle | Docs check in step 3, or the step 4 measurement |
| U5 | What visitors' agents can actually do with a pasted line (connect to MCP, POST, or fetch only) | Unknowable in advance; F5 and F6 cover both tiers |
| U6 | Real traffic | All of L1 and L2 are assumed; nothing depends on them being right within 10 times |

## Clarifications after confirmation

| Date | Clarification | Basis |
|---|---|---|
| 2026-11-15 | F7: approval requests and alerts must arrive in Tom's Outlook inbox | stated (Tom) |
| 2026-11-15 | Owner sign-in provider (Microsoft or Google): don't care | stated (Tom) |
| 2026-11-15 | D1's restore window is 7 days, not 30. The free Workers plan therefore passes D1, so the plan (free or $5) is a deployment choice to settle at the decision step, not a difference between the options | stated (Tom) |

## Frame revision 2 (2026-11-15)

After the options and the four reviews were written, Tom questioned whether the consistency scenarios were stricter than needed. Cal.com (source and open issues) and Calendly (community reports) both give weaker guarantees: check the calendar, save the booking, write to the calendar as a best effort. Tom agreed these changes:

| Scenario | Change | Reason |
|---|---|---|
| R1 | Kept as is | A database uniqueness rule gives it almost for free |
| R2 | One booking and one invite; a rare spare Meet room is acceptable | The Meet API cannot deduplicate a retried create, and a spare room harms nobody |
| R3 | Displayed slots may be 5 minutes stale; the booking still re-checks Outlook | Calendly users report minutes of lag; the commit-time check is what prevents conflicts |
| A3 | Now a should: confirm, add the link when it succeeds, email Tom after 15 minutes | Cal.com saves the booking when the calendar write fails |
| D1 | 7 days; Outlook is the record of confirmed meetings | Every confirmed meeting exists in Outlook |
| F7 | A waiting request reserves nothing; approving one declines overlapping ones | Removes the cheap lockout the security review found |
| R5 | New: double approval is a no-op; two overlapping requests cannot both be approved | Cal.com has this gap (open issue); Tom wants it closed |
| K8 | About an hour of Tom's hands-on time | Two reviewers found every option exceeds 30 minutes |

Options A, B and C and the four files in `review/` were written against the earlier wording.

## Frame revision 3 (2026-11-15)

Tom asked for any meeting type to be addable and configurable from his agent. F2 now also covers several length options per type, unlisted types, phone and in-person locations, named schedules shared by types, date overrides, weekly caps, and previewing a type's open times before saving. The design is updated in `options/d.md`, section "Event type settings".

## Question-bank topics skipped

Tenant isolation and skew (one owner), compliance obligations, on-call paging (replaced by the A4 email), long-lived connections, batch and streaming workloads.
