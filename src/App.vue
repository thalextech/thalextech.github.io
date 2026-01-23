<script setup>
import { onMounted, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstrument,
  fetchInstruments,
  fetchMarkHistory,
  indexNameFromInstrumentName,
} from "./lib/thalex.js";

const RESOLUTIONS = {
  "1m": { label: "1m", seconds: 60, detail: "1m" },
  "5m": { label: "5m", seconds: 5 * 60, detail: "1m" },
  "15m": { label: "15m", seconds: 15 * 60, detail: "5m" },
  "1h": { label: "1h", seconds: 60 * 60, detail: "15m" },
  "1d": { label: "1d", seconds: 24 * 60 * 60, detail: "1h" },
};
const RESOLUTION_KEYS = ["1m", "5m", "15m", "1h", "1d"];

const MAIN_POINT_LIMIT = 400;

const resolution = ref("1d");
const scatterResolution = ref("");
const instruments = ref([]);
const instrumentName = ref("");
const chartRef = ref(null);
const data = ref([]);
const scatterData = ref([]);
const detailRange = ref(null);
const loading = ref(false);
const error = ref("");

function getIndexName(instrument) {
  return (
    instrument?.underlying || indexNameFromInstrumentName(instrumentName.value)
  );
}

async function getInstrumentAndIndexName() {
  const instrument = await fetchInstrument(instrumentName.value);
  return { instrument, indexName: getIndexName(instrument) };
}

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];
  scatterData.value = [];
  detailRange.value = null;

  const resolutionConfig = RESOLUTIONS[resolution.value];

  const now = Math.floor(Date.now() / 1000);
  const seconds = resolutionConfig?.seconds ?? 3600;
  const timestampRange = {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };
  try {
    const { instrument, indexName } = await getInstrumentAndIndexName();

    detailRange.value = null;
    scatterResolution.value = resolutionConfig?.detail || "1h";

    const p1 = Promise.all([
      fetchMarkHistory({
        instrument_name: instrumentName.value,
        resolution: resolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution: resolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    const p2 = Promise.all([
      fetchMarkHistory({
        instrument_name: instrumentName.value,
        resolution: scatterResolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution: scatterResolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    const [markResult, index] = await p1;
    const [detailMarkResult, detailIndex] = await p2;

    const { data: mark } = markResult;

    const mainSeries = computeBasisSeries({
      mark,
      index,
      instrument,
    });
    data.value = mainSeries.slice(-MAIN_POINT_LIMIT);

    scatterData.value = computeBasisSeries({
      mark: detailMarkResult?.data || [],
      index: detailIndex || [],
      instrument,
    });

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

function handleDetailBrush(brushRange) {
  detailRange.value = brushRange || null;
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
            <option v-for="key in RESOLUTION_KEYS" :key="key" :value="key">
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
      :detail-range="detailRange"
      :instrument-name="instrumentName"
      :detail-resolution="scatterResolution"
      :loading="loading"
      @brush="handleDetailBrush"
    />
  </div>
</template>
