<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import WeeklyBacktestChart from "./components/WeeklyBacktestChart.vue";
import { loadThalexHistory } from "./lib/thalexParquet.js";
import {
  DEFAULT_BACKTEST_CONFIG,
  prepareBacktestData,
  runWeeklyStraddleBacktest,
} from "./lib/weeklyStraddleBacktest.js";

const MATURITY_OPTIONS = [
  { value: 7, label: "7D", minDteDays: 5, maxDteDays: 10 },
  { value: 14, label: "14D", minDteDays: 7, maxDteDays: 28 },
  { value: 30, label: "30D", minDteDays: 14, maxDteDays: 60 },
];

const STRUCTURE_OPTIONS = [
  { value: "straddle", label: "Straddle" },
  { value: "strangle", label: "Strangle" },
  { value: "risk_reversal", label: "Risk reversal" },
];

const DELTA_OPTIONS = [
  { value: 0.15, label: "15D" },
  { value: 0.25, label: "25D" },
  { value: 0.3, label: "30D" },
];

const WEEKDAY_OPTIONS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, "0")}:00`,
}));

const HEDGE_FREQUENCY_OPTIONS = [
  { value: 1, label: "1h" },
  { value: 2, label: "2h" },
  { value: 3, label: "3h" },
  { value: 4, label: "4h" },
  { value: 6, label: "6h" },
  { value: 8, label: "8h" },
  { value: 12, label: "12h" },
  { value: 24, label: "24h" },
];

const SWEEP_DIMENSION_OPTIONS = [
  { value: "entry_hour", label: "Hour of day" },
  { value: "hedge_frequency", label: "Hedge frequency" },
  { value: "delta_band", label: "Delta band" },
];

const ui = reactive({
  structure: "straddle",
  maturityDays: 7,
  targetDelta: 0.25,
  entryWeekday: 5,
  entryHourUtc: 8,
  hedgeEnabled: true,
  hedgeIntervalHours: 24,
  holdToExpiry: true,
  exitHoldDays: 7,
});

const openMenu = ref(null);

function toggleMenu(name) {
  openMenu.value = openMenu.value === name ? null : name;
}

// Close menu on outside click
watch(openMenu, (val) => {
  if (!val) return;
  const handler = (e) => {
    const targetPill = e.target.closest('.pill');
    if (!targetPill) {
      openMenu.value = null;
    }
    document.removeEventListener('click', handler);
  };
  setTimeout(() => {
    document.addEventListener('click', handler, { once: true });
  }, 0);
});

const localHedgeIntervalHours = ref(ui.hedgeIntervalHours);

watch(() => ui.hedgeIntervalHours, (val) => {
  localHedgeIntervalHours.value = val;
});

let hedgeDebounce = null;

function updateHedgeInterval(val) {
  const numVal = Number(val);
  localHedgeIntervalHours.value = numVal;
  clearTimeout(hedgeDebounce);
  hedgeDebounce = setTimeout(() => {
    ui.hedgeIntervalHours = numVal;
  }, 500);
}

const hedgePct = computed(() => {
  const val = Number(localHedgeIntervalHours.value) || 1;
  return ((val - 1) / 23) * 100 + '%';
});

const activeRailGroup = ref("instrument");
const mode = ref("single");
const sweepDimension = ref("entry_hour");
const sweepResults = ref([]);
const sweepRunning = ref(false);
const sweepProgress = ref("");

const state = reactive({
  loading: true,
  error: "",
  progress: "",
});

const result = ref(null);
const preparedData = ref(null);

const formatUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const formatPct = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

const formatNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const formatDte = (value) =>
  Number.isFinite(value) ? `${formatNumber.format(value)}D` : "n/a";

const hoursFor = (hour, enabled, interval) => {
  const hs = new Set([Number(hour), 8]);
  if (enabled) {
    const step = Math.max(1, Math.min(24, Number(interval)));
    let h = Number(hour);
    do { hs.add(h); h = (h + step) % 24; } while (h !== Number(hour));
  }
  return [...hs].sort((a, b) => a - b);
};
const requiredHours = computed(() => hoursFor(ui.entryHourUtc, ui.hedgeEnabled, ui.hedgeIntervalHours));
const requiredHoursKey = computed(() => requiredHours.value.join(","));
let loadedHoursKey = "";

const metrics = computed(() => {
  const summary = result.value?.summary;
  if (!summary) return [];
  return [
    { label: "Final PnL", value: formatUsd.format(summary.finalEquityUsd) },
    { label: "Sharpe", value: Number.isFinite(summary.sharpeRatio) ? formatNumber.format(summary.sharpeRatio) : "n/a" },
    { label: "Max DD", value: formatUsd.format(maxDrawdown.value) },
  ];
});

const maxDrawdown = computed(() => {
  let peak = 0;
  let drawdown = 0;
  for (const row of result.value?.weeklyChartData || []) {
    const equity = row.cumulativeDeltaHedgedPnl;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return drawdown;
});

const sweepConfigs = computed(() => {
  if (sweepDimension.value === "entry_hour") {
    return HOUR_OPTIONS.map((hour) => ({
      key: `hour-${hour.value}`,
      label: hour.label,
      overrides: {
        entryHourUtc: hour.value,
        hourlyOffset: hour.value,
      },
    }));
  }

  if (sweepDimension.value === "hedge_frequency") {
    return HEDGE_FREQUENCY_OPTIONS.map((frequency) => ({
      key: `hedge-${frequency.value}`,
      label: frequency.label,
      overrides: {
        hedgeEnabled: true,
        hedgeIntervalHours: frequency.value,
      },
    }));
  }

  if (ui.structure === "straddle") return [];

  return DELTA_OPTIONS.map((delta) => ({
    key: `delta-${delta.value}`,
    label: delta.label,
    overrides: {
      targetDelta: delta.value,
    },
  }));
});

const sweepSharpeExtent = computed(() => {
  const values = sweepResults.value.map(c => c.sharpe).filter(Number.isFinite);
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
});

const sweepCellStyle = (cell) => {
  const [minS, maxS] = sweepSharpeExtent.value;
  const v = Number.isFinite(cell.sharpe) ? cell.sharpe : minS;
  const r = Math.max(0.001, maxS - minS);
  const i = Math.max(0, Math.min(1, (v - minS) / r));
  return { background: `hsl(${8 + i * 150} 48% ${22 + i * 22}%)` };
};

const railGroups = computed(() => {
  const mat = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  const struc = STRUCTURE_OPTIONS.find(o => o.value === ui.structure) || STRUCTURE_OPTIONS[0];
  const del = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  const wd = WEEKDAY_OPTIONS.find(o => o.value === Number(ui.entryWeekday)) || WEEKDAY_OPTIONS[4];
  const opt = ui.structure === "straddle" ? "ATM" : del.label;
  const entryLbl = `${wd.label} ${String(ui.entryHourUtc).padStart(2,"0")}:00 UTC`;
  const hedgeLbl = !ui.hedgeEnabled ? "Off" : ui.hedgeIntervalHours === 24 ? `Daily ${String(ui.entryHourUtc).padStart(2,"0")}:00` : `Every ${ui.hedgeIntervalHours}h`;
  const hedge2 = ui.hedgeEnabled ? "Perp · no fees" : "Option-only PnL";
  const exit1 = ui.holdToExpiry ? "Hold to expiry" : `Close after ${ui.exitHoldDays}D`;
  const exit2 = ui.holdToExpiry ? "Use selected expiry" : `Max ${mat.value}D`;
  return [
    { key: "instrument", label: "Instrument", primary: `BTC · ${struc.label}`, secondary: `${mat.label} · ${opt}` },
    { key: "entry", label: "Entry", primary: entryLbl, secondary: "Filter: none" },
    { key: "hedging", label: "Hedging", primary: hedgeLbl, secondary: hedge2 },
    { key: "exit", label: "Exit", primary: exit1, secondary: exit2 },
  ];
});

const strategyTitle = computed(() => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  const s = STRUCTURE_OPTIONS.find(o => o.value === ui.structure) || STRUCTURE_OPTIONS[0];
  const d = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  const opt = ui.structure === "straddle" ? "ATM" : d.label;
  const h = ui.hedgeEnabled ? `${ui.hedgeIntervalHours}h Delta Hedge` : "Unhedged";
  return `${m.label} ${opt} ${s.label} - ${h}`;
});

// New design pill values
const instrumentPill = computed(() => {
  const s = STRUCTURE_OPTIONS.find(o => o.value === ui.structure) || STRUCTURE_OPTIONS[0];
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  const d = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  const opt = ui.structure === "straddle" ? "ATM" : `${d.label} ${s.label}`;
  return `BTC · ${s.label} · ${m.label} ${opt}`;
});

const structureLabel = computed(() => {
  const s = STRUCTURE_OPTIONS.find(o => o.value === ui.structure) || STRUCTURE_OPTIONS[0];
  return s.label;
});

const maturityLabel = computed(() => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  const d = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  const opt = ui.structure === "straddle" ? "ATM" : d.label;
  return `${m.label} ${opt}`;
});

const deltaLabel = computed(() => {
  const d = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  return d.label;
});

const entryPill = computed(() => {
  const wd = WEEKDAY_OPTIONS.find(o => o.value === Number(ui.entryWeekday)) || WEEKDAY_OPTIONS[4];
  return `${wd.label.slice(0,3)} ${String(ui.entryHourUtc).padStart(2,'0')}:00`;
});

const hedgePill = computed(() => {
  if (!ui.hedgeEnabled) return "Off";
  return ui.hedgeIntervalHours === 24
    ? `Daily ${String(ui.entryHourUtc).padStart(2,'0')}:00 · Perp`
    : `Every ${ui.hedgeIntervalHours}h · Perp`;
});

const exitPill = computed(() => {
  return ui.holdToExpiry
    ? "Hold to expiry"
    : `Close after ${ui.exitHoldDays}D`;
});

const holdPill = computed(() => ui.holdToExpiry ? "On" : "Off");

const maxExitHoldDays = computed(() => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  return m.value;
});

// Metrics for new design (only 3)
const finalPnlValue = computed(() => {
  if (!result.value?.summary) return "—";
  return formatUsd.format(result.value.summary.finalEquityUsd);
});

const sharpeValue = computed(() => {
  const s = result.value?.summary?.sharpeRatio;
  return Number.isFinite(s) ? formatNumber.format(s) : "—";
});

const maxDdValue = computed(() => {
  if (!result.value) return "—";
  const dd = maxDrawdown.value;
  return formatUsd.format(dd);
});

// Chart data and titles
const chartRows = computed(() => result.value?.weeklyChartData || []);

const chartTitle = computed(() => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  const s = STRUCTURE_OPTIONS.find(o => o.value === ui.structure) || STRUCTURE_OPTIONS[0];
  const d = DELTA_OPTIONS.find(o => o.value === Number(ui.targetDelta)) || DELTA_OPTIONS[1];
  const opt = ui.structure === "straddle" ? "ATM" : d.label;
  const hedgeLabel = ui.hedgeEnabled ? "Hedged" : "Unhedged";
  return `${m.label} ${opt} ${s.label} — ${hedgeLabel}`;
});

const chartSubtitle = computed(() => {
  if (!result.value) return "";
  const start = new Date(result.value.summary?.start || "2025-06-01");
  const end = result.value.dataEnd || new Date();
  const startLabel = start.toLocaleString("en-US", { month: "short", year: "2-digit" });
  const endLabel = end.toLocaleString("en-US", { month: "short", year: "2-digit" });
  return `Bars show weekly hedged PnL; line shows cumulative hedged PnL · ${startLabel} – ${endLabel} · Source: Thalex`;
});

const buildConfig = (overrides = {}) => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    end: new Date(),
    targetDteDays: m.value,
    minWeeklyDteDays: m.minDteDays,
    maxWeeklyDteDays: m.maxDteDays,
    maxHedgeDays: m.maxDteDays + 2,
    structure: ui.structure,
    targetDelta: Number(ui.targetDelta),
    entryWeekday: Number(ui.entryWeekday),
    entryHourUtc: Number(ui.entryHourUtc),
    hourlyOffset: Number(ui.entryHourUtc),
    hedgeEnabled: ui.hedgeEnabled,
    hedgeIntervalHours: Number(ui.hedgeIntervalHours),
    holdToExpiry: ui.holdToExpiry,
    exitHoldDays: Number(ui.exitHoldDays),
    ...overrides,
  };
};

const runCurrent = () => {
  if (mode.value === "sweep") {
    runSweep();
    return;
  }
  if (!preparedData.value) return;
  const config = buildConfig();
  result.value = runWeeklyStraddleBacktest({
    preparedData: preparedData.value,
    config,
  });
};

const applySweepResult = (cell) => {
  if (sweepDimension.value === "entry_hour") {
    ui.entryHourUtc = cell.config.entryHourUtc;
  } else if (sweepDimension.value === "hedge_frequency") {
    ui.hedgeEnabled = true;
    ui.hedgeIntervalHours = cell.config.hedgeIntervalHours;
  } else if (sweepDimension.value === "delta_band") {
    ui.targetDelta = cell.config.targetDelta;
  }
  mode.value = "single";
  runCurrent();
};

const runSingleConfigForSweep = async (cell, index, total) => {
  const config = buildConfig(cell.overrides);
  sweepProgress.value = `${cell.label} (${index + 1}/${total})`;
  const loaded = await loadThalexHistory({
    start: config.start,
    end: config.end,
    hourlyOffsets: hoursFor(config.entryHourUtc, config.hedgeEnabled, config.hedgeIntervalHours),
  });
  const sweepPrepared = prepareBacktestData({
    indexRows: loaded.indexRows,
    markRows: loaded.markRows,
    config,
  });
  const run = runWeeklyStraddleBacktest({
    preparedData: sweepPrepared,
    config,
  });
  return {
    ...cell,
    config,
    sharpe: run.summary.sharpeRatio,
    pnl: run.summary.finalEquityUsd,
    cycles: run.counts.closedCycles,
    returnOnNotional: run.summary.cumulativeReturnOnNotional,
  };
};

const runSweep = async () => {
  if (sweepRunning.value) return;
  sweepRunning.value = true;
  state.error = "";
  sweepResults.value = [];
  try {
    const cells = sweepConfigs.value;
    const nextResults = [];
    for (const [index, cell] of cells.entries()) {
      nextResults.push(await runSingleConfigForSweep(cell, index, cells.length));
      sweepResults.value = [...nextResults];
    }
    sweepProgress.value = "";
  } catch (error) {
    state.error = error?.message || "Sweep failed";
  } finally {
    sweepRunning.value = false;
  }
};

const loadBacktest = async () => {
  state.loading = true;
  state.error = "";
  state.progress = "Loading data";
  preparedData.value = null;
  try {
    const config = buildConfig();
    state.progress = "Loading data";
    const loaded = await loadThalexHistory({
      start: config.start,
      end: config.end,
      hourlyOffsets: requiredHours.value,
      onProgress: ({ current, total, file }) => {
        state.progress = `Prepared ${current}/${total}: ${file}`;
      },
    });
    state.progress = "Preparing quotes";
    preparedData.value = prepareBacktestData({
      indexRows: loaded.indexRows,
      markRows: loaded.markRows,
      config,
    });
    loadedHoursKey = requiredHoursKey.value;
    state.progress = "Running strategy";
    runCurrent();
    state.progress = "";
  } catch (error) {
    state.error = error?.message || "Backtest failed";
  } finally {
    state.loading = false;
  }
};

const handleMaturityChange = () => {
  state.error = "";
  if (!preparedData.value || requiredHoursKey.value !== loadedHoursKey) {
    loadBacktest();
    return;
  }
  runCurrent();
};

watch(
  () => [
    ui.maturityDays,
    ui.structure,
    ui.targetDelta,
    ui.entryWeekday,
    ui.entryHourUtc,
    ui.hedgeEnabled,
    ui.hedgeIntervalHours,
    ui.holdToExpiry,
    ui.exitHoldDays,
  ],
  handleMaturityChange,
);

watch(() => ui.maturityDays, () => {
  const m = MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0];
  if (ui.exitHoldDays > m.value) ui.exitHoldDays = m.value;
});

watch(
  () => ui.structure,
  () => {
    if (ui.structure === "straddle" && sweepDimension.value === "delta_band") {
      sweepDimension.value = "entry_hour";
    }
  },
);

watch(
  () => [
    sweepDimension.value,
    ui.maturityDays,
    ui.structure,
    ui.targetDelta,
    ui.entryWeekday,
    ui.entryHourUtc,
    ui.hedgeEnabled,
    ui.hedgeIntervalHours,
    ui.holdToExpiry,
    ui.exitHoldDays,
  ],
  () => {
    sweepResults.value = [];
    sweepProgress.value = "";
  },
);

onMounted(loadBacktest);
</script>

<template>
  <main class="app">
    <!-- Top bar -->
    <div class="topBar">
      <div class="wordmark">Backtest</div>
      <div class="divider"></div>

      <div class="configPills">
        <!-- Instrument -->
        <div class="pill" style="position: relative;" @click="toggleMenu('instrument')">
          <span class="pillLabel">Instrument</span>
          <span class="pillValue">{{ instrumentPill }}</span>
          <div v-if="openMenu === 'instrument'" class="dropdown" style="min-width: 260px;" @click.stop>
            <div class="inst-field">
              <label class="inst-label">Structure</label>
              <select v-model="ui.structure">
                <option v-for="s in STRUCTURE_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </div>
            <div class="inst-field">
              <label class="inst-label">Maturity</label>
              <select v-model.number="ui.maturityDays">
                <option v-for="m in MATURITY_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
            </div>
            <div class="inst-field">
              <label class="inst-label">Delta</label>
              <select v-model.number="ui.targetDelta" :disabled="ui.structure === 'straddle'">
                <option v-for="d in DELTA_OPTIONS" :key="d.value" :value="d.value">{{ d.label }}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Entry -->
        <div class="pill" style="position: relative;" @click="toggleMenu('entry')">
          <span class="pillLabel">Entry</span>
          <span class="pillValue">{{ entryPill }}</span>
          <div v-if="openMenu === 'entry'" class="dropdown" style="min-width: 380px;" @click.stop>
            <select v-model.number="ui.entryWeekday" @change="openMenu = null">
              <option v-for="w in WEEKDAY_OPTIONS" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
            <div class="hour-grid">
              <button
                v-for="h in 24"
                :key="h-1"
                :class="{ active: ui.entryHourUtc === h-1 }"
                @click="ui.entryHourUtc = h-1; openMenu = null"
              >
                {{ String(h-1).padStart(2, '0') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Hedge -->
        <div class="pill" style="position: relative;" @click="toggleMenu('hedge')">
          <span class="pillLabel">Hedge</span>
          <span class="pillValue">{{ hedgePill }}</span>
          <div v-if="openMenu === 'hedge'" class="dropdown" @click.stop>
            <div class="freq-toggle-row">
              <span class="freq-row__label">Hedge</span>
              <label class="toggle-switch">
                <input type="checkbox" v-model="ui.hedgeEnabled" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <label class="freq-row__label" for="freq">Frequency</label>
            <input 
              id="freq" 
              class="freq-slider" 
              type="range" 
              min="1" 
              max="24" 
              step="1" 
              :value="localHedgeIntervalHours"
              @input="updateHedgeInterval(Number($event.target.value))"
              :style="{ '--pct': hedgePct }"
              :disabled="!ui.hedgeEnabled"
              @change="openMenu = null"
            >
            <div class="freq-footer">
              <span class="freq-footer__edge">1h</span>
              <span class="freq-footer__value">Every {{ localHedgeIntervalHours }}h</span>
              <span class="freq-footer__edge">24h</span>
            </div>
          </div>
        </div>

        <!-- Exit -->
        <div class="pill" style="position: relative;" @click="toggleMenu('exit')">
          <span class="pillLabel">Exit</span>
          <span class="pillValue">{{ exitPill }}</span>
          <div v-if="openMenu === 'exit'" class="dropdown" @click.stop>
            <input type="checkbox" v-model="ui.holdToExpiry" />
            <input type="range" v-model.number.lazy="ui.exitHoldDays" min="1" :max="maxExitHoldDays" :disabled="ui.holdToExpiry" />
          </div>
        </div>
      </div>

      <div class="spacer"></div>

      <div class="segmented">
        <div
          class="segment"
          :class="{ active: mode === 'single' }"
          @click="mode = 'single'"
        >
          Single run
        </div>
        <div
          class="segment"
          :class="{ active: mode === 'sweep' }"
          @click="mode = 'sweep'"
        >
          Sweep
        </div>
      </div>
    </div>

    <div class="main">
      <!-- Left metrics column -->
      <div class="metricsColumn">
        <div class="metric">
          <div class="metricValue">{{ finalPnlValue }}</div>
          <div class="metricLabel">FINAL PNL</div>
        </div>
        <div class="metric">
          <div class="metricValue">{{ sharpeValue }}</div>
          <div class="metricLabel">SHARPE</div>
        </div>
        <div class="metric">
          <div class="metricValue maxdd">{{ maxDdValue }}</div>
          <div class="metricLabel">MAX DRAWDOWN</div>
        </div>
      </div>

      <!-- Chart area -->
      <div class="chartColumn">
        <div class="chartHeader">
          <div class="chartTitle">{{ chartTitle }}</div>
          <div class="chartSubtitle">{{ chartSubtitle }}</div>
        </div>

        <WeeklyBacktestChart
          :rows="chartRows"
          :design-spec="true"
        />
      </div>
    </div>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  min-width: 320px;
  background: #0a0b0e;
  color: #e8eaed;
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}

.app {
  max-width: none;
  width: 100%;
  min-height: 100vh;
  padding: 0;
  background: #0a0b0e;
  display: flex;
  flex-direction: column;
}

.topBar {
  display: flex;
  align-items: center;
  height: 58px;
  padding: 0 28px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  gap: 20px;
  flex-shrink: 0;
}

.wordmark {
  font-size: 14px;
  font-weight: 600;
  color: #e8eaed;
}

.divider {
  width: 1px;
  height: 20px;
  background: rgba(255,255,255,0.08);
}

.configPills {
  display: flex;
  gap: 8px;
}

.pill {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 8px;
  padding: 7px 13px;
  font-size: 12px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  position: relative;
  overflow: visible;
}

.pill:hover {
  border-color: rgba(255,255,255,0.2);
}

/* Ensure controls are visible and usable on hover */
.pill select,
.pill input {
  cursor: pointer;
}

.pill select,
.pill input[type="range"],
.pill input[type="checkbox"] {
  font-size: 11px;
  background: #000;
  color: #fff;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.pill select option {
  background: #000;
  color: #fff;
}

/* In dropdowns, no borders on inner inputs */
.dropdown select,
.dropdown input {
  border: none !important;
  background: #000;
  color: #fff;
  padding: 4px 6px;
  width: 100%;
  margin-bottom: 4px;
}

.dropdown .freq-toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.pillLabel {
  color: #70767d;
}

.pillValue {
  color: #e8eaed;
  font-weight: 500;
}

.pillValue.off {
  color: #565c63;
}



.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 340px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  background: #0a0b0e;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.15);
  z-index: 10;
}

/* Ensure no inner borders on dropdown content */
.dropdown .freq-toggle-row,
.dropdown .freq-row__label,
.dropdown .freq-footer {
  border: none;
}

.dropdown select {
  width: 100%;
  margin-bottom: 2px;
  background: #000;
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 12px;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.hour-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
  margin-top: 10px;
}

.hour-grid button {
  padding: 14px 2px;
  font-size: 16px;
  background: #111114;
  color: #e8eaed;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  cursor: pointer;
  text-align: center;
  transition: all 0.1s;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hour-grid button:hover {
  background: #222;
  border-color: rgba(255,255,255,0.3);
}

.hour-grid button.active {
  background: #7dd3fc;
  color: #000;
  border-color: #7dd3fc;
  font-weight: 600;
}

.inst-field {
  background: #111114;
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
}
.inst-field:last-child {
  margin-bottom: 0;
}

.inst-label {
  display: block;
  color: #70767d;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.inst-field select {
  background: #0a0b0e;
  color: #e8eaed;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 3px;
  padding: 5px 6px;
  font-size: 12px;
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}
.inst-field select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* Frequency Dropdown Menu styles from spec */
.freq-menu {
  position: relative;
  font-family: var(--font, 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  -webkit-font-smoothing: antialiased;
  width: auto;
}

.freq-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 13px;
  background: var(--surface, #131316);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.09));
  border-radius: 8px;
  color: var(--text, #f4f4f5);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s, border-color .15s;
  min-width: 120px;
}
.freq-trigger:hover {
  background: var(--surface-hover, #1a1a1f);
  border-color: var(--border-hover, rgba(255, 255, 255, 0.14));
}
.freq-trigger__lead { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.freq-trigger__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #7dd3fc;
  box-shadow: 0 0 6px #7dd3fc;
}


.freq-panel {
  position: absolute;
  top: 100%; left: 0; margin-top: 4px;
  background: var(--panel, #0f0f12);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.09));
  border-radius: 18px;
  padding: 8px;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.8),
              0 0 0 1px rgba(255, 255, 255, 0.02);
  z-index: 10;
  min-width: 220px;
}
.freq-menu[data-open="false"] .freq-panel { display: none; }

.freq-row {
  padding: 12px 10px 10px;
  border-radius: 12px;
  transition: background .15s;
}
.freq-row:hover { background: var(--row-hover, rgba(255, 255, 255, 0.02)); }
.freq-row__label {
  display: block;
  margin-bottom: 12px;
  color: var(--text-2, #e7e7ea);
  font-size: 12px;
  font-weight: 600;
}

.freq-slider {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  width: 100%;
  height: 22px;
  background: transparent;
  outline: none;
  border: none;
  box-shadow: none;
  cursor: pointer;
  --pct: 32%;
}
.freq-slider::-webkit-slider-runnable-track {
  height: 6px; border-radius: 99px;
  background: linear-gradient(
    to right,
    var(--fill, #f4f4f5) 0 var(--pct),
    var(--track, #2b2b30) var(--pct) 100%
  );
}
.freq-slider::-moz-range-track {
  height: 6px; border-radius: 99px; background: var(--track, #2b2b30);
}
.freq-slider::-moz-range-progress {
  height: 6px; border-radius: 99px; background: var(--fill, #f4f4f5);
}
.freq-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 18px; height: 18px; margin-top: -6px;
  border-radius: 50%; border: none;
  background: var(--handle, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.freq-slider::-moz-range-thumb {
  width: 18px; height: 18px;
  border-radius: 50%; border: none;
  background: var(--handle, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.06);
}

.freq-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}
.freq-footer__edge {
  color: var(--text-muted, #71717a); font-size: 11px; font-weight: 500;
}
.freq-footer__value {
  padding: 4px 10px;
  background: var(--surface-hover, #1a1a1f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text, #f4f4f5);
  font-size: 11px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* More padding below toggle and slider */
.freq-toggle-row {
  margin-bottom: 16px;
}

.freq-row .freq-slider {
  margin-bottom: 8px;
}

/* Nice round toggle switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #333;
  border-radius: 20px;
  transition: .3s;
  border: 1px solid rgba(255,255,255,0.2);
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: white;
  border-radius: 50%;
  transition: .3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: #7dd3fc;
  border-color: #7dd3fc;
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(16px);
}

/* Grey out slider when hedging is off */
.freq-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.freq-slider:disabled::-webkit-slider-thumb {
  background: #666;
}

.freq-slider:disabled::-moz-range-thumb {
  background: #666;
}

.spacer {
  flex: 1;
}

.segmented {
  display: flex;
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 2px;
}

.segment {
  font-size: 12px;
  font-weight: 500;
  color: #70767d;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
}

.segment.active {
  background: rgba(255,255,255,0.1);
  color: #e8eaed;
}

.configCluster {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.modeToggle button,
.field select,
.runButton {
  height: 36px;
  border: 1px solid #35353a;
  border-radius: 6px;
  background: #111114;
  color: #f4f4f5;
  font: inherit;
  outline: none;
}

.modeToggle {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid #303035;
  border-radius: 8px;
  background: #0d0d10;
}

.modeToggle button {
  height: 30px;
  padding: 0 13px;
  border: 0;
  background: transparent;
  color: #a6a6ad;
  cursor: pointer;
  font-weight: 600;
}

.modeToggle button.active {
  background: #c7ddff;
  color: #163f7d;
}

.main {
  flex: 1;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 20px 36px 20px 28px;
  min-height: 0;
  height: 0; /* allow flex child to grow */
}

.metricsColumn {
  display: flex;
  flex-direction: column;
  gap: 28px;
  width: 170px;
  flex: none;
  padding-top: 44px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 5px;
  white-space: nowrap;
  background: transparent;
  border: none;
  padding: 0;
  min-height: auto;
}

.metricValue {
  font-size: 22px;
  font-weight: 300;
  letter-spacing: -0.3px;
  color: #e8eaed;
}

.metricValue.maxdd {
  color: #9aa0a6;
}

.metricLabel {
  font-size: 10px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: #70767d;
}

.railGroups {
  display: grid;
  gap: 14px;
}

.railGroup {
  border-bottom: 1px solid #29292d;
  padding-bottom: 14px;
}

.railGroupButton {
  display: grid;
  width: 100%;
  gap: 8px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  text-align: left;
}

.railGroupButton span {
  color: #8f8f96;
  font-size: 14px;
  font-weight: 700;
}

.railGroupButton strong {
  color: #f2f2f4;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.15;
}

.railGroupButton em {
  color: #b4b4bc;
  font-style: normal;
  font-size: 14px;
  font-weight: 500;
}

.railPanel {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid #303035;
  border-radius: 8px;
  background: #101014;
}

.field {
  display: grid;
  gap: 6px;
}

.field span {
  color: #8f8f96;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.field select {
  width: 100%;
  padding: 0 30px 0 10px;
}

.field select:focus,
.field select:disabled {
  color: #73737b;
  cursor: not-allowed;
}

.toggleField,
.rangeField {
  display: grid;
  gap: 10px;
  color: #d7d7dc;
  font-size: 13px;
  font-weight: 700;
}

.toggleField {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.toggleField input {
  width: 42px;
  height: 24px;
  appearance: none;
  border: 1px solid #3a3a40;
  border-radius: 999px;
  background: #1a1a1f;
  cursor: pointer;
  position: relative;
}

.toggleField input::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #8f8f96;
  transition: transform 140ms ease, background 140ms ease;
}

.toggleField input:checked {
  border-color: #5fc7a6;
  background: #12392f;
}

.toggleField input:checked::before {
  transform: translateX(18px);
  background: #62c7a7;
}

.rangeField span {
  color: #8f8f96;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.rangeField input {
  width: 100%;
  accent-color: #62c7a7;
}

.rangeField.disabled {
  opacity: 0.45;
}

.readonlyPanel {
  padding: 12px;
}

.readonlyRow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.readonlyRow span {
  color: #f2f2f4;
}

.readonlyRow strong {
  color: #9fa0aa;
  font-size: 13px;
}

.runButton {
  width: 100%;
  height: 54px;
  background: #f2f2f4;
  color: #09090b;
  cursor: pointer;
  font-size: 20px;
  font-weight: 650;
}

.runButton:hover:not(:disabled) {
  background: #ffffff;
}

.runButton:disabled {
  cursor: progress;
  opacity: 0.55;
}

.chartColumn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.chartHeader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  flex: none;
}

.chartTitle {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  color: #e8eaed;
}

.chartSubtitle {
  font-size: 12px;
  color: #70767d;
}

.strategyHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  min-width: 0;
  margin-bottom: 18px;
}

.strategyHeader p,
.strategyHeader h2 {
  margin: 0;
  letter-spacing: 0;
}

.strategyHeader p {
  flex: 0 0 auto;
  color: #8d8d96;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.strategyHeader h2 {
  min-width: 0;
  color: #f5f5f7;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.25;
  text-align: right;
}



.chartPanel {
  width: 100%;
  min-height: 620px;
  margin-bottom: 20px;
  padding: 12px;
  border: 1px solid #23232a;
  border-radius: 8px;
  background: #08080a;
}

.status {
  display: flex;
  min-height: 520px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #a6a6ad;
  text-align: center;
}

.status strong {
  color: #f4f4f5;
  font-size: 16px;
  font-weight: 650;
}

.status.error strong {
  color: #ff6b7a;
}

.sweepPanel {
  display: grid;
  min-height: 520px;
  align-content: start;
  gap: 20px;
  padding: 24px;
}

.sweepToolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
}

.sweepSelect {
  width: min(280px, 100%);
}

.sweepAnnotation {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 16px;
  color: #9fa0aa;
  text-align: right;
}

.sweepAnnotation strong {
  color: #f4f4f5;
  font-size: 18px;
}

.sweepGrid {
  display: grid;
  grid-template-columns: repeat(8, minmax(96px, 1fr));
  gap: 8px;
}

.sweepGrid-delta_band {
  grid-template-columns: repeat(3, minmax(140px, 1fr));
}

.sweepCell {
  display: grid;
  min-height: 92px;
  align-content: center;
  gap: 7px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 8px;
  color: #f4f4f5;
  cursor: pointer;
  padding: 12px;
  text-align: left;
}

.sweepCell:hover {
  border-color: rgba(255, 255, 255, 0.38);
}

.sweepCell span {
  font-size: 13px;
  font-weight: 750;
}

.sweepCell strong {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
}

.sweepCell em {
  color: rgba(255, 255, 255, 0.78);
  font-size: 12px;
  font-style: normal;
  font-weight: 650;
}

.sweepEmpty {
  display: grid;
  min-height: 260px;
  place-items: center;
  border: 1px solid #29292d;
  border-radius: 8px;
  color: #9fa0aa;
  background: #101014;
}

.runFacts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.runFacts span {
  min-height: 34px;
  padding: 8px 12px;
  border: 1px solid #2c2c31;
  border-radius: 6px;
  color: #d2d2d8;
  background: #101014;
  font-size: 13px;
}

.positive {
  color: #66d38f;
}

.negative {
  color: #e46578;
}

@media (max-width: 960px) {
  .header {
    align-items: flex-start;
    flex-direction: column;
    padding: 16px;
  }

  .configCluster {
    width: 100%;
    justify-content: flex-start;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .rail {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid #26262a;
  }

  .strategyHeader {
    align-items: stretch;
    flex-direction: column;
  }

  .strategyHeader h2 {
    text-align: left;
  }

  .chartPanel {
    padding: 10px;
  }
}
</style>
