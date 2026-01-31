<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import FundingChart from "./components/FundingChart.vue";
import {
  buildFundingSeries,
  buildBasisSeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const MAIN_POINT_LIMIT = 300;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");

const UNDERLYING = "BTCUSD";

const ui = reactive({
  resolution: "3600",
  perpetualInstrumentName: "",
  futureInstrumentName: "",
  loading: false,
  error: "",
  notice: "",
});
const data = reactive({
  instruments: [],
  futureInstruments: [],
  perpetualMark: {},
  futureMark: {},
  index: {},
});
const chartRef = ref(null);
let perpReqId = 0;
let futureReqId = 0;
let pendingLoads = 0;

const selectedPerpetual = computed(() => {
  if (!ui.perpetualInstrumentName) return null;
  return (
    data.instruments.find(
      (i) => i.instrument_name === ui.perpetualInstrumentName,
    ) || null
  );
});

const selectedFuture = computed(() => {
  if (!ui.futureInstrumentName) return null;
  return (
    data.futureInstruments.find(
      (i) => i.instrument_name === ui.futureInstrumentName,
    ) || null
  );
});

const startLoad = () => {
  pendingLoads += 1;
  ui.loading = true;
};

const finishLoad = () => {
  pendingLoads = Math.max(0, pendingLoads - 1);
  ui.loading = pendingLoads > 0;
};

function getTimestampRange(resolutionKey) {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(resolutionKey) ?? 0;
  return {
    now,
    resolution,
    range: {
      from: now - seconds * MAIN_POINT_LIMIT,
      to: now,
    },
  };
}

function formatUtc(tsSeconds) {
  return (
    new Date(tsSeconds * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16) + " UTC"
  );
}

function getIndexRangeOrFallback(resolutionKey, fallbackRange) {
  const rows = data.index[resolutionKey] || [];
  if (!rows.length) return fallbackRange;

  let minTs = null;
  let maxTs = null;
  for (const row of rows) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    if (minTs == null || ts < minTs) minTs = ts;
    if (maxTs == null || ts > maxTs) maxTs = ts;
  }

  if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
    return { from: minTs, to: maxTs };
  }
  return fallbackRange;
}

function findClosestFuture(futures, nowSeconds) {
  if (!futures.length) return null;

  const target = nowSeconds + 7 * 24 * 60 * 60;
  const validFutures = futures.filter(
    (i) =>
      Number.isFinite(i.expiration_timestamp) &&
      i.expiration_timestamp > nowSeconds,
  );

  if (!validFutures.length) return futures[0];

  const byDistance = (a, b) =>
    Math.abs(a.expiration_timestamp - target) -
    Math.abs(b.expiration_timestamp - target);

  return validFutures.sort(byDistance)[0];
}

const mainSeries = computed(() => {
  const mark = data.perpetualMark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const intervalSeconds =
    RESOLUTION_CONFIG[ui.resolution]?.interval_seconds ?? Number(ui.resolution);
  const series = buildFundingSeries({
    mark,
    index,
    intervalSeconds,
  });
  return series
    .filter((point) => point.date >= MIN_DATA_DATE)
    .slice(-MAIN_POINT_LIMIT);
});

const basisSeries = computed(() => {
  const mark = data.futureMark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const series = buildBasisSeries({
    mark,
    index,
    instrument: selectedFuture.value || {},
  });
  return series
    .filter((point) => point.date >= MIN_DATA_DATE)
    .slice(-MAIN_POINT_LIMIT);
});

