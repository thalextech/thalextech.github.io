<script setup>
import { computed, onMounted, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstrument,
  fetchInstruments,
  fetchMarkHistory,
  indexNameFromInstrumentName,
} from "./lib/thalex.js";

const RESOLUTIONS = [
  { label: "1m", value: "1m", seconds: 60 },
  { label: "5m", value: "5m", seconds: 5 * 60 },
  { label: "15m", value: "15m", seconds: 15 * 60 },
  { label: "1h", value: "1h", seconds: 60 * 60 },
  { label: "1d", value: "1d", seconds: 24 * 60 * 60 },
];

const POINTS = 500;

const resolution = ref("1h");
const instruments = ref([]);
const instrumentName = ref("");
const chartRef = ref(null);

const availableResolutions = computed(() => {
  const MIN_POINTS_NEEDED_FOR_RESOLUTION = 100;
  const selectedInstrument = instruments.value.find(
    (i) => i.instrument_name === instrumentName.value,
  );
  if (!selectedInstrument) {
    return RESOLUTIONS;
  }
  const createTimeMs = Number.isFinite(selectedInstrument?.create_time_ms)
    ? selectedInstrument.create_time_ms
    : 0;
  const ageMs = Math.max(0, Date.now() - createTimeMs);
  const allowed = RESOLUTIONS.filter((r) => {
    const requirementMs = r.seconds * MIN_POINTS_NEEDED_FOR_RESOLUTION * 1000;
    return ageMs >= requirementMs;
  });
  return allowed.length ? allowed : RESOLUTIONS;
});

const range = ref(null);
const data = ref([]);
const detailData = ref([]);
const detailRange = ref(null);
const detailResolution = ref("1h");
const loading = ref(false);
const error = ref("");

function computeRange() {
  const now = Math.floor(Date.now() / 1000);
  const seconds =
    RESOLUTIONS.find((r) => r.value === resolution.value)?.seconds ?? 3600;
  return {
    from: now - seconds * POINTS,
    to: now,
    resolution: resolution.value,
  };
}

function getIndexName(instrument) {
  return (
    instrument?.underlying || indexNameFromInstrumentName(instrumentName.value)
  );
}

function pickDetailResolution(baseResolution = resolution.value) {
  const allowed = availableResolutions.value.length
    ? availableResolutions.value.map((r) => r.value)
    : RESOLUTIONS.map((r) => r.value);
  const baseIndex = RESOLUTIONS.findIndex((r) => r.value === baseResolution);
  if (baseIndex <= 0) {
    return baseResolution;
  }
  const candidate = RESOLUTIONS[baseIndex - 1]?.value;
  if (candidate && allowed.includes(candidate)) {
    return candidate;
  }
  return baseResolution;
}

async function getInstrumentAndIndexName() {
  const instrument = await fetchInstrument(instrumentName.value);
  return { instrument, indexName: getIndexName(instrument) };
}

async function fetchMarkIndex({ indexName, resolutionValue, range }) {
  const [markResult, index] = await Promise.all([
    fetchMarkHistory({
      instrument_name: instrumentName.value,
      resolution: resolutionValue,
      from: range.from,
      to: range.to,
    }),
    fetchIndexHistory({
      index_name: indexName,
      resolution: resolutionValue,
      from: range.from,
      to: range.to,
    }),
  ]);
  return { markResult, index };
}

const toBasisSeries = (mark, index, instrument) =>
  computeBasisSeries({
    mark,
    index,
    instrument,
    instrument_name: instrumentName.value,
  });

async function loadDetail(range) {
  if (!instrumentName.value || !range) return;
  const { instrument, indexName } = await getInstrumentAndIndexName();
  const detailResolutionValue = pickDetailResolution(resolution.value);
  detailResolution.value = detailResolutionValue;

  const { markResult: detailMarkResult, index: detailIndex } =
    await fetchMarkIndex({
      indexName,
      resolutionValue: detailResolutionValue,
      range,
    });

  detailData.value = toBasisSeries(
    detailMarkResult?.data || [],
    detailIndex || [],
    instrument,
  );
}

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];
  detailData.value = [];
  detailRange.value = null;

  const nextRange = computeRange();
  range.value = nextRange;

  try {
    const { instrument, indexName } = await getInstrumentAndIndexName();

    detailRange.value = null;
    const detailResolutionValue = pickDetailResolution(resolution.value);
    detailResolution.value = detailResolutionValue;
    const [{ markResult, index }, detail] = await Promise.all([
      fetchMarkIndex({
        indexName,
        resolutionValue: resolution.value,
        range: nextRange,
      }),
      fetchMarkIndex({
        indexName,
        resolutionValue: detailResolutionValue,
        range: nextRange,
      }),
    ]);
    const { markResult: detailMarkResult, index: detailIndex } = detail;

    const { instrument_type, data: mark } = markResult;

    if (instrument_type !== "future") {
      throw new Error(
        `Instrument type is '${instrument_type}'. Pick a future instrument.`,
      );
    }

    data.value = toBasisSeries(mark, index, instrument);
    detailData.value = toBasisSeries(
      detailMarkResult?.data || [],
      detailIndex || [],
      instrument,
    );

    if (!data.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = [];
    detailData.value = [];
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

async function handleDetailBrush(brushRange) {
  const nextRange = brushRange || range.value;
  detailRange.value = brushRange || null;
  if (!nextRange) return;
  try {
    await loadDetail(nextRange);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    detailData.value = [];
  }
}

onMounted(async () => {
  const list = await fetchInstruments();
  const now = Math.floor(Date.now() / 1000);

  const filtered = list.filter(
    (i) => i?.type === "future" && i?.underlying === "BTCUSD",
  );

  const prepared = [...filtered].sort(
    (a, b) => a.expiration_timestamp - b.expiration_timestamp,
  );

  instruments.value = prepared;

  const getCreateTimeMs = (instrument) =>
    Number.isFinite(instrument?.create_time_ms)
      ? instrument.create_time_ms
      : Number.POSITIVE_INFINITY;

  const earliestByCreate = prepared.reduce((best, candidate) => {
    if (!best) return candidate;
    return getCreateTimeMs(candidate) < getCreateTimeMs(best)
      ? candidate
      : best;
  }, null);

  const active = prepared.find((i) => i.expiration_timestamp > now);

  const initialInstrument = earliestByCreate || active || prepared[0] || null;

  instrumentName.value = initialInstrument?.instrument_name;
  resolution.value = "1d";
});

watch(
  () => [resolution.value, instrumentName.value],
  async () => {
    if (!instrumentName.value) return;
    await load();
  },
  { immediate: true },
);

watch(() => availableResolutions.value, { immediate: true });
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
              v-for="r in availableResolutions"
              :key="r.value"
              :value="r.value"
            >
              {{ r.label }}
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
      :detail-data="detailData"
      :detail-range="detailRange"
      :detail-resolution="detailResolution"
      :instrument-name="instrumentName"
      :range="range"
      :loading="loading"
      @brush="handleDetailBrush"
    />
  </div>
</template>
