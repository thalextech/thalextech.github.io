const API_BASE = "/api/v2/public";

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "thalex-cache";

function getLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

function isCacheFresh(timestamp) {
  return (
    typeof timestamp === "number" && Date.now() - timestamp <= CACHE_TTL_MS
  );
}

function readCache(key) {
  const storage = getLocalStorage();
  if (!storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!isCacheFresh(parsed.timestamp)) {
    storage.removeItem(key);
    return null;
  }
  if (!Array.isArray(parsed.rows)) {
    storage.removeItem(key);
    return null;
  }
  return {
    rows: parsed.rows,
    meta: parsed.meta,
  };
}

function clearOldCache() {
  const storage = getLocalStorage();
  if (!storage) return;

  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) {
      keys.push(key);
    }
  }

  // Parse timestamps and sort by age (oldest first)
  const entries = keys.map(key => {
    try {
      const raw = storage.getItem(key);
      const parsed = JSON.parse(raw);
      return { key, timestamp: parsed.timestamp || 0 };
    } catch {
      return { key, timestamp: 0 };
    }
  }).sort((a, b) => a.timestamp - b.timestamp);

  // Remove oldest 30% of cache entries
  const toRemove = Math.ceil(entries.length * 0.3);
  for (let i = 0; i < toRemove && i < entries.length; i++) {
    storage.removeItem(entries[i].key);
  }
}

function writeCache(key, rows, meta) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const payload = {
      timestamp: Date.now(),
      rows,
      meta,
    };
    storage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    if (error.name === "QuotaExceededError") {
      // Clear old cache entries and retry once
      clearOldCache();
      try {
        storage.setItem(key, JSON.stringify(payload));
      } catch (retryError) {
        // Silently fail if still can't write
      }
    }
  }
}

async function getJson(url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        json?.error?.message ||
        json?.message ||
        `Request failed (${res.status})`;
      throw new Error(message);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function makeUrl(path, params = {}) {
  const search = new URLSearchParams(params);
  return `${API_BASE}${path}?${search}`;
}

export async function fetchInstruments() {
  const url = makeUrl("/instruments", {});
  const json = await getJson(url);
  const result = json?.result;
  if (!Array.isArray(result)) return [];
  return result.map((instrument) => {
    if (!instrument || typeof instrument !== "object") return instrument;
    return {
      ...instrument,
      create_time_ms: instrument.create_time,
    };
  });
}

export async function fetchIndexHistory({
  index_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = `${CACHE_PREFIX}:index:${index_name}:${resolution}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return (cached.rows || []).map((row) => ({
      ts: row[0],
      index_price_open: row[1],
      index_price_high: row[2],
      index_price_low: row[3],
      index_price_close: row[4],
    }));
  }

  const url = makeUrl("/index_price_historical_data", {
    index_name,
    resolution,
    from,
    to,
  });
  const json = await getJson(url);
  const rows = json?.result?.index;
  if (!Array.isArray(rows)) return [];

  writeCache(cacheKey, rows, { index_name, resolution });

  return rows.map((row) => ({
    ts: row[0],
    index_price_open: row[1],
    index_price_high: row[2],
    index_price_low: row[3],
    index_price_close: row[4],
  }));
}

function mapMarkRow(row) {
  if (!Array.isArray(row)) return null;
  const ts = row[0];
  const mark_price_open = row[1];
  const mark_price_high = row[2];
  const mark_price_low = row[3];
  const mark_price_close = row[4];
  let funding = null;
  let tob = null;
  let iv_open = null;
  let iv_high = null;
  let iv_low = null;
  let iv_close = null;

  if (row.length >= 9) {
    iv_open = row[5];
    iv_high = row[6];
    iv_low = row[7];
    iv_close = row[8];
    tob = row[9] ?? null;
  } else if (row.length >= 7) {
    funding = row[5];
    tob = row[6];
  } else if (row.length >= 6) {
    tob = row[5];
  }

  return {
    ts,
    mark_price_open,
    mark_price_high,
    mark_price_low,
    mark_price_close,
    funding,
    tob,
    iv_open,
    iv_high,
    iv_low,
    iv_close,
  };
}

export async function fetchMarkHistory({
  instrument_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = `${CACHE_PREFIX}:mark:${instrument_name}:${resolution}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return {
      data: (cached.rows || []).map(mapMarkRow).filter((row) => row !== null),
    };
  }

  const url = makeUrl("/mark_price_historical_data", {
    instrument_name,
    resolution,
    from,
    to,
  });
  const json = await getJson(url);
  const rows = json?.result?.mark;

  if (!Array.isArray(rows)) return { data: [] };

  writeCache(cacheKey, rows, { instrument_name, resolution });

  return {
    data: rows.map(mapMarkRow),
  };
}

export function computeBasisSeries({ mark, index, instrument }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const expiration = instrument?.expiration_timestamp;
  const instrumentName = instrument.instrument_name;

  const merged = [];
  for (const m of mark || []) {
    const i = indexByTs.get(m.ts);
    if (!i) continue;

    const tte = expiration - m.ts;
    const basis_open = m.mark_price_open - i.index_price_open;
    const basis_close = m.mark_price_close - i.index_price_close;

    const basis_pct =
      i.index_price_close !== 0
        ? (basis_close / i.index_price_close) * (SECONDS_PER_YEAR / tte)
        : null;

    merged.push({
      ...m,
      ...i,
      instrumentName,
      date: new Date(m.ts * 1000),
      tte,
      basis_open,
      basis_close,
      basis_change: basis_close - basis_open,
      basis_pct,
    });
  }
  return merged;
}

export function computeFundingSeries({ mark, index, intervalSeconds }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const merged = [];
  for (const m of mark || []) {
    const i = indexByTs.get(m.ts);
    if (!i) continue;

    const annualizedFunding = Number.isFinite(m.funding)
      ? ((m.funding * -1) / i.index_price_close) *
        (SECONDS_PER_YEAR / intervalSeconds)
      : null;

    merged.push({
      ...m,
      ...i,
      date: new Date(m.ts * 1000),
      funding_rate_annualized: annualizedFunding,
    });
  }
  return merged;
}

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - tau);
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