async function loadPerpetualAndIndex({ resolutionKey, perpetualInstrument }) {
  if (!perpetualInstrument) return;

  const reqId = ++perpReqId;
  const { resolution, range } = getTimestampRange(resolutionKey);

  startLoad();
  ui.error = "";

  try {
    const indexName = perpetualInstrument?.underlying || "BTCUSD";
    const [perpetualData, indexData] = await Promise.all([
      fetchMarkHistory({
        instrument_name: perpetualInstrument.instrument_name,
        resolution,
        from: range.from,
        to: range.to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution,
        from: range.from,
        to: range.to,
      }),
    ]);

    if (reqId !== perpReqId) return;

    data.perpetualMark[resolutionKey] = perpetualData || [];
    data.index[resolutionKey] = indexData || [];

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    if (reqId !== perpReqId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    data.perpetualMark = {};
    data.index = {};
  } finally {
    finishLoad();
  }
}

async function loadFutureMark({ resolutionKey, futureName }) {
  if (!futureName) return;

  const reqId = ++futureReqId;
  const { resolution, range } = getTimestampRange(resolutionKey);
  const indexRange = getIndexRangeOrFallback(resolutionKey, range);

  startLoad();
  ui.error = "";

  try {
    const futureData = await fetchMarkHistory({
      instrument_name: futureName,
      resolution,
      from: indexRange.from,
      to: indexRange.to,
    });

    if (reqId !== futureReqId) return;

    data.futureMark[resolutionKey] = futureData || [];
    const label = RESOLUTION_CONFIG[resolutionKey]?.label || resolutionKey;
    const rows = futureData || [];
    let futureMin = null;
    let futureMax = null;
    for (const row of rows) {
      const ts = row?.ts;
      if (!Number.isFinite(ts)) continue;
      if (futureMin == null || ts < futureMin) futureMin = ts;
      if (futureMax == null || ts > futureMax) futureMax = ts;
    }
    const hasFuture = Number.isFinite(futureMin) && Number.isFinite(futureMax);
    const overlapsIndex =
      hasFuture &&
      !(futureMax < indexRange.from || futureMin > indexRange.to);

    if (!hasFuture || !overlapsIndex) {
      ui.notice = `No ${futureName} data for ${formatUtc(
        indexRange.from,
      )} - ${formatUtc(indexRange.to)} at ${label} resolution.`;
    } else {
      ui.notice = "";
    }
  } catch (e) {
    if (reqId !== futureReqId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    ui.notice = "";
    data.futureMark = {};
  } finally {
    finishLoad();
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  chartRef.value.exportPng({ filename: "cost_of_carry_comparison.png" });
}

onMounted(async () => {
  const allInstruments = await fetchInstruments();

  const perps = allInstruments.filter(
    (i) => i?.type === "perpetual" && i?.underlying === UNDERLYING,
  );
  const futures = allInstruments
    .filter((i) => i?.type === "future" && i?.underlying === UNDERLYING)
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );

  data.instruments = perps;
  data.futureInstruments = futures;

  ui.perpetualInstrumentName = data.instruments[0]?.instrument_name || "";

  if (futures.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const closest = findClosestFuture(futures, nowSeconds);
    ui.futureInstrumentName = closest.instrument_name;
  } else {
    ui.futureInstrumentName = "";
  }

});

watch(
  () => [ui.resolution, ui.perpetualInstrumentName],
  async () => {
    const perpetualInstrument = selectedPerpetual.value;
    if (!perpetualInstrument) return;

    await loadPerpetualAndIndex({
      perpetualInstrument,
      resolutionKey: ui.resolution,
    });
  },
  { immediate: true },
);

watch(
  () => [ui.resolution, ui.futureInstrumentName],
  async () => {
    if (!ui.futureInstrumentName) return;

    await loadFutureMark({
      resolutionKey: ui.resolution,
      futureName: ui.futureInstrumentName,
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Cost of Carry Comparison — Perpetuals vs Futures</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="instrument">Instrument</label>
          <select id="instrument" v-model="ui.perpetualInstrumentName">
            <option
              v-for="i in data.instruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!data.instruments.length"
              :value="ui.perpetualInstrumentName"
            >
              {{ ui.perpetualInstrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="future-instrument">Future</label>
          <select id="future-instrument" v-model="ui.futureInstrumentName">
            <option
              v-for="i in data.futureInstruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!data.futureInstruments.length"
              :value="ui.futureInstrumentName"
            >
              {{ ui.futureInstrumentName }}
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

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !mainSeries.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
      <div v-else-if="ui.notice" class="error">{{ ui.notice }}</div>
    </header>

    <FundingChart
      ref="chartRef"
      :data="mainSeries"
      :basis-data="basisSeries"
      :instrument-name="ui.perpetualInstrumentName"
      :loading="ui.loading"
    />
  </div>
</template>
