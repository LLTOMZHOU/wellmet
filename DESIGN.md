# Wellmet design rules

Updated: 2026-11-15

## Direction
A printed Swiss transit timetable: a white sheet split by black rules, bold numerals, and one signal yellow marking what you've picked. (User confirmed: chose direction D, "Swiss grid", over the calling card, departure board and day strip)

## Brand assets (do not change)
- Wordmark: "Wellmet" set in Inter Tight bold, top left of every page. No logo graphic. (Agent inferred)
- Signal yellow `--signal` is the only accent. (User confirmed with direction D)
- Fonts: Inter Tight for everything; IBM Plex Mono only for copyable code and URLs. Self-hosted from `packages/public/static/assets/fonts`, never loaded from Google. (Agent inferred)

## Semantic roles
Variables live in `packages/public/static/assets/styles.css`; this lists where each role is used.
- `--signal`: the current selection only: the chosen date, the chosen time, hover on a time, and the one primary action on the receipt. Never decoration, never a background area. (Agent inferred)
- `--ink`, `--ink-2`, `--ink-3`: text, secondary text, de-emphasised text. `--ink-3` is never body copy. (Agent inferred)
- `--rule` (2px) separates major regions: the two columns, under the top row, above each section. `--hair` (1px) separates rows inside a region. (Agent inferred)
- `--error`: field errors and the "time was just taken" box only. (Agent inferred)
- Type: weight 700 for headlines, times and dates; 600 for values; 400 for prose. Times always use tabular figures. (Agent inferred)
- Shape: no rounded corners anywhere; buttons are flat black rectangles with a 2px border. (Agent inferred)
- Motion: hover fills only, no animation. (Agent inferred)

## Components
- `sheet()` two-column page in `packages/public/src/views/layout.ts`: left for who and what, right for the thing to act on; stacks under 960px. (Agent inferred)
- `.headline` (title, then "with <host>" in grey), `.facts` three-column, `.cal` month calendar with open-time bars, `.time` big time link, `.upcoming` all-times list, `.rows` label/value list, `.status` big status word, `.button` and its `--signal`, `--quiet`, `--danger`, `--small` variants. New pages use these first. (Agent inferred)

## Reference pages
- `packages/public/src/views/pages.ts`: index, booking, confirm and receipt pages are fully built to these rules. (Agent inferred)

## User choices
- 2026-11-15: Inspired by Calendly and Cal.com, with an unusual brand touch so it doesn't read as a clone. (User confirmed)
- 2026-11-15: Compared four directions and chose D, Swiss grid ("I like option D a lot"). (User confirmed)

## Do not
- Do not hide open times behind script: every open time is a plain link in the HTML. The booking page lists the chosen day's times and an "All open times, next 7 days" list. (User confirmed)
- No script at all on owner pages (consent, connect, approve or decline). (User confirmed)
- No second accent colour, no gradients, shadows, textures or rounded corners. (Agent inferred)
- No hero banners or marketing copy; the calendar and the times are the content. (Agent inferred)