function calcInputs(spot, strike, tteSeconds, iv) {
  const tau = tteSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tau) / (iv * sqrtTau);
  return { tau, sqrtTau, d1 };
}

export function calcGreeks(spot, strike, tteSeconds, iv, optionType = "call") {
  const inputs = calcInputs(spot, strike, tteSeconds, iv);
  if (!inputs) {
    return { delta: null, gamma: null, theta: null, vega: null };
  }
  const { d1, sqrtTau } = inputs;
  const pdf = normalPdf(d1);
  const cdf = normalCdf(d1);
  const delta = optionType === "put" ? cdf - 1 : cdf;
  const gamma = pdf / (spot * iv * sqrtTau);
  const vega = spot * pdf * sqrtTau;
  const thetaAnnual = -(spot * pdf * iv) / (2 * sqrtTau);
  const theta = thetaAnnual / 365.25;
  return { delta, gamma, theta, vega };
}

export function computeGreeksPnlSeries({ mark, index, instrument }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const strike = Number(instrument?.strike_price);
  const expiration = Number(instrument?.expiration_timestamp);
  const optionType =
    instrument?.option_type?.toLowerCase?.() === "put" ? "put" : "call";
  if (!Number.isFinite(strike) || !Number.isFinite(expiration)) return [];

  const merged = [];
  const sortedMark = (mark || [])
    .filter((row) => row && Number.isFinite(row.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  let prevTs = null;

  for (const m of sortedMark) {
    const i = indexByTs.get(m.ts);
    if (!i) continue;

    // Calculate Greeks at the OPEN of this candle (start of the interval)
    const tteSecondsOpen = expiration - m.ts;
    const greeksAtOpen = calcGreeks(
      i.index_price_open,
      strike,
      tteSecondsOpen,
      m.iv_open,
      optionType,
    );

    // Calculate Greeks at close for reporting
    const tteSecondsClose = expiration - m.ts;
    const greeksAtClose = calcGreeks(
      i.index_price_close,
      strike,
      tteSecondsClose,
      m.iv_close,
      optionType,
    );

    const dS =
      Number.isFinite(i.index_price_close) &&
      Number.isFinite(i.index_price_open)
        ? i.index_price_close - i.index_price_open
        : null;
    const dIV =
      Number.isFinite(m.iv_close) && Number.isFinite(m.iv_open)
        ? m.iv_close - m.iv_open
        : null;
    const dT =
      Number.isFinite(prevTs) && Number.isFinite(m.ts)
        ? (m.ts - prevTs) / (24 * 60 * 60)
        : null;
    const pl =
      Number.isFinite(m.mark_price_close) && Number.isFinite(m.mark_price_open)
        ? m.mark_price_close - m.mark_price_open
        : null;

    // Use Greeks at OPEN for attribution (aligned with the interval we're explaining)
    let delta_PL = null;
    let gamma_PL = null;
    let theta_PL = null;
    let vega_PL = null;
    if (Number.isFinite(dS)) {
      if (Number.isFinite(greeksAtOpen.delta)) {
        delta_PL = greeksAtOpen.delta * dS;
      }
      if (Number.isFinite(greeksAtOpen.gamma)) {
        gamma_PL = greeksAtOpen.gamma * dS * dS * 0.5;
      }
    }
    if (Number.isFinite(dT) && Number.isFinite(greeksAtOpen.theta)) {
      theta_PL = greeksAtOpen.theta * dT;
    }
    if (Number.isFinite(dIV) && Number.isFinite(greeksAtOpen.vega)) {
      vega_PL = greeksAtOpen.vega * dIV;
    }

    let attributed_PL = null;
    if (
      [delta_PL, gamma_PL, theta_PL, vega_PL].some((v) => Number.isFinite(v))
    ) {
      attributed_PL = 0;
      if (Number.isFinite(delta_PL)) attributed_PL += delta_PL;
      if (Number.isFinite(gamma_PL)) attributed_PL += gamma_PL;
      if (Number.isFinite(theta_PL)) attributed_PL += theta_PL;
      if (Number.isFinite(vega_PL)) attributed_PL += vega_PL;
    }
    const residual_PL =
      attributed_PL != null && Number.isFinite(pl) ? pl - attributed_PL : null;
    const gamma_theta_PL =
      Number.isFinite(gamma_PL) || Number.isFinite(theta_PL)
        ? (Number.isFinite(gamma_PL) ? gamma_PL : 0) +
          (Number.isFinite(theta_PL) ? theta_PL : 0)
        : null;

    merged.push({
      ...m,
      ...i,
      date: new Date(m.ts * 1000),
      tte_seconds: tteSecondsClose,
      delta: greeksAtClose.delta,
      gamma: greeksAtClose.gamma,
      theta: greeksAtClose.theta,
      vega: greeksAtClose.vega,
      dS,
      dIV,
      dT,
      PL: pl,
      delta_PL,
      gamma_PL,
      theta_PL,
      vega_PL,
      attributed_PL,
      residual_PL,
      gamma_theta_PL,
    });

    prevTs = m.ts;
  }

  return merged;
}
