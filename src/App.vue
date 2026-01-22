<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstrument,
  fetchInstruments,
  fetchMarkHistory,
  findInstrument,
  indexNameFromInstrumentName,
} from "./lib/thalex.js";

const RESOLUTIONS = [
  { label: "1m", value: "1m", seconds: 60, detail: "1m" },
  { label: "5m", value: "5m", seconds: 5 * 60, detail: "1m" },
  { label: "15m", value: "15m", seconds: 15 * 60, detail: "5m" },
  { label: "1h", value: "1h", seconds: 60 * 60, detail: "15m" },
  { label: "1d", value: "1d", seconds: 24 * 60 * 60, detail: "1h" },
];

const POINTS = 500;

const resolution = ref("1h");
const instruments = ref([]);
const instrumentName = ref("");
const chartRef = ref(null);
const range = ref(null);
const data = ref([]);
const detailData = ref([]);
const detailRange = ref(null);
const detailResolution = ref("1h");
const loading = ref(false);
const error = ref("");

const selectedInstrument = computed(() =>
  findInstrument(instruments.value, instrumentName.value),
);

const mainTitle = computed(
  () => `${instrumentName.value || "Instrument"} Basis`,
);

const mainSubtitle = computed(() => {
  const from = range.value?.from ? new Date(range.value.from * 1000) : null;
  const to = range.value?.to ? new Date(range.value.to * 1000) : null;
  if (!from || !to) return "";
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  return `${fmt(from)} — ${fmt(to)}`;
});

const detailTitle = computed(() => "Basis vs Price");
const detailSubtitle = computed(() =>
  detailResolution.value ? `${detailResolution.value} resolution` : "",
);

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
  detailData.value = [];
  detailRange.value = null;

  const resolutionConfig = RESOLUTIONS.find(
    (r) => r.value === resolution.value,
  );

  const now = Math.floor(Date.now() / 1000);
  const seconds = resolutionConfig.seconds ?? 3600;
  const timestampRange = {
    from: now - seconds * POINTS,
    to: now,
  };
  range.value = timestampRange;

  try {
    const { instrument, indexName } = await getInstrumentAndIndexName();

    detailRange.value = null;
    detailResolution.value = resolutionConfig?.detail || "1h";

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
        resolution: detailResolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution: detailResolution.value,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    const [markResult, index] = await p1;
    const [detailMarkResult, detailIndex] = await p2;

    const { data: mark } = markResult;

    data.value = computeBasisSeries({
      mark,
      index,
      instrument,
    });

    detailData.value = computeBasisSeries({
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

function handleDetailBrush(brushRange) {
  detailRange.value = brushRange || null;
}

const filteredDetailData = computed(() => {
  // If no brush is active, show the full high-res dataset
  if (!detailRange.value) {
    return detailData.value;
  }

  const { from, to } = detailRange.value;

  return detailData.value.filter((point) => {
    const ts = point.timestamp;
    return ts >= from && ts <= to;
  });
});

onMounted(async () => {
  const all_instruments = await fetchInstruments();
  const now = Math.floor(Date.now() / 1000);

  const futures = all_instruments.filter(
    (i) => i?.type === "future" && i?.underlying === "BTCUSD",
  );

  const futuresByExpiration = [...futures].sort(
    (a, b) => a.expiration_timestamp - b.expiration_timestamp,
  );

  instruments.value = futuresByExpiration;

  const futuresByCreateTime = [...futures].sort(
    (a, b) =>
      (Number.isFinite(a.create_time_ms) ? a.create_time_ms : Infinity) -
      (Number.isFinite(b.create_time_ms) ? b.create_time_ms : Infinity),
  );

  const initialInstrument = futuresByCreateTime[0] || null;

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
            <option v-for="r in RESOLUTIONS" :key="r.value" :value="r.value">
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
      :detail-data="filteredDetailData"
      :detail-range="detailRange"
      :main-title="mainTitle"
      :main-subtitle="mainSubtitle"
      :detail-title="detailTitle"
      :detail-subtitle="detailSubtitle"
      :instrument-name="instrumentName"
      :range="range"
      :loading="loading"
      @brush="handleDetailBrush"
    />
  </div>
</template>
