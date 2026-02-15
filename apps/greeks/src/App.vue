<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as d3 from "d3";
import Greeks from "./components/Greeks.vue";
import {
  calcGreeks,
  fetchInstruments,
  fetchIndexHistory,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  "1h": { label: "1h" },
  "1d": { label: "1d" },
};
const GREEK_OPTIONS = [
  { value: "delta", symbol: "\u03b4" },
  { value: "gamma", symbol: "\u0393" },
  { value: "theta", symbol: "\u0398" },
  { value: "vega", symbol: "\u03c3" },
  { value: "vanna", symbol: "v" },
];
const ONE_HOUR_SECONDS = 60 * 60;
const ONE_DAY_SECONDS = 24 * ONE_HOUR_SECONDS;
const RESOLUTION_SECONDS = {
  "1h": ONE_HOUR_SECONDS,
  "1d": ONE_DAY_SECONDS,
};
const MAX_POINTS_PER_INSTRUMENT = 48;
const MAX_MARK_REQUEST_CONCURRENCY = 20;
const MARK_REQUEST_PACING_MS = 300;
const MARK_REQUEST_MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_MAX_RETRIES = 3;
const REQUEST_RETRY_DELAYS_MS = [1000, 10_000, 60_000];
const ERROR_AUTO_CLEAR_MS = 5_000;

const ui = reactive({
  expirationPrimary: "",
  mode: "single",
  resolution: "1d",
  greek: "delta",
  loading: false,
  error: "",
});

const data = reactive({
  instruments: [],
  indexRows: [],
  markRows: [],
  markRowsByExpiry: {},
  requestedRange: null,
});
const chartRef = ref(null);
const isBootstrapping = ref(true);
const progressiveDots = ref(0);
const expiryPanelLoading = reactive({
  primary: false,
  secondary: false,
});
const expiryPanelLoadToken = {
  primary: 0,
  secondary: 0,
};

const multiModeExpirations = computed(() => {
  const options = expirationOptions.value;
  if (!Array.isArray(options) || options.length <= 2) return [];
  return options.slice(1, -1).map((option) => option.value);
});

const selectedExpirations = computed(() =>
  ui.mode === "multi"
    ? multiModeExpirations.value
    : typeof ui.expirationPrimary === "string" && ui.expirationPrimary.length
      ? [ui.expirationPrimary]
      : [],
);

const expirationByValue = computed(() => {
  const map = new Map();
  for (const option of expirationOptions.value) {
    map.set(option.value, option);
  }
  return map;
});

