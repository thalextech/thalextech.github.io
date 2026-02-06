/**
 * Backtest helpers: filter options active in a date range and run PnL simulation.
 * Delta hedge: rehedge by tolerance or frequency; track option PnL + hedge PnL.
 * Uses root lib for fetchInstruments, fetchMarkHistory.
 */
import {
  fetchInstruments,
  fetchMarkHistory,
} from "../../../../lib/thalex.js";

const MAX_RANGE_DAYS = 365;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export const DEFAULT_RESOLUTION = "1d";
export const RESOLUTION_OPTIONS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
];

function resolutionSeconds(resolution) {
  const map = { "1m": 60, "5m": 5 * 60, "15m": 15 * 60, "1h": 60 * 60, "1d": 24 * 60 * 60 };
  return map[resolution] ?? 24 * 60 * 60;
}

/** Standard normal CDF (approximation) for Black–Scholes delta */
function normCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return x >= 0 ? y : 1 - y;
}

/** Black–Scholes delta: S, K, T (years), sigma (e.g. 0.5 for 50%), isCall */
function bsDelta(S, K, T, sigma, isCall) {
  if (!S || !K || T <= 0 || !sigma || sigma <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  return Number.isFinite(delta) ? delta : null;
}

export function getStrike(instrument) {
  if (instrument.strike_price != null) return Number(instrument.strike_price);
  if (instrument.strike != null) return Number(instrument.strike);
  const name = (instrument.instrument_name || "").toUpperCase();
  const m = name.match(/-(\d+)-[CP]/);
  return m ? parseFloat(m[1]) : null;
}

export function isCall(instrument) {
  const type = (instrument.option_type || "").toLowerCase();
  if (type === "call") return true;
  if (type === "put") return false;
  const name = (instrument.instrument_name || "").toUpperCase();
  return name.includes("-C-");
}

export function parseExpirationTs(instrument) {
  if (instrument.expiration_timestamp != null) return Number(instrument.expiration_timestamp);
  if (instrument.expiry_date) {
    const d = new Date(instrument.expiry_date);
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }
  const name = (instrument.instrument_name || "").toUpperCase();
  const m = name.match(/(\d{2})([A-Z]{3})(\d{2})/);
  if (m) {
    const [, day, monthStr, yearShort] = m;
    const monthMap = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const month = monthMap[monthStr];
    if (month !== undefined) {
      const year = 2000 + parseInt(yearShort, 10);
      const d = new Date(Date.UTC(year, month, parseInt(day, 10)));
      return Math.floor(d.getTime() / 1000);
    }
  }
  return null;
}

function getCreateTs(instrument) {
  const t = instrument.create_time ?? instrument.creation_time;
  if (t != null) return Number(t);
  return null;
}

function isOptionForUnderlying(instrument, indexName) {
  const product = (instrument.product || "").toUpperCase();
  const type = (instrument.type || instrument.instrument_type || "").toLowerCase();
  const underlying = (instrument.underlying || "").toUpperCase();
  const idx = (indexName || "").toUpperCase();
  if (type !== "option") return false;
  if (product !== "OBTCUSD" && product !== "OETHUSD") return false;
  return underlying === idx;
}

/**
 * Options that were tradable at both start and end of the range:
 * created before (or at) start, expire after end.
 */
export function filterActiveOptions(instruments, indexName, startTs, endTs) {
  if (!Array.isArray(instruments) || !startTs || !endTs) return [];
  return instruments.filter((inst) => {
    if (!isOptionForUnderlying(inst, indexName)) return false;
    const createTs = getCreateTs(inst);
    const expTs = parseExpirationTs(inst);
    if (createTs == null || expTs == null) return false;
    return createTs <= startTs && expTs > endTs;
  });
}

/**
 * From active options, pick the longest-dated straddle: same strike, same expiry, one call + one put.
 * Returns { call, put } instruments or null if none found.
 */
export function getLongestDatedStraddle(activeOptions) {
  if (!Array.isArray(activeOptions) || activeOptions.length === 0) return null;
  const byExpiry = new Map();
  for (const inst of activeOptions) {
    const expTs = parseExpirationTs(inst);
    if (expTs == null) continue;
    if (!byExpiry.has(expTs)) byExpiry.set(expTs, []);
    byExpiry.get(expTs).push(inst);
  }
  const maxExpiry = Math.max(...byExpiry.keys());
  const atExpiry = byExpiry.get(maxExpiry) || [];
  const byStrike = new Map();
  for (const inst of atExpiry) {
    const k = getStrike(inst);
    if (k == null) continue;
    if (!byStrike.has(k)) byStrike.set(k, { call: null, put: null });
    const bucket = byStrike.get(k);
    if (isCall(inst)) bucket.call = inst;
    else bucket.put = inst;
  }
  for (const k of [...byStrike.keys()].sort((a, b) => a - b)) {
    const { call, put } = byStrike.get(k);
    if (call && put) return { call, put };
  }
  return null;
}

export function validateDateRange(startTs, endTs) {
  if (!startTs || !endTs) return { ok: false, error: "Start and end dates are required." };
  if (endTs <= startTs) return { ok: false, error: "End date must be after start date." };
  const days = (endTs - startTs) / (24 * 60 * 60);
  if (days > MAX_RANGE_DAYS) return { ok: false, error: `Range must be at most ${MAX_RANGE_DAYS} days (1 year).` };
  return { ok: true };
}

export const DEFAULT_DELTA_TOLERANCE = 0.05;
export const DEFAULT_FREQUENCY_MINUTES = 1440; // 1 day
export const FREQUENCY_OPTIONS = [
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "1 day" },
  { value: 2880, label: "2 days" },
  { value: 10080, label: "1 week" },
  { value: 0, label: "When tolerance exceeded only" },
];

