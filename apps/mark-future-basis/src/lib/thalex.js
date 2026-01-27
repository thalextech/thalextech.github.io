const API_BASE = "https://thalex.com/api/v2/public"
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
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

export async function fetchMarkHistory({
  instrument_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = `${CACHE_PREFIX}:mark:${instrument_name}:${resolution}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return (cached.rows || []).map((row) => ({
      ts: row[0],
      mark_price_open: row[1],
      mark_price_high: row[2],
      mark_price_low: row[3],
      mark_price_close: row[4],
    }));
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

  return rows.map((row) => ({
    ts: row[0],
    mark_price_open: row[1],
    mark_price_high: row[2],
    mark_price_low: row[3],
    mark_price_close: row[4],
  }));
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
