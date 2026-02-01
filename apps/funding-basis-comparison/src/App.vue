<script setup>
import { computed, onMounted, reactive, ref, shallowRef, watch } from "vue";
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

const DEFAULT_UNDERLYING = "BTCUSD";
const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_UNTIL_TARGET_FUTURE = 7;

const ui = reactive({
  resolution: "3600",
  perpetualInstrumentName: "",
  futureInstrumentName: "",
  loading: false,
  error: "",
});
const perpetualInstruments = ref([]);
const futureInstruments = ref([]);
const perpMarkByResolution = shallowRef({});
const futureMarkByResolution = shallowRef({});
const indexByResolution = shallowRef({});
const chartRef = ref(null);
const lastLoadedResolutionKey = ref("3600");
const mainRequestId = ref(0);
const futureRequestId = ref(0);

function findInstrument(instruments, name) {
  return instruments.find((i) => i.instrument_name === name) || null;
}

function findClosestFuture(futures, nowSeconds) {
  if (!futures.length) return null;

  const target = nowSeconds + DAYS_UNTIL_TARGET_FUTURE * SECONDS_PER_DAY;
  const closest = futures.reduce((best, current) => {
    const exp = current?.expiration_timestamp;
    if (!Number.isFinite(exp) || exp <= nowSeconds) return best;
    const dist = Math.abs(exp - target);
    if (!best) return { future: current, dist };
    return dist < best.dist ? { future: current, dist } : best;
  }, null);

  return closest?.future || futures[0];
}

const displayResolutionKey = computed(
  () => lastLoadedResolutionKey.value || ui.resolution,
);
const selectedPerpetualInstrument = computed(() =>
  findInstrument(perpetualInstruments.value, ui.perpetualInstrumentName),
);
const selectedFutureInstrument = computed(() =>
  findInstrument(futureInstruments.value, ui.futureInstrumentName),
);
const resolutionKeys = computed(() => Object.keys(RESOLUTION_CONFIG));

function filterSeriesData(series) {
  const result = [];
  for (const point of series) {
    if (!(point.date instanceof Date)) continue;
    if (point.date < MIN_DATA_DATE) continue;
    result.push(point);
  }
  return result.slice(-MAIN_POINT_LIMIT);
}

const mainSeries = computed(() => {
  const resolutionKey = displayResolutionKey.value;
  const mark = perpMarkByResolution.value[resolutionKey] || [];
  const index = indexByResolution.value[resolutionKey] || [];
  const intervalSeconds =
    RESOLUTION_CONFIG[resolutionKey]?.interval_seconds ?? Number(resolutionKey);
  const series = buildFundingSeries({
    mark,
    index,
    intervalSeconds,
  });
  return filterSeriesData(series);
});

const basisSeries = computed(() => {
  const resolutionKey = displayResolutionKey.value;
  const mark = futureMarkByResolution.value[resolutionKey] || [];
  const index = indexByResolution.value[resolutionKey] || [];
  const series = buildBasisSeries({
    mark,
    index,
    instrument: selectedFutureInstrument.value || {},
  });
  return filterSeriesData(series);
});

function getTimestampRange(resolutionKey) {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[resolutionKey];
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(resolutionKey) ?? 0;
  return {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
    resolution: resolutionConfig?.resolution,
  };
}

async function loadPerpetual({ perpetualInstrument, resolutionKey }) {
  if (!perpetualInstrument) return;
  const requestId = ++mainRequestId.value;

  ui.loading = true;
  ui.error = "";

  const { from, to, resolution } = getTimestampRange(resolutionKey);
  const indexName = perpetualInstrument?.underlying || DEFAULT_UNDERLYING;

  try {
    const [mainMarkResult, mainIndex] = await Promise.all([
      fetchMarkHistory({
        instrument_name: perpetualInstrument.instrument_name,
        resolution,
        from,
        to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution,
        from,
        to,
      }),
    ]);

    if (requestId !== mainRequestId.value) return;

    perpMarkByResolution.value = {
      ...perpMarkByResolution.value,
      [resolutionKey]: mainMarkResult || [],
    };
    indexByResolution.value = {
      ...indexByResolution.value,
      [resolutionKey]: mainIndex || [],
    };
    lastLoadedResolutionKey.value = resolutionKey;

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    if (requestId !== mainRequestId.value) return;
    ui.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (requestId === mainRequestId.value) {
      ui.loading = false;
    }
  }
}

async function loadFuture({ futureInstrument, resolutionKey }) {
  const requestId = ++futureRequestId.value;
  if (!futureInstrument) {
    futureMarkByResolution.value = {
      ...futureMarkByResolution.value,
      [resolutionKey]: [],
    };
    return;
  }

  const { from, to, resolution } = getTimestampRange(resolutionKey);
  const futureName = futureInstrument?.instrument_name || "";

  try {
    const futureMarkResult = futureName
      ? await fetchMarkHistory({
          instrument_name: futureName,
          resolution,
          from,
          to,
        })
      : [];

    if (requestId !== futureRequestId.value) return;

    futureMarkByResolution.value = {
      ...futureMarkByResolution.value,
      [resolutionKey]: futureMarkResult || [],
    };
  } catch (e) {
    if (requestId !== futureRequestId.value) return;
    if (!ui.error) {
      ui.error = e instanceof Error ? e.message : String(e);
    }
  }
}

async function loadSelectedFutureSeries(resolutionKey) {
  if (!ui.futureInstrumentName) return;
  await loadFuture({
    futureInstrument: selectedFutureInstrument.value,
    resolutionKey,
  });
}

function handleSavePng() {
  if (!chartRef.value) return;
  chartRef.value.exportPng({ filename: "cost_of_carry_comparison.png" });
}

onMounted(async () => {
  const allInstruments = await fetchInstruments();

  // Filter perpetuals and futures for BTC
  const perps = allInstruments.filter(
    (i) => i?.type === "perpetual" && i?.underlying === DEFAULT_UNDERLYING,
  );
  const futures = allInstruments
    .filter((i) => i?.type === "future" && i?.underlying === DEFAULT_UNDERLYING)
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );

  // Set available instruments
  const defaultPerp = findInstrument(perps, "BTC-PERPETUAL");
  perpetualInstruments.value = perps;
  futureInstruments.value = futures;

  // Set initial perpetual selection
  ui.perpetualInstrumentName = defaultPerp?.instrument_name || "";

  // Set initial future selection (closest to 7 days from now)
  if (futures.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const closest = findClosestFuture(futures, nowSeconds);
    ui.futureInstrumentName = closest.instrument_name;
  }

});

watch(
  () => [ui.resolution, ui.perpetualInstrumentName],
  async () => {
    if (!ui.perpetualInstrumentName) return;

    const perpetualInstrument = selectedPerpetualInstrument.value;
    if (!perpetualInstrument) return;

    await loadPerpetual({
      perpetualInstrument,
      resolutionKey: ui.resolution,
    });
  },
  { immediate: true },
);

watch(
  () => [ui.resolution, ui.futureInstrumentName],
  async () => {
    await loadSelectedFutureSeries(ui.resolution);
  },
  { immediate: false },
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
          <label for="perpetual-instrument">Perpetual</label>
          <select
            id="perpetual-instrument"
            v-model="ui.perpetualInstrumentName"
          >
            <option
              v-for="i in perpetualInstruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!perpetualInstruments.length"
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
              v-for="i in futureInstruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!futureInstruments.length"
              :value="ui.futureInstrumentName"
            >
              {{ ui.futureInstrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="ui.resolution">
            <option v-for="key in resolutionKeys" :key="key" :value="key">
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