/**
 * Run backtest: fetch option mark + perpetual mark; use perp mark as underlying (S) for delta + hedge PnL.
 * instrument: { strike, expiration_timestamp, option_type } or full instrument (strike/parseExpirationTs/isCall used).
 * deltaHedgeParams: { tolerance (default 0.05), frequencyMinutes (default 1440; 0 = rehedge only when |delta - hedge| > tolerance) }.
 * Returns { series, pnl, startValue, endValue, hedgePnl, totalPnl } with series including cumulativeOptionPnl, cumulativeHedgePnl, cumulativeTotalPnl.
 */
export async function runBacktest({
  instrumentName,
  startTs,
  endTs,
  direction,
  instrument,
  indexName,
  resolution = DEFAULT_RESOLUTION,
  deltaHedgeParams = {},
}) {
  const tolerance = Number(deltaHedgeParams.tolerance) || DEFAULT_DELTA_TOLERANCE;
  const frequencyMinutes = deltaHedgeParams.frequencyMinutes != null ? Number(deltaHedgeParams.frequencyMinutes) : DEFAULT_FREQUENCY_MINUTES;
  const frequencySeconds = frequencyMinutes > 0 ? frequencyMinutes * 60 : 0;
  const useFrequency = frequencyMinutes > 0;

  const perpInstrumentName = "BTC-PERPETUAL";
  const [mark, perpRows] = await Promise.all([
    fetchMarkHistory({
      instrument_name: instrumentName,
      resolution,
      from: startTs,
      to: endTs,
    }),
    perpInstrumentName
      ? fetchMarkHistory({
          instrument_name: perpInstrumentName,
          resolution,
          from: startTs,
          to: endTs,
        })
      : Promise.resolve([]),
  ]);

  if (!mark || mark.length === 0) {
    return { series: [], pnl: null, startValue: null, endValue: null, error: "No mark history for this option in the selected range." };
  }
  if (!perpRows || perpRows.length === 0) {
    return {
      series: [],
      pnl: null,
      startValue: null,
      endValue: null,
      error: `No perpetual mark history returned for ${perpInstrumentName || "selected index"}.`,
    };
  }

  const mult = direction === "short" ? -1 : 1;
  const strike = instrument ? getStrike(instrument) : null;
  const expiryTs = instrument ? parseExpirationTs(instrument) : null;
  const isCallOption = instrument ? isCall(instrument) : true;

  const bucketSeconds = resolutionSeconds(resolution);
  const perpByTs = new Map();
  const perpTsList = [];
  const perpPricesByOrder = [];
  if (Array.isArray(perpRows)) {
    const sorted = [...perpRows].filter((r) => (r.mark_price_close ?? r.mark_price) != null && Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts);
    for (const r of sorted) {
      const t = r.ts;
      const price = r.mark_price_close ?? r.mark_price ?? null;
      if (price != null && Number.isFinite(price)) {
        perpByTs.set(t, price);
        perpTsList.push(t);
        perpPricesByOrder.push(price);
      }
    }
  }
  const maxTsDiff = Math.max(bucketSeconds * 2, 25 * 60 * 60);
  function getPerpMarkForTs(ts) {
    if (perpTsList.length === 0) return null;
    const exact = perpByTs.get(ts);
    if (exact != null) return exact;
    let lo = 0;
    let hi = perpTsList.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (perpTsList[mid] <= ts) lo = mid;
      else hi = mid;
    }
    const a = perpTsList[lo];
    const b = perpTsList[hi];
    const da = Math.abs(ts - a);
    const db = Math.abs(ts - b);
    const best = da <= db ? a : b;
    const diff = Math.min(da, db);
    if (diff <= maxTsDiff) return perpByTs.get(best) ?? null;
    return null;
  }

  const series = mark.map((row, i) => {
    const markPrice = row.mark_price_close ?? row.mark_price ?? 0;
    const value = mult * markPrice;
    const prevValue = i === 0 ? value : mult * (mark[i - 1].mark_price_close ?? mark[i - 1].mark_price ?? 0);
    const periodOptionPnl = value - prevValue;

    // When option and perp have same length, use index alignment so consecutive points get consecutive perp prices (S !== prevS), fixing zero hedge PnL.
    const useIndexAlignment = perpPricesByOrder.length > 0 && mark.length === perpPricesByOrder.length;
    let S = useIndexAlignment ? perpPricesByOrder[i] : getPerpMarkForTs(row.ts);
    if (S == null && perpPricesByOrder.length > 0) {
      S = perpPricesByOrder[Math.min(i, perpPricesByOrder.length - 1)];
    }
    const T = expiryTs && row.ts < expiryTs ? (expiryTs - row.ts) / SECONDS_PER_YEAR : null;
    const sigmaRaw = row.iv_close != null ? row.iv_close / 100 : null;
    const sigma = sigmaRaw > 0 ? sigmaRaw : 0.5;
    const delta = strike && S && T && T > 0 ? bsDelta(S, strike, T, sigma, isCallOption) : null;

    return {
      ts: row.ts,
      date: new Date(row.ts * 1000),
      mark_price_close: markPrice,
      iv_close: row.iv_close != null ? row.iv_close : null,
      value,
      periodPnl: i === 0 ? 0 : periodOptionPnl,
      periodOptionPnl: i === 0 ? 0 : periodOptionPnl,
      delta,
      indexPrice: S,
    };
  });

  let cumOption = 0;
  let cumHedge = 0;
  let hedgeRatio = null;
  let lastRehedgeIndex = -1;

  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    const prevS = i > 0 ? series[i - 1].indexPrice : null;
    const S = row.indexPrice;

    cumOption += row.periodOptionPnl ?? 0;
    row.cumulativeOptionPnl = cumOption;

    const periodHedgePnl =
      i > 0 && prevS != null && S != null && hedgeRatio != null && Number.isFinite(hedgeRatio)
        ? hedgeRatio * (S - prevS)
        : 0;
    cumHedge += periodHedgePnl;
    row.cumulativeHedgePnl = cumHedge;
    row.cumulativeTotalPnl = cumOption + cumHedge;
    row.cumulativePnl = row.cumulativeOptionPnl;

    const delta = row.delta;
    const secondsSinceRehedge =
      lastRehedgeIndex < 0 ? (useFrequency ? frequencySeconds : 0) : row.ts - series[lastRehedgeIndex].ts;
    const deltaDev =
      hedgeRatio != null && delta != null ? Math.abs(-delta * mult - hedgeRatio) : (delta != null ? Infinity : 0);
    const timeTrigger = useFrequency && secondsSinceRehedge >= frequencySeconds;
    const toleranceTrigger = deltaDev > tolerance;
    const shouldRehedge =
      delta != null && Number.isFinite(delta) && (timeTrigger || toleranceTrigger);

    if (shouldRehedge) {
      hedgeRatio = -delta * mult;
      lastRehedgeIndex = i;
      row.rehedge = true;
    } else {
      row.rehedge = false;
    }
  }

  const hedgeStats = {
    points: series.length,
    withIndex: series.filter((r) => r.indexPrice != null && Number.isFinite(r.indexPrice)).length,
    withDelta: series.filter((r) => r.delta != null && Number.isFinite(r.delta)).length,
    rehedges: series.filter((r) => r.rehedge).length,
  };

  const rawStart = series[0]?.value;
  const rawEnd = series.length ? series[series.length - 1]?.value : undefined;
  const startValue = rawStart != null && Number.isFinite(rawStart) ? rawStart : null;
  const endValue = rawEnd != null && Number.isFinite(rawEnd) ? rawEnd : null;
  const pnl =
    startValue != null && endValue != null && Number.isFinite(startValue) && Number.isFinite(endValue)
      ? endValue - startValue
      : null;
  const lastRow = series.length ? series[series.length - 1] : null;
  const hedgePnl =
    lastRow != null && lastRow.cumulativeHedgePnl != null && Number.isFinite(lastRow.cumulativeHedgePnl)
      ? lastRow.cumulativeHedgePnl
      : null;
  const totalPnl =
    lastRow != null && lastRow.cumulativeTotalPnl != null && Number.isFinite(lastRow.cumulativeTotalPnl)
      ? lastRow.cumulativeTotalPnl
      : null;

  return {
    series,
    pnl,
    startValue,
    endValue,
    hedgePnl,
    totalPnl,
    hedgeStats,
  };
}

