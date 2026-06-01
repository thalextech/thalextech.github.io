<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import OptionGridChart from "./components/OptionGridChart.vue";
import { fetchIndexHistory, fetchInstruments } from "../../../lib/thalex.js";

const API_BASE = "https://thalex.com/api/v2/public";
const DEFAULT_POINT_LIMIT = 420;
const MIN_POINT_LIMIT = 80;
const MAX_POINT_LIMIT = 1600;
const DEFAULT_EXPIRY_COUNT = 6;
const DEFAULT_STRIKE_LEVELS = 12;
const TICKER_BURST_REQUESTS = 100;
const TICKER_BURST_INTERVAL_MS = 0;
const TICKER_SUSTAINED_INTERVAL_MS = 110;
const TICKER_MATURITY_PAUSE_MS = 0;
const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", intervalSeconds: 60 },
  300: { label: "5m", resolution: "5m", intervalSeconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", intervalSeconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", intervalSeconds: 60 * 60 },
};

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const METRIC_OPTIONS = [
  {
    value: "omega",
    label: "Omega",
    tooltip:
      "Omega (Ω) — leverage of the option vs the underlying. |Δ · S / V|: % change in option value per 1% spot move.",
  },
  {
    value: "touch",
    label: "Touch",
    tooltip:
      "One-touch multiplier — 1 / P(spot touches strike before expiry). Estimated from current IV under a GBM model.",
  },
];

const ui = reactive({
  resolutionKey: "3600",
  maxPoints: DEFAULT_POINT_LIMIT,
  expiryCount: DEFAULT_EXPIRY_COUNT,
  strikeLevels: DEFAULT_STRIKE_LEVELS,
  strikeRangePct: DEFAULT_STRIKE_RANGE_PCT,
  metric: "omega",
  loadingIndex: false,
  loadingTickers: false,
  error: "",
});

const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const indexRows = ref([]);
const tickerByInstrument = ref({});
const failedTickerFetches = reactive({});
const chartRef = ref(null);
const initialized = ref(false);
const selectedOption = ref(null);
let indexRequestId = 0;
let tickerRequestId = 0;
let tickerAbortController = null;
let suppressTickerWatch = false;
let tickerRequestCount = 0;
let nextTickerRequestAt = 0;
let failedTickerRetryTimer = null;
let failedTickerRetryController = null;

const expiryFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const config = RESOLUTION_CONFIG[ui.resolutionKey] || RESOLUTION_CONFIG[3600];
  const maxPoints = Math.max(
    MIN_POINT_LIMIT,
    Math.min(MAX_POINT_LIMIT, Math.floor(Number(ui.maxPoints)) || DEFAULT_POINT_LIMIT),
  );
  const to = now - (now % config.intervalSeconds);
  return {
    resolution: config.resolution,
    from: to - config.intervalSeconds * (maxPoints - 1),
    to,
    maxPoints,
  };
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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

function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

