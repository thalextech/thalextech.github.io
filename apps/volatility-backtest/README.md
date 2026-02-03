# Volatility Arbitrage Backtest

Vue 3 app for backtesting volatility arbitrage strategies using Thalex historical option data.

## Features

- **Date range**: Select a past period (max 1 year). Start and end dates must be in the past.
- **Active options**: Only options that were tradable for the **entire** range (created before start, expire after end) are listed.
- **Direction**: Long or short the selected option.
- **Simulation**: Fetches mark price (and IV when available) history and computes PnL over the range.
- **Display**: Summary (start value, end value, PnL) and a time series table with option value (mark), IV, and cumulative PnL.

## Run locally

```bash
cd apps/volatility-backtest
npm install
npm run dev
```

Uses the root `lib/thalex.js` (Thalex public API). No proxy needed if the API allows CORS from your origin.

## Build

From repo root, `./build_apps.sh` builds all apps; output for this app is under `apps_deployment/volatility-backtest/`.
