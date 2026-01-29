const API_BASE = "/api/v2/public";
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

export async function fetchTicker(instrument_name) {
  const url = makeUrl("/ticker", { instrument_name });
  const json = await getJson(url);
  const result = json?.result ?? json;
  return {
    mark_price: result?.mark_price ?? result?.mark ?? result?.price ?? result?.last_price,
    index_price: result?.index_price ?? result?.index ?? result?.underlying_price,
  };
}

function isRollInstrument(instrument) {
  if (!instrument || instrument.product !== "FBTCUSD") {
    return false;
  }

  const name = (instrument.instrument_name || "").toUpperCase();
  const instType = instrument.type || instrument.instrument_type;
  const legs = instrument.legs || [];

  if (instType === "combination" && legs.length > 0) {
    let hasPerp = false;
    let hasDated = false;

    legs.forEach((leg) => {
      const legName = (leg.instrument_name || "").toUpperCase();
      if (legName.includes("PERPETUAL")) {
        hasPerp = true;
      } else if (legName) {
        hasDated = true;
      }
    });

    if (hasPerp && hasDated) {
      return true;
    }
  }

  if (name.includes("PERPETUAL") && name !== "BTC-PERPETUAL") {
    const datePattern = /\d{2}[A-Z]{3}\d{2}|\d{4}-\d{2}-\d{2}|\d{8}/;
    return datePattern.test(name);
  }

  return false;
}

function parseExpirationDate(instrument) {
  const expiration =
    instrument.expiration_timestamp ??
    instrument.expiry_date ??
    instrument.expiration;

  if (typeof expiration === "number") {
    return new Date(expiration * 1000);
  }

  if (typeof expiration === "string") {
    const parsed = new Date(expiration);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const name = instrument.instrument_name || "";
  const match = name.match(/(\d{2}[A-Z]{3}\d{2})/);
  if (match) {
    const dateStr = match[1];
    const day = parseInt(dateStr.slice(0, 2), 10);
    const monthStr = dateStr.slice(2, 5);
    const year = 2000 + parseInt(dateStr.slice(5, 7), 10);
    const monthMap = {
      JAN: 0,
      FEB: 1,
      MAR: 2,
      APR: 3,
      MAY: 4,
      JUN: 5,
      JUL: 6,
      AUG: 7,
      SEP: 8,
      OCT: 9,
      NOV: 10,
      DEC: 11,
    };
    const month = monthMap[monthStr];
    if (month !== undefined) {
      return new Date(Date.UTC(year, month, day));
    }
  }

  return null;
}

export async function fetchRollsData() {
  const allInstruments = await fetchInstruments();
  
  const rolls = allInstruments
    .filter(isRollInstrument)
    .map((instrument) => ({
      instrument,
      expirationDate: parseExpirationDate(instrument),
    }))
    .filter(({ expirationDate }) => expirationDate);

  const now = new Date();
  const upcomingRolls = rolls
    .map(({ instrument, expirationDate }) => ({
      instrument,
      expirationDate,
      daysToExpiration: Math.ceil(
        (expirationDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      ),
    }))
    .filter(({ daysToExpiration }) => daysToExpiration > 0)
    .sort((a, b) => a.expirationDate - b.expirationDate);

  // Get index price from BTC-PERPETUAL
  let indexPrice = null;
  try {
    const perpTicker = await fetchTicker("BTC-PERPETUAL");
    indexPrice = perpTicker.index_price;
  } catch (e) {
    console.warn("Failed to fetch index price", e);
  }

  const rollRows = await Promise.all(
    upcomingRolls.map(async ({ instrument, expirationDate, daysToExpiration }) => {
      try {
        const ticker = await fetchTicker(instrument.instrument_name);
        const markPrice = Number(ticker.mark_price);
        const tickerIndex = Number(ticker.index_price);
        const currentIndex = Number.isFinite(tickerIndex) ? tickerIndex : indexPrice;

        let impliedBasis = null;
        if (currentIndex && markPrice && daysToExpiration > 0 && currentIndex > 0) {
          // Implied annualized basis: (markPrice / indexPrice) * (365 / daysToExpiration) * 100
          // This matches the calculation used in thalex-notebooks
          impliedBasis = (markPrice / currentIndex) * (365 / daysToExpiration) * 100;
        }

        return {
          instrument: instrument.instrument_name,
          markPrice,
          indexPrice: currentIndex,
          expirationDate,
          daysToExpiration,
          impliedBasis,
        };
      } catch (e) {
        console.warn(`Failed to fetch ticker for ${instrument.instrument_name}`, e);
        return null;
      }
    })
  );

  return rollRows.filter((row) => row && row.markPrice);
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
    return {
      data: (cached.rows || []).map((row) => ({
        ts: row[0],
        mark_price_open: row[1],
        mark_price_high: row[2],
        mark_price_low: row[3],
        mark_price_close: row[4],
        accum_funding: row[5] || null,
      })),
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
    data: rows.map((row) => ({
      ts: row[0],
      mark_price_open: row[1],
      mark_price_high: row[2],
      mark_price_low: row[3],
      mark_price_close: row[4],
      accum_funding: row[5] || null,
    })),
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

export function computeFundingSeries({ mark, resolution }) {
  const merged = [];
  
  // Calculate periods per day based on resolution
  // accum_funding is per period, so we need to multiply by periods per day * 365 to annualize
  const SECONDS_PER_DAY = 24 * 60 * 60;
  let periodsPerDay = 1; // default for 1d
  
  if (resolution) {
    const resolutionSeconds = {
      "1m": 60,
      "5m": 5 * 60,
      "15m": 15 * 60,
      "1h": 60 * 60,
      "1d": 24 * 60 * 60,
    }[resolution];
    
    if (resolutionSeconds) {
      periodsPerDay = SECONDS_PER_DAY / resolutionSeconds;
    }
  }
  
  const annualizationMultiplier = periodsPerDay * 365;
  
  for (const m of mark || []) {
    const date = new Date(m.ts * 1000);
    let funding_rate_annual = null;
    
    if (
      m.accum_funding != null &&
      Number.isFinite(m.accum_funding) &&
      m.mark_price_close != null &&
      m.mark_price_close !== 0 &&
      Number.isFinite(m.mark_price_close)
    ) {
      // Calculate annualized funding rate: |accumFunding / price| * periodsPerDay * 365 * 100
      funding_rate_annual = Math.abs((m.accum_funding / m.mark_price_close) * annualizationMultiplier * 100);
    }

    merged.push({
      ...m,
      date,
      funding_rate_annual,
    });
  }
  return merged;
}
