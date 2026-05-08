# Golf · Pete · Eric · Jim

A summer-long points-tracking app for our heads-up golf competition. Static site
hosted on GitHub Pages, with a JSON file in this repo as the source of truth.

URL: https://petebehrens.github.io/golf/

## What's in here

```
site/
  index.html              single-page app shell
  manifest.webmanifest    PWA manifest (Add to Home Screen on iPhone)
  favicon.svg
  css/style.css
  js/scoring.js           pure scoring engine — no DOM
  js/storage.js           GitHub Contents API + localStorage
  js/app.js               routing + view rendering
  data/seasons.json       the data — every event 2014→present
```

## Rules baked into the scoring engine

- 1 point per 9-hole win, 1–5 strokes
- +1 additional point for a 5+ stroke 9-hole win (so 5+ win = 2 points)
- +1 additional point for the 18-hole win
- +1 additional point per eagle (the player who eagled gets +1 vs each opponent)
- Final round: all points doubled (mark via checkbox at entry time)
- Max hole score: par × 2 (enforced by the entrant)

### House rules per season

| Season | Players | Rule |
|--------|---------|------|
| 2014–2020 | Eric, Pete | Heads-up |
| 2021–2022 | Eric, Pete, Jim | Round-robin pairs, all heads-up |
| 2023 | Eric, Pete, Jim | + Jim's "magic eraser" (any one hole on a 9 reset to par) |
| 2024 | Eric, Pete | USGA-style fractional handicap |
| 2025 | none | Year off |
| 2026+ | Eric, Pete, Jim | Jim gets +2 strokes off each 9 |

For historical events the points are stored as imported from the spreadsheet
(eraser, handicap, doubling, and match-play notation are preserved as-is).
For new events the engine calculates the points and stores them in the same
field, so display logic is uniform.

## Roles

- **Pete** is the keeper of scores. With a fine-grained PAT pasted in Settings,
  the **+ Add Round** button writes directly to `data/seasons.json` in this
  repo via the GitHub Contents API.
- **Eric and Jim** can use the same Add Round form. Without a PAT, Submit
  generates a `#/pending?event=…` URL containing the round (base64 in the
  hash) and opens the iOS/macOS Share Sheet (or copies the link). They text
  it to Pete; Pete taps the link, sees an Approve/Reject prompt, taps
  Approve → it commits to the repo.

## Setup checklist for Pete

1. Create a new GitHub repo: `petebehrens/golf` (public).
2. Push everything in this `site/` directory to the repo root.
3. In repo Settings → Pages: source = `Deploy from a branch`, branch = `main`,
   folder = `/ (root)`. Wait a minute or two for the first deploy.
4. Visit `https://petebehrens.github.io/golf/`.
5. Generate a fine-grained PAT:
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained tokens → Generate new token.
   - Repository access: Only select repositories → `petebehrens/golf`.
   - Repository permissions → Contents: **Read and write**.
   - Expiration: pick what you're comfortable with (1 year is reasonable).
6. Open the deployed site → Settings → paste the PAT → Save.
7. Try **+ Add Round** to write a test event, then delete it and re-commit
   from the local repo (or just leave a placeholder).

For Eric and Jim: they only need the URL. No PAT, no setup. Their suggestions
flow back to you via text.

## Local development

```
cd site
python3 -m http.server 8765
open http://localhost:8765/
```

For the GitHub write flow to work, you need a PAT in localStorage and the
right repo config in Settings. CORS is fine — GitHub's API allows browser
requests.

## Importing/exporting

- **Import**: Settings → paste a `seasons.json` payload → Import. Overwrites
  local cache only; commit via Save flow to persist to the repo.
- **Export JSON**: Settings → Export JSON downloads the current dataset.
- **Export XLSX**: Settings → Export XLSX writes a multi-sheet workbook
  (one sheet per season + an All Years sheet). Lazy-loads SheetJS from CDN.

## Known data quirks

When importing the historical spreadsheet I noticed two minor inconsistencies
where the running-total column drifted from the per-row points column:

- **2024 Pete July 9 IP Back 9**: row says points = 4, running total only
  advanced by 1. Per-row sum: 29.5. Running total: 26.5.
- **2022 Jim vs Eric**: imported sum 19, All Years column says 20.

The app uses per-row values (the actual data) so totals will look slightly
different from the original spreadsheet's bottom row.

## Verification

`verify_scoring.js` (in repo root, not deployed): re-runs the scoring engine
over every imported event and compares against the imported points. For the
new house rules (2026+ engine-computed), every event matches exactly.
Historical mismatches are explained by season-specific rules (final-round
doubling, magic eraser, fractional handicap, match play) — none of which
the engine attempts to back-derive. Display always uses the stored values.
