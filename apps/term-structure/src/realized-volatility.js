const HOUR = 3600;
const HOURS_PER_YEAR = 365.25 * 24;
export const RV_MIN_COVERAGE = 0.99;

// Garman–Klass uses each complete hourly OHLC range and open/close return.
export function hourlyVariance({ open, high, low, close }) {
  if (
    ![open, high, low, close].every((v) => Number.isFinite(v) && v > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    high < low
  )
    return null;
  return Math.max(
    0,
    0.5 * Math.log(high / low) ** 2 -
      (2 * Math.LN2 - 1) * Math.log(close / open) ** 2,
  );
}

function realizedWindows(windows, bars, asOf) {
  if (!Number.isFinite(asOf)) return [];
  const latestComplete = bars.reduce(
    (latest, bar) =>
      bar.ts + HOUR <= asOf ? Math.max(latest, bar.ts + HOUR) : latest,
    -Infinity,
  );
  const end = Number.isFinite(latestComplete)
    ? latestComplete
    : Math.floor(asOf / HOUR) * HOUR;
  const byTs = new Map(bars.map((bar) => [bar.ts, hourlyVariance(bar)]));
  return windows.map(({ expiry, startExpiry, fromHours, toHours }) => {
    const hours = toHours - fromHours;
    const start = end - toHours * HOUR;
    const windowEnd = end - fromHours * HOUR;
    let variance = 0,
      count = 0;
    for (let ts = start; ts < windowEnd; ts += HOUR) {
      const value = byTs.get(ts);
      if (value != null) {
        variance += value;
        count++;
      }
    }
    const coverage = hours > 0 ? count / hours : 0;
    return {
      expiry,
      startExpiry,
      start,
      end: windowEnd,
      hours,
      count,
      coverage,
      partial: count < hours,
      iv:
        count > 0 && coverage >= RV_MIN_COVERAGE && expiry > asOf
          ? Math.sqrt((variance / count) * HOURS_PER_YEAR)
          : null,
    };
  });
}

export function realizedByExpiry(expiries, bars, asOf) {
  if (!Number.isFinite(asOf)) return [];
  return realizedWindows(
    expiries.map((expiry) => ({
      expiry,
      startExpiry: null,
      fromHours: 0,
      toHours: Math.max(1, Math.ceil((expiry - asOf) / HOUR)),
    })),
    bars,
    asOf,
  );
}

// Compare every forward bucket with the most recent history of the same duration.
export function realizedForwardByExpiry(expiries, bars, asOf) {
  if (!Number.isFinite(asOf)) return [];
  const ordered = [...new Set(expiries)].sort((a, b) => a - b);
  return realizedWindows(
    ordered.map((expiry, index) => ({
      expiry,
      startExpiry: index ? ordered[index - 1] : null,
      fromHours: 0,
      toHours: Math.max(
        1,
        Math.ceil((expiry - (index ? ordered[index - 1] : asOf)) / HOUR),
      ),
    })),
    bars,
    asOf,
  );
}
