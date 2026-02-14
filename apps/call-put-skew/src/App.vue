<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as d3 from "d3";
import DeltaSkewChart from "./components/DeltaSkewChart.vue";
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
const RESOLUTION_KEYS = Object.keys(RESOLUTION_CONFIG);

const RANGE_DAYS = 21;
const ONE_HOUR_SECONDS = 60 * 60;
const MAX_1H_POINTS_PER_INSTRUMENT = 120;
const MAX_INSTRUMENTS_PER_SIDE = 16;
const MAX_MARK_REQUEST_CONCURRENCY = 30;
const MARK_REQUEST_PACING_MS = 180;
const MARK_REQUEST_MAX_RETRIES = 3;

const ui = reactive({
  expiration: "",
  resolution: "1h",
  loading: false,
  error: "",
});
const visualSettings = reactive({
  opacityMin: 0.12,
  opacityMax: 0.9,
  sizeMin: 0.7,
  sizeMax: 1.55,
});

const data = reactive({
  instruments: [],
  indexRows: [],
  markRows: [],
  requestedRange: null,
});

const chartRef = ref(null);
const isBootstrapping = ref(true);
const showSettings = ref(false);
const settingsRef = ref(null);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function setOpacityMin(value) {
  const next = clamp(Number(value), 0, 1);
  visualSettings.opacityMin = Math.min(next, visualSettings.opacityMax);
}

function setOpacityMax(value) {
  const next = clamp(Number(value), 0, 1);
  visualSettings.opacityMax = Math.max(next, visualSettings.opacityMin);
}

function setSizeMin(value) {
  const next = clamp(Number(value), 0.2, 2.5);
  visualSettings.sizeMin = Math.min(next, visualSettings.sizeMax);
}

function setSizeMax(value) {
  const next = clamp(Number(value), 0.2, 2.5);
  visualSettings.sizeMax = Math.max(next, visualSettings.sizeMin);
}

function handleDocumentPointerDown(event) {
  if (!showSettings.value) return;
  const root = settingsRef.value;
  if (!root?.contains(event.target)) {
    showSettings.value = false;
  }
}

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

const expirationByValue = computed(() => {
  const map = new Map();
  for (const option of expirationOptions.value) {
    map.set(option.value, option);
  }
  return map;
});

const selectedInstruments = computed(() => {
  if (!ui.expiration) return [];
  return data.instruments.filter((instrument) => {
    if (instrument?.product !== "OBTCUSD") return false;
    if (instrument?.expiry_date !== ui.expiration) return false;
    const type = (instrument?.option_type || "").toLowerCase();
    return type === "call" || type === "put";
  });
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

  for (const mark of data.markRows) {
    const index = indexByTs.get(mark.ts);
    if (!index) continue;
    const instrument = lookup.get(mark.instrument_name);
    if (!instrument) continue;

    const optionType = (instrument.option_type || "").toLowerCase();
    if (optionType !== "call" && optionType !== "put") continue;

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

    rows.push({
      ...index,
      ...mark,
      strike,
      tte,
      expiry_date: instrument.expiry_date,
      option_type: optionType,
      delta,
      gamma,
      theta,
      vega,
      delta_abs: Math.abs(delta),
      date_time: new Date(mark.ts * 1000),
    });
  }

  return rows;
});

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
  if (!ui.expiration) return "";
  return `${selectedInstruments.value.length} instruments | ${chartRows.value.length} points`;
});

const chartLoading = computed(() => ui.loading && chartRows.value.length === 0);

