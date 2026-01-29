# Rolls Analysis (Vue + D3)

Vue 3 + D3 app that analyzes roll instruments, displaying annualized basis charts with statistical analysis including z-scores and trading recommendations.

## Features

- **Basis Visualization**: Scatter plot of mark price colored by annualized basis (gradient mode) or histogram view
- **Rolls Analysis Table**: Shows implied annualized basis for all roll instruments with:
  - Difference from average
  - Z-score analysis
  - Trading recommendations (Buy/Sell/Neutral)

## Run

```bash
cd rolls-analysis
npm install
npm run dev
```

## Notes

- The resolution dropdown (`1m`, `5m`, `15m`, `1h`, `1d`) computes `to = now` and `from = now - resolutionSeconds * 400` to target ~400 datapoints.
- The instrument dropdown auto-loads BTCUSD futures from the public `/instruments` endpoint.
- The default API base is `/api/v2/public` and `vite.config.js` proxies `/api/*` to `https://thalex.com` to avoid CORS during local dev.