/**
 * Run backtest for a straddle (call + put same strike/expiry). Fetches call mark, put mark, perp; aligns by timestamp; combines option value and delta; same hedge logic.
 */
export async function runBacktestStraddle({
  callInstrument,
  putInstrument,
  startTs,
  endTs,
  direction,
  indexName,
  resolution = DEFAULT_RESOLUTION,
  deltaHedgeParams = {},
}) {
  const tolerance = Number(deltaHedgeParams.tolerance) || DEFAULT_DELTA_TOLERANCE;
  const frequencyMinutes = deltaHedgeParams.frequencyMinutes != null ? Number(deltaHedgeParams.frequencyMinutes) : DEFAULT_FREQUENCY_MINUTES;
  const frequencySeconds = frequencyMinutes > 0 ? frequencyMinutes * 60 : 0;
  const useFrequency = frequencyMinutes > 0;

  const perpInstrumentName = "BTC-PERPETUAL";
  const [callMark, putMark, perpRows] = await Promise.all([
    fetchMarkHistory({
      instrument_name: callInstrument.instrument_name,
      resolution,
      from: startTs,
      to: endTs,
    }),
    fetchMarkHistory({
      instrument_name: putInstrument.instrument_name,
      resolution,
      from: startTs,
      to: endTs,
    }),
    fetchMarkHistory({
      instrument_name: perpInstrumentName,
      resolution,
      from: startTs,
      to: endTs,
    }),
  ]);

  if (!callMark?.length) {
    return { series: [], pnl: null, startValue: null, endValue: null, error: "No mark history for call in the selected range." };
  }
  if (!putMark?.length) {
    return { series: [], pnl: null, startValue: null, endValue: null, error: "No mark history for put in the selected range." };
  }
  if (!perpRows?.length) {
    return { series: [], pnl: null, startValue: null, endValue: null, error: `No perpetual mark history for ${perpInstrumentName}.` };
  }

  const mult = direction === "short" ? -1 : 1;
  const strike = getStrike(callInstrument);
  const expiryTs = parseExpirationTs(callInstrument);

  const bucketSeconds = resolutionSeconds(resolution);
  const perpByTs = new Map();
  const perpTsList = [];
  const perpPricesByOrder = [];
  const putByTs = new Map();
  const putTsList = [];
  const putPricesByOrder = [];

  for (const r of (perpRows || []).filter((x) => (x.mark_price_close ?? x.mark_price) != null && Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts)) {
    const t = r.ts;
    const price = r.mark_price_close ?? r.mark_price ?? null;
    if (price != null && Number.isFinite(price)) {
      perpByTs.set(t, price);
      perpTsList.push(t);
      perpPricesByOrder.push(price);
    }
  }
  for (const r of (putMark || []).filter((x) => (x.mark_price_close ?? x.mark_price) != null && Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts)) {
    const t = r.ts;
    const price = r.mark_price_close ?? r.mark_price ?? null;
    if (price != null && Number.isFinite(price)) {
      putByTs.set(t, price);
      putTsList.push(t);
      putPricesByOrder.push(price);
    }
  }

  const maxTsDiff = Math.max(bucketSeconds * 2, 25 * 60 * 60);
  function getPerpForTs(ts) {
    if (perpTsList.length === 0) return null;
    if (perpByTs.has(ts)) return perpByTs.get(ts);
    let lo = 0, hi = perpTsList.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (perpTsList[mid] <= ts) lo = mid;
      else hi = mid;
    }
    const a = perpTsList[lo], b = perpTsList[hi];
    const best = Math.abs(ts - a) <= Math.abs(ts - b) ? a : b;
    return Math.min(Math.abs(ts - a), Math.abs(ts - b)) <= maxTsDiff ? perpByTs.get(best) : null;
  }
  function getPutForTs(ts) {
    if (putTsList.length === 0) return null;
    if (putByTs.has(ts)) return putByTs.get(ts);
    let lo = 0, hi = putTsList.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (putTsList[mid] <= ts) lo = mid;
      else hi = mid;
    }
    const a = putTsList[lo], b = putTsList[hi];
    const best = Math.abs(ts - a) <= Math.abs(ts - b) ? a : b;
    return Math.min(Math.abs(ts - a), Math.abs(ts - b)) <= maxTsDiff ? putByTs.get(best) : null;
  }

  const useIndexAlignment =
    callMark.length === perpPricesByOrder.length && callMark.length === putPricesByOrder.length;

  const series = callMark.map((row, i) => {
    const callPrice = Number(row.mark_price_close ?? row.mark_price) || 0;
    const putPriceRaw = useIndexAlignment
      ? (putPricesByOrder[i] ?? getPutForTs(row.ts) ?? 0)
      : (getPutForTs(row.ts) ?? (putPricesByOrder[i] ?? 0));
    const putPrice = Number(putPriceRaw) || 0;
    const combinedMark = callPrice + putPrice;
    const value = mult * combinedMark;
    const prevCall =
      i === 0 ? callPrice : Number(callMark[i - 1].mark_price_close ?? callMark[i - 1].mark_price) || 0;
    const prevPutRaw = useIndexAlignment
      ? (i === 0 ? putPrice : (putPricesByOrder[i - 1] ?? 0))
      : (i === 0 ? putPrice : (getPutForTs(callMark[i - 1].ts) ?? 0));
    const prevPut = Number(prevPutRaw) || 0;
    const prevCombined = prevCall + prevPut;
    const prevValue = mult * prevCombined;
    const periodOptionPnl = value - prevValue;

    let S = useIndexAlignment ? perpPricesByOrder[i] : getPerpForTs(row.ts);
    if (S == null && perpPricesByOrder.length > 0) S = perpPricesByOrder[Math.min(i, perpPricesByOrder.length - 1)];

    const T = expiryTs && row.ts < expiryTs ? (expiryTs - row.ts) / SECONDS_PER_YEAR : null;
    const sigmaCall = (row.iv_close != null ? row.iv_close / 100 : 0.5) || 0.5;
    const sigmaPut = sigmaCall;
    const callDelta = strike && S && T && T > 0 ? bsDelta(S, strike, T, sigmaCall, true) : null;
    const putDelta = strike && S && T && T > 0 ? bsDelta(S, strike, T, sigmaPut, false) : null;
    const delta = (callDelta != null && putDelta != null) ? callDelta + putDelta : null;

    return {
      ts: row.ts,
      date: new Date(row.ts * 1000),
      mark_price_close: combinedMark,
      iv_close: row.iv_close != null ? row.iv_close : null,
      value,
      periodPnl: i === 0 ? 0 : periodOptionPnl,
      periodOptionPnl: i === 0 ? 0 : periodOptionPnl,
      delta,
      indexPrice: S,
    };
  });

  let cumOption = 0, cumHedge = 0, hedgeRatio = null, lastRehedgeIndex = -1;

  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    const prevS = i > 0 ? series[i - 1].indexPrice : null;
    const S = row.indexPrice;

    cumOption += row.periodOptionPnl ?? 0;
    row.cumulativeOptionPnl = cumOption;
    const periodHedgePnl =
      i > 0 && prevS != null && S != null && hedgeRatio != null && Number.isFinite(hedgeRatio)
        ? hedgeRatio * (S - prevS)
        : 0;
    cumHedge += periodHedgePnl;
    row.cumulativeHedgePnl = cumHedge;
    row.cumulativeTotalPnl = cumOption + cumHedge;
    row.cumulativePnl = row.cumulativeOptionPnl;

    const delta = row.delta;
    const secondsSinceRehedge =
      lastRehedgeIndex < 0 ? (useFrequency ? frequencySeconds : 0) : row.ts - series[lastRehedgeIndex].ts;
    const deltaDev =
      hedgeRatio != null && delta != null ? Math.abs(-delta * mult - hedgeRatio) : (delta != null ? Infinity : 0);
    const timeTrigger = useFrequency && secondsSinceRehedge >= frequencySeconds;
    const toleranceTrigger = deltaDev > tolerance;
    const shouldRehedge =
      delta != null && Number.isFinite(delta) && (timeTrigger || toleranceTrigger);

    if (shouldRehedge) {
      hedgeRatio = -delta * mult;
      lastRehedgeIndex = i;
      row.rehedge = true;
    } else {
      row.rehedge = false;
    }
  }

  const hedgeStats = {
    points: series.length,
    withIndex: series.filter((r) => r.indexPrice != null && Number.isFinite(r.indexPrice)).length,
    withDelta: series.filter((r) => r.delta != null && Number.isFinite(r.delta)).length,
    rehedges: series.filter((r) => r.rehedge).length,
  };

  const rawStart = series[0]?.value;
  const rawEnd = series.length ? series[series.length - 1]?.value : undefined;
  const startValue = rawStart != null && Number.isFinite(rawStart) ? rawStart : null;
  const endValue = rawEnd != null && Number.isFinite(rawEnd) ? rawEnd : null;
  const pnl =
    startValue != null && endValue != null && Number.isFinite(startValue) && Number.isFinite(endValue)
      ? endValue - startValue
      : null;
  const lastRow = series.length ? series[series.length - 1] : null;
  const hedgePnl =
    lastRow != null && lastRow.cumulativeHedgePnl != null && Number.isFinite(lastRow.cumulativeHedgePnl)
      ? lastRow.cumulativeHedgePnl
      : null;
  const totalPnl =
    lastRow != null && lastRow.cumulativeTotalPnl != null && Number.isFinite(lastRow.cumulativeTotalPnl)
      ? lastRow.cumulativeTotalPnl
      : null;

  return {
    series,
    pnl,
    startValue,
    endValue,
    hedgePnl,
    totalPnl,
    hedgeStats,
  };
}

