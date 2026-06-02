<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DollarBarChart from "./components/DollarBarChart.vue";
import { fetchBitfinexCandles } from "./lib/bitfinex.js";
import {
  buildDollarBars,
  getDefaultDollarBinSize,
} from "./lib/volumeBars.js";

const SECONDS_PER_DAY = 24 * 60 * 60;
const LOOKBACK_DEBOUNCE_MS = 550;
const MAX_LOOKBACK_DAYS = 3_650;
const MIN_SOURCE_CANDLES_PER_DOLLAR_BAR = 100;

const SYMBOL_OPTIONS = [
  { value: "BTCUSD", label: "BTCUSD" },
  { value: "ETHUSD", label: "ETHUSD" },
];

const CANDLE_TIMEFRAMES = [
  { value: "1m", label: "1m", seconds: 60 },
  { value: "5m", label: "5m", seconds: 5 * 60 },
  { value: "15m", label: "15m", seconds: 15 * 60 },
  { value: "30m", label: "30m", seconds: 30 * 60 },
  { value: "1h", label: "1h", seconds: 60 * 60 },
  { value: "3h", label: "3h", seconds: 3 * 60 * 60 },
  { value: "6h", label: "6h", seconds: 6 * 60 * 60 },
  { value: "12h", label: "12h", seconds: 12 * 60 * 60 },
  { value: "1D", label: "1D", seconds: SECONDS_PER_DAY },
];

const ui = reactive({
  symbol: "BTCUSD",
  lookbackDays: 30,
  targetBars: 32,
  loading: false,
  loadingMessage: "",
  error: "",
});

const candles = ref([]);
const chartRef = ref(null);
let loadRequestId = 0;
let lookbackDebounceTimer = null;

const safeLookbackDays = computed(() => {
  const value = Math.floor(Number(ui.lookbackDays));
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(MAX_LOOKBACK_DAYS, value));
});

const safeTargetBars = computed(() => {
  const value = Math.floor(Number(ui.targetBars));
  if (!Number.isFinite(value)) return 32;
  return Math.max(4, Math.min(160, value));
});

function selectCandleTimeframe({ lookbackDays, targetBars }) {
  const lookbackSeconds = Math.max(1, Number(lookbackDays)) * SECONDS_PER_DAY;
  const bars = Math.max(1, Number(targetBars));
  const maxResolutionSeconds =
    lookbackSeconds / (bars * MIN_SOURCE_CANDLES_PER_DOLLAR_BAR);

  return (
    [...CANDLE_TIMEFRAMES]
      .sort((a, b) => b.seconds - a.seconds)
      .find((timeframe) => timeframe.seconds < maxResolutionSeconds) ||
    CANDLE_TIMEFRAMES[0]
  );
}

const selectedTimeframe = computed(() =>
  selectCandleTimeframe({
    lookbackDays: safeLookbackDays.value,
    targetBars: safeTargetBars.value,
  }),
);

const estimatedSourceCandleCount = computed(() =>
  Math.ceil(
    (safeLookbackDays.value * SECONDS_PER_DAY) /
      Math.max(1, selectedTimeframe.value.seconds),
  ),
);

const estimatedSourceCandlesPerDollarBar = computed(
  () => estimatedSourceCandleCount.value / safeTargetBars.value,
);

const sourceMetaText = computed(() => {
  const ratio = estimatedSourceCandlesPerDollarBar.value;
  const ratioLabel = Number.isFinite(ratio) ? ratio.toFixed(0) : "0";
  const prefix =
    ratio > MIN_SOURCE_CANDLES_PER_DOLLAR_BAR ? "source" : "best source";
  return `${prefix} ${selectedTimeframe.value.label}, ~${ratioLabel} OHLC/bar`;
});

const dollarBinSize = computed(() =>
  getDefaultDollarBinSize(candles.value, safeTargetBars.value),
);

const dollarBars = computed(() =>
  buildDollarBars(candles.value, dollarBinSize.value),
);

const formatUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const formatDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const chartTitle = computed(() => {
  const size = dollarBinSize.value;
  const sizeLabel = Number.isFinite(size) && size > 0 ? formatUsd.format(size) : "";
  return `${ui.symbol} Bitfinex ${sizeLabel} Bars`;
});

const metaText = computed(() => {
  if (!candles.value.length || !dollarBars.value.length) return "";
  const first = candles.value[0].date;
  const last = candles.value[candles.value.length - 1].date;
  return `${candles.value.length.toLocaleString()} OHLC candles, ${dollarBars.value.length.toLocaleString()} dollar bars, ${sourceMetaText.value}, ${formatDateTime.format(first)} - ${formatDateTime.format(last)} UTC`;
});

