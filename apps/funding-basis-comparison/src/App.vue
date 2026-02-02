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
const showRollPnl = ref(false);
const perpetuals = shallowRef([]);
const futures = shallowRef([]);
const displayed = reactive({
  resolutionKey: uiState.selectedResolutionKey,
  perpMark: [],
  futureMark: [],
  index: [],
});
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
  findInstrument(perpetuals.value, uiState.perpetualInstrumentName),
);
const selectedFutureInstrument = computed(() =>
  findInstrument(futures.value, uiState.futureInstrumentName),
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
  const resolutionKey = displayed.resolutionKey;
  const mark = displayed.perpMark || [];
  const index = displayed.index || [];
  const { intervalSeconds } = resolveResolution(resolutionKey);
  const series = buildFundingSeries({
    mark,
    index,
    intervalSeconds,
  });
  return filterSeriesData(series);
});

const basisSeries = computed(() => {
  const mark = displayed.futureMark || [];
  const index = displayed.index || [];
  const series = buildBasisSeries({
    mark,
    index,
    instrument: selectedFutureInstrument.value || {},
  });
  return filterSeriesData(series);
});

const rollSeries = computed(() => {
  const perpMark = displayed.perpMark || [];
  const futureMark = displayed.futureMark || [];
  if (!perpMark.length || !futureMark.length) return [];

  const futureByTs = new Map(futureMark.map((row) => [row.ts, row]));
  const merged = [];
  for (const perpPoint of perpMark) {
    const futurePoint = futureByTs.get(perpPoint.ts);
    if (!futurePoint) continue;
    const spread =
      Number.isFinite(futurePoint.mark_price_close) &&
      Number.isFinite(perpPoint.mark_price_close)
        ? futurePoint.mark_price_close - perpPoint.mark_price_close
        : null;
    if (spread == null) continue;
    merged.push({
      ts: perpPoint.ts,
      date: new Date(perpPoint.ts * 1000),
      basis_close: spread,
    });
  }
  return filterSeriesData(merged);
});

const secondarySeries = computed(() =>
  showRollPnl.value ? rollSeries.value : basisSeries.value,
);

function resolveResolution(resolutionKey) {
  const config = RESOLUTION_CONFIG[resolutionKey];
  const intervalSeconds = config?.interval_seconds ?? Number(resolutionKey) ?? 0;
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
  const previousResolutionKey = displayed.resolutionKey;

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

    displayed.perpMark = mainMarkResult || [];
    displayed.index = mainIndex || [];
    displayed.resolutionKey = resolutionKey;
    if (previousResolutionKey !== resolutionKey) {
      displayed.futureMark = [];
    }

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }

    // make non blocking
    if (uiState.futureInstrumentName) {
      void loadFuture({
        futureInstrument: selectedFutureInstrument.value,
        resolutionKey,
      });
    }
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
    displayed.futureMark = [];
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

    displayed.futureMark = futureMarkResult || [];
  } catch (e) {
    if (requestId !== futureRequestId) return;
    if (!uiState.error) {
      uiState.error = e instanceof Error ? e.message : String(e);
    }
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
    (i) => i?.type === "perpetual" && i?.underlying === DEFAULT_UNDERLYING,
  );
  const futureInstruments = allInstruments
    .filter((i) => i?.type === "future" && i?.underlying === DEFAULT_UNDERLYING)
    .sort(
      (a, b) => (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0),
    );

  // Set available instruments
  const defaultPerp = findInstrument(perps, "BTC-PERPETUAL");
  perpetuals.value = perps;
  futures.value = futureInstruments;

  // Set initial perpetual selection
  uiState.perpetualInstrumentName = defaultPerp?.instrument_name || "";

  // Set initial future selection (closest to 7 days from now)
  if (futureInstruments.length) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const closest = findClosestFuture(futureInstruments, nowSeconds);
    uiState.futureInstrumentName = closest.instrument_name;
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
    if (!uiState.futureInstrumentName || !displayed.resolutionKey) return;
    await loadFuture({
      futureInstrument: selectedFutureInstrument.value,
      resolutionKey: displayed.resolutionKey,
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
          <label for="perpetual-instrument">Perpetual</label>
          <select
            id="perpetual-instrument"
            v-model="uiState.perpetualInstrumentName"
          >
            <option
              v-for="i in perpetuals"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!perpetuals.length"
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
              v-for="i in futures"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option
              v-if="!futures.length"
              :value="uiState.futureInstrumentName"
            >
              {{ uiState.futureInstrumentName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="uiState.selectedResolutionKey">
            <option v-for="key in RESOLUTION_KEYS" :key="key" :value="key">
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

        <div class="modeToggle">
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: !showRollPnl }"
            @click="showRollPnl = false"
          >
            Carry
          </button>
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: showRollPnl }"
            @click="showRollPnl = true"
          >
            Roll
          </button>
        </div>
      </div>

      <div v-if="uiState.error" class="error">{{ uiState.error }}</div>
    </header>

    <FundingChart
      ref="chartRef"
      :data="mainSeries"
      :basis-data="secondarySeries"
      :future-basis-data="basisSeries"
      :instrument-name="uiState.perpetualInstrumentName"
      :loading="uiState.loading"
      :show-roll-pnl="showRollPnl"
    />
  </div>
</template>
