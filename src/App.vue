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
const futureInstruments = ref([]);
const instrumentName = ref("");

const range = ref(null);
const data = ref([]);
const loading = ref(false);
const error = ref("");

const resolutionSeconds = computed(() => {
  return RESOLUTIONS.find((r) => r.value === resolution.value)?.seconds ?? 3600;
});

function computeRange() {
  const now = Math.floor(Date.now() / 1000);
  const seconds = resolutionSeconds.value;
  return {
    from: now - seconds * POINTS,
    to: now,
    points: POINTS,
    resolution: resolution.value,
  };
}

const rangeText = computed(() => {
  if (!range.value) return "";
  const from = new Date(range.value.from * 1000).toISOString();
  const to = new Date(range.value.to * 1000).toISOString();
  return `${from} → ${to}`;
});

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];

  const nextRange = computeRange();
  range.value = nextRange;

  try {
    const instrument = await fetchInstrument(instrumentName.value);

    const index_name =
      instrument?.underlying ||
      indexNameFromInstrumentName(instrumentName.value);

    const [{ instrument_type, data: mark }, index] = await Promise.all([
      fetchMarkHistory({
        instrument_name: instrumentName.value,
        resolution: resolution.value,
        from: nextRange.from,
        to: nextRange.to,
      }),
      fetchIndexHistory({
        index_name,
        resolution: resolution.value,
        from: nextRange.from,
        to: nextRange.to,
      }),
    ]);

    if (instrument_type !== "future") {
      throw new Error(
        `Instrument type is '${instrument_type}'. Pick a future instrument.`,
      );
    }

    data.value = computeBasisSeries({
      mark,
      index,
      instrument,
      instrument_name: instrumentName.value,
    });

    if (!data.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    const list = await fetchInstruments();
    const now = Math.floor(Date.now() / 1000);

    futureInstruments.value = list
      .filter((i) => i?.type === "future" && i?.underlying === "BTCUSD")
      .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

    const active = futureInstruments.value.find(
      (i) => i.expiration_timestamp > now,
    );

    instrumentName.value =
      active?.instrument_name ||
      futureInstruments.value[0]?.instrument_name ||
      "BTC-30JAN26";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    instrumentName.value = "BTC-30JAN26";
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
        <h1>Mark Future Basis (Thalex)</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="resolution">
            <option v-for="r in RESOLUTIONS" :key="r.value" :value="r.value">
              {{ r.label }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="instrument">Instrument</label>
          <select id="instrument" v-model="instrumentName">
            <option
              v-for="i in futureInstruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option v-if="!futureInstruments.length" :value="instrumentName">
              {{ instrumentName || "BTC-26DEC25" }}
            </option>
          </select>
        </div>
      </div>

      <div class="meta">
        <div>Range: {{ rangeText }}</div>
        <div v-if="data.length">Points plotted: {{ data.length }}</div>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </header>

    <BasisChart
      :data="data"
      :instrument-name="instrumentName"
      :range="range"
      :loading="loading"
    />
  </div>
</template>
