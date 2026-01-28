<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  computeFundingSeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
  fetchRollsData,
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
  visualizationMode: "basis", // "basis" or "funding"
});
const data = reactive({
  allInstruments: [],
  instruments: [],
  instrument: null,
  mark: {},
  index: {},
  rolls: [],
});
const chartRef = ref(null);

const mainSeries = computed(() => {
  const mark = data.mark[ui.resolution] || [];
  if (ui.visualizationMode === "funding") {
    const series = computeFundingSeries({ mark, resolution: ui.resolution });
    return series.slice(-MAIN_POINT_LIMIT);
  }
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
  if (ui.visualizationMode === "funding") {
    return computeFundingSeries({ mark, resolution: resolutionKey });
  }
  const index = data.index[resolutionKey] || [];
  return computeBasisSeries({
    mark,
    index,
    instrument: data.instrument || {},
  });
});

const averageAnnualizedBasis = computed(() => {
  const series = mainSeries.value;
  if (!series || series.length === 0) return null;
  
  let basisValues = [];
  if (ui.visualizationMode === "funding") {
    basisValues = series
      .map((d) => d?.funding_rate_annual)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
  } else {
    basisValues = series
      .map((d) => d?.basis_pct)
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((v) => v * 100); // Convert to percentage
  }
  
  if (basisValues.length === 0) return null;
  
  const mean = basisValues.reduce((sum, val) => sum + val, 0) / basisValues.length;
  
  // Calculate standard deviation
  const variance = basisValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / basisValues.length;
  const stdDev = Math.sqrt(variance);
  
  return { mean, stdDev };
});

