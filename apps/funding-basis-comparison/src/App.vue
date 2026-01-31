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

const DEFAULT_INSTRUMENT = "BTC-PERPETUAL";
const DEFAULT_UNDERLYING = "BTCUSD";
const INSTRUMENT_TYPE = {
  PERPETUAL: "perpetual",
  FUTURE: "future",
};
const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_UNTIL_TARGET_FUTURE = 7;

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

function findInstrument(instruments, name, fallback = null) {
  return (
    instruments.find((i) => i.instrument_name === name) ||
    (name === DEFAULT_INSTRUMENT
      ? { instrument_name: DEFAULT_INSTRUMENT, underlying: DEFAULT_UNDERLYING }
      : fallback)
  );
}

function findDefaultPerpetual(instruments, allInstruments) {
  const btcPerp = instruments.find(
    (i) => i.instrument_name === DEFAULT_INSTRUMENT,
  );
  if (btcPerp) return btcPerp;

  // Fallback: search in all instruments
  const fromAll = allInstruments.find(
    (i) => i?.instrument_name === DEFAULT_INSTRUMENT,
  );
  if (fromAll) return fromAll;

  // Last resort: create synthetic default
  return {
    instrument_name: DEFAULT_INSTRUMENT,
    underlying: DEFAULT_UNDERLYING,
  };
}

function findClosestFuture(futures, nowSeconds) {
  if (!futures.length) return null;

  const target = nowSeconds + DAYS_UNTIL_TARGET_FUTURE * SECONDS_PER_DAY;
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
  const mark = data.mark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const intervalSeconds =
    RESOLUTION_CONFIG[ui.resolution]?.interval_seconds ?? Number(ui.resolution);
  const series = buildFundingSeries({
    mark,
    index,
    intervalSeconds,
  });
  const result = [];
  for (const point of series) {
    if (!(point.date instanceof Date)) continue;
    if (point.date < MIN_DATA_DATE) continue;
    result.push(point);
  }
  return result.slice(-MAIN_POINT_LIMIT);
});

const basisSeries = computed(() => {
  const mark = data.futureMark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  const series = buildBasisSeries({
    mark,
    index,
    instrument: data.futureInstrument || {},
  });
  const result = [];
  for (const point of series) {
    if (!(point.date instanceof Date)) continue;
    if (point.date < MIN_DATA_DATE) continue;
    result.push(point);
  }
  return result.slice(-MAIN_POINT_LIMIT);
});

async function load({ instrument, futureInstrument, resolutionKey }) {
  if (!instrument) return;

  ui.loading = true;
  ui.error = "";

  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(resolutionKey) ?? 0;
  const timestampRange = {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };

  try {
    const indexName =
      instrument?.underlying || futureInstrument?.underlying || "BTCUSD";
    const futureName = futureInstrument?.instrument_name || "";
    const [mainMarkResult, mainIndex, futureMarkResult] = await Promise.all([
      fetchMarkHistory({
        instrument_name: instrument.instrument_name,
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
            resolution,
            from: timestampRange.from,
            to: timestampRange.to,
          })
        : Promise.resolve([]),
    ]);

    data.mark[resolutionKey] = mainMarkResult || [];
    data.index[resolutionKey] = mainIndex || [];
    data.futureMark[resolutionKey] = futureMarkResult || [];

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
  chartRef.value.exportPng({ filename: "cost_of_carry_comparison.png" });
}

onMounted(async () => {
  const allInstruments = await fetchInstruments();

  // Filter perpetuals and futures for BTC
  const perps = allInstruments.filter(
    (i) =>
      i?.type === INSTRUMENT_TYPE.PERPETUAL &&
      i?.underlying === DEFAULT_UNDERLYING,
  );
  const futures = allInstruments
    .filter(
      (i) =>
        i?.type === INSTRUMENT_TYPE.FUTURE &&
        i?.underlying === DEFAULT_UNDERLYING,
    )
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );

  // Set available instruments
  const defaultPerp = findDefaultPerpetual(perps, allInstruments);
  data.instruments = perps.length ? perps : [defaultPerp];
  data.futureInstruments = futures;

  // Set initial perpetual selection
  data.instrument = data.instruments[0] || defaultPerp;
  ui.instrumentName = data.instrument.instrument_name;

  // Set initial future selection (closest to 7 days from now)
  if (futures.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const closest = findClosestFuture(futures, nowSeconds);
    data.futureInstrument = closest;
    ui.futureInstrumentName = closest.instrument_name;
  }

  const instrument = data.instrument;
  const futureInstrument = data.futureInstrument;
  if (instrument) {
    await load({
      instrument,
      futureInstrument,
      resolutionKey: ui.resolution,
    });
  }
});

watch(
  () => [ui.resolution, ui.instrumentName, ui.futureInstrumentName],
  async () => {
    if (!ui.instrumentName) return;

    data.instrument = findInstrument(data.instruments, ui.instrumentName, null);
    data.futureInstrument = findInstrument(
      data.futureInstruments,
      ui.futureInstrumentName,
      null,
    );

    await load({
      instrument: data.instrument,
      futureInstrument: data.futureInstrument,
      resolutionKey: ui.resolution,
    });
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
