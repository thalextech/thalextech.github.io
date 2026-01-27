<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "./lib/thalex.js";

const RESOLUTION_CONFIG = {
  "1m": { label: "1m", seconds: 60, detail: "1m" },
  "5m": { label: "5m", seconds: 5 * 60, detail: "1m" },
  "15m": { label: "15m", seconds: 15 * 60, detail: "5m" },
  "1h": { label: "1h", seconds: 60 * 60, detail: "15m" },
  "1d": { label: "1d", seconds: 24 * 60 * 60, detail: "1h" },
};
const MAIN_POINT_LIMIT = 400;

const ui = reactive({
  resolution: "1d",
  instrumentName: "",
  loading: false,
  error: "",
});
const data = reactive({
  instruments: [],
  instrument: null,
  mark: {},
  index: {},
});
const chartRef = ref(null);

const mainSeries = computed(() => {
  const mark = data.mark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const series = computeBasisSeries({
    mark,
    index,
    instrument: data.instrument || {},
  });
  return series.slice(-MAIN_POINT_LIMIT);
});

const detailSeries = computed(() => {
  const resolutionKey = RESOLUTION_CONFIG[ui.resolution].detail;
  const mark = data.mark[resolutionKey] || [];
  const index = data.index[resolutionKey] || [];
  return computeBasisSeries({
    mark,
    index,
    instrument: data.instrument || {},
  });
});

async function load() {
  if (!ui.instrumentName) return;

  ui.loading = true;
  ui.error = "";
  data.mark = {};
  data.index = {};

  const now = Math.floor(Date.now() / 1000);
  const seconds = RESOLUTION_CONFIG[ui.resolution].seconds;
  const timestampRange = {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };

  try {
    const instrument = data.instrument;
    const [mainMarkResult, mainIndex] = await Promise.all([
      fetchMarkHistory({
        instrument_name: ui.instrumentName,
        resolution: ui.resolution,
        from: now - seconds * MAIN_POINT_LIMIT,
        to: now,
      }),
      fetchIndexHistory({
        index_name: instrument?.underlying,
        resolution: ui.resolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    const detailResolution = RESOLUTION_CONFIG[ui.resolution].detail;

    const [detailMarkResult, detailIndex] = await Promise.all([
      fetchMarkHistory({
        instrument_name: ui.instrumentName,
        resolution: detailResolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: instrument?.underlying,
        resolution: detailResolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    data.mark[ui.resolution] = mainMarkResult || [];
    data.index[ui.resolution] = mainIndex || [];
    data.mark[detailResolution] = detailMarkResult || [];
    data.index[detailResolution] = detailIndex || [];

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    ui.error = e instanceof Error ? e.message : String(e);
    data.mark = {};
    data.index = {};
  } finally {
    ui.loading = false;
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = ui.instrumentName || "basis-chart";
  const filename = ui.resolution
    ? `${base}-${ui.resolution}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

onMounted(async () => {
  const all_instruments = await fetchInstruments();
  data.instruments = all_instruments
    .filter((i) => i?.type === "future" && i?.underlying === "BTCUSD")
    .sort((a, b) => a.create_time_ms - b.create_time_ms);
  // longest running expiry is top of list and selected by default
  if (data.instruments.length) {
    data.instrument = data.instruments[0];
    ui.instrumentName = data.instruments[0].instrument_name;
  }
});

watch(
  () => [ui.resolution, ui.instrumentName],
  async () => {
    if (!ui.instrumentName) return;
    data.instrument =
      data.instruments.find((i) => i.instrument_name === ui.instrumentName) ||
      null;
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
          <select id="instrument" v-model="ui.instrumentName">
            <option
              v-for="i in data.instruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option v-if="!data.instruments.length" :value="ui.instrumentName">
              {{ ui.instrumentName }}
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
    </header>

    <BasisChart
      ref="chartRef"
      :data="mainSeries"
      :detail-data="detailSeries"
      :instrument-name="ui.instrumentName"
      :detail-resolution="RESOLUTION_CONFIG[ui.resolution].detail"
      :loading="ui.loading"
    />
  </div>
</template>
