const DEFAULT_TARGET_BARS = 32;

const isUsableCandle = (candle) =>
  candle?.date instanceof Date &&
  !Number.isNaN(candle.date.getTime()) &&
  Number.isFinite(candle.open) &&
  Number.isFinite(candle.high) &&
  Number.isFinite(candle.low) &&
  Number.isFinite(candle.close) &&
  Number.isFinite(candle.quoteVolume) &&
  candle.quoteVolume > 0;

const emptyBar = (index, binSize) => ({
  index,
  key: String(index),
  binSize,
  open: null,
  high: -Infinity,
  low: Infinity,
  close: null,
  date: null,
  baseVolume: 0,
  quoteVolume: 0,
});

const appendCandle = (bar, candle) => {
  if (bar.open == null) bar.open = candle.open;
  bar.high = Math.max(bar.high, candle.high);
  bar.low = Math.min(bar.low, candle.low);
  bar.close = candle.close;
  bar.date = candle.date;
  bar.baseVolume += candle.baseVolume;
  bar.quoteVolume += candle.quoteVolume;
};

export function getDefaultDollarBinSize(candles, targetBars = DEFAULT_TARGET_BARS) {
  const totalQuoteVolume = (candles || []).reduce(
    (sum, candle) =>
      sum + (Number.isFinite(candle?.quoteVolume) ? candle.quoteVolume : 0),
    0,
  );
  if (!Number.isFinite(totalQuoteVolume) || totalQuoteVolume <= 0) return 0;
  return totalQuoteVolume / Math.max(1, targetBars);
}

export function buildDollarBars(candles, binSize) {
  const cleanCandles = (candles || []).filter(isUsableCandle);
  const size = Number(binSize);
  if (!cleanCandles.length || !Number.isFinite(size) || size <= 0) return [];

  const bars = [];
  let bar = emptyBar(0, size);
  let barVolume = 0;

  for (const candle of cleanCandles) {
    if (barVolume >= size && bar.open != null) {
      bars.push(bar);
      bar = emptyBar(bars.length, size);
      barVolume = 0;
    }

    appendCandle(bar, candle);
    barVolume += candle.quoteVolume;
  }

  if (bar.open != null) bars.push(bar);

  return bars.map((row, index) => ({
    ...row,
    index,
    key: String(index),
    high: Number.isFinite(row.high) ? row.high : row.close,
    low: Number.isFinite(row.low) ? row.low : row.close,
  }));
}
