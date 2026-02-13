<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
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
const MAX_1H_POINTS_PER_INSTRUMENT = 72;
const MAX_INSTRUMENTS_PER_SIDE = 8;
const MARK_REQUEST_PACING_MS = 180;
const MARK_REQUEST_MAX_RETRIES = 3;

const ui = reactive({
  expiration: "",
  resolution: "1d",
  loading: false,
  error: "",
});

const data = reactive({
  instruments: [],
  indexRows: [],
  markRows: [],
  requestedRange: null,
});

const chartRef = ref(null);
const isBootstrapping = ref(true);

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

async function fetchMarkRows(instruments, range, resolution) {
  const rows = [];
  let rateLimitedCount = 0;

  for (let index = 0; index < instruments.length; index += 1) {
    const instrument = instruments[index];
    let fetchedRows = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MARK_REQUEST_MAX_RETRIES; attempt += 1) {
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
        const backoffMs = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 180);
        await sleep(backoffMs);
      }
    }

    if (!Array.isArray(fetchedRows)) {
      if (lastError?.status === 429) {
        rateLimitedCount += 1;
      }
    } else {
      const instrumentName = instrument?.instrument_name;
      fetchedRows.forEach((row) => {
        rows.push({ ...row, instrument_name: instrumentName });
      });
    }

    if (index < instruments.length - 1) {
      await sleep(MARK_REQUEST_PACING_MS);
    }
  }

  return { rows, rateLimitedCount };
}

async function loadMarkRowsForExpiry(expiry, range, resolution, referencePrice) {
  const cacheKey = buildMarkCacheKey({ expiry, resolution });
  const cachedRows = markRowsCache.get(cacheKey);
  if (cachedRows) {
    return cachedRows;
  }

  const allInstruments = getAllInstrumentsForExpiry(expiry);
  const instruments = pickInstrumentSubset(allInstruments, referencePrice);
  if (!instruments.length) {
    throw new Error(`No call/put instruments available for expiry ${expiry}.`);
  }

  const markResult = await fetchMarkRows(instruments, range, resolution);
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

    const latestIndex = nextIndexRows[nextIndexRows.length - 1];
    const referencePrice = Number(latestIndex?.index_price_close);
    const markRows = await loadMarkRowsForExpiry(
      ui.expiration,
      range,
      ui.resolution,
      referencePrice,
    );

    if (requestId !== reloadRequestId) return;

    data.indexRows = nextIndexRows;
    data.markRows = markRows;
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
    const upcoming = options.filter((option) => option.expiration_timestamp > now);
    const pickFrom = upcoming.length ? upcoming : options;

    const closest = pickFrom.reduce((best, option) => {
      if (!best) return option;
      const bestDiff = Math.abs(best.expiration_timestamp - target);
      const optionDiff = Math.abs(option.expiration_timestamp - target);
      return optionDiff < bestDiff ? option : best;
    }, null);

    ui.expiration = (closest || options[0]).value;
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
        <h1>Call/Put Delta Skew</h1>
        <div v-if="chartSubtitle || metaSummary" class="titleMetaGroup">
          <div v-if="chartSubtitle" class="meta">{{ chartSubtitle }}</div>
          <div v-if="metaSummary" class="meta">{{ metaSummary }}</div>
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
</style>
