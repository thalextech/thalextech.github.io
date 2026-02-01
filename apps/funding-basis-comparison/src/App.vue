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

const uiState = reactive({
  selectedResolutionKey: "3600",
  perpetualInstrumentName: "",
  futureInstrumentName: "",
  loading: false,
  error: "",
});
const availableInstruments = reactive({
  perpetual: [],
  future: [],
});
const displayedResolutionKey = ref(uiState.selectedResolutionKey);
const displayedPerpMark = shallowRef([]);
const displayedFutureMark = shallowRef([]);
const displayedIndex = shallowRef([]);
const chartRef = ref(null);
let mainRequestId = 0;
let futureRequestId = 0;

function findInstrument(instruments, name) {
  return instruments.find((i) => i.instrument_name === name) || null;
}

function findClosestFuture(futures, nowSeconds) {
  const target = nowSeconds + DAYS_UNTIL_TARGET_FUTURE * SECONDS_PER_DAY;
  return (
    futures
      .filter((future) => future.expiration_timestamp > nowSeconds)
      .sort(
        (a, b) =>
          Math.abs(a.expiration_timestamp - target) -
          Math.abs(b.expiration_timestamp - target),
      )[0] ||
    futures[0] ||
    null
  );
}

const selectedPerpetualInstrument = computed(() =>
  findInstrument(availableInstruments.perpetual, uiState.perpetualInstrumentName),
);
const selectedFutureInstrument = computed(() =>
  findInstrument(availableInstruments.future, uiState.futureInstrumentName),
);
const RESOLUTION_KEYS = Object.keys(RESOLUTION_CONFIG);

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
  const resolutionKey = displayedResolutionKey.value;
  const mark = displayedPerpMark.value || [];
  const index = displayedIndex.value || [];
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
  const mark = displayedFutureMark.value || [];
  const index = displayedIndex.value || [];
  const series = buildBasisSeries({
    mark,
    index,
    instrument: selectedFutureInstrument.value || {},
  });
  return filterSeriesData(series);
});

function resolveResolution(resolutionKey) {
  const config = RESOLUTION_CONFIG[resolutionKey];
  const intervalSeconds =
    config?.interval_seconds ?? Number(resolutionKey) ?? 0;
  return {
    intervalSeconds,
    apiResolution: config?.resolution,
  };
}

function getTimestampRange(resolutionKey) {
  const now = Math.floor(Date.now() / 1000);
  const { intervalSeconds, apiResolution } = resolveResolution(resolutionKey);
  return {
    from: now - intervalSeconds * MAIN_POINT_LIMIT,
    to: now,
    resolution: apiResolution,
  };
}

async function loadPerpetual({ perpetualInstrument, resolutionKey }) {
  if (!perpetualInstrument) return;
  const requestId = ++mainRequestId;
  const previousResolutionKey = displayedResolutionKey.value;

  uiState.loading = true;
  uiState.error = "";

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

    if (requestId !== mainRequestId) return;

    displayedPerpMark.value = mainMarkResult || [];
    displayedIndex.value = mainIndex || [];
    displayedResolutionKey.value = resolutionKey;
    if (previousResolutionKey !== resolutionKey) {
      displayedFutureMark.value = [];
    }

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }

    // make non blocking
    void loadSelectedFutureSeries(resolutionKey);
  } catch (e) {
    if (requestId !== mainRequestId) return;
    uiState.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (requestId === mainRequestId) {
      uiState.loading = false;
    }
  }
}

async function loadFuture({ futureInstrument, resolutionKey }) {
  const requestId = ++futureRequestId;
  if (!futureInstrument) {
    displayedFutureMark.value = [];
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

    if (requestId !== futureRequestId) return;

    displayedFutureMark.value = futureMarkResult || [];
  } catch (e) {
    if (requestId !== futureRequestId) return;
    if (!uiState.error) {
      uiState.error = e instanceof Error ? e.message : String(e);
    }
  }
}

async function loadSelectedFutureSeries(resolutionKey) {
  if (!resolutionKey || !uiState.futureInstrumentName) return;
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
  const futureInstruments = allInstruments
    .filter((i) => i?.type === "future" && i?.underlying === DEFAULT_UNDERLYING)
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );

  // Set available instruments
  const defaultPerp = findInstrument(perps, "BTC-PERPETUAL");
  availableInstruments.perpetual = perps;
  availableInstruments.future = futures;

  // Set initial perpetual selection
  uiState.perpetualInstrumentName = defaultPerp?.instrument_name || "";

  // Set initial future selection (closest to 7 days from now)
  if (futureInstruments.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const closest = findClosestFuture(futures, nowSeconds);
    ui.futureInstrumentName = closest.instrument_name;
  }
});

watch(
  () => [uiState.selectedResolutionKey, uiState.perpetualInstrumentName],
  async () => {
    if (!uiState.perpetualInstrumentName) return;

    const perpetualInstrument = selectedPerpetualInstrument.value;
    if (!perpetualInstrument) return;

    await loadPerpetual({
      perpetualInstrument,
      resolutionKey: uiState.selectedResolutionKey,
    });
  },
  { immediate: true },
  { immediate: true },
);

watch(
  () => uiState.futureInstrumentName,
  async () => {
    if (uiState.loading) return;
    await loadSelectedFutureSeries(displayedResolutionKey.value);
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
            v-model="uiState.perpetualInstrumentName"
          >
            <option
              v-for="i in availableInstruments.perpetual"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!availableInstruments.perpetual.length"
              :value="uiState.perpetualInstrumentName"
            >
              {{ uiState.perpetualInstrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="future-instrument">Future</label>
          <select id="future-instrument" v-model="uiState.futureInstrumentName">
            <option
              v-for="i in availableInstruments.future"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!availableInstruments.future.length"
              :value="uiState.futureInstrumentName"
            >
              {{ uiState.futureInstrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="uiState.selectedResolutionKey">
            <option v-for="key in resolutionKeys" :key="key" :value="key">
              {{ RESOLUTION_CONFIG[key].label }}
            </option>
          </select>
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="uiState.loading || !mainSeries.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="uiState.error" class="error">{{ uiState.error }}</div>
    </header>

    <FundingChart
      ref="chartRef"
      :data="mainSeries"
      :basis-data="basisSeries"
      :instrument-name="uiState.perpetualInstrumentName"
      :loading="uiState.loading"
    />
  </div>
</template>
