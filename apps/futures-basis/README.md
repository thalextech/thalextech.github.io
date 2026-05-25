# Basis (Vue + D3)

Vue 3 + D3 app that mirrors `mark_future_basis.py`: it fetches Thalex index + mark historical data, computes basis metrics, and renders a scatterplot of `mark_price_close` colored by annualized basis.

## Run

```bash
cd apps/basis
npm install
npm run dev
```

## Notes

- The resolution dropdown (`1m`, `5m`, `15m`, `1h`, `1d`) computes `to = now` and `from = now - resolutionSeconds * 1000` to target ~1000 datapoints.
- The instrument dropdown auto-loads BTCUSD futures from the public `/instruments` endpoint and selects the nearest non-expired future by default.
