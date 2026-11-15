# The three options in plain terms

A short, readable version of the three designs. The full documents are in `options/` and are reference material; you should not need them to follow the decision.

Everything here is from the options as revised (Revision 2). The authors' fixes are self-reported until the re-review in `review/recheck.md` confirms them.

## What all three have in common

- Runs on Cloudflare's free plan at `meet.yuxingzhou.me`, with a stated trigger to move to the $5 plan.
- A booking page for people, a no-login endpoint for their agents, and a signed-in MCP endpoint for you.
- Your Outlook calendar is read for busy times and written when a booking confirms. Outlook sends the invite as you.
- A Google Meet room is created per booking. If Google fails, the booking still confirms and the link is added later.
- Each event type confirms instantly or waits for your approval. A waiting request reserves nothing; approving one declines the others that overlap it.
- Approval requests and alerts arrive in your Outlook inbox with approve and decline links.
- A scheduled job runs every minute to retry unfinished work, expire old requests and refresh tokens.

## Option A: one Worker

**In one sentence:** one program does everything, organised into modules inside it.

| | |
|---|---|
| Deployed parts | 1 Worker, 1 database, 1 small store for sign-in grants |
| Addresses | `meet.yuxingzhou.me` only |
| Your sign-in | Microsoft; the same sign-in connects the Outlook calendar |
| Tools | 14 for you, 3 for visitors' agents |
| Size | About 1,900 lines (author's estimate) |
| Your setup time | About 43 minutes (author's estimate) |

**How a booking flows:** the request arrives, the Worker checks its rules, writes the booking to the database, re-reads Outlook, asks Google for a Meet room, and creates the Outlook event.

**Strength:** the least to build, deploy and debug. One log, one rollback.

**Weakness:** the public page, your owner tools and your stored Microsoft and Google credentials all run in the same program. A bug in the public part is a bug in the part that holds the credentials.

## Option B: five Workers

**In one sentence:** each job gets its own program, and each program can only call the one next to it.

| Worker | Address | Job | What it can reach |
|---|---|---|---|
| `sched-public` | `meet.yuxingzhou.me` | Booking page and visitors' agents | Only the core's public interface. Holds no data and no secrets |
| `sched-auth` | `meet-auth.yuxingzhou.me` | Signs you in; serves approve and decline pages | Its own sign-in store |
| `sched-mcp` | `meet-mcp.yuxingzhou.me` | Your owner tools | Only the core's owner interface |
| `sched-core` | none | Rules, abuse limits, bookings | The bookings database and the vault |
| `sched-vault` | none | Talks to Outlook and Google | The only holder of your Microsoft and Google credentials |

| | |
|---|---|
| Deployed parts | 5 Workers, 3 databases, 1 store for sign-in grants |
| Your sign-in | Google |
| Tools | 21 for you, 6 for visitors' agents |
| Size | About 1.4 times a balanced design (author's estimate) |
| Your setup time | About 39 minutes (author's estimate) |

**How a booking flows:** public Worker, then core, then vault, then Outlook and Google, and back.

**Strength:** if the public Worker is fully compromised, the attacker still cannot read a stored booking, reach an owner tool, or touch your credentials. They are held to the same limits as any anonymous visitor.

**Weakness:** five things to deploy, roll back and debug, with errors relayed through the core. Every request pays for the extra hops: about 250 ms of headroom on a booking and 20 ms on the slowest owner tool.

## Option C: one Worker with a per-booking lock

**In one sentence:** like Option A, but each booking is driven by a small lock-and-timer object that can resume it after a crash.

| | |
|---|---|
| Deployed parts | 1 Worker, 1 lock object class, 1 database, 1 store for sign-in grants |
| Addresses | `meet.yuxingzhou.me` only |

**Strength:** a booking interrupted halfway is picked up where it left off.

**Weakness:** the slowest booking path, fewer slots offered, and machinery the relaxed requirements no longer ask for.

## A and B side by side

| | Option A | Option B |
|---|---|---|
| Separation of jobs | In code: modules inside one Worker | In deployment: one Worker per job |
| What enforces the separation | Convention. Any module can call any other | The platform. A Worker can only call what it is bound to |
| If the public page has a security bug | The attacker is in the same program as your credentials | The attacker is in a program with no data and no secrets |
| If one part has an ordinary bug | Everything redeploys together; one bad release takes down all of it | Only that Worker is affected |
| Deploy and rollback | One command | Five Workers, in order |
| Finding out what broke | One log | Five logs, relayed through the core |
| Speed | 310 ms headroom on a booking | 250 ms on a booking, 20 ms on the slowest owner tool |
| Sign-in for chat apps | Signed-in and no-login endpoints share one address (untested) | Each has its own address (untested) |
| Build risk in one pass | Lowest | Highest |

**The point to be clear on:** separate Workers are not needed to get a tidy design. Option A already has a module for the MCP tools, a module for booking, a module for sign-in and so on. What separate Workers add is a wall the platform enforces, plus independent deploys. The question is whether those two things are worth five deployables.

## A middle path: three Workers

Not one of the reviewed options. Your skill treats a hybrid as a new design that needs its own review before it is recorded.

| Worker | Address | Job |
|---|---|---|
| Public | `meet.yuxingzhou.me` | Booking page and visitors' agents. No data, no secrets |
| Owner | `meet-mcp.yuxingzhou.me` | Your sign-in and your MCP tools |
| Core | none | Rules, bookings, and the Outlook and Google credentials |

What it keeps from B: the public Worker holds nothing, the owner endpoint has its own address, and each part deploys on its own. What it gives up: the separate vault, so the core holds both the bookings and the credentials, and sign-in shares a Worker with the owner tools.

It matches the picture you described (one Worker for MCP, one for booking), costs roughly one extra hop instead of two or three, and removes Option A's main untested assumption, because the signed-in endpoint and the no-login endpoint no longer share an address.
