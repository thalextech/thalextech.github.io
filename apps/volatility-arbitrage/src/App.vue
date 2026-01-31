<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import VolatilityChart from "./components/VolatilityChart.vue";
import {
  computeVolatilitySeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchOptionsData,
} from "./lib/thalex.js";

const RESOLUTION_CONFIG = {
  "1m": { label: "1m", seconds: 60, detail: "1m" },
  "5m": { label: "5m", seconds: 5 * 60, detail: "1m" },
  "15m": { label: "15m", seconds: 15 * 60, detail: "5m" },
  "1h": { label: "1h", seconds: 60 * 60, detail: "15m" },
  "1d": { label: "1d", seconds: 24 * 60 * 60, detail: "1h" },
};
const MAIN_POINT_LIMIT = 400;
const VOLATILITY_WINDOW = 20; // Rolling window for volatility calculation

const ui = reactive({
  resolution: "1d",
  indexName: "BTCUSD",
  loading: false,
  error: "",
  visualizationMode: "gradient", // "gradient" or "histogram"
});

const data = reactive({
  allInstruments: [],
  index: {},
  options: [],
});

const chartRef = ref(null);

const mainSeries = computed(() => {
  const index = data.index[ui.resolution] || [];
  if (index.length === 0) return [];
  
  const series = computeVolatilitySeries({
    index,
    resolution: ui.resolution,
    windowSize: VOLATILITY_WINDOW,
  });
  return series.slice(-MAIN_POINT_LIMIT);
});

const detailSeries = computed(() => {
  const resolutionKey = RESOLUTION_CONFIG[ui.resolution].detail;
  const index = data.index[resolutionKey] || [];
  if (index.length === 0) return [];
  
  return computeVolatilitySeries({
    index,
    resolution: resolutionKey,
    windowSize: VOLATILITY_WINDOW,
  });
});

const averageVolatility = computed(() => {
  const series = mainSeries.value;
  if (!series || series.length === 0) return null;
  
  const volValues = series
    .map((d) => d?.realized_vol)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  
  if (volValues.length === 0) return null;
  
  const mean = volValues.reduce((sum, val) => sum + val, 0) / volValues.length;
  const variance = volValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / volValues.length;
  const stdDev = Math.sqrt(variance);
  
  // Calculate realized variance: (volatility/100)^2
  const realizedVariance = Math.pow(mean / 100, 2);
  
  return { mean, stdDev, realizedVariance };
});

async function load() {
  if (!ui.indexName) return;

  ui.loading = true;
  ui.error = "";
  data.index = {};

  const now = Math.floor(Date.now() / 1000);
  const seconds = RESOLUTION_CONFIG[ui.resolution].seconds;
  const timestampRange = {
    from: now - seconds * (MAIN_POINT_LIMIT + VOLATILITY_WINDOW),
    to: now,
  };

  try {
    const [mainIndex, detailIndex] = await Promise.all([
      fetchIndexHistory({
        index_name: ui.indexName,
        resolution: ui.resolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      fetchIndexHistory({
        index_name: ui.indexName,
        resolution: RESOLUTION_CONFIG[ui.resolution].detail,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
    ]);

    data.index[ui.resolution] = mainIndex || [];
    data.index[RESOLUTION_CONFIG[ui.resolution].detail] = detailIndex || [];

    if (!mainSeries.value.length) {
      throw new Error("No volatility data returned for this time range.");
    }
  } catch (e) {
    ui.error = e instanceof Error ? e.message : String(e);
    data.index = {};
  } finally {
    ui.loading = false;
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = ui.indexName || "volatility-chart";
  const filename = ui.resolution
    ? `${base}-${ui.resolution}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

async function loadOptions() {
  try {
    console.log("Loading options for:", ui.indexName);
    const options = await fetchOptionsData(ui.indexName);
    console.log("Options loaded:", options.length);
    if (options.length > 0) {
      console.log("First option sample:", options[0]);
      data.options = options; // Only update if we got results
    } else {
      // Only clear if we explicitly got empty results (not on error)
      data.options = [];
    }
  } catch (e) {
    console.error("Failed to load options data:", e);
    console.error("Error details:", e.message, e.stack);
    // Don't clear existing options on error - keep what we have
    if (data.options.length === 0) {
      data.options = [];
    }
  }
}

function formatCurrency(value) {
  if (!value || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value) {
  if (!value || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)}%`;
}

function formatVariance(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  // Variance is typically displayed as a decimal (e.g., 0.04 for 4% variance)
  return value.toFixed(4);
}

function formatDate(date) {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

onMounted(async () => {
  data.allInstruments = await fetchInstruments();
  await load();
  await loadOptions();
});

watch(
  () => [ui.resolution, ui.indexName, ui.visualizationMode],
  async () => {
    if (!ui.indexName) return;
    await load();
    await loadOptions();
  },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Realized Volatility - thalex</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="index">Index</label>
          <select id="index" v-model="ui.indexName">
            <option value="BTCUSD">BTCUSD</option>
            <option value="ETHUSD">ETHUSD</option>
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

        <div class="field">
          <label for="visualization-mode">View</label>
          <select id="visualization-mode" v-model="ui.visualizationMode">
            <option value="gradient">Gradient</option>
            <option value="histogram">Histogram</option>
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

    <VolatilityChart
      ref="chartRef"
      :data="mainSeries"
      :detail-data="detailSeries"
      :index-name="ui.indexName"
      :detail-resolution="RESOLUTION_CONFIG[ui.resolution].detail"
      :loading="ui.loading"
      :visualization-mode="ui.visualizationMode"
    />

    <section class="options-section">
      <div class="options-header">
        <h2>ATM Straddle Options</h2>
        <p class="options-hint">Implied volatility and cost of at-the-money straddles for all available expirations.</p>
        <div v-if="averageVolatility" class="realized-vol-display">
          <span class="realized-vol-label">Average Realized Volatility (selected period):</span>
          <span class="realized-vol-value">{{ formatPercent(averageVolatility.mean) }}</span>
          <span class="realized-vol-std">(σ: {{ formatPercent(averageVolatility.stdDev) }})</span>
          <span class="realized-vol-separator">|</span>
          <span class="realized-vol-label">Average Realized Variance:</span>
          <span class="realized-vol-value">{{ formatVariance(averageVolatility.realizedVariance) }}</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="options-table">
          <thead>
            <tr>
              <th>Expiration</th>
              <th>Days to Expiration</th>
              <th>Strike</th>
              <th>Index Price</th>
              <th>Call Price</th>
              <th>Put Price</th>
              <th>Straddle Cost</th>
              <th>Implied Volatility</th>
              <th>Implied Variance</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="data.options.length === 0">
              <td colspan="9" class="status">No options data available.</td>
            </tr>
            <tr v-for="(option, index) in data.options" :key="option.expirationDate ? option.expirationDate.getTime() : index">
              <td>{{ formatDate(option.expirationDate) }}</td>
              <td>{{ option.daysToExpiry }}</td>
              <td>{{ formatCurrency(option.strike) }}</td>
              <td>{{ formatCurrency(option.indexPrice) }}</td>
              <td>{{ formatCurrency(option.callPrice) }}</td>
              <td>{{ formatCurrency(option.putPrice) }}</td>
              <td>{{ formatCurrency(option.straddleCost) }}</td>
              <td>{{ formatPercent(option.iv) }}</td>
              <td>{{ formatVariance(option.impliedVariance) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