const expirationOptions = computed(() => {
  const map = new Map();
  for (const instrument of data.instruments) {
    if (!instrument || instrument.product !== "OBTCUSD") continue;
    const expiry = instrument.expiry_date;
    const ts = instrument.expiration_timestamp;
    if (!expiry || !Number.isFinite(ts)) continue;
    if (!map.has(expiry)) {
      map.set(expiry, {
        value: expiry,
        label: expiry,
        expiration_timestamp: ts,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.expiration_timestamp - b.expiration_timestamp,
  );
});

const selectedInstruments = computed(() => {
  const selected = new Set(selectedExpirations.value);
  if (!selected.size) return [];
  return data.instruments.filter(
    (instrument) =>
      instrument?.product === "OBTCUSD" &&
      selected.has(instrument?.expiry_date) &&
      (instrument?.option_type || "call").toLowerCase() === "call",
  );
});

const instrumentLookup = computed(() => {
  const map = new Map();
  for (const instrument of data.instruments) {
    if (!instrument?.instrument_name) continue;
    map.set(instrument.instrument_name, instrument);
  }
  return map;
});

const chartRows = computed(() => {
  if (!data.indexRows.length || !data.markRows.length) return [];
  const indexByTs = new Map(data.indexRows.map((row) => [row.ts, row]));
  const lookup = instrumentLookup.value;
  const rows = [];
  const ivAggByTs = new Map();

  for (const mark of data.markRows) {
    const index = indexByTs.get(mark.ts);
    if (!index) continue;
    const instrument = lookup.get(mark.instrument_name);
    if (!instrument) continue;
    const optionType = (instrument.option_type || "call").toLowerCase();
    if (optionType !== "call") continue;
    const strike = Number(instrument.strike_price);
    const tte = instrument.expiration_timestamp - mark.ts;
    const spot = index.index_price_close;
    const iv = mark.iv_close;
    const { delta, gamma, theta, vega, vanna } = calcGreeks(
      spot,
      strike,
      tte,
      iv,
      optionType,
    );
    if (!Number.isFinite(delta)) continue;

    const m = spot / strike;
    if (!Number.isFinite(m)) continue;

    rows.push({
      ...index,
      ...mark,
      strike,
      tte,
      expiry_date: instrument.expiry_date,
      expiry_rank: Math.max(
        0,
        selectedExpirations.value.indexOf(instrument.expiry_date),
      ),
      delta,
      gamma,
      theta,
      vega,
      vanna,
      delta_abs: Math.abs(delta),
      m,
      date_time: new Date(mark.ts * 1000),
    });

    if (Number.isFinite(iv)) {
      const agg = ivAggByTs.get(mark.ts) || { sum: 0, count: 0 };
      agg.sum += iv;
      agg.count += 1;
      ivAggByTs.set(mark.ts, agg);
    }
  }

  if (!rows.length) return [];
  const ivMeanByTs = new Map();
  ivAggByTs.forEach((agg, ts) => {
    ivMeanByTs.set(ts, agg.count ? agg.sum / agg.count : null);
  });
  const minTs = rows.reduce(
    (min, row) => (row.ts < min ? row.ts : min),
    rows[0].ts,
  );
  const maxTs = rows.reduce(
    (max, row) => (row.ts > max ? row.ts : max),
    rows[0].ts,
  );
  const denom = maxTs - minTs || 1;

  return rows.map((row) => ({
    ...row,
    iv_mean: ivMeanByTs.get(row.ts),
    opacity: (row.ts - minTs) / denom || 0,
    is_latest: row.ts === maxTs,
  }));
});

const activeGreekSymbol = computed(
  () =>
    GREEK_OPTIONS.find((option) => option.value === ui.greek)?.symbol ||
    GREEK_OPTIONS[0].symbol,
);

const chartTitle = computed(() => "");

const chartSubtitle = computed(() => {
  if (!chartRows.value.length) return "";
  const format = d3.timeFormat("%d %b %y %I:%M %p");
  const minDate = chartRows.value.reduce(
    (min, row) => (row.date_time < min ? row.date_time : min),
    chartRows.value[0].date_time,
  );
  const maxDate = chartRows.value.reduce(
    (max, row) => (row.date_time > max ? row.date_time : max),
    chartRows.value[0].date_time,
  );
  return `${format(minDate)} - ${format(maxDate)}`;
});

const metaSummary = computed(() => {
  if (!selectedExpirations.value.length) return "";
  const expiryCount = selectedExpirations.value.length;
  return `${expiryCount} expiries | ${selectedInstruments.value.length} instruments | ${chartRows.value.length} points`;
});

const chartLoading = computed(() => ui.loading && chartRows.value.length === 0);
const loadingPanelIndexes = computed(() => {
  if (ui.mode === "multi") return [];
  return expiryPanelLoading.primary ? [0] : [];
});

function handleSavePng() {
  if (!chartRef.value) return;
  const expiryPart =
    ui.mode === "multi" ? "all-expiries" : ui.expirationPrimary || "expiry";
  const filename = `greeks-${expiryPart}-${ui.greek}.png`;
  chartRef.value.exportPng({ filename });
}

const computeRange = (expirationTimestamp) => {
  const now = Math.floor(Date.now() / 1000);
  const safeEnd = Number.isFinite(expirationTimestamp)
    ? Math.min(now, expirationTimestamp - 3600)
    : now;
  const to = Math.max(safeEnd, 0);
  const resolutionSeconds =
    RESOLUTION_SECONDS[ui.resolution] || ONE_HOUR_SECONDS;
  const maxByPointsFrom = Math.max(
    0,
    to - MAX_POINTS_PER_INSTRUMENT * resolutionSeconds,
  );
  const from = maxByPointsFrom;
  return { from, to };
};

let indexRequestId = 0;
const markRequestIdByExpiry = new Map();
const markRowsCache = new Map();
let pendingLoads = 0;
let errorAutoClearTimer = null;
let progressiveDotsTimer = null;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function startProgressiveDots() {
  if (progressiveDotsTimer) return;
  const sequence = [1, 2, 3, 0];
  let sequenceIndex = 0;
  progressiveDots.value = sequence[sequenceIndex];
  progressiveDotsTimer = setInterval(() => {
    sequenceIndex = (sequenceIndex + 1) % sequence.length;
    progressiveDots.value = sequence[sequenceIndex];
  }, 400);
}

function stopProgressiveDots() {
  if (progressiveDotsTimer) {
    clearInterval(progressiveDotsTimer);
    progressiveDotsTimer = null;
  }
  progressiveDots.value = 0;
}

function clearError() {
  ui.error = "";
  if (errorAutoClearTimer) {
    clearTimeout(errorAutoClearTimer);
    errorAutoClearTimer = null;
  }
}

function setError(message) {
  ui.error = message || "";
  if (errorAutoClearTimer) {
    clearTimeout(errorAutoClearTimer);
    errorAutoClearTimer = null;
  }
  if (ui.error.includes("No datapoints returned")) {
    errorAutoClearTimer = setTimeout(() => {
      ui.error = "";
      errorAutoClearTimer = null;
    }, ERROR_AUTO_CLEAR_MS);
  }
}

function startLoad() {
  pendingLoads += 1;
  ui.loading = true;
}

function finishLoad() {
  pendingLoads = Math.max(0, pendingLoads - 1);
  ui.loading = pendingLoads > 0;
}

function rebuildMarkRows() {
  const combined = [];
  for (const expiry of selectedExpirations.value) {
    const rows = data.markRowsByExpiry[expiry] || [];
    combined.push(...rows);
  }
  data.markRows = combined;
}

function startPanelLoad(panelKey) {
  if (!panelKey) return 0;
  const next = (expiryPanelLoadToken[panelKey] || 0) + 1;
  expiryPanelLoadToken[panelKey] = next;
  expiryPanelLoading[panelKey] = true;
  return next;
}

function finishPanelLoad(panelKey, token) {
  if (!panelKey || !token) return;
  if (expiryPanelLoadToken[panelKey] === token) {
    expiryPanelLoading[panelKey] = false;
  }
}

function resetPanelLoad(panelKey) {
  if (!panelKey) return;
  expiryPanelLoadToken[panelKey] = (expiryPanelLoadToken[panelKey] || 0) + 1;
  expiryPanelLoading[panelKey] = false;
}

function getReferenceExpiryTs() {
  const timestamps = selectedExpirations.value
    .map((value) => expirationByValue.value.get(value)?.expiration_timestamp)
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return Math.max(...timestamps);
}

function buildMarkCacheKey({ expiry, resolution }) {
  return `${expiry}|${resolution}`;
}

async function fetchMarkRows(
  instruments,
  range,
  resolution,
  { onInstrumentRows = null, isCanceled = null } = {},
) {
  const rows = [];
  let rateLimitedCount = 0;

  const fetchInstrumentRows = async (instrument, index) => {
    let fetchedRows = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MARK_REQUEST_MAX_RETRIES; attempt += 1) {
      if (isCanceled?.()) break;
      try {
        fetchedRows = await fetchMarkHistory({
          instrument_name: instrument.instrument_name,
          resolution,
          from: range.from,
          to: range.to,
          requestOptions: {
            timeoutMs: REQUEST_TIMEOUT_MS,
            maxRetries: REQUEST_MAX_RETRIES,
            retryDelaysMs: REQUEST_RETRY_DELAYS_MS,
          },
        });
        lastError = null;
        break;
      } catch (reason) {
        lastError = reason;
        if (reason?.status !== 429 || attempt >= MARK_REQUEST_MAX_RETRIES) {
          break;
        }
        const backoffMs =
          2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 180);
        await sleep(backoffMs);
      }
    }

    return { instrument, index, fetchedRows, lastError };
  };

  for (
    let batchStart = 0;
    batchStart < instruments.length;
    batchStart += MAX_MARK_REQUEST_CONCURRENCY
  ) {
    if (isCanceled?.()) break;
    const batch = instruments.slice(
      batchStart,
      batchStart + MAX_MARK_REQUEST_CONCURRENCY,
    );
    const inFlight = new Map();

    batch.forEach((instrument, offset) => {
      const index = batchStart + offset;
      const tracked = fetchInstrumentRows(instrument, index).then((result) => ({
        key: index,
        result,
      }));
      inFlight.set(index, tracked);
    });

    while (inFlight.size) {
      if (isCanceled?.()) break;
      const { key, result } = await Promise.race(inFlight.values());
      inFlight.delete(key);
      if (!Array.isArray(result.fetchedRows)) {
        if (result.lastError?.status === 429) {
          rateLimitedCount += 1;
        }
        continue;
      }

      const instrumentName = result.instrument?.instrument_name;
      const nextRows = result.fetchedRows.map((row) => ({
        ...row,
        instrument_name: instrumentName,
      }));
      rows.push(...nextRows);
      onInstrumentRows?.(nextRows, {
        instrumentName,
        index: result.index,
        total: instruments.length,
      });
    }

    const hasMore =
      batchStart + MAX_MARK_REQUEST_CONCURRENCY < instruments.length;
    if (hasMore) {
      await sleep(MARK_REQUEST_PACING_MS);
    }
  }

  return { rows, rateLimitedCount };
}

async function loadIndex() {
  if (!selectedExpirations.value.length) return;
  const referenceExpiryTs = getReferenceExpiryTs();
  if (!Number.isFinite(referenceExpiryTs)) return;

  const current = (indexRequestId += 1);
  startLoad();
  clearError();

  const range = computeRange(referenceExpiryTs);
  data.requestedRange = range;

  try {
    const indexRows = await fetchIndexHistory({
      index_name: "BTCUSD",
      resolution: ui.resolution,
      from: range.from,
      to: range.to,
      requestOptions: {
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES,
        retryDelaysMs: REQUEST_RETRY_DELAYS_MS,
      },
    });

    if (current !== indexRequestId) return;
    data.indexRows = indexRows || [];

    if (!data.indexRows.length) {
      throw new Error("No datapoints returned for this range.");
    }
  } catch (error) {
    if (current !== indexRequestId) return;
    setError(error instanceof Error ? error.message : String(error));
    data.indexRows = [];
  } finally {
    finishLoad();
  }
}

async function loadExpiry(expiry, { rebuild = true, panelKey = null } = {}) {
  if (!expiry) return;
  const option = expirationByValue.value.get(expiry);
  if (!option) return;
  const resolution = ui.resolution;
  const instruments = data.instruments.filter(
    (instrument) =>
      instrument?.product === "OBTCUSD" &&
      instrument?.expiry_date === expiry &&
      (instrument?.option_type || "call").toLowerCase() === "call",
  );
  if (!instruments.length) {
    setError(`No instruments available for expiry ${expiry}.`);
    return;
  }

  const prevRequestId = markRequestIdByExpiry.get(expiry) || 0;
  const current = prevRequestId + 1;
  markRequestIdByExpiry.set(expiry, current);

  const range =
    data.requestedRange || computeRange(option?.expiration_timestamp);
  data.requestedRange = range;
  const cacheKey = buildMarkCacheKey({
    expiry,
    resolution,
  });
  const cachedRows = markRowsCache.get(cacheKey);
  if (cachedRows) {
    data.markRowsByExpiry[expiry] = cachedRows;
    if (rebuild) rebuildMarkRows();
    return;
  }

  const panelToken = startPanelLoad(panelKey);
  startLoad();
  clearError();

  try {
    data.markRowsByExpiry[expiry] = [];
    if (rebuild) rebuildMarkRows();
    let progressiveRowsCount = 0;

    const markResult = await fetchMarkRows(instruments, range, resolution, {
      onInstrumentRows: (nextRows) => {
        if (markRequestIdByExpiry.get(expiry) !== current) return;
        if (!Array.isArray(nextRows) || !nextRows.length) return;
        const existingRows = data.markRowsByExpiry[expiry] || [];
        existingRows.push(...nextRows);
        data.markRowsByExpiry[expiry] = existingRows;
        progressiveRowsCount += nextRows.length;
        if (rebuild) rebuildMarkRows();
      },
      isCanceled: () => markRequestIdByExpiry.get(expiry) !== current,
    });
    if (markRequestIdByExpiry.get(expiry) !== current) return;

    const nextRows = markResult?.rows || [];
    if (!nextRows.length) {
      if (markResult?.rateLimitedCount > 0) {
        throw new Error(
          `Rate limited by Thalex (429) while loading ${markResult.rateLimitedCount} instrument request(s). Please wait a bit and retry.`,
        );
      }
      throw new Error(`No datapoints returned for expiry ${expiry}.`);
    }

    if (
      !progressiveRowsCount ||
      data.markRowsByExpiry[expiry]?.length !== nextRows.length
    ) {
      data.markRowsByExpiry[expiry] = nextRows;
    }
    markRowsCache.set(cacheKey, nextRows);
    if (rebuild) rebuildMarkRows();
  } catch (error) {
    if (markRequestIdByExpiry.get(expiry) !== current) return;
    if (error?.status === 429) {
      setError("Rate limited by Thalex (429). Please wait a bit and retry.");
    } else {
      setError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    finishPanelLoad(panelKey, panelToken);
    finishLoad();
  }
}

async function reloadAll() {
  data.indexRows = [];
  data.markRowsByExpiry = {};
  data.markRows = [];
  if (!selectedExpirations.value.length) return;
  await loadIndex();
  for (const expiry of selectedExpirations.value) {
    await loadExpiry(expiry, {
      rebuild: true,
      panelKey: ui.mode === "single" ? "primary" : null,
    });
  }
}

onMounted(async () => {
  try {
    const all = await fetchInstruments();
    data.instruments = Array.isArray(all) ? all : [];
    const options = expirationOptions.value;
    if (!options.length) {
      setError("No option expirations found.");
      return;
    }
    const now = Date.now() / 1000;
    const target = now + 30 * 24 * 60 * 60;
    const upcoming = options.filter(
      (option) => option.expiration_timestamp > now,
    );
    const pickFrom = upcoming.length ? upcoming : options;
    const closest = pickFrom.reduce((best, option) => {
      if (!best) return option;
      const bestDiff = Math.abs(best.expiration_timestamp - target);
      const optionDiff = Math.abs(option.expiration_timestamp - target);
      return optionDiff < bestDiff ? option : best;
    }, null);
    const primary = (closest || options[0]).value;
    ui.expirationPrimary = primary;
    await reloadAll();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    isBootstrapping.value = false;
  }
});

onUnmounted(() => {
  if (errorAutoClearTimer) {
    clearTimeout(errorAutoClearTimer);
    errorAutoClearTimer = null;
  }
  stopProgressiveDots();
});

watch(
  () => ui.resolution,
  async () => {
    if (isBootstrapping.value) return;
    await reloadAll();
  },
  { immediate: false },
);

watch(
  () => ui.expirationPrimary,
  async (next) => {
    if (isBootstrapping.value) return;
    if (ui.mode !== "single") return;
    if (next) {
      await loadExpiry(next, { panelKey: "primary" });
    } else {
      resetPanelLoad("primary");
      rebuildMarkRows();
    }
  },
  { immediate: false },
);

watch(
  () => ui.mode,
  async () => {
    if (isBootstrapping.value) return;
    await reloadAll();
  },
  { immediate: false },
);

watch(
  () => ui.loading,
  (isLoading) => {
    if (isLoading) {
      startProgressiveDots();
    } else {
      stopProgressiveDots();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Options {{ activeGreekSymbol }} vs moneyness</h1>
        <div v-if="chartSubtitle || metaSummary" class="titleMetaGroup">
          <div v-if="chartSubtitle" class="meta">{{ chartSubtitle }}</div>
          <div v-if="metaSummary" class="meta">{{ metaSummary }}</div>
        </div>
      </div>

      <div class="controls">
        <div class="modeToggle">
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: ui.mode === 'single' }"
            @click="ui.mode = 'single'"
          >
            Single
          </button>
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: ui.mode === 'multi' }"
            @click="ui.mode = 'multi'"
          >
            Multi
          </button>
        </div>

        <div class="field" v-if="ui.mode === 'single'">
          <label for="expiration-primary">Expiry</label>
          <select id="expiration-primary" v-model="ui.expirationPrimary">
            <option
              v-for="option in expirationOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option
              v-if="!expirationOptions.length"
              :value="ui.expirationPrimary"
            >
              {{ ui.expirationPrimary || "No expirations" }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="ui.resolution">
            <option
              v-for="key in Object.keys(RESOLUTION_CONFIG)"
              :key="key"
              :value="key"
            >
              {{ RESOLUTION_CONFIG[key].label }}
            </option>
          </select>
        </div>

        <div class="greekSymbolGrid" role="group" aria-label="Greek">
          <button
            v-for="option in GREEK_OPTIONS"
            :key="option.value"
            type="button"
            class="greekSymbolButton"
            :class="{ active: ui.greek === option.value }"
            @click="ui.greek = option.value"
          >
            {{ option.symbol }}
          </button>
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !chartRows.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="ui.loading" class="progressiveFetchLabel">
        Fetching progressively{{ ".".repeat(progressiveDots) }}
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <Greeks
      ref="chartRef"
      :data="chartRows"
      :title="chartTitle"
      subtitle=""
      :loading="chartLoading"
      :loading-panels="loadingPanelIndexes"
      :mode="ui.mode"
      x-mode="m"
      :greek="ui.greek"
      :resolution="ui.resolution"
    />
  </div>
</template>

<style scoped>
.titleMetaGroup {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.greekSymbolGrid {
  display: inline-grid;
  grid-auto-flow: column;
  gap: 8px;
}

.greekSymbolButton {
  border: 1px solid var(--border);
  background: color-mix(in oklab, var(--panel), #1b1f2f 35%);
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  width: 44px;
  height: 40px;
  border-radius: 10px;
  cursor: pointer;
}

.greekSymbolButton.active {
  color: var(--text);
  font-weight: 600;
}

.progressiveFetchLabel {
  margin-top: 8px;
  font-size: 12px;
  letter-spacing: 0.03em;
  color: color-mix(in oklab, var(--muted), #d8deee 16%);
}
</style>