function calcOneTouchProbability({ spot, strike, expirationTs, iv, optionType }) {
  if (![spot, strike, expirationTs, iv].every(Number.isFinite)) return null;
  if (spot <= 0 || strike <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const tte = expirationTs - now;
  if (tte <= 0) return strike === spot ? 1 : 0;

  const sigma = iv > 5 ? iv / 100 : iv;
  if (!Number.isFinite(sigma) || sigma <= 0) return null;

  const tau = tte / SECONDS_PER_YEAR;
  const distance = Math.abs(Math.log(strike / spot));
  if (distance <= 0) return 1;

  const drift = -0.5 * sigma * sigma;
  const denom = sigma * Math.sqrt(tau);
  if (!Number.isFinite(denom) || denom <= 0) return null;

  const isUpperTouch = optionType === "call";
  const first =
    isUpperTouch
      ? Math.exp((2 * drift * distance) / (sigma * sigma)) *
        normalCdf((-distance - drift * tau) / denom)
      : Math.exp((-2 * drift * distance) / (sigma * sigma)) *
        normalCdf((-distance + drift * tau) / denom);
  const second = isUpperTouch
    ? normalCdf((-distance + drift * tau) / denom)
    : normalCdf((-distance - drift * tau) / denom);
  const probability = first + second;
  if (!Number.isFinite(probability)) return null;
  return Math.max(0, Math.min(1, probability));
}

function calcOneTouchMultiplier(args) {
  const probability = calcOneTouchProbability(args);
  if (!Number.isFinite(probability) || probability <= 0) return null;
  return 1 / probability;
}

function calcNd2({ forward, strike, expirationTs, iv, optionType }) {
  if (![forward, strike, expirationTs, iv].every(Number.isFinite)) return null;
  if (forward <= 0 || strike <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const tte = expirationTs - now;
  if (tte <= 0) return null;
  const sigma = iv > 5 ? iv / 100 : iv;
  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  const tau = tte / SECONDS_PER_YEAR;
  const sigmaRootTau = sigma * Math.sqrt(tau);
  if (!Number.isFinite(sigmaRootTau) || sigmaRootTau <= 0) return null;
  const d1 = (Math.log(forward / strike) + 0.5 * sigma * sigma * tau) / sigmaRootTau;
  const d2 = d1 - sigmaRootTau;
  return optionType === "put" ? normalCdf(-d2) : normalCdf(d2);
}

function calcOmega({ delta, underlyingPrice, markPrice }) {
  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(underlyingPrice) ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0
  ) {
    return null;
  }
  const omega = (delta * underlyingPrice) / markPrice;
  return Number.isFinite(omega) ? Math.abs(omega) : null;
}

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const type = String(instrument.type || instrument.kind || "").toLowerCase();
  if (type !== "option") return null;

  const strike = toFiniteNumber(instrument.strike_price);
  const expirationTs = toFiniteNumber(instrument.expiration_timestamp);
  if (!Number.isFinite(strike) || !Number.isFinite(expirationTs)) return null;

  return {
    ...instrument,
    strike,
    expiration_ts: expirationTs,
    option_type_normalized:
      String(instrument.option_type || "").toLowerCase() === "put"
        ? "put"
        : "call",
  };
};

function buildPublicUrl(path, params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    searchParams.set(key, String(value));
  });
  return `${API_BASE}${path}?${searchParams.toString()}`;
}

function sleepWithAbort(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}

async function getJson(url, requestOptions = {}) {
  const response = await fetch(url, requestOptions);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      json?.error?.message ||
      json?.message ||
      `Request failed (${response.status})`;
    throw new Error(message);
  }
  return json;
}

async function fetchTicker(instrumentName, requestOptions = {}) {
  const url = buildPublicUrl("/ticker", { instrument_name: instrumentName });
  const json = await getJson(url, requestOptions);
  return json?.result || null;
}

function clearFailedTicker(instrumentName) {
  if (failedTickerFetches[instrumentName]) {
    delete failedTickerFetches[instrumentName];
  }
}

function recordFailedTicker(instrumentName, error) {
  const previous = failedTickerFetches[instrumentName];
  failedTickerFetches[instrumentName] = {
    instrumentName,
    failedAt: Date.now(),
    attempts: (previous?.attempts || 0) + 1,
    error: error instanceof Error ? error.message : String(error),
  };
  scheduleFailedTickerRetry();
}

function clearAllFailedTickers() {
  Object.keys(failedTickerFetches).forEach((instrumentName) => {
    delete failedTickerFetches[instrumentName];
  });
}

async function waitForTickerSlot(signal) {
  const now = Date.now();
  if (nextTickerRequestAt > now) {
    await sleepWithAbort(nextTickerRequestAt - now, signal);
  }
  const interval =
    tickerRequestCount < TICKER_BURST_REQUESTS
      ? TICKER_BURST_INTERVAL_MS
      : TICKER_SUSTAINED_INTERVAL_MS;
  tickerRequestCount += 1;
  nextTickerRequestAt = Date.now() + interval;
}

