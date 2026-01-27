<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import FundingChart from "./components/FundingChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";
import { computeFundingSeries } from "./composables/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const MAIN_POINT_LIMIT = 300;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");

const ui = reactive({
  resolution: "3600",
  instrumentName: "",
  futureInstrumentName: "",
  loading: false,
  error: "",
});
const data = reactive({
  instruments: [],
  instrument: null,
  futureInstruments: [],
  futureInstrument: null,
  mark: {},
  futureMark: {},
  index: {},
});
const chartRef = ref(null);

const mainSeries = computed(() => {
  const mark = data.mark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const intervalSeconds =
    RESOLUTION_CONFIG[ui.resolution]?.interval_seconds ?? Number(ui.resolution);
  const series = computeFundingSeries({
    mark,
    index,
    intervalSeconds,
  });
  const filtered = series.filter(
    (point) => point.date instanceof Date && point.date >= MIN_DATA_DATE,
  );
  return filtered.slice(-MAIN_POINT_LIMIT);
});

const basisSeries = computed(() => {
  const mark = data.futureMark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const series = computeBasisSeries({
    mark,
    index,
    instrument: data.futureInstrument || {},
  });
  const filtered = series.filter(
    (point) => point.date instanceof Date && point.date >= MIN_DATA_DATE,
  );
  return filtered.slice(-MAIN_POINT_LIMIT);
});

async function load() {
  if (!ui.instrumentName) return;

  ui.loading = true;
  ui.error = "";
  data.mark = {};
  data.futureMark = {};
  data.index = {};

  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolution];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolution) ?? 0;
  const timestampRange = {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };

  try {
    const instrument = data.instrument;
    const futureInstrument = data.futureInstrument;
    const indexName =
      instrument?.underlying || futureInstrument?.underlying || "BTCUSD";
    const futureName = ui.futureInstrumentName;
    const [mainMarkResult, mainIndex, futureMarkResult] = await Promise.all([
      fetchMarkHistory({
        instrument_name: ui.instrumentName,
        instrument_type: 'perpetual',
        resolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: indexName,
        resolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      futureName
        ? fetchMarkHistory({
            instrument_name: futureName,
            instrument_type: 'future',
            resolution,
            from: timestampRange.from,
            to: timestampRange.to,
          })
        : Promise.resolve([]),
    ]);

    data.mark[ui.resolution] = mainMarkResult || [];
    data.index[ui.resolution] = mainIndex || [];
    data.futureMark[ui.resolution] = futureMarkResult || [];

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
  const base = ui.instrumentName || "funding-chart";
  const filename = ui.resolution
    ? `${base}-${ui.resolution}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

onMounted(async () => {
  const all_instruments = await fetchInstruments();
  const perps = all_instruments.filter(
    (i) => i?.type === "perpetual" && i?.underlying === "BTCUSD",
  );
  const futures = all_instruments
    .filter((i) => i?.type === "future" && i?.underlying === "BTCUSD")
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );
  const btcPerp =
    perps.find((i) => i.instrument_name === "BTC-PERPETUAL") ||
    all_instruments.find((i) => i?.instrument_name === "BTC-PERPETUAL");
  data.instruments = perps.length ? perps : btcPerp ? [btcPerp] : [];
  data.futureInstruments = futures;
  const defaultInstrument =
    data.instruments.find((i) => i.instrument_name === "BTC-PERPETUAL") ||
    data.instruments[0] ||
    null;
  if (defaultInstrument) {
    data.instrument = defaultInstrument;
    ui.instrumentName = defaultInstrument.instrument_name;
  } else {
    data.instrument = {
      instrument_name: "BTC-PERPETUAL",
      underlying: "BTCUSD",
    };
    ui.instrumentName = "BTC-PERPETUAL";
  }

  if (data.futureInstruments.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const target = nowSeconds + 7 * 24 * 60 * 60;
    const futureCandidates = data.futureInstruments.filter(
      (i) =>
        Number.isFinite(i.expiration_timestamp) &&
        i.expiration_timestamp > nowSeconds,
    );
    const byDistance = (a, b) =>
      Math.abs(a.expiration_timestamp - target) -
      Math.abs(b.expiration_timestamp - target);
    const closest =
      futureCandidates.sort(byDistance)[0] || data.futureInstruments[0];
    data.futureInstrument = closest;
    ui.futureInstrumentName = closest.instrument_name;
  }
});

watch(
  () => [ui.resolution, ui.instrumentName, ui.futureInstrumentName],
  async () => {
    if (!ui.instrumentName) return;
    data.instrument =
      data.instruments.find((i) => i.instrument_name === ui.instrumentName) ||
      (ui.instrumentName === "BTC-PERPETUAL"
        ? { instrument_name: "BTC-PERPETUAL", underlying: "BTCUSD" }
        : null);
    data.futureInstrument =
      data.futureInstruments.find(
        (i) => i.instrument_name === ui.futureInstrumentName,
      ) || null;
    await load();
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
    </header>

    <FundingChart
      ref="chartRef"
      :data="mainSeries"
      :basis-data="basisSeries"
      :instrument-name="ui.instrumentName"
      :loading="ui.loading"
    />
  </div>
</template>