const rollsWithDifference = computed(() => {
  const stats = averageAnnualizedBasis.value;
  if (!stats || stats.stdDev === 0) {
    // Fallback to simple difference if no stats available
    return data.rolls.map((roll) => {
      const difference = roll.impliedBasis !== null && Number.isFinite(roll.impliedBasis)
        ? roll.impliedBasis - stats?.mean
        : null;
      return {
        ...roll,
        difference,
        zScore: null,
        action: null,
      };
    });
  }
  
  return data.rolls.map((roll) => {
    const difference = roll.impliedBasis !== null && Number.isFinite(roll.impliedBasis)
      ? roll.impliedBasis - stats.mean
      : null;
    
    // Calculate z-score: (x - μ) / σ
    const zScore = roll.impliedBasis !== null && Number.isFinite(roll.impliedBasis) && stats.stdDev > 0
      ? (roll.impliedBasis - stats.mean) / stats.stdDev
      : null;
    
    // Determine action based on z-score:
    // When you BUY a roll, you lock in the implied rate and profit if perpetual funding > implied rate
    // Buy if z < -1 (more than 1 SD below average - good opportunity to lock in lower rate)
    // Sell if z > 1 (more than 1 SD above average - avoid locking in high rate)
    // Neutral if within 1 SD
    let action = null;
    if (zScore !== null) {
      if (zScore < -1) {
        action = "Buy"; // More than 1 SD below average - good buy opportunity
      } else if (zScore > 1) {
        action = "Sell"; // More than 1 SD above average - avoid
      } else {
        action = "Neutral"; // Within 1 SD - neutral
      }
    } else if (difference !== null) {
      // Fallback to difference-based logic if z-score unavailable
      if (difference < 0) {
        action = "Buy";
      } else if (difference > 0) {
        action = "Sell";
      } else {
        action = "Neutral";
      }
    }
    
    return {
      ...roll,
      difference,
      zScore,
      action,
    };
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
    
    if (ui.visualizationMode === "funding") {
      // For funding mode, we only need mark price data
      const mainMarkResult = await fetchMarkHistory({
        instrument_name: ui.instrumentName,
        resolution: ui.resolution,
        from: now - seconds * MAIN_POINT_LIMIT,
        to: now,
      });

      const detailResolution = RESOLUTION_CONFIG[ui.resolution].detail;
      const detailMarkResult = await fetchMarkHistory({
        instrument_name: ui.instrumentName,
        resolution: detailResolution,
        from: timestampRange.from,
        to: timestampRange.to,
      });

      data.mark[ui.resolution] = mainMarkResult?.data || [];
      data.mark[detailResolution] = detailMarkResult?.data || [];
      data.index[ui.resolution] = [];
      data.index[detailResolution] = [];

      if (!data.mark[ui.resolution]?.length) {
        throw new Error("No mark price data returned for this time range.");
      }
    } else {
      // For basis mode, we need both mark and index data
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

      data.mark[ui.resolution] = mainMarkResult?.data || [];
      data.index[ui.resolution] = mainIndex || [];
      data.mark[detailResolution] = detailMarkResult?.data || [];
      data.index[detailResolution] = detailIndex || [];

      if (!mainSeries.value.length) {
        throw new Error("No merged datapoints returned for this time range.");
      }
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

function updateInstruments() {
  if (ui.visualizationMode === "funding") {
    // For funding mode, show perpetual contracts
    data.instruments = data.allInstruments
      .filter((i) => {
        const name = (i?.instrument_name || "").toUpperCase();
        return (i?.type === "perpetual" || name.includes("PERPETUAL")) && 
               (i?.underlying === "BTCUSD" || name.includes("BTC"));
      })
      .sort((a, b) => (a.create_time_ms || 0) - (b.create_time_ms || 0));
  } else {
    // For basis mode, show futures contracts
    data.instruments = data.allInstruments
      .filter((i) => i?.type === "future" && i?.underlying === "BTCUSD")
      .sort((a, b) => (a.create_time_ms || 0) - (b.create_time_ms || 0));
  }
  
  // Select first instrument if current selection is not in the filtered list
  if (data.instruments.length) {
    const currentInList = data.instruments.find(
      (i) => i.instrument_name === ui.instrumentName
    );
    if (!currentInList) {
      data.instrument = data.instruments[0];
      ui.instrumentName = data.instruments[0].instrument_name;
    }
  } else if (ui.instrumentName) {
    // Clear selection if no instruments available
    ui.instrumentName = "";
    data.instrument = null;
  }
}

async function loadRolls() {
  try {
    data.rolls = await fetchRollsData();
  } catch (e) {
    console.error("Failed to load rolls data:", e);
    data.rolls = [];
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
  updateInstruments();
  await loadRolls();
});

// Watch for visualization mode changes and update instruments
watch(
  () => ui.visualizationMode,
  () => {
    updateInstruments();
  }
);

watch(
  () => [ui.resolution, ui.instrumentName, ui.visualizationMode],
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
        <h1>Future Annualized Basis - thalex</h1>
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

        <div class="field">
          <label for="visualization-mode">View</label>
          <select id="visualization-mode" v-model="ui.visualizationMode">
            <option value="basis">Gradient</option>
            <option value="funding">Histogram</option>
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
      :visualization-mode="ui.visualizationMode"
    />

    <section class="rolls-section">
      <div class="rolls-header">
        <h2>Annualized Returns of the Rolls</h2>
        <p class="rolls-hint">Implied annualized basis based on roll mark price vs index.</p>
      </div>
      <div class="table-wrap">
        <table class="rolls-table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Mark Price</th>
              <th>Index Price</th>
              <th>Expiration</th>
              <th>Days to Expiration</th>
              <th>Implied Annualized Basis</th>
              <th>Difference from Avg</th>
              <th>Z-Score</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="rollsWithDifference.length === 0">
              <td colspan="9" class="status">No roll data available.</td>
            </tr>
            <tr v-for="roll in rollsWithDifference" :key="roll.instrument">
              <td>{{ roll.instrument }}</td>
              <td>{{ formatCurrency(roll.markPrice) }}</td>
              <td>{{ formatCurrency(roll.indexPrice) }}</td>
              <td>{{ formatDate(roll.expirationDate) }}</td>
              <td>{{ roll.daysToExpiration }}</td>
              <td>{{ formatPercent(roll.impliedBasis) }}</td>
              <td :class="{ 'positive': roll.difference > 0, 'negative': roll.difference < 0 }">
                <span v-if="roll.difference !== null">
                  {{ roll.difference > 0 ? '+' : '' }}{{ formatPercent(roll.difference) }}
                </span>
                <span v-else>N/A</span>
              </td>
              <td :class="{ 
                'z-positive': roll.zScore !== null && roll.zScore > 0,
                'z-negative': roll.zScore !== null && roll.zScore < 0,
                'z-extreme': roll.zScore !== null && Math.abs(roll.zScore) > 2
              }">
                <span v-if="roll.zScore !== null">
                  {{ roll.zScore.toFixed(2) }}
                  <span v-if="Math.abs(roll.zScore) > 2" class="z-extreme-indicator" title="More than 2 standard deviations from mean">⚠</span>
                </span>
                <span v-else>N/A</span>
              </td>
              <td>
                <span v-if="roll.action === 'Buy'" class="action-buy">Buy</span>
                <span v-else-if="roll.action === 'Sell'" class="action-sell">Sell</span>
                <span v-else-if="roll.action === 'Neutral'" class="action-neutral">Neutral</span>
                <span v-else>N/A</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
