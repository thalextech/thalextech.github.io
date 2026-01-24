import { csvFormatRows, csvParseRows } from "d3-dsv";

const DEFAULT_API_BASE = "/api/v2/public";
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
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

function buildCacheKey(type, name, resolution) {
  return `${CACHE_PREFIX}:${type}:${name}:${resolution}`;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestampMs(value) {
  const numeric = toNumberOrNull(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function readCache(key) {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !isCacheFresh(parsed.timestamp)) {
      storage.removeItem(key);
      return null;
    }
    if (typeof parsed.rows !== "string") return null;
    const rows = csvParseRows(parsed.rows).map((row) =>
      row.map((value) => toNumberOrNull(value)),
    );
    return {
      rows,
      meta: parsed.meta ?? null,
    };
  } catch (error) {
    return null;
  }
}

function writeCache(key, rows, meta) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const payload = {
      timestamp: Date.now(),
      rows: csvFormatRows(rows),
      meta,
    };
    storage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    // intentionally ignore caching failures
  }
}

function normalizeMarkRows(rows, instrument_type) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;

      const ts = toNumberOrNull(row[0]);
      if (!Number.isFinite(ts)) return null;

      const mark_price_open = toNumberOrNull(row[1]);
      const mark_price_high = toNumberOrNull(row[2]);
      const mark_price_low = toNumberOrNull(row[3]);
      const mark_price_close = toNumberOrNull(row[4]);

      let funding;
      let tob;
      if (instrument_type === "perpetual") {
        funding = toNumberOrNull(row[5]);
        tob = toNumberOrNull(row[6]);
      } else if (instrument_type === "future") {
        tob = toNumberOrNull(row[5]);
      }

      return {
        ts,
        mark_price_open,
        mark_price_high,
        mark_price_low,
        mark_price_close,
        funding,
        tob,
      };
    })
    .filter(Boolean);
}

function normalizeIndexRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;

      const ts = toNumberOrNull(row[0]);
      if (!Number.isFinite(ts)) return null;

      const index_price_open = toNumberOrNull(row[1]);
      const index_price_high = toNumberOrNull(row[2]);
      const index_price_low = toNumberOrNull(row[3]);
      const index_price_close = toNumberOrNull(row[4]);

      return {
        ts,
        index_price_open,
        index_price_high,
        index_price_low,
        index_price_close,
      };
    })
    .filter(Boolean);
}

function getApiBase() {
  return import.meta.env.VITE_THALEX_API_BASE || DEFAULT_API_BASE;
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

function makeUrl(path, params) {
  const base = getApiBase();
  const url = new URL(`${base}${path}`, window.location.origin);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
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
      create_time_ms: normalizeTimestampMs(instrument.create_time),
    };
  });
}

export async function fetchIndexHistory({
  index_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = buildCacheKey("index", index_name, resolution);
  const cached = readCache(cacheKey);
  if (cached) {
    return normalizeIndexRows(cached.rows);
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

  writeCache(cacheKey, rows, null);

  return normalizeIndexRows(rows);
}

export async function fetchMarkHistory({
  instrument_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = buildCacheKey("mark", instrument_name, resolution);
  const cached = readCache(cacheKey);
  if (cached) {
    return {
      instrument_type: cached.meta?.instrument_type,
      data: normalizeMarkRows(cached.rows, cached.meta?.instrument_type),
    };
  }

  const url = makeUrl("/mark_price_historical_data", {
    instrument_name,
    resolution,
    from,
    to,
  });
  const json = await getJson(url);
  const instrument_type = json?.result?.instrument_type;
  const rows = json?.result?.mark;
  if (!Array.isArray(rows)) return { instrument_type, data: [] };

  writeCache(cacheKey, rows, { instrument_type });

  return {
    instrument_type,
    data: normalizeMarkRows(rows, instrument_type),
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
