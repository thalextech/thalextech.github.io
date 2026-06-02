# Dollar Bars

Vue 3 + D3 app that fetches Bitfinex OHLC candles, defaults to a 30-day
lookback, and aggregates them into USD volume-bar candlesticks.

The calculation is OHLC-based. It approximates dollar bars from candle quote
volume, but it is not trade-level equivalent to the notebook's trade CSV path.

The candle resolution is derived from the requested lookback and dollar-bar
count:

```text
source_candles_per_dollar_bar =
  lookback_days * 86400 / (resolution_seconds * requested_dollar_bars)
```

The app chooses the coarsest Bitfinex candle resolution where this ratio is
greater than `100`. If none can satisfy that, it uses `1m`.

Bitfinex candle responses are paginated with `limit=10000`. Longer lookbacks
continue from the last returned candle timestamp until the requested range is
covered. Requests are paced at one request every two seconds, matching the
Bitfinex `30 requests/minute` limit.

## Run

```bash
cd apps/dollar-bars
npm install
npm run dev
```

## Bitfinex API

The Bitfinex API URL is hardcoded to:

```text
https://api-pub.bitfinex.com/v2/candles
```
