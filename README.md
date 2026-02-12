# metaculus-trackers
Metaculus question trackers (static HTML) with live-updating data via Netlify Functions.

## How updates work

The tracker pages are static files:
- `february-2026-currency-tracker.html`
- `german-bond-tracker.html`
- `brent-wti-spread-tracker.html`
- `ivv-basket-weight-tracker.html`

They fetch fresh data at runtime from same-origin endpoints:
- `/.netlify/functions/fx-tracker` (Yahoo Finance daily **Close** values)
- `/.netlify/functions/bond-yield` (Deutsche Bundesbank series)
- `/.netlify/functions/oil-calibrated` (EIA spot ground truth + Yahoo futures for calibrated intraday estimates)
- `/.netlify/functions/ivv-holdings-weight` (iShares IVV holdings CSV; basket weights)

Responses are CDN-cached to keep costs low and avoid redeploying the site for routine data updates.

## Required environment variables

- `EIA_API_KEY` (required for `oil-calibrated`): create a free key at EIA Open Data and set it in Netlify. If you use Deploy Previews, set it for both **Production** and **Deploy Previews** contexts.

## Rigorous checks (before pushing)

This repo is a live data dashboard, so we run sanity checks before shipping:

- Unit tests (mock upstream API shapes): `node --test scripts/bond-yield.test.js scripts/fx-tracker.test.js`
- CI runs the same tests on PRs (see `.github/workflows/ci.yml`).

## Legacy GitHub Action

This repo previously committed daily HTML updates via GitHub Actions. That workflow is now manual-only and does not push changes.
