# Volatility Arbitrage (Vue + D3)

Vue 3 + D3 app that displays realized volatility calculated from Thalex index price historical data. The app visualizes index price over time with volatility shown as either a gradient color scale or histogram bars.

## Features

- **Realized Volatility Calculation**: Calculates rolling realized volatility from index price returns
- **Two Visualization Modes**:
  - **Gradient**: Scatter plot of index price over time, colored by realized volatility
  - **Histogram**: Index price line chart with volatility bars
- **Multiple Resolutions**: Support for 1m, 5m, 15m, 1h, and 1d timeframes
- **Interactive Detail View**: Brush selection in gradient mode shows volatility vs price scatter plot

## Run

```bash
cd volatility-arbitrage
npm install
npm run dev
```

## Notes

- Realized volatility is calculated as the standard deviation of log returns over a rolling window (default: 20 periods), annualized
- The resolution dropdown computes the time range to show approximately 400 data points
- The default API base is `/api/v2/public` and `vite.config.js` proxies `/api/*` to `https://thalex.com` to avoid CORS during local dev
- Supported indices: BTCUSD, ETHUSD