async function fetchTickerBatch(instrumentNames, { signal, isStale } = {}) {
  const next = {};
  for (let i = 0; i < instrumentNames.length; i += 1) {
    if (signal?.aborted || isStale?.()) break;
    const instrumentName = instrumentNames[i];
    try {
      await waitForTickerSlot(signal);
      if (signal?.aborted || isStale?.()) break;
      const ticker = await fetchTicker(instrumentName, { signal });
      if (ticker) {
        next[instrumentName] = ticker;
        clearFailedTicker(instrumentName);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") break;
      recordFailedTicker(instrumentName, error);
    }
  }
  return next;
}

async function retryFailedTickers() {
  failedTickerRetryTimer = null;
  const visibleNames = new Set(gridOptions.value.map((option) => option.instrument_name));
  const retryNames = Object.keys(failedTickerFetches).filter(
    (instrumentName) =>
      visibleNames.has(instrumentName) && !tickerByInstrument.value[instrumentName],
  );
  if (!retryNames.length) return;

  failedTickerRetryController?.abort();
  failedTickerRetryController = new AbortController();
  const { signal } = failedTickerRetryController;
  const retryTickers = await fetchTickerBatch(retryNames, {
    signal,
    isStale: () => false,
  });
  if (!Object.keys(retryTickers).length) {
    scheduleFailedTickerRetry();
    return;
  }
  tickerByInstrument.value = {
    ...tickerByInstrument.value,
    ...retryTickers,
  };
  if (Object.keys(failedTickerFetches).length) {
    scheduleFailedTickerRetry();
  }
}

function scheduleFailedTickerRetry() {
  if (failedTickerRetryTimer) return;
  failedTickerRetryTimer = window.setTimeout(() => {
    retryFailedTickers().catch((error) => {
      ui.error = error instanceof Error ? error.message : String(error);
      scheduleFailedTickerRetry();
    });
  }, 3000);
}

const latestSpot = computed(() => {
  for (let i = indexRows.value.length - 1; i >= 0; i -= 1) {
    const close = toFiniteNumber(indexRows.value[i]?.index_price_close);
    if (Number.isFinite(close)) return close;
  }
  return null;
});

const optionUniverse = computed(() => {
  const now = Math.floor(Date.now() / 1000);
  return (allInstruments.value || [])
    .map(normalizeOptionInstrument)
    .filter(Boolean)
    .filter(
      (instrument) =>
        instrument.underlying === underlying.value &&
        instrument.expiration_ts > now &&
        instrument.instrument_name,
    )
    .sort(
      (a, b) =>
        a.expiration_ts - b.expiration_ts ||
        a.strike - b.strike ||
        a.option_type_normalized.localeCompare(b.option_type_normalized),
    );
});

const selectedExpiries = computed(() => {
  const count = Math.max(2, Math.min(12, Math.floor(Number(ui.expiryCount)) || 2));
  return Array.from(new Set(optionUniverse.value.map((option) => option.expiration_ts)))
    .sort((a, b) => a - b)
    .slice(0, count);
});

const CHART_INNER_HEIGHT_PX = 740;
const STRIKE_PIXEL_GAP = 26;
const DOMAIN_PADDING_FACTOR = 1.16;
const STRIKE_RANGE_OPTIONS = [10, 20, 30];
const DEFAULT_STRIKE_RANGE_PCT = 20;

const perExpiryStrikes = computed(() => {
  const spot = latestSpot.value;
  const result = new Map();
  if (!Number.isFinite(spot)) return result;

  const count = Math.max(
    6,
    Math.min(22, Math.floor(Number(ui.strikeLevels)) || DEFAULT_STRIKE_LEVELS),
  );
  const aboveTarget = Math.ceil(count / 2);
  const belowTarget = count - aboveTarget;

  const pickWithGap = (sorted, targetCount, gap) => {
    const picked = [];
    for (const strike of sorted) {
      if (picked.length >= targetCount) break;
      if (gap <= 0 || picked.every((p) => Math.abs(p - strike) >= gap)) {
        picked.push(strike);
      }
    }
    return picked;
  };

  const rangePct =
    (STRIKE_RANGE_OPTIONS.includes(ui.strikeRangePct)
      ? ui.strikeRangePct
      : DEFAULT_STRIKE_RANGE_PCT) / 100;
  const minAllowedStrike = spot * (1 - rangePct);
  const maxAllowedStrike = spot * (1 + rangePct);

  const expiryStrikes = new Map();
  for (const expiryTs of selectedExpiries.value) {
    expiryStrikes.set(
      expiryTs,
      Array.from(
        new Set(
          optionUniverse.value
            .filter(
              (option) =>
                option.expiration_ts === expiryTs &&
                option.strike >= minAllowedStrike &&
                option.strike <= maxAllowedStrike,
            )
            .map((option) => option.strike),
        ),
      ),
    );
  }

  const pass1Strikes = new Set();
  for (const [, strikesAtExpiry] of expiryStrikes) {
    const aboveAll = strikesAtExpiry.filter((s) => s >= spot).sort((a, b) => a - b);
    const belowAll = strikesAtExpiry.filter((s) => s < spot).sort((a, b) => b - a);
    aboveAll.slice(0, aboveTarget).forEach((s) => pass1Strikes.add(s));
    belowAll.slice(0, belowTarget).forEach((s) => pass1Strikes.add(s));
  }

  const domainValues = [spot, ...pass1Strikes];
  for (const row of indexRows.value || []) {
    const value = toFiniteNumber(row?.index_price_close);
    if (Number.isFinite(value)) domainValues.push(value);
  }
  const minVal = Math.min(...domainValues);
  const maxVal = Math.max(...domainValues);
  const domainSpan = (maxVal - minVal) * DOMAIN_PADDING_FACTOR;
  const minStrikeGap =
    domainSpan > 0
      ? Math.max(1, (domainSpan / CHART_INNER_HEIGHT_PX) * STRIKE_PIXEL_GAP)
      : Math.max(1, spot * 0.015);

  for (const [expiryTs, strikesAtExpiry] of expiryStrikes) {
    const above = pickWithGap(
      strikesAtExpiry.filter((s) => s >= spot).sort((a, b) => a - b),
      aboveTarget,
      minStrikeGap,
    );
    const below = pickWithGap(
      strikesAtExpiry.filter((s) => s < spot).sort((a, b) => b - a),
      belowTarget,
      minStrikeGap,
    );
    result.set(expiryTs, new Set([...above, ...below]));
  }

  return result;
});

const selectedStrikes = computed(() => {
  const all = new Set();
  for (const strikes of perExpiryStrikes.value.values()) {
    strikes.forEach((s) => all.add(s));
  }
  return Array.from(all).sort((a, b) => a - b);
});

const gridOptions = computed(() => {
  const spot = latestSpot.value;
  if (!Number.isFinite(spot)) return [];
  const perExpiry = perExpiryStrikes.value;

  return optionUniverse.value.filter((option) => {
    const allowed = perExpiry.get(option.expiration_ts);
    if (!allowed?.has(option.strike)) return false;
    if (option.strike >= spot) return option.option_type_normalized === "call";
    return option.option_type_normalized === "put";
  });
});

const tickerMaturityGroups = computed(() =>
  selectedExpiries.value
    .map((expiryTs) => {
      const instrumentNames = Array.from(
        new Set(
          gridOptions.value
            .filter((option) => option.expiration_ts === expiryTs)
            .sort((a, b) => a.strike - b.strike)
            .map((option) => option.instrument_name),
        ),
      );
      return { expiryTs, instrumentNames };
    })
    .filter((group) => group.instrumentNames.length > 0),
);

const gridRows = computed(() =>
  gridOptions.value
    .map((option) => {
      const ticker = tickerByInstrument.value[option.instrument_name] || {};
      const iv = toFiniteNumber(ticker.iv);
      const markPrice = toFiniteNumber(ticker.mark_price);
      const forward = toFiniteNumber(ticker.forward);
      const delta = toFiniteNumber(ticker.delta);
      const oneTouchMultiplier = calcOneTouchMultiplier({
        spot: latestSpot.value,
        strike: option.strike,
        expirationTs: option.expiration_ts,
        iv,
        optionType: option.option_type_normalized,
      });
      const omega = calcOmega({
        delta,
        underlyingPrice: Number.isFinite(forward) ? forward : latestSpot.value,
        markPrice,
      });
      const nd2 = calcNd2({
        forward,
        strike: option.strike,
        expirationTs: option.expiration_ts,
        iv,
        optionType: option.option_type_normalized,
      });
      return {
        instrumentName: option.instrument_name,
        expiryTs: option.expiration_ts,
        expiryLabel: expiryFormatter.format(new Date(option.expiration_ts * 1000)),
        strike: option.strike,
        optionType: option.option_type_normalized,
        markPrice,
        iv,
        forward,
        delta,
        oneTouchMultiplier,
        omega,
        nd2,
      };
    })
    .filter((row) => row.markPrice !== 0),
);

const canSavePng = computed(() => indexRows.value.length > 0 || gridRows.value.length > 0);
const loading = computed(() => ui.loadingIndex || ui.loadingTickers);

const slugValue = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function cycleStrikeRange() {
  const idx = STRIKE_RANGE_OPTIONS.indexOf(ui.strikeRangePct);
  ui.strikeRangePct =
    STRIKE_RANGE_OPTIONS[(idx + 1) % STRIKE_RANGE_OPTIONS.length];
}

function handleSavePng() {
  if (!chartRef.value) return;
  const parts = [
    "grid",
    underlying.value,
    RESOLUTION_CONFIG[ui.resolutionKey]?.label || ui.resolutionKey,
  ].map(slugValue);
  chartRef.value.exportPng({ filename: `${parts.join("-")}.png` });
}

const fullExpiryFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

function formatExpiryIso(ts) {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const compactNumber = (value, digits = 2) =>
  Number.isFinite(value)
    ? Number(value).toLocaleString("en-US", {
        maximumFractionDigits: digits,
      })
    : "-";

const selectedDetails = computed(() => {
  const option = selectedOption.value;
  if (!option) return null;
  const thalexUrl = `https://thalex.com/exchange/options?underlying=${encodeURIComponent(
    underlying.value,
  )}&expiration=${formatExpiryIso(option.expiryTs)}`;
  return {
    raw: option,
    title: option.instrumentName,
    typeLabel: option.optionType === "call" ? "Call" : "Put",
    thalexUrl,
    rows: [
      { key: "instrument", label: "Instrument", value: option.instrumentName },
      { key: "underlying", label: "Underlying", value: underlying.value },
      { key: "type", label: "Type", value: option.optionType === "call" ? "Call" : "Put" },
      { key: "strike", label: "Strike", value: compactNumber(option.strike, 0) },
      {
        key: "expiry",
        label: "Expiry (UTC)",
        value: fullExpiryFormatter.format(new Date(option.expiryTs * 1000)),
      },
      {
        key: "mark",
        label: "Mark price",
        value: compactNumber(option.markPrice, 4),
      },
      {
        key: "iv",
        label: "IV",
        value: Number.isFinite(option.iv)
          ? `${compactNumber(option.iv * 100, 2)}%`
          : "-",
      },
      {
        key: "forward",
        label: "Forward",
        value: compactNumber(option.forward, 2),
      },
      {
        key: "nd2",
        label: "N(d2)",
        value: Number.isFinite(option.nd2)
          ? `${compactNumber(option.nd2 * 100, 2)}%`
          : "-",
      },
      {
        key: "omega",
        label: "Omega",
        value: Number.isFinite(option.omega)
          ? `${compactNumber(option.omega, 2)}x`
          : "-",
      },
    ],
  };
});

function handleSelectOption(option) {
  selectedOption.value = option;
}

function closeOptionModal() {
  selectedOption.value = null;
}

async function loadIndexData() {
  const requestId = ++indexRequestId;
  ui.loadingIndex = true;
  ui.error = "";
  const { resolution, from, to, maxPoints } = getTimestampRange();

  try {
    const rows = await fetchIndexHistory({
      index_name: underlying.value,
      resolution,
      from,
      to,
      count: maxPoints,
    });
    if (requestId !== indexRequestId) return;
    indexRows.value = rows || [];
  } catch (error) {
    if (requestId !== indexRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    indexRows.value = [];
  } finally {
    if (requestId === indexRequestId) ui.loadingIndex = false;
  }
}

async function loadTickers() {
  const requestId = ++tickerRequestId;
  const groups = tickerMaturityGroups.value.map((group) => ({
    expiryTs: group.expiryTs,
    instrumentNames: [...group.instrumentNames],
  }));
  tickerAbortController?.abort();
  tickerAbortController = new AbortController();
  const { signal } = tickerAbortController;
  ui.loadingTickers = true;
  ui.error = "";

  try {
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      if (signal.aborted || requestId !== tickerRequestId) return;
      const missingNames = group.instrumentNames.filter(
        (name) => !tickerByInstrument.value[name],
      );
      if (!missingNames.length) continue;
      const maturityTickers = await fetchTickerBatch(missingNames, {
        signal,
        isStale: () => requestId !== tickerRequestId,
      });
      if (requestId !== tickerRequestId) return;
      tickerByInstrument.value = {
        ...tickerByInstrument.value,
        ...maturityTickers,
      };
      if (i < groups.length - 1) {
        await sleepWithAbort(TICKER_MATURITY_PAUSE_MS, signal);
      }
    }
  } catch (error) {
    if (requestId !== tickerRequestId) return;
    if (error?.name === "AbortError") return;
    ui.error = error instanceof Error ? error.message : String(error);
    tickerByInstrument.value = {};
  } finally {
    if (requestId === tickerRequestId) {
      tickerAbortController = null;
      ui.loadingTickers = false;
    }
  }
}

async function switchUnderlying(next) {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((option) => option.value === next)) return;
  suppressTickerWatch = true;
  try {
    underlying.value = next;
    tickerByInstrument.value = {};
    clearAllFailedTickers();
    failedTickerRetryController?.abort();
    await loadIndexData();
  } finally {
    suppressTickerWatch = false;
  }
  await loadTickers();
}

onMounted(async () => {
  try {
    ui.loadingIndex = true;
    const [instruments] = await Promise.all([fetchInstruments(), loadIndexData()]);
    allInstruments.value = instruments || [];
    await loadTickers();
    initialized.value = true;
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    initialized.value = true;
    ui.loadingIndex = false;
  }
});

watch(
  () => [ui.resolutionKey, ui.maxPoints],
  async () => {
    if (!initialized.value) return;
    await loadIndexData();
  },
);

watch(
  tickerMaturityGroups,
  async () => {
    if (!initialized.value) return;
    if (suppressTickerWatch) return;
    await loadTickers();
  },
  { deep: false },
);

function handleKeydown(event) {
  if (event.key === "Escape" && selectedOption.value) {
    closeOptionModal();
  }
}

onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>Option Grid</h1>
    </header>

    <div class="workspace">
      <div class="chartToolbar">
        <div class="toolbarGroup">
          <div class="segmented" role="group" aria-label="Underlying">
            <button
              v-for="opt in UNDERLYING_OPTIONS"
              :key="opt.value"
              type="button"
              :class="{ active: underlying === opt.value }"
              :disabled="loading && underlying !== opt.value"
              @click="switchUnderlying(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>

          <div class="segmented" role="group" aria-label="Metric">
            <button
              v-for="opt in METRIC_OPTIONS"
              :key="opt.value"
              type="button"
              :class="{ active: ui.metric === opt.value }"
              :title="opt.tooltip"
              @click="ui.metric = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="toolbarGroup">
          <button
            type="button"
            class="rangeToggle"
            @click="cycleStrikeRange"
            :aria-label="`Strike range ±${ui.strikeRangePct}%`"
          >
            ±{{ ui.strikeRangePct }}%
          </button>

          <label class="stepper">
            <span>Expiries</span>
            <input v-model.number="ui.expiryCount" type="number" min="2" max="12" />
          </label>

          <label class="stepper">
            <span>Strikes</span>
            <input v-model.number="ui.strikeLevels" type="number" min="6" max="22" />
          </label>
        </div>

        <button
          class="saveButton"
          type="button"
          :disabled="loading || !canSavePng"
          @click="handleSavePng"
        >
          Save PNG
        </button>
      </div>

      <OptionGridChart
        ref="chartRef"
        :index-rows="indexRows"
        :grid-rows="gridRows"
        :spot="latestSpot"
        :loading="ui.loadingIndex"
        :underlying="underlying"
        :metric="ui.metric"
        @select-option="handleSelectOption"
      />
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </div>

    <div
      v-if="selectedDetails"
      class="modalBackdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="selectedDetails.title"
      @click.self="closeOptionModal"
    >
      <div class="modalCard">
        <div class="modalHeader">
          <div class="modalTitleGroup">
            <span class="typeBadge" :class="selectedDetails.raw.optionType">
              {{ selectedDetails.typeLabel }}
            </span>
            <h2 class="modalTitle">{{ selectedDetails.title }}</h2>
          </div>
          <button
            type="button"
            class="closeButton"
            aria-label="Close"
            @click="closeOptionModal"
          >
            ×
          </button>
        </div>

        <dl class="modalGrid">
          <div
            v-for="row in selectedDetails.rows"
            :key="row.key"
            class="modalRow"
          >
            <dt>{{ row.label }}</dt>
            <dd>
              <span class="rowValue">{{ row.value }}</span>
            </dd>
          </div>
        </dl>

        <div class="modalActions">
          <a
            class="thalexLink"
            :href="selectedDetails.thalexUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            View expiry on Thalex →
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  width: 100%;
  min-height: 100vh;
  padding: 14px 14px 18px;
  background: #000;
  font-family:
    ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial,
    sans-serif;
}

