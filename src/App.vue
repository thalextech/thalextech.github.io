<script setup>
import { computed, onMounted, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstrument,
  fetchInstruments,
  fetchMarkHistory,
} from "./lib/thalex.js";

const RESOLUTIONS = {
  "1m": { label: "1m", seconds: 60, detail: "1m" },
  "5m": { label: "5m", seconds: 5 * 60, detail: "1m" },
  "15m": { label: "15m", seconds: 15 * 60, detail: "5m" },
  "1h": { label: "1h", seconds: 60 * 60, detail: "15m" },
  "1d": { label: "1d", seconds: 24 * 60 * 60, detail: "1h" },
};
const MAIN_POINT_LIMIT = 400;

// UI inputs & states
const resolution = ref("1d");
const instruments = ref([]);
const instrumentName = ref("");
const chartRef = ref(null);
const data = ref([]);
const scatterData = ref([]);
const detailRange = ref(null);
const loading = ref(false);
const error = ref("");

const resolutionConfig = computed(
  () => RESOLUTIONS[resolution.value] || RESOLUTIONS["1h"],
);
const scatterResolution = computed(() => resolutionConfig.value.detail || "1h");

function makeTimestampRange({ seconds, points }) {
  const now = Math.floor(Date.now() / 1000);
  const safeSeconds = Number.isFinite(seconds) ? seconds : 3600;
  const safePoints = Number.isFinite(points) ? points : MAIN_POINT_LIMIT;
  return {
    from: now - safeSeconds * safePoints,
    to: now,
  };
}

async function fetchSeries({ instrument, indexName, resolutionKey, range }) {
  const [markResult, index] = await Promise.all([
    fetchMarkHistory({
      instrument_name: instrumentName.value,
      resolution: resolutionKey,
      from: range.from,
      to: range.to,
    }),
    fetchIndexHistory({
      index_name: indexName,
      resolution: resolutionKey,
      from: range.from,
      to: range.to,
    }),
  ]);

  return computeBasisSeries({
    mark: markResult?.data || [],
    index: index || [],
    instrument,
  });
}

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];
  scatterData.value = [];
  detailRange.value = null;

  const mainRange = makeTimestampRange({
    seconds: resolutionConfig.value.seconds,
    points: MAIN_POINT_LIMIT,
  });

  try {
    const instrument = await fetchInstrument(instrumentName.value);
    const indexName = instrument?.underlying;

    const [mainSeries, detailSeries] = await Promise.all([
      fetchSeries({
        instrument,
        indexName,
        resolutionKey: resolution.value,
        range: mainRange,
      }),
      fetchSeries({
        instrument,
        indexName,
        resolutionKey: scatterResolution.value,
        range: mainRange,
      }),
    ]);

    data.value = mainSeries.slice(-MAIN_POINT_LIMIT);
    scatterData.value = detailSeries;

    if (!data.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = [];
    scatterData.value = [];
  } finally {
    loading.value = false;
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = instrumentName.value || "basis-chart";
  const filename = resolution.value
    ? `${base}-${resolution.value}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

watch(
  resolution,
  () => {
    detailRange.value = null;
    chartRef.value?.clearBrush?.();
  },
  { immediate: false },
);

onMounted(async () => {
  const all = await fetchInstruments();

  instruments.value = all
    .filter((i) => i?.type === "future" && i?.underlying === "BTCUSD")
    .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

  if (!instrumentName.value && instruments.value.length) {
    const oldest =
      [...instruments.value].sort(
        (a, b) =>
          (Number.isFinite(a.create_time_ms) ? a.create_time_ms : Infinity) -
          (Number.isFinite(b.create_time_ms) ? b.create_time_ms : Infinity),
      )[0] || null;
    instrumentName.value = oldest?.instrument_name;
  }
});

watch(
  () => [resolution.value, instrumentName.value],
  async () => {
    if (!instrumentName.value) return;
    await load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Future basis - thalex</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="instrument">Instrument</label>
          <select id="instrument" v-model="instrumentName">
            <option
              v-for="i in instruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option v-if="!instruments.length" :value="instrumentName">
              {{ instrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="resolution">
            <option
              v-for="key in Object.keys(RESOLUTIONS)"
              :key="key"
              :value="key"
            >
              {{ RESOLUTIONS[key].label }}
            </option>
          </select>
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="loading || !data.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </header>

    <BasisChart
      ref="chartRef"
      :data="data"
      :detail-data="scatterData"
      v-model:detailRange="detailRange"
      :instrument-name="instrumentName"
      :detail-resolution="scatterResolution"
      :loading="loading"
    />
  </div>
</template>
