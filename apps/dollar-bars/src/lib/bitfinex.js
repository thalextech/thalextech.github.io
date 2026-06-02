const BITFINEX_CANDLES_URL = "https://api-pub.bitfinex.com/v2/candles";
const MAX_CANDLE_LIMIT = 10_000;
const REQUESTS_PER_MINUTE = 30;
const REQUEST_INTERVAL_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE);
const REQUEST_SCHEDULER_POLL_MS = 50;
const REQUEST_MAX_RETRIES = 4;
const REQUEST_RETRY_BASE_MS = 800;
const REQUEST_RETRY_MAX_MS = 8_000;
const REQUEST_TIMEOUT_MS = 45_000;
const RATE_LIMIT_COOLDOWN_BASE_MS = 1_500;
const RATE_LIMIT_COOLDOWN_MAX_MS = 15_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const toBitfinexSymbol = (symbol) =>
  symbol.startsWith("t") ? symbol : `t${symbol}`;

const candleUrl = ({ symbol, timeframe, startMs, endMs, limit }) => {
  const params = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    limit: String(limit),
    sort: "1",
  });
  return `${BITFINEX_CANDLES_URL}/trade:${timeframe}:${toBitfinexSymbol(symbol)}/hist?${params}`;
};

const sleep = (ms) =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const computeBackoffMs = (attempt, baseMs, maxMs) => {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return exp + Math.random() * 250;
};

const createCanceledError = () => {
  const error = new Error("Request canceled");
  error.canceled = true;
  return error;
};

const isRetryableRequestError = (error) => {
  if (!error) return false;
  if (RETRYABLE_STATUS.has(Number(error?.status))) return true;
  if (error?.name === "AbortError") return true;
  return error instanceof TypeError;
};

const looksLikeRateLimit = (error) => {
  if (!error) return false;
  if (Number(error?.status) === 429) return true;
  return error instanceof TypeError;
};

function createRequestScheduler() {
  let pendingReservation = Promise.resolve();
  let cooldownUntilMs = 0;
  let consecutiveRateLimits = 0;
  let nextLaunchMs = 0;

  const reserveSlot = async ({ isCanceled = null } = {}) => {
    while (true) {
      if (isCanceled?.()) throw createCanceledError();

      const now = Date.now();
      if (now < cooldownUntilMs) {
        const remaining = cooldownUntilMs - now;
        await sleep(Math.min(remaining, REQUEST_SCHEDULER_POLL_MS));
        continue;
      }

      const delayMs = nextLaunchMs - now;
      if (delayMs <= 0) {
        nextLaunchMs = Date.now() + REQUEST_INTERVAL_MS;
        return;
      }

      await sleep(Math.min(delayMs, REQUEST_SCHEDULER_POLL_MS));
    }
  };

  return {
    async acquire({ isCanceled = null } = {}) {
      const reservation = pendingReservation.then(() =>
        reserveSlot({ isCanceled }),
      );
      pendingReservation = reservation.catch(() => {});
      return reservation;
    },
    noteRateLimit() {
      consecutiveRateLimits += 1;
      const backoff = computeBackoffMs(
        consecutiveRateLimits - 1,
        RATE_LIMIT_COOLDOWN_BASE_MS,
        RATE_LIMIT_COOLDOWN_MAX_MS,
      );
      const until = Date.now() + backoff;
      if (until > cooldownUntilMs) cooldownUntilMs = until;
    },
    noteSuccess() {
      consecutiveRateLimits = 0;
    },
  };
}

const requestScheduler = createRequestScheduler();

function createHttpError(response, payload) {
  const message = `Bitfinex returned ${response.status}.`;
  const error = new Error(message);
  error.status = response.status;
  error.payload = payload;
  return error;
}

async function fetchJsonWithRetries(
  url,
  {
    isCanceled = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxRetries = REQUEST_MAX_RETRIES,
    onRateLimit = null,
  } = {},
) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (isCanceled?.()) throw createCanceledError();

    try {
      await requestScheduler.acquire({ isCanceled });

      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw createHttpError(response, payload);
        }

        requestScheduler.noteSuccess();
        return payload;
      } finally {
        globalThis.clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (looksLikeRateLimit(error)) {
        requestScheduler.noteRateLimit();
        onRateLimit?.(error);
      }

      const canRetry =
        attempt < maxRetries &&
        isRetryableRequestError(error) &&
        !isCanceled?.();
      if (!canRetry) throw error;

      await sleep(
        computeBackoffMs(attempt, REQUEST_RETRY_BASE_MS, REQUEST_RETRY_MAX_MS),
      );
    }
  }

  throw lastError || new Error("Bitfinex request failed.");
}

const normalizeCandle = (row) => {
  const [mts, open, close, high, low, volume] = row || [];
  const ts = Number(mts);
  const parsed = {
    ts,
    date: new Date(ts),
    open: Number(open),
    close: Number(close),
    high: Number(high),
    low: Number(low),
    baseVolume: Math.abs(Number(volume)),
  };

  if (
    !Number.isFinite(parsed.ts) ||
    Number.isNaN(parsed.date.getTime()) ||
    !Number.isFinite(parsed.open) ||
    !Number.isFinite(parsed.close) ||
    !Number.isFinite(parsed.high) ||
    !Number.isFinite(parsed.low) ||
    !Number.isFinite(parsed.baseVolume)
  ) {
    return null;
  }

  const typicalPrice =
    (parsed.open + parsed.high + parsed.low + parsed.close) / 4;
  return {
    ...parsed,
    quoteVolume: parsed.baseVolume * typicalPrice,
  };
};

export async function fetchBitfinexCandles({
  symbol = "BTCUSD",
  timeframe = "1h",
  from,
  to,
  isCanceled = null,
  onProgress = null,
  onRateLimit = null,
} = {}) {
  const startMs = Math.floor(Number(from) * 1000);
  const endMs = Math.floor(Number(to) * 1000);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("Invalid candle time range.");
  }

  let cursorMs = startMs;
  const rows = [];
  let page = 0;

  while (cursorMs < endMs) {
    if (isCanceled?.()) throw createCanceledError();

    page += 1;
    const payload = await fetchJsonWithRetries(
      candleUrl({
        symbol,
        timeframe,
        startMs: cursorMs,
        endMs,
        limit: MAX_CANDLE_LIMIT,
      }),
      { isCanceled, onRateLimit },
    );

    if (!Array.isArray(payload) || !payload.length) break;

    const candles = payload.map(normalizeCandle).filter(Boolean);
    if (!candles.length) break;

    rows.push(...candles);
    onProgress?.({
      page,
      rows: rows.length,
      pageRows: candles.length,
      lastDate: candles[candles.length - 1].date,
    });

    const lastTs = candles[candles.length - 1].ts;
    if (!Number.isFinite(lastTs) || lastTs <= cursorMs) break;
    cursorMs = lastTs + 1;

    if (payload.length < MAX_CANDLE_LIMIT) break;
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      if (seen.has(row.ts)) return false;
      seen.add(row.ts);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}