function buildMarkLookup(rows) {
  const clean = (rows || [])
    .filter((r) => Number.isFinite(r?.ts))
    .map((r) => {
      const priceRaw = r?.mark_price_close ?? r?.mark_price;
      const price = Number(priceRaw);
      if (!Number.isFinite(price)) return null;
      return {
        ts: r.ts,
        price,
        iv: r?.iv_close != null ? Number(r.iv_close) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  const byTs = new Map();
  const tsList = [];
  for (const row of clean) {
    byTs.set(row.ts, row);
    tsList.push(row.ts);
  }
  return { rows: clean, byTs, tsList };
}

function getNearestMarkRow(lookup, ts, maxTsDiff) {
  if (!lookup?.tsList?.length || !Number.isFinite(ts)) return null;
  const exact = lookup.byTs.get(ts);
  if (exact) return exact;
  const tsList = lookup.tsList;
  let lo = 0;
  let hi = tsList.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tsList[mid] <= ts) lo = mid;
    else hi = mid;
  }
  const a = tsList[lo];
  const b = tsList[hi];
  const da = Math.abs(ts - a);
  const db = Math.abs(ts - b);
  const bestTs = da <= db ? a : b;
  const diff = Math.min(da, db);
  if (diff > maxTsDiff) return null;
  return lookup.byTs.get(bestTs) || null;
}

/**
 * Run backtest for one or more option instruments. Option values are summed and hedged as a single position.
 * Supports single option and 2-leg combinations.
 */
export async function runBacktestOptionsBasket({
  instruments,
  startTs,
  endTs,
  direction,
  indexName,
  resolution = DEFAULT_RESOLUTION,
  deltaHedgeParams = {},
}) {
  const selected = Array.isArray(instruments)
    ? instruments.filter((inst) => inst?.instrument_name)
    : [];
  if (!selected.length) {
    return {
      series: [],
      pnl: null,
      startValue: null,
      endValue: null,
      error: "Select at least one option instrument.",
    };
  }

  const tolerance = Number(deltaHedgeParams.tolerance) || DEFAULT_DELTA_TOLERANCE;
  const frequencyMinutes = deltaHedgeParams.frequencyMinutes != null
    ? Number(deltaHedgeParams.frequencyMinutes)
    : DEFAULT_FREQUENCY_MINUTES;
  const frequencySeconds = frequencyMinutes > 0 ? frequencyMinutes * 60 : 0;
  const useFrequency = frequencyMinutes > 0;
  const perpInstrumentName = String(indexName || "").toUpperCase().includes("ETH")
    ? "ETH-PERPETUAL"
    : "BTC-PERPETUAL";

  const [optionMarks, perpRows] = await Promise.all([
    Promise.all(
      selected.map((inst) => fetchMarkHistory({
        instrument_name: inst.instrument_name,
        resolution,
        from: startTs,
        to: endTs,
      })),
    ),
    fetchMarkHistory({
      instrument_name: perpInstrumentName,
      resolution,
      from: startTs,
      to: endTs,
    }),
  ]);

  for (let i = 0; i < selected.length; i += 1) {
    if (!optionMarks[i] || optionMarks[i].length === 0) {
      return {
        series: [],
        pnl: null,
        startValue: null,
        endValue: null,
        error: `No mark history for ${selected[i].instrument_name} in the selected range.`,
      };
    }
  }
  if (!perpRows || perpRows.length === 0) {
    return {
      series: [],
      pnl: null,
      startValue: null,
      endValue: null,
      error: `No perpetual mark history for ${perpInstrumentName}.`,
    };
  }

  const optionLookups = selected.map((inst, idx) => ({
    strike: getStrike(inst),
    expiryTs: parseExpirationTs(inst),
    isCallOption: isCall(inst),
    lookup: buildMarkLookup(optionMarks[idx]),
  }));
  const perpLookup = buildMarkLookup(perpRows);

  if (!perpLookup.rows.length) {
    return {
      series: [],
      pnl: null,
      startValue: null,
      endValue: null,
      error: `No perpetual mark history for ${perpInstrumentName}.`,
    };
  }

  const baseRows = optionLookups[0].lookup.rows;
  if (!baseRows.length) {
    return {
      series: [],
      pnl: null,
      startValue: null,
      endValue: null,
      error: `No mark history for ${selected[0].instrument_name} in the selected range.`,
    };
  }

  const mult = direction === "short" ? -1 : 1;
  const bucketSeconds = resolutionSeconds(resolution);
  const maxTsDiff = Math.max(bucketSeconds * 2, 25 * 60 * 60);
  const useIndexAlignment =
    baseRows.length === perpLookup.rows.length &&
    optionLookups.every((meta) => meta.lookup.rows.length === baseRows.length);

  const series = baseRows.map((baseRow, i) => {
    const ts = baseRow.ts;
    const prevTs = i > 0 ? baseRows[i - 1].ts : ts;
    let combinedMark = 0;
    let prevCombinedMark = 0;
    const matchedRows = [];

    for (const meta of optionLookups) {
      const { lookup } = meta;
      let currentRow = null;
      if (useIndexAlignment) {
        currentRow = lookup.rows[i] ?? getNearestMarkRow(lookup, ts, maxTsDiff);
      } else {
        currentRow =
          getNearestMarkRow(lookup, ts, maxTsDiff) ??
          lookup.rows[Math.min(i, lookup.rows.length - 1)] ??
          null;
      }
      let prevRow = currentRow;
      if (i > 0) {
        if (useIndexAlignment) {
          prevRow = lookup.rows[i - 1] ?? getNearestMarkRow(lookup, prevTs, maxTsDiff);
        } else {
          prevRow = getNearestMarkRow(lookup, prevTs, maxTsDiff) ?? currentRow;
        }
      }

      const price = currentRow?.price ?? 0;
      const prevPrice = i === 0 ? price : (prevRow?.price ?? 0);
      combinedMark += price;
      prevCombinedMark += prevPrice;
      matchedRows.push(currentRow);
    }

    let perpRow = null;
    if (useIndexAlignment) {
      perpRow = perpLookup.rows[i] ?? getNearestMarkRow(perpLookup, ts, maxTsDiff);
    } else {
      perpRow =
        getNearestMarkRow(perpLookup, ts, maxTsDiff) ??
        perpLookup.rows[Math.min(i, perpLookup.rows.length - 1)] ??
        null;
    }
    const S = perpRow?.price ?? null;

    let delta = null;
    if (S != null && Number.isFinite(S)) {
      let deltaSum = 0;
      let hasDelta = false;
      for (let j = 0; j < optionLookups.length; j += 1) {
        const meta = optionLookups[j];
        const row = matchedRows[j];
        const T =
          meta.expiryTs && ts < meta.expiryTs
            ? (meta.expiryTs - ts) / SECONDS_PER_YEAR
            : null;
        const sigmaRaw = row?.iv != null ? row.iv / 100 : null;
        const sigma = sigmaRaw > 0 ? sigmaRaw : 0.5;
        const d =
          meta.strike && T && T > 0
            ? bsDelta(S, meta.strike, T, sigma, meta.isCallOption)
            : null;
        if (d != null && Number.isFinite(d)) {
          deltaSum += d;
          hasDelta = true;
        }
      }
      delta = hasDelta ? deltaSum : null;
    }

    const value = mult * combinedMark;
    const prevValue = mult * prevCombinedMark;
    const periodOptionPnl = i === 0 ? 0 : value - prevValue;

    return {
      ts,
      date: new Date(ts * 1000),
      mark_price_close: combinedMark,
      iv_close: baseRow.iv != null && Number.isFinite(baseRow.iv) ? baseRow.iv : null,
      value,
      periodPnl: periodOptionPnl,
      periodOptionPnl,
      delta,
      indexPrice: S,
    };
  });

  let cumOption = 0;
  let cumHedge = 0;
  let hedgeRatio = null;
  let lastRehedgeIndex = -1;

  for (let i = 0; i < series.length; i += 1) {
    const row = series[i];
    const prevS = i > 0 ? series[i - 1].indexPrice : null;
    const S = row.indexPrice;

    cumOption += row.periodOptionPnl ?? 0;
    row.cumulativeOptionPnl = cumOption;
    const periodHedgePnl =
      i > 0 && prevS != null && S != null && hedgeRatio != null && Number.isFinite(hedgeRatio)
        ? hedgeRatio * (S - prevS)
        : 0;
    cumHedge += periodHedgePnl;
    row.cumulativeHedgePnl = cumHedge;
    row.cumulativeTotalPnl = cumOption + cumHedge;
    row.cumulativePnl = row.cumulativeOptionPnl;

    const deltaDev =
      hedgeRatio != null && row.delta != null
        ? Math.abs(-row.delta * mult - hedgeRatio)
        : (row.delta != null ? Infinity : 0);
    const secondsSinceRehedge =
      lastRehedgeIndex < 0
        ? (useFrequency ? frequencySeconds : 0)
        : row.ts - series[lastRehedgeIndex].ts;
    const timeTrigger = useFrequency && secondsSinceRehedge >= frequencySeconds;
    const toleranceTrigger = deltaDev > tolerance;
    const shouldRehedge =
      row.delta != null && Number.isFinite(row.delta) && (timeTrigger || toleranceTrigger);

    if (shouldRehedge) {
      hedgeRatio = -row.delta * mult;
      lastRehedgeIndex = i;
      row.rehedge = true;
    } else {
      row.rehedge = false;
    }
  }

  const hedgeStats = {
    points: series.length,
    withIndex: series.filter((r) => r.indexPrice != null && Number.isFinite(r.indexPrice)).length,
    withDelta: series.filter((r) => r.delta != null && Number.isFinite(r.delta)).length,
    rehedges: series.filter((r) => r.rehedge).length,
  };

  const rawStart = series[0]?.value;
  const rawEnd = series.length ? series[series.length - 1]?.value : undefined;
  const startValue = rawStart != null && Number.isFinite(rawStart) ? rawStart : null;
  const endValue = rawEnd != null && Number.isFinite(rawEnd) ? rawEnd : null;
  const pnl =
    startValue != null && endValue != null && Number.isFinite(startValue) && Number.isFinite(endValue)
      ? endValue - startValue
      : null;
  const lastRow = series.length ? series[series.length - 1] : null;
  const hedgePnl =
    lastRow != null && lastRow.cumulativeHedgePnl != null && Number.isFinite(lastRow.cumulativeHedgePnl)
      ? lastRow.cumulativeHedgePnl
      : null;
  const totalPnl =
    lastRow != null && lastRow.cumulativeTotalPnl != null && Number.isFinite(lastRow.cumulativeTotalPnl)
      ? lastRow.cumulativeTotalPnl
      : null;

  return {
    series,
    pnl,
    startValue,
    endValue,
    hedgePnl,
    totalPnl,
    hedgeStats,
  };
}

export async function loadInstruments() {
  return fetchInstruments();
}