.header {
  padding: 10px 0 14px;
}

.header h1 {
  margin: 0;
  color: #fafafa;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.05;
  text-align: center;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(920px, 1fr);
  grid-template-rows: auto minmax(680px, 1fr);
  gap: 10px;
  height: min(960px, calc(100vh - 74px));
  min-height: 740px;
  overflow-x: auto;
}

.chartToolbar {
  grid-column: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.toolbarGroup {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.segmented {
  display: inline-flex;
  height: 31px;
  overflow: hidden;
  border: 1px solid #262626;
  border-radius: 6px;
  background: #0a0a0a;
}

.segmented button,
.saveButton {
  height: 100%;
  border: 0;
  background: transparent;
  color: #a1a1a1;
  cursor: pointer;
  padding: 0 16px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
}

.segmented button + button {
  border-left: 1px solid #262626;
}

.segmented .active {
  background: #fafafa;
  color: #000;
}

.saveButton,
.rangeToggle {
  height: 31px;
  border: 1px solid #262626;
  border-radius: 6px;
  background: #0a0a0a;
  color: #a1a1a1;
  cursor: pointer;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
}

.rangeToggle:hover {
  color: #fafafa;
}

.saveButton:hover:not(:disabled),
.segmented button:hover:not(:disabled):not(.active) {
  color: #fafafa;
}

.saveButton:disabled,
.segmented button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.pointSlider,
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.pointSlider span,
.stepper span {
  color: #a1a1a1;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.pointSlider input {
  width: 160px;
  accent-color: #fafafa;
}

.stepper input {
  width: 58px;
  height: 31px;
  border: 1px solid #262626;
  border-radius: 6px;
  background: #0a0a0a;
  color: #fafafa;
  padding: 0 8px;
  font-size: 12px;
  font-family: inherit;
}

.workspace :deep(.chartWrap) {
  grid-column: 1;
  grid-row: 2;
  height: 100%;
}

.workspace :deep(.chartSvg) {
  height: 100%;
}

.error {
  grid-column: 1;
  grid-row: 2;
  align-self: start;
  justify-self: center;
  margin-top: 18px;
  padding: 8px 12px;
  border: 1px solid #525252;
  border-radius: 8px;
  background: #171717;
  color: #fafafa;
  font-size: 13px;
  line-height: 1.35;
}

.modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(2px);
}

.modalCard {
  width: min(440px, 100%);
  background: #0a0a0a;
  border: 1px solid #262626;
  border-radius: 12px;
  padding: 20px 22px 18px;
  color: #fafafa;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.8);
}

.modalHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.modalTitleGroup {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.modalTitle {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: #fafafa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.typeBadge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid #fafafa;
}

.typeBadge.call {
  background: #fafafa;
  color: #000;
}

.typeBadge.put {
  background: transparent;
  color: #fafafa;
}

.closeButton {
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  color: #a1a1a1;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  border-radius: 6px;
}

.closeButton:hover {
  color: #fafafa;
  background: #171717;
}

.modalGrid {
  margin: 0;
  display: grid;
  gap: 1px;
  background: #262626;
  border: 1px solid #262626;
  border-radius: 8px;
  overflow: hidden;
}

.modalRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: #0a0a0a;
}

.modalRow dt {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #a1a1a1;
}

.modalRow dd {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: #fafafa;
  font-variant-numeric: tabular-nums;
}

.rowValue {
  text-align: right;
}

.modalActions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.thalexLink {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: #000;
  background: #fafafa;
  border-radius: 6px;
  text-decoration: none;
  border: 1px solid #fafafa;
}

.thalexLink:hover {
  background: #e5e5e5;
  border-color: #e5e5e5;
}
</style>