function handleSavePng() {
  if (!chartRef.value) return;
  const expiry = ui.expiration || "expiry";
  const filename = `delta-skew-${expiry}-${ui.resolution}.png`;
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

const markRowsCache = new Map();
let pendingLoads = 0;
let reloadRequestId = 0;

function startLoad() {
  pendingLoads += 1;
  ui.loading = true;
}

function finishLoad() {
  pendingLoads = Math.max(0, pendingLoads - 1);
  ui.loading = pendingLoads > 0;
}

function buildMarkCacheKey({ expiry, resolution }) {
  return `${expiry}|${resolution}`;
}

function getLongestRunningExpiration(options) {
  if (!Array.isArray(options) || !options.length) return null;
  return (
    [...options].sort(
      (a, b) =>
        (Number(b.expiration_timestamp) || 0) -
        (Number(a.expiration_timestamp) || 0),
    )[0] || null
  );
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function getAllInstrumentsForExpiry(expiry) {
  return data.instruments.filter((instrument) => {
    if (instrument?.product !== "OBTCUSD") return false;
    if (instrument?.expiry_date !== expiry) return false;
    const type = (instrument?.option_type || "").toLowerCase();
    return type === "call" || type === "put";
  });
}

function pickCenteredByStrike(instruments, count) {
  if (instruments.length <= count) return instruments;
  const sorted = [...instruments].sort(
    (a, b) => Number(a.strike_price) - Number(b.strike_price),
  );
  const start = Math.max(0, Math.floor((sorted.length - count) / 2));
  return sorted.slice(start, start + count);
}

function pickInstrumentSubset(instruments, referencePrice) {
  const calls = instruments.filter(
    (instrument) => (instrument?.option_type || "").toLowerCase() === "call",
  );
  const puts = instruments.filter(
    (instrument) => (instrument?.option_type || "").toLowerCase() === "put",
  );

  const pickSide = (sideInstruments) => {
    if (sideInstruments.length <= MAX_INSTRUMENTS_PER_SIDE) {
      return sideInstruments;
    }
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return pickCenteredByStrike(sideInstruments, MAX_INSTRUMENTS_PER_SIDE);
    }
    const ranked = [...sideInstruments].sort((a, b) => {
      const da = Math.abs(Number(a.strike_price) - referencePrice);
      const db = Math.abs(Number(b.strike_price) - referencePrice);
      return da - db;
    });
    return ranked.slice(0, MAX_INSTRUMENTS_PER_SIDE);
  };

  return [...pickSide(calls), ...pickSide(puts)];
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

async function loadMarkRowsForExpiry(
  expiry,
  range,
  resolution,
  referencePrice,
  { onInstrumentRows = null, isCanceled = null } = {},
) {
  const cacheKey = buildMarkCacheKey({ expiry, resolution });
  const allInstruments = getAllInstrumentsForExpiry(expiry);
  const instruments = pickInstrumentSubset(allInstruments, referencePrice);
  if (!instruments.length) {
    throw new Error(`No call/put instruments available for expiry ${expiry}.`);
  }

  const cachedRows = markRowsCache.get(cacheKey);
  if (cachedRows) {
    if (onInstrumentRows) {
      const rowsByInstrument = new Map();
      cachedRows.forEach((row) => {
        const key = row?.instrument_name;
        if (!key) return;
        const list = rowsByInstrument.get(key) || [];
        list.push(row);
        rowsByInstrument.set(key, list);
      });
      instruments.forEach((instrument, index) => {
        const instrumentName = instrument?.instrument_name;
        const nextRows = rowsByInstrument.get(instrumentName) || [];
        if (nextRows.length) {
          onInstrumentRows(nextRows, {
            instrumentName,
            index,
            total: instruments.length,
            cached: true,
          });
        }
      });
    }
    return cachedRows;
  }

  const markResult = await fetchMarkRows(instruments, range, resolution, {
    onInstrumentRows,
    isCanceled,
  });
  const nextRows = markResult?.rows || [];
  if (!nextRows.length) {
    if (markResult?.rateLimitedCount > 0) {
      throw new Error(
        `Rate limited by Thalex (429) while loading ${markResult.rateLimitedCount} instrument request(s). Please wait a bit and retry.`,
      );
    }
    throw new Error(`No mark datapoints returned for expiry ${expiry}.`);
  }

  markRowsCache.set(cacheKey, nextRows);
  return nextRows;
}

async function reloadAll() {
  if (!ui.expiration) {
    data.indexRows = [];
    data.markRows = [];
    return;
  }

  const option = expirationByValue.value.get(ui.expiration);
  if (!option) return;

  const requestId = ++reloadRequestId;
  startLoad();
  ui.error = "";

  try {
    const range = computeRange(option.expiration_timestamp);
    data.requestedRange = range;

    const indexRows = await fetchIndexHistory({
      index_name: "BTCUSD",
      resolution: ui.resolution,
      from: range.from,
      to: range.to,
    });

    if (requestId !== reloadRequestId) return;

    const nextIndexRows = Array.isArray(indexRows) ? indexRows : [];
    if (!nextIndexRows.length) {
      throw new Error("No index datapoints returned for this range.");
    }

    data.indexRows = nextIndexRows;
    data.markRows = [];

    const latestIndex = nextIndexRows[nextIndexRows.length - 1];
    const referencePrice = Number(latestIndex?.index_price_close);
    let progressiveRowsCount = 0;
    const markRows = await loadMarkRowsForExpiry(
      ui.expiration,
      range,
      ui.resolution,
      referencePrice,
      {
        onInstrumentRows: (nextRows) => {
          if (requestId !== reloadRequestId) return;
          if (!Array.isArray(nextRows) || !nextRows.length) return;
          data.markRows.push(...nextRows);
          progressiveRowsCount += nextRows.length;
        },
        isCanceled: () => requestId !== reloadRequestId,
      },
    );

    if (requestId !== reloadRequestId) return;

    if (!progressiveRowsCount) {
      data.markRows = markRows;
    } else if (data.markRows.length !== markRows.length) {
      data.markRows = markRows;
    }
  } catch (error) {
    if (requestId !== reloadRequestId) return;
    if (error?.status === 429) {
      ui.error = "Rate limited by Thalex (429). Please wait a bit and retry.";
    } else {
      ui.error = error instanceof Error ? error.message : String(error);
    }
    data.indexRows = [];
    data.markRows = [];
  } finally {
    finishLoad();
  }
}

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  try {
    const all = await fetchInstruments();
    data.instruments = Array.isArray(all) ? all : [];

    const options = expirationOptions.value;
    if (!options.length) {
      ui.error = "No option expirations found.";
      return;
    }

    const longestRunning = getLongestRunningExpiration(options);
    ui.expiration = (longestRunning || options[0]).value;
    await reloadAll();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    isBootstrapping.value = false;
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
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
  () => ui.expiration,
  async () => {
    if (isBootstrapping.value) return;
    await reloadAll();
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Call-Put Skew</h1>
        <div class="titleRight">
          <div v-if="chartSubtitle || metaSummary" class="titleMetaGroup">
            <div v-if="chartSubtitle" class="meta">{{ chartSubtitle }}</div>
            <div v-if="metaSummary" class="meta">{{ metaSummary }}</div>
          </div>
          <div ref="settingsRef" class="settingsMenu">
            <button
              class="settingsButton"
              type="button"
              title="Chart settings"
              aria-label="Chart settings"
              @click.stop="showSettings = !showSettings"
            >
              ⚙
            </button>
            <div v-if="showSettings" class="settingsDropdown" @click.stop>
              <div class="settingsTitle">Point Settings</div>
              <div class="settingsRow">
                <label>Opacity Min</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  :value="visualSettings.opacityMin"
                  @input="setOpacityMin($event.target.value)"
                />
                <span>{{ (visualSettings.opacityMin * 100).toFixed(0) }}%</span>
              </div>
              <div class="settingsRow">
                <label>Opacity Max</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  :value="visualSettings.opacityMax"
                  @input="setOpacityMax($event.target.value)"
                />
                <span>{{ (visualSettings.opacityMax * 100).toFixed(0) }}%</span>
              </div>
              <div class="settingsRow">
                <label>Size Min</label>
                <input
                  type="range"
                  min="0.2"
                  max="2.5"
                  step="0.05"
                  :value="visualSettings.sizeMin"
                  @input="setSizeMin($event.target.value)"
                />
                <span>{{ visualSettings.sizeMin.toFixed(2) }}x</span>
              </div>
              <div class="settingsRow">
                <label>Size Max</label>
                <input
                  type="range"
                  min="0.2"
                  max="2.5"
                  step="0.05"
                  :value="visualSettings.sizeMax"
                  @input="setSizeMax($event.target.value)"
                />
                <span>{{ visualSettings.sizeMax.toFixed(2) }}x</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="controls">
        <div class="field">
          <label for="expiration">Expiration</label>
          <select id="expiration" v-model="ui.expiration">
            <option
              v-for="option in expirationOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option v-if="!expirationOptions.length" :value="ui.expiration">
              {{ ui.expiration || "No expirations" }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="ui.resolution">
            <option v-for="key in RESOLUTION_KEYS" :key="key" :value="key">
              {{ RESOLUTION_CONFIG[key].label }}
            </option>
          </select>
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

    <DeltaSkewChart
      ref="chartRef"
      :data="chartRows"
      :loading="chartLoading"
      :subtitle="chartSubtitle"
      :opacity-range="[visualSettings.opacityMin, visualSettings.opacityMax]"
      :size-range="[visualSettings.sizeMin, visualSettings.sizeMax]"
    />
  </div>
</template>

<style scoped>
.titleRight {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.titleMetaGroup {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.settingsMenu {
  position: relative;
}

.settingsButton {
  border: 1px solid var(--border);
  background: color-mix(in oklab, var(--panel), #1b1f2f 35%);
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  cursor: pointer;
}

.settingsButton:hover {
  color: var(--text);
}

.settingsDropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 20;
  width: 300px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
}

.settingsTitle {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 8px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.settingsRow {
  display: grid;
  grid-template-columns: 86px 1fr 50px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.settingsRow:last-child {
  margin-bottom: 0;
}

.settingsRow label {
  font-size: 12px;
  color: var(--muted);
}

.settingsRow input[type="range"] {
  width: 100%;
}

.settingsRow span {
  font-size: 12px;
  color: var(--text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
