# Scenario-by-option matrix

Built 2026-11-15 from the three revised scorecards (options at Revision 2, frame at revision 2).

**How to read it:** the frame has 40 scenarios and 9 constraints. 42 of those 49 rows are "pass" in all three options, so they are listed by id only. The 7 rows below are the ones that are not a clean pass everywhere. Every pass is the author's own score after revising; `review/recheck.md` will say whether the fixes are real.

The frame's wording for each id is in `frame.md`. Each option's full scorecard, with the number and basis for every row, is the "Scenario scorecard" section of its file in `options/`.

## Rows that are not a clean pass

| Scenario | Option A | Option B | Option C | Why |
|---|---|---|---|---|
| F1: sign in from Claude, ChatGPT, Grok (must) | unknown | unknown | unknown | Nobody has tried it in any client |
| F4: invite arrives with a Meet link (must) | unknown | unknown | unknown | Meet on a personal Gmail account is unmeasured |
| K4: one endpoint serves all three chat apps (constraint) | unknown | unknown | unknown | Same as F1 |
| K6: unique Meet link per booking (constraint) | unknown | unknown | unknown | Same as F4 |
| T3: booking within 3 s (should) | unknown, 310 ms spare | unknown, 250 ms spare | unknown, 300 ms spare | Outlook and Google response times are guesses |
| T4: owner tool within 3 s (should) | pass | unknown, 20 ms spare | pass | B's extra hops leave almost no margin |
| A1: up 99.5% of a month (should) | unknown | unknown | unknown | On the free plan a large flood is an outage until midnight UTC |

Three rows were aligned: Option C scored F4 and K6 as pass, and Option A scored K4 as pass, on facts the other options scored unknown. They are shown as unknown for all three.

## Rows that pass in all three

- **Function:** F2, F3, F5, F6, F7, F8
- **Load:** L1, L2, L3
- **Latency:** T1, T2
- **Availability and durability:** A2, A3, A4, D1
- **Correctness:** R1, R2, R3, R4, R5
- **Security:** S1, S2, S3, S4, S5, S6, S7, S8, S9
- **Cost, operability, change:** C1, C2, O1, O2, O3, X1
- **Constraints:** K1, K2, K3, K5, K7, K8, K9
