<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
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
  { value: "vega", symbol: "\u03bd" },
];
const RANGE_DAYS = 30;
const ONE_HOUR_SECONDS = 60 * 60;
const MAX_1H_POINTS_PER_INSTRUMENT = 72;
const MAX_MARK_REQUEST_CONCURRENCY = 30;
const MARK_REQUEST_PACING_MS = 120;
const MARK_REQUEST_MAX_RETRIES = 3;

const ui = reactive({
  expirationPrimary: "",
  expirationSecondary: "",
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
const expiryPanelLoading = reactive({
  primary: false,
  secondary: false,
});
const expiryPanelLoadToken = {
  primary: 0,
  secondary: 0,
};

const selectedExpirations = computed(() =>
  Array.from(
    new Set(
      [ui.expirationPrimary, ui.expirationSecondary].filter(
        (expiry) => typeof expiry === "string" && expiry.length,
      ),
    ),
  ),
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
    const { delta, gamma, theta, vega } = calcGreeks(
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
  const indexes = [];
  if (expiryPanelLoading.primary) {
    indexes.push(0);
  }
  if (
    expiryPanelLoading.secondary &&
    ui.expirationSecondary &&
    ui.expirationSecondary !== ui.expirationPrimary
  ) {
    indexes.push(1);
  }
  return indexes;
});

function handleSavePng() {
  if (!chartRef.value) return;
  const primary = ui.expirationPrimary || "expiry-a";
  const secondary = ui.expirationSecondary || "expiry-b";
  const filename = `greeks-${primary}-${secondary}-${ui.greek}.png`;
  chartRef.value.exportPng({ filename });
}

const computeRange = (expirationTimestamp) => {
  const now = Math.floor(Date.now() / 1000);
  const safeEnd = Number.isFinite(expirationTimestamp)
    ? Math.min(now, expirationTimestamp - 3600)
    : now;
  const to = Math.max(safeEnd, 0);
  let from = Math.max(0, to - RANGE_DAYS * 24 * 60 * 60);
  if (ui.resolution === "1h") {
    const spanSeconds = MAX_1H_POINTS_PER_INSTRUMENT * ONE_HOUR_SECONDS;
    from = Math.max(0, to - spanSeconds);
  }
  return { from, to };
};

let indexRequestId = 0;
const markRequestIdByExpiry = new Map();
const markRowsCache = new Map();
let pendingLoads = 0;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
        });
        lastError = null;
        break;
      } catch (reason) {
        lastError = reason;
        if (reason?.status !== 429 || attempt >= MARK_REQUEST_MAX_RETRIES) {
          break;
        }
        const backoffMs =
          600 * Math.pow(2, attempt) + Math.floor(Math.random() * 180);
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
    const batchResults = await Promise.all(
      batch.map((instrument, offset) =>
        fetchInstrumentRows(instrument, batchStart + offset),
      ),
    );

    for (const result of batchResults) {
      if (isCanceled?.()) break;
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
  ui.error = "";

  const range = computeRange(referenceExpiryTs);
  data.requestedRange = range;

  try {
    const indexRows = await fetchIndexHistory({
      index_name: "BTCUSD",
      resolution: ui.resolution,
      from: range.from,
      to: range.to,
    });

    if (current !== indexRequestId) return;
    data.indexRows = indexRows || [];

    if (!data.indexRows.length) {
      throw new Error("No datapoints returned for this range.");
    }
  } catch (error) {
    if (current !== indexRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
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
    ui.error = `No instruments available for expiry ${expiry}.`;
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
  ui.error = "";

  try {
    const markResult = await fetchMarkRows(instruments, range, resolution, {
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

    data.markRowsByExpiry[expiry] = nextRows;
    markRowsCache.set(cacheKey, nextRows);
    if (rebuild) rebuildMarkRows();
  } catch (error) {
    if (markRequestIdByExpiry.get(expiry) !== current) return;
    if (error?.status === 429) {
      ui.error = "Rate limited by Thalex (429). Please wait a bit and retry.";
    } else {
      ui.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    finishPanelLoad(panelKey, panelToken);
    finishLoad();
  }
}

async function reloadAll() {
  if (!selectedExpirations.value.length) return;
  data.indexRows = [];
  data.markRowsByExpiry = {};
  data.markRows = [];
  await loadIndex();
  const expiriesToLoad = [];
  if (ui.expirationPrimary) {
    expiriesToLoad.push({ expiry: ui.expirationPrimary, panelKey: "primary" });
  }
  if (
    ui.expirationSecondary &&
    ui.expirationSecondary !== ui.expirationPrimary
  ) {
    expiriesToLoad.push({
      expiry: ui.expirationSecondary,
      panelKey: "secondary",
    });
  }
  for (const { expiry, panelKey } of expiriesToLoad) {
    await loadExpiry(expiry, { rebuild: false, panelKey });
  }
  rebuildMarkRows();
}

onMounted(async () => {
  try {
    const all = await fetchInstruments();
    data.instruments = Array.isArray(all) ? all : [];
    const options = expirationOptions.value;
    if (!options.length) {
      ui.error = "No option expirations found.";
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
    const primaryIndex = options.findIndex(
      (option) => option.value === primary,
    );
    const secondaryFallback =
      options[primaryIndex + 1] || options[primaryIndex - 1] || options[0];
    ui.expirationPrimary = primary;
    ui.expirationSecondary =
      secondaryFallback?.value === primary
        ? ""
        : secondaryFallback?.value || "";
    await reloadAll();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    isBootstrapping.value = false;
  }
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
  () => ui.expirationSecondary,
  async (next) => {
    if (isBootstrapping.value) return;
    if (next) {
      await loadExpiry(next, { panelKey: "secondary" });
    } else {
      resetPanelLoad("secondary");
      rebuildMarkRows();
    }
  },
  { immediate: false },
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
        <div class="field">
          <label for="expiration-primary">Expiry A</label>
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
          <label for="expiration-secondary">Expiry B</label>
          <select id="expiration-secondary" v-model="ui.expirationSecondary">
            <option value="">None</option>
            <option
              v-for="option in expirationOptions"
              :key="`secondary-${option.value}`"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option
              v-if="!expirationOptions.length"
              :value="ui.expirationSecondary"
            >
              {{ ui.expirationSecondary || "No expirations" }}
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

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <Greeks
      ref="chartRef"
      :data="chartRows"
      :title="chartTitle"
      subtitle=""
      :loading="chartLoading"
      :loading-panels="loadingPanelIndexes"
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
</style>
