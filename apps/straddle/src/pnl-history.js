import { csvParse } from "d3";

// The only boundary that knows Thalex's historical row and instrument shapes.
export function buildStraddlePnlHistory({ index, callMark, putMark, callInstrument, putInstrument, intervalSeconds }) {
  if (!callInstrument || !putInstrument) return { legs: [], observations: [], intervalSeconds };
  const legs = [callInstrument, putInstrument].map(instrument => ({
    name: instrument.instrument_name,
    strike: Number(instrument.strike_price),
    expiry: Number(instrument.expiration_timestamp),
    type: instrument.option_type.toLowerCase(),
    quantity: 1,
  }));
  const calls = new Map(callMark.map(row => [row.ts, row]));
  const puts = new Map(putMark.map(row => [row.ts, row]));
  const observations = index.map(row => ({ ts: row.ts, spot: row.index_price_close,
    marks: [calls.get(row.ts)?.mark_price_close, puts.get(row.ts)?.mark_price_close],
    reportedIvs: [calls.get(row.ts)?.iv_close, puts.get(row.ts)?.iv_close],
  })).sort((a, b) => a.ts - b.ts);
  // Keep incomplete observations: the engine rejects them rather than silently
  // bridging missing data and presenting a coarser path as the chosen resolution.
  return { legs, observations, intervalSeconds };
}

// Observations only: never interpolate, forward-fill, or infer ATM from the legs.
export function parseAtmIvHistory(csv, expiry) {
  const rows = csvParse(csv.trim());
  if (!["timestamp", "expiry", "atm_iv"].every(key => rows.columns.includes(key))) {
    throw new Error("ATM CSV needs timestamp,expiry,atm_iv columns (UTC seconds or ISO UTC; IV as a decimal).");
  }
  const timestamp = value => /^\d+(\.\d+)?$/.test(value) ? Number(value)
    : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) / 1000 : NaN;
  const result = new Map();
  for (const row of rows) {
    const ts = timestamp(row.timestamp);
    const rowExpiry = timestamp(row.expiry);
    const iv = row.atm_iv.trim() === "" ? NaN : Number(row.atm_iv);
    if (!Number.isFinite(ts) || rowExpiry !== expiry || !Number.isFinite(iv) || iv < 0 || result.has(ts)) {
      throw new Error("ATM rows must be unique, have nonnegative decimal IV, and match the selected expiry exactly.");
    }
    result.set(ts, iv);
  }
  if (!result.size) throw new Error("ATM CSV has no observations.");
  return result;
}
