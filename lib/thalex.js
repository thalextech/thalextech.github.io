const API_BASE = "https://thalex.com/api/v2/public";
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "thalex-cache";
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

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
    console.error("Failed to write cache", error);
  }
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(
  url,
  { timeoutMs = 20_000, maxRetries = 2, retryDelayMs = 500 } = {},
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        const error = new Error(message);
        error.status = res.status;

        if (attempt < maxRetries && isRetryableStatus(res.status)) {
          const delay = retryDelayMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw error;
      }

      return json;
    } catch (error) {
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

function mapMarkRowByType(row) {
  if (!Array.isArray(row)) return null;

  // Perpetual contracts return 7 columns (including funding at index 5)
  // All other instruments (future, option, combination) return 6 columns
  if (row.length >= 7) {
    return {
      ts: row[0],
      mark_price_open: row[1],
      mark_price_high: row[2],
      mark_price_low: row[3],
      mark_price_close: row[4],
      funding: row[5],
      tob: row[6],
    };
  } else {
    return {
      ts: row[0],
      mark_price_open: row[1],
      mark_price_high: row[2],
      mark_price_low: row[3],
      mark_price_close: row[4],
      tob: row[5],
    };
  }
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
    return (cached.rows || [])
      .map((row) => mapMarkRowByType(row))
      .filter((row) => row !== null);
  }

  const url = makeUrl("/mark_price_historical_data", {
    instrument_name,
    resolution,
    from,
    to,
  });
  const json = await getJson(url);
  const rows = json?.result?.mark;

  if (!Array.isArray(rows)) return [];

  writeCache(cacheKey, rows, { instrument_name, resolution });

  return rows.map((row) => mapMarkRowByType(row)).filter((row) => row !== null);
}

export function buildBasisSeries({ mark, index, instrument }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const expiration = instrument?.expiration_timestamp;
  const instrumentName = instrument.instrument_name;

  const merged = [];
  for (const markPoint of mark || []) {
    const indexPoint = indexByTs.get(markPoint.ts);
    if (!indexPoint) continue;

    const tte = expiration - markPoint.ts;
    const basis_open = markPoint.mark_price_open - indexPoint.index_price_open;
    const basis_close = markPoint.mark_price_close - indexPoint.index_price_close;

    const basis_pct =
      indexPoint.index_price_close !== 0
        ? (basis_close / indexPoint.index_price_close) * (SECONDS_PER_YEAR / tte)
        : null;

    merged.push({
      ...markPoint,
      ...indexPoint,
      instrumentName,
      date: new Date(markPoint.ts * 1000),
      tte,
      basis_open,
      basis_close,
      basis_change: basis_close - basis_open,
      basis_pct,
    });
  }
  return merged;
}

export function buildFundingSeries({ mark, index, intervalSeconds }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const merged = [];

  for (const markPoint of mark || []) {
    const indexPoint = indexByTs.get(markPoint.ts);
    if (!indexPoint) continue;

    const annualizedFunding = Number.isFinite(markPoint.funding)
      ? ((markPoint.funding * -1) / indexPoint.index_price_close) *
        (SECONDS_PER_YEAR / intervalSeconds)
      : null;

    merged.push({
      ...markPoint,
      ...indexPoint,
      date: new Date(markPoint.ts * 1000),
      funding_rate_annualized: annualizedFunding,
    });
  }
  return merged;
}
