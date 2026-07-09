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
    <header class="header">
      <h1>Backtest</h1>
      <div class="configCluster" aria-label="Mode">
        <div class="modeToggle" role="group" aria-label="Mode">
          <button
            type="button"
            :class="{ active: mode === 'single' }"
            @click="mode = 'single'"
          >
            Single run
          </button>
          <button
            type="button"
            :class="{ active: mode === 'sweep' }"
            @click="mode = 'sweep'"
          >
            Sweep
          </button>
        </div>
      </div>
    </header>

    <section class="workspace">
      <aside class="rail" aria-label="Backtest configuration">
        <div class="railGroups">
          <section
            v-for="group in railGroups"
            :key="group.key"
            class="railGroup"
            :class="{ expanded: activeRailGroup === group.key }"
          >
            <button
              type="button"
              class="railGroupButton"
              @click="activeRailGroup = activeRailGroup === group.key ? '' : group.key"
            >
              <span>{{ group.label }}</span>
              <strong>{{ group.primary }}</strong>
              <em>{{ group.secondary }}</em>
            </button>

            <div v-if="activeRailGroup === 'instrument' && group.key === 'instrument'" class="railPanel">
              <label class="field">
                <span>Structure</span>
                <select v-model="ui.structure">
                  <option
                    v-for="structure in STRUCTURE_OPTIONS"
                    :key="structure.value"
                    :value="structure.value"
                  >
                    {{ structure.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>Maturity</span>
                <select v-model.number="ui.maturityDays">
                  <option
                    v-for="maturity in MATURITY_OPTIONS"
                    :key="maturity.value"
                    :value="maturity.value"
                  >
                    {{ maturity.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>Target delta</span>
                <select v-model.number="ui.targetDelta" :disabled="ui.structure === 'straddle'">
                  <option
                    v-for="delta in DELTA_OPTIONS"
                    :key="delta.value"
                    :value="delta.value"
                  >
                    {{ delta.label }}
                  </option>
                </select>
              </label>
            </div>

            <div v-else-if="activeRailGroup === 'entry' && group.key === 'entry'" class="railPanel">
              <label class="field">
                <span>Weekday</span>
                <select v-model.number="ui.entryWeekday">
                  <option
                    v-for="weekday in WEEKDAY_OPTIONS"
                    :key="weekday.value"
                    :value="weekday.value"
                  >
                    {{ weekday.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>Hour UTC</span>
                <select v-model.number="ui.entryHourUtc">
                  <option
                    v-for="hour in HOUR_OPTIONS"
                    :key="hour.value"
                    :value="hour.value"
                  >
                    {{ hour.label }}
                  </option>
                </select>
              </label>
            </div>

            <div v-else-if="activeRailGroup === 'hedging' && group.key === 'hedging'" class="railPanel">
              <label class="toggleField">
                <span>Delta hedge</span>
                <input v-model="ui.hedgeEnabled" type="checkbox" />
              </label>

              <label class="rangeField" :class="{ disabled: !ui.hedgeEnabled }">
                <span>Every {{ ui.hedgeIntervalHours }}h</span>
                <input
                  v-model.number.lazy="ui.hedgeIntervalHours"
                  type="range"
                  min="1"
                  max="24"
                  step="1"
                  :disabled="!ui.hedgeEnabled"
                />
              </label>
            </div>

            <div v-else-if="activeRailGroup === 'exit' && group.key === 'exit'" class="railPanel">
              <label class="toggleField">
                <span>Hold to expiry</span>
                <input v-model="ui.holdToExpiry" type="checkbox" />
              </label>

              <label class="rangeField" :class="{ disabled: ui.holdToExpiry }">
                <span>Hold {{ ui.exitHoldDays }}D</span>
                <input
                  v-model.number.lazy="ui.exitHoldDays"
                  type="range"
                  min="1"
                  :max="(MATURITY_OPTIONS.find(o => o.value === Number(ui.maturityDays)) || MATURITY_OPTIONS[0]).value"
                  step="1"
                  :disabled="ui.holdToExpiry"
                />
              </label>
            </div>

            <div v-else-if="activeRailGroup === group.key" class="railPanel readonlyPanel">
              <div class="readonlyRow">
                <span>{{ group.primary }}</span>
                <strong>{{ group.secondary }}</strong>
              </div>
            </div>
          </section>
        </div>

        <button
          type="button"
          class="runButton"
          :disabled="state.loading || sweepRunning"
          @click="runCurrent"
        >
          Run
        </button>
      </aside>

      <section class="mainPanel">
        <div class="strategyHeader">
          <p>BTC / Thalex parquet history</p>
          <h2>{{ strategyTitle }}</h2>
        </div>

        <section class="summaryStrip" aria-label="Backtest summary">
          <div
            v-for="metric in metrics"
            :key="metric.label"
            class="metric"
            :class="{ skeptical: metric.tone === 'skeptical' }"
          >
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </section>

        <section class="chartPanel">
          <div v-if="state.loading" class="status">
            <strong>Loading</strong>
            <span>{{ state.progress }}</span>
          </div>
          <div v-else-if="state.error" class="status error">
            <strong>Could not run backtest</strong>
            <span>{{ state.error }}</span>
          </div>
          <div v-else-if="mode === 'sweep'" class="sweepPanel">
            <div class="sweepToolbar">
              <label class="field sweepSelect">
                <span>Sweep</span>
                <select v-model="sweepDimension">
                  <option
                    v-for="dimension in SWEEP_DIMENSION_OPTIONS"
                    :key="dimension.value"
                    :value="dimension.value"
                    :disabled="dimension.value === 'delta_band' && ui.structure === 'straddle'"
                  >
                    {{ dimension.label }}
                  </option>
                </select>
              </label>

              <div class="sweepAnnotation">
                <strong>{{ sweepResults.length.toLocaleString("en-US") }} configs tested</strong>
              </div>
            </div>

            <div v-if="sweepRunning" class="sweepEmpty">
              Running {{ sweepProgress }}
            </div>

            <div v-else-if="!sweepResults.length" class="sweepEmpty">
              {{ sweepDimension === "delta_band" && ui.structure === "straddle" ? "Delta band applies to strangle and risk reversal." : "Press Run to sweep this dimension." }}
            </div>

            <div v-else class="sweepGrid" :class="`sweepGrid-${sweepDimension}`">
              <button
                v-for="cell in sweepResults"
                :key="cell.key"
                type="button"
                class="sweepCell"
                :style="sweepCellStyle(cell)"
                @click="applySweepResult(cell)"
              >
                <span>{{ cell.label }}</span>
                <strong>
                  {{ Number.isFinite(cell.sharpe) ? formatNumber.format(cell.sharpe) : "n/a" }}
                </strong>
                <em>{{ formatUsd.format(cell.pnl) }}</em>
              </button>
            </div>
          </div>
          <WeeklyBacktestChart v-else :rows="result?.weeklyChartData || []" />
        </section>

        <div v-if="result" class="runFacts">
          <span>Cycles: {{ result.counts.closedCycles.toLocaleString("en-US") }}</span>
          <span>Return: {{ formatPct.format(result.summary.cumulativeReturnOnNotional) }}</span>
          <span>Entry DTE: {{ formatDte(result.summary.meanEntryDteDays) }} avg</span>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  min-width: 320px;
  background: #050506;
  color: #f0f1f4;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}

.app {
  max-width: none;
  width: 100%;
  min-height: 100vh;
  padding: 0;
  background: #050506;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  gap: 18px;
  padding: 0 22px;
  border-bottom: 1px solid #26262a;
  background: #08080a;
}

h1 {
  margin: 0;
  color: #f5f5f7;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: 0;
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

.workspace {
  display: grid;
  grid-template-columns: 338px minmax(0, 1fr);
  min-height: calc(100vh - 64px);
}

.rail {
  display: flex;
  min-height: calc(100vh - 64px);
  flex-direction: column;
  justify-content: space-between;
  gap: 20px;
  padding: 22px;
  border-right: 1px solid #26262a;
  background: #09090b;
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

.mainPanel {
  min-width: 0;
  padding: 24px 28px 30px;
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

.summaryStrip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.metric {
  display: grid;
  align-content: center;
  min-height: 94px;
  gap: 8px;
  padding: 18px 20px;
  border: 1px solid #222227;
  border-radius: 8px;
  background: #101014;
}

.metric span,
.metric strong {
  color: #f4f4f5;
  font-size: 30px;
  font-weight: 650;
  line-height: 1.05;
}

.metric.skeptical strong {
  color: #d89430;
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

  .summaryStrip {
    grid-template-columns: 1fr;
  }

  .chartPanel {
    padding: 10px;
  }
}
</style>