const statusText = computed(() => {
  if (ui.loading) return ui.loadingMessage || "Loading Bitfinex candles...";
  return metaText.value;
});

async function load() {
  const requestId = ++loadRequestId;
  ui.loading = true;
  const timeframe = selectedTimeframe.value.value;
  const timeframeLabel = selectedTimeframe.value.label;
  ui.loadingMessage = `Loading ${ui.symbol} ${timeframeLabel} candles (${sourceMetaText.value})...`;
  ui.error = "";

  const now = Math.floor(Date.now() / 1000);
  const to = now;
  const from = now - safeLookbackDays.value * SECONDS_PER_DAY;

  try {
    const rows = await fetchBitfinexCandles({
      symbol: ui.symbol,
      timeframe,
      from,
      to,
      isCanceled: () => requestId !== loadRequestId,
      onProgress: ({ page, rows, lastDate }) => {
        if (requestId !== loadRequestId) return;
        const suffix =
          lastDate instanceof Date && !Number.isNaN(lastDate.getTime())
            ? ` through ${formatDateTime.format(lastDate)} UTC`
            : "";
        ui.loadingMessage = `Loaded page ${page}, ${rows.toLocaleString()} ${timeframeLabel} candles${suffix}...`;
      },
      onRateLimit: () => {
        if (requestId !== loadRequestId) return;
        ui.loadingMessage = "Rate limited by Bitfinex; waiting before retry...";
      },
    });

    if (requestId !== loadRequestId) return;
    if (!rows.length) {
      throw new Error("No Bitfinex OHLC candles returned for this range.");
    }
    candles.value = rows;
  } catch (error) {
    if (requestId !== loadRequestId) return;
    candles.value = [];
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
      ui.loadingMessage = "";
    }
  }
}

function clearLookbackDebounce() {
  if (!lookbackDebounceTimer) return;
  window.clearTimeout(lookbackDebounceTimer);
  lookbackDebounceTimer = null;
}

function loadImmediately() {
  clearLookbackDebounce();
  load();
}

function loadAfterLookbackDebounce() {
  clearLookbackDebounce();
  lookbackDebounceTimer = window.setTimeout(() => {
    lookbackDebounceTimer = null;
    load();
  }, LOOKBACK_DEBOUNCE_MS);
}

function handleSavePng() {
  chartRef.value?.exportPng({
    filename: `${ui.symbol.toLowerCase()}-bitfinex-dollar-bars.png`,
  });
}

onMounted(load);

watch(
  () => ui.symbol,
  loadImmediately,
);

watch(
  () => safeTargetBars.value,
  (targetBars, previousTargetBars) => {
    const previousTimeframe = selectCandleTimeframe({
      lookbackDays: safeLookbackDays.value,
      targetBars: previousTargetBars,
    });
    if (selectedTimeframe.value.value !== previousTimeframe.value) {
      loadImmediately();
    }
  },
);

watch(
  () => safeLookbackDays.value,
  loadAfterLookbackDebounce,
);

onBeforeUnmount(clearLookbackDebounce);
</script>

<template>
  <div class="app dollarBarsApp">
    <header class="header">
      <div class="titleRow">
        <h1>Dollar bars - bitfinex</h1>
        <button
          type="button"
          class="saveButton"
          :disabled="ui.loading || !dollarBars.length"
          @click="handleSavePng"
        >
          Save PNG
        </button>
      </div>

      <div class="controls">
        <div class="field">
          <label for="symbol">Symbol</label>
          <select id="symbol" v-model="ui.symbol" :disabled="ui.loading">
            <option
              v-for="option in SYMBOL_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="lookback">Days</label>
          <input
            id="lookback"
            v-model.number="ui.lookbackDays"
            type="number"
            min="1"
            :max="MAX_LOOKBACK_DAYS"
            step="1"
            :disabled="ui.loading"
          />
        </div>

        <div class="field">
          <label for="targetBars">Bars</label>
          <input
            id="targetBars"
            v-model.number="ui.targetBars"
            type="number"
            min="4"
            max="160"
            step="1"
            :disabled="ui.loading"
          />
        </div>
      </div>

      <div v-if="statusText" class="meta">{{ statusText }}</div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <DollarBarChart
      ref="chartRef"
      :data="dollarBars"
      :title="chartTitle"
      :loading="ui.loading"
    />
  </div>
</template>

<style scoped>
.dollarBarsApp {
  max-width: 1660px;
}

.field input {
  width: 76px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  padding: 0;
}

.field input:focus {
  outline: none;
}

.field input:disabled,
.field select:disabled {
  cursor: default;
  opacity: 0.55;
}
</style>
