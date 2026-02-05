# metaculus-trackers
Metaculus question trackers (static HTML) with live-updating data via Netlify Functions.

## How updates work

The tracker pages are static files:
- `february-2026-currency-tracker.html`
- `german-bond-tracker.html`

They fetch fresh data at runtime from same-origin endpoints:
- `/.netlify/functions/fx-tracker` (Yahoo Finance daily **Close** values)
- `/.netlify/functions/bond-yield` (Deutsche Bundesbank series)

Responses are CDN-cached to keep costs low and avoid redeploying the site for routine data updates.

## Legacy GitHub Action

This repo previously committed daily HTML updates via GitHub Actions. That workflow is now manual-only and does not push changes.
