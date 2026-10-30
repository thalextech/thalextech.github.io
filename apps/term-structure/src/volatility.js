// Domain inputs use seconds, decimal IV, and C/P sides. No API row shapes here.
export const SLICES = [
  { value: "atm", label: "ATM at spot" },
  { value: "25p", label: "25Δ put", side: "P", delta: -0.25 },
  { value: "25c", label: "25Δ call", side: "C", delta: 0.25 },
  { value: "10p", label: "10Δ put", side: "P", delta: -0.1 },
  { value: "10c", label: "10Δ call", side: "C", delta: 0.1 },
];

export function selectLiveQuotes(quotes, source = "mark") {
  return source === "mark"
    ? quotes
    : quotes.map((q) => ({
        ...q,
        iv: q.bookIv > 0 && Number.isFinite(q.bookIv) ? q.bookIv : q.iv,
      }));
}

export function rankCurrentCurve(current, history) {
  const byExpiry = new Map();
  for (const point of history) {
    if (!byExpiry.has(point.expiry)) byExpiry.set(point.expiry, []);
    byExpiry.get(point.expiry).push(point.iv);
  }
  return current.map((point) => {
    const sample = byExpiry.get(point.expiry) || [];
    const rank = sample.length
      ? (100 *
          sample.reduce(
            (n, iv) => n + (iv < point.iv ? 1 : iv === point.iv ? 0.5 : 0),
            0,
          )) /
        sample.length
      : null;
    return { ...point, count: sample.length, rank };
  });
}

function normalCdf(x) {
  const z = Math.abs(x),
    t = 1 / (1 + 0.2316419 * z);
  const p =
    1 -
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}

export function spotDelta({ strike, iv, spot, expiry, ts, side }) {
  const years = (expiry - ts) / (365.25 * 86400);
  if (!(years > 0 && iv > 0 && spot > 0 && strike > 0)) return NaN;
  const d1 =
    (Math.log(spot / strike) + (iv * iv * years) / 2) / (iv * Math.sqrt(years));
  return normalCdf(d1) - (side === "P" ? 1 : 0);
}

// Undiscounted Black forward price, using the live ticker's expiry forward.
export function bookMidIv({ bid, ask, forward, strike, expiry, ts, side }) {
  if (
    ![bid, ask, forward, strike, expiry, ts].every(Number.isFinite) ||
    bid < 0 ||
    ask <= 0 ||
    ask < bid ||
    forward <= 0 ||
    strike <= 0 ||
    expiry <= ts
  )
    return null;
  const price = (bid + ask) / 2,
    years = (expiry - ts) / (365.25 * 86400);
  const intrinsic = Math.max(
    side === "C" ? forward - strike : strike - forward,
    0,
  );
  if (price <= intrinsic || price >= (side === "C" ? forward : strike))
    return null;
  const optionPrice = (iv) => {
    const volTime = iv * Math.sqrt(years);
    const d1 = Math.log(forward / strike) / volTime + volTime / 2,
      d2 = d1 - volTime;
    return side === "C"
      ? forward * normalCdf(d1) - strike * normalCdf(d2)
      : strike * normalCdf(-d2) - forward * normalCdf(-d1);
  };
  let low = 0.000001,
    high = 1;
  while (optionPrice(high) < price && high < 64) high *= 2;
  if (optionPrice(high) < price) return null;
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2;
    if (optionPrice(mid) < price) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function interpolateSlice(quotes, slice = "atm") {
  const clean = quotes.filter(
    (q) =>
      q.iv > 0 &&
      Number.isFinite(q.iv) &&
      q.strike > 0 &&
      q.spot > 0 &&
      q.expiry > q.ts,
  );
  if (!clean.length) return null;
  const spec = SLICES.find((s) => s.value === slice);
  if (!spec) throw new Error(`Unknown volatility slice: ${slice}`);
  let points, target;
  if (slice === "atm") {
    const strikes = new Map();
    for (const q of clean) {
      if (!strikes.has(q.strike)) strikes.set(q.strike, []);
      strikes.get(q.strike).push(q.iv * q.iv);
    }
    points = [...strikes].map(([x, vars]) => ({
      x,
      variance: vars.reduce((a, b) => a + b, 0) / vars.length,
    }));
    target = clean[0].spot;
  } else {
    points = clean
      .filter((q) => q.side === spec.side)
      .map((q) => ({ x: spotDelta(q), variance: q.iv * q.iv }))
      .filter((q) => Number.isFinite(q.x));
    target = spec.delta;
  }
  points.sort((a, b) => a.x - b.x);
  if (!points.length) return null;
  let low = points.findLast((p) => p.x <= target),
    high = points.find((p) => p.x >= target);
  // Preserve the notebook's nearest-strike ATM fallback, but never extrapolate delta wings.
  const clamped = !low || !high;
  if (clamped && slice !== "atm") return null;
  low ||= high;
  high ||= low;
  const weight = high.x === low.x ? 0 : (target - low.x) / (high.x - low.x);
  return {
    iv: Math.sqrt(low.variance * (1 - weight) + high.variance * weight),
    clamped,
  };
}

export function buildTermStructure({
  live,
  history,
  slice = "atm",
  limit = 2000,
  expiries,
}) {
  const current = buildCurrentSeries(live, slice);
  const observations = buildHistoricalSeries({ history, slice, limit, expiries: expiries || current.map(p => p.expiry) });
  return { current: rankCurrentCurve(current, observations), history: observations };
}

export function buildCurrentSeries(live, slice = "atm") {
  const liveGroups = new Map();
  for (const q of live) {
    if (!liveGroups.has(q.expiry)) liveGroups.set(q.expiry, []);
    liveGroups.get(q.expiry).push(q);
  }
  return [...liveGroups]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([expiry, quotes]) => {
      const point = interpolateSlice(quotes, slice);
      return point
        ? [{ expiry, ts: Math.max(...quotes.map((q) => q.ts)), ...point }]
        : [];
    });
}

export function buildHistoricalSeries({ history, slice = "atm", limit = 2000, expiries }) {
  const liveExpiries = new Set(expiries);
  const groups = new Map();
  for (const q of history) {
    if (!liveExpiries.has(q.expiry)) continue;
    const key = `${q.expiry}:${q.ts}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const byExpiry = new Map();
  for (const quotes of groups.values()) {
    const point = interpolateSlice(quotes, slice);
    if (!point) continue;
    const { expiry, ts } = quotes[0];
    if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
    byExpiry.get(expiry).push({ expiry, ts, ...point });
  }
  return [...byExpiry.values()].flatMap((rows) =>
    rows.sort((a, b) => a.ts - b.ts).slice(-limit),
  );
}
