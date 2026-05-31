<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import OptionGridChart from "./components/OptionGridChart.vue";
import { fetchIndexHistory, fetchInstruments } from "../../../lib/thalex.js";

const API_BASE = "https://thalex.com/api/v2/public";
const DEFAULT_POINT_LIMIT = 420;
const MIN_POINT_LIMIT = 80;
const MAX_POINT_LIMIT = 1600;
const DEFAULT_EXPIRY_COUNT = 6;
const DEFAULT_STRIKE_LEVELS = 12;
const TICKER_BURST_REQUESTS = 60;
const TICKER_BURST_INTERVAL_MS = 75;
const TICKER_SUSTAINED_INTERVAL_MS = 350;
const TICKER_MATURITY_PAUSE_MS = 750;
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

const ui = reactive({
  resolutionKey: "3600",
  maxPoints: DEFAULT_POINT_LIMIT,
  expiryCount: DEFAULT_EXPIRY_COUNT,
  strikeLevels: DEFAULT_STRIKE_LEVELS,
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

const selectedStrikes = computed(() => {
  const spot = latestSpot.value;
  const count = Math.max(
    6,
    Math.min(22, Math.floor(Number(ui.strikeLevels)) || DEFAULT_STRIKE_LEVELS),
  );
  const strikes = Array.from(
    new Set(
      optionUniverse.value
        .filter((option) => selectedExpiries.value.includes(option.expiration_ts))
        .map((option) => option.strike),
    ),
  );

  if (!Number.isFinite(spot)) return strikes.sort((a, b) => a - b).slice(0, count);

  const minStrikeGap = Math.max(1, spot * 0.011);
  const selected = [];
  for (const strike of strikes.sort(
    (a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b,
  )) {
    if (selected.length >= count) break;
    if (selected.every((picked) => Math.abs(picked - strike) >= minStrikeGap)) {
      selected.push(strike);
    }
  }

  return selected.sort((a, b) => a - b);
});

const gridOptions = computed(() => {
  const spot = latestSpot.value;
  if (!Number.isFinite(spot)) return [];
  const expirySet = new Set(selectedExpiries.value);
  const strikeSet = new Set(selectedStrikes.value);

  return optionUniverse.value.filter((option) => {
    if (!expirySet.has(option.expiration_ts)) return false;
    if (!strikeSet.has(option.strike)) return false;
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
  gridOptions.value.map((option) => {
    const ticker = tickerByInstrument.value[option.instrument_name] || {};
    const iv = toFiniteNumber(ticker.iv);
    const oneTouchMultiplier = calcOneTouchMultiplier({
      spot: latestSpot.value,
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
      markPrice: toFiniteNumber(ticker.mark_price),
      iv,
      forward: toFiniteNumber(ticker.forward),
      oneTouchMultiplier,
    };
  }),
);

const chartSubtitle = computed(() => {
  const resolution = RESOLUTION_CONFIG[ui.resolutionKey]?.label || ui.resolutionKey;
  const spot = latestSpot.value;
  const spotText = Number.isFinite(spot) ? spot.toLocaleString("en-US") : "-";
  return `${underlying.value} index ${resolution} | spot ${spotText}`;
});

const canSavePng = computed(() => indexRows.value.length > 0 || gridRows.value.length > 0);
const loading = computed(() => ui.loadingIndex || ui.loadingTickers);

const slugValue = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function handleSavePng() {
  if (!chartRef.value) return;
  const parts = [
    "grid",
    underlying.value,
    RESOLUTION_CONFIG[ui.resolutionKey]?.label || ui.resolutionKey,
  ].map(slugValue);
  chartRef.value.exportPng({ filename: `${parts.join("-")}.png` });
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

          <div class="segmented" role="group" aria-label="Resolution">
            <button
              v-for="key in Object.keys(RESOLUTION_CONFIG)"
              :key="key"
              type="button"
              :class="{ active: ui.resolutionKey === key }"
              @click="ui.resolutionKey = key"
            >
              {{ RESOLUTION_CONFIG[key].label }}
            </button>
          </div>
        </div>

        <div class="toolbarGroup">
          <label class="pointSlider">
            <span>{{ ui.maxPoints }} index points</span>
            <input
              v-model.number="ui.maxPoints"
              type="range"
              :min="MIN_POINT_LIMIT"
              :max="MAX_POINT_LIMIT"
              step="20"
            />
          </label>

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
        :subtitle="chartSubtitle"
        :loading="ui.loadingIndex"
      />
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </div>
  </div>
</template>

<style scoped>
.app {
  width: 100%;
  min-height: 100vh;
  padding: 14px 14px 18px;
  background:
    radial-gradient(circle at 45% 52%, rgba(235, 84, 156, 0.14), transparent 28%),
    linear-gradient(135deg, #221018 0%, #12080d 48%, #080607 100%);
}

.header {
  padding: 10px 0 14px;
}

.header h1 {
  margin: 0;
  color: #fff8fb;
  font-size: 28px;
  font-weight: 760;
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
  border: 1px solid rgba(244, 126, 181, 0.35);
  border-radius: 6px;
  background: rgba(18, 8, 13, 0.9);
}

.segmented button,
.saveButton {
  height: 100%;
  border: 0;
  background: transparent;
  color: #f7d7e6;
  cursor: pointer;
  padding: 0 16px;
  font-size: 12px;
  font-weight: 650;
  font-family: inherit;
}

.segmented button + button {
  border-left: 1px solid rgba(244, 126, 181, 0.22);
}

.segmented .active {
  background: rgba(244, 126, 181, 0.23);
  color: #fff;
}

.saveButton {
  height: 31px;
  border: 1px solid rgba(244, 126, 181, 0.35);
  border-radius: 6px;
  background: rgba(18, 8, 13, 0.9);
}

.saveButton:disabled,
.segmented button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.pointSlider,
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.pointSlider span,
.stepper span {
  color: #e7a0c5;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.pointSlider input {
  width: 160px;
  accent-color: #f4e94d;
}

.stepper input {
  width: 58px;
  height: 31px;
  border: 1px solid rgba(244, 126, 181, 0.35);
  border-radius: 6px;
  background: rgba(18, 8, 13, 0.9);
  color: #fff8fb;
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
  border: 1px solid rgba(253, 164, 175, 0.3);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.2);
  color: #fda4af;
  font-size: 13px;
  line-height: 1.35;
}
</style>
