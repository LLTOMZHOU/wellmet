# Wellmet design rules

Updated: 2026-11-15

## Direction
A calling card left for a visitor: warm paper, typeset ink, and one red postmark. The name comes from the old greeting "well met". (User confirmed)

## Brand assets (do not change)
- The postmark seal (`seal()` in `packages/public/src/views/layout.ts`): a ring with "WELL MET" around an italic "wm", with cancellation waves at card size. Small brand-mark size drops the ring text. (User confirmed)
- Stamp red `--stamp` is the only accent colour. (User confirmed)
- Fonts: Newsreader (serif) and IBM Plex Mono, self-hosted from `packages/public/assets/fonts`, never loaded from Google. (Agent inferred)

## Semantic roles
Variables live in `packages/public/assets/styles.css`; this lists where each role is used.
- `--paper`, `--paper-2`, `--paper-3`: page, cards and notes, pressed or disabled fills. (Agent inferred)
- `--ink`, `--ink-2`, `--ink-3`: text, secondary text, labels and hints. `--ink-3` is never used for body text. (Agent inferred)
- `--stamp`: the one primary action per page, the chosen time, hover tint on times, and pending postmarks. Nothing else. (Agent inferred)
- `--ok`: the "Booked" postmark only. (Agent inferred)
- Type: Newsreader for titles, body and dates; Plex Mono for times, small-caps labels, buttons and anything an agent might copy. Times always use tabular figures. (Agent inferred)
- Shape: cards 10px radius, controls 6px, time tickets 4px with 6px notches on both short edges. Hairline rules, not boxes, separate rows. (Agent inferred)
- Motion: hover and press only, 140 to 160ms, off under reduced motion. (Agent inferred)

## Components
- `.card` calling card, `.facts` label/value rows, `.ticket` time slot, `.note` assistant note, `.receipt` with `.postmark`, `.button--stamp | --quiet | --danger`, `.banner` and `.banner--warn`. New pages use these first. (Agent inferred)

## Reference pages
- `packages/public/src/views/pages.ts`: index, booking, confirm and receipt pages are fully built to these rules. (Agent inferred)

## User choices
- 2026-11-15: Inspired by Calendly and Cal.com's who-and-what / day / time structure, with an unusual brand touch so it doesn't read as a clone. (User confirmed)
- 2026-11-15: Chose the calling-card direction from mockups. (User confirmed)

## Do not
- Do not put a JavaScript calendar widget on the booking page: every open time is a plain link in the HTML so page-reading agents can see it. (User confirmed)
- No script at all on owner pages (consent, connect, approve or decline). (User confirmed)
- No large page titles or hero banners; the times are the main content. (Agent inferred)
- No second accent colour, and no paper textures or grain images. (Agent inferred)
