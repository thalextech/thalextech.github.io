<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import CycleDetailChart from "./components/CycleDetailChart.vue";
import HedgePerformanceChart from "./components/HedgePerformanceChart.vue";
import SweepResultsChart from "./components/SweepResultsChart.vue";
import WeeklyBacktestChart from "./components/WeeklyBacktestChart.vue";
import { loadThalexHistory } from "./lib/thalexParquet.js";
import { blackScholesPrice } from "./lib/optionPricing.js";
import { computeZeroMtmContours } from "./lib/zeroMtmContours.js";
import {
  DEFAULT_BACKTEST_CONFIG,
  buildCycleDetail,
  computeMaxDrawdown,
  computeBreakEvens,
  normalizeBacktestConfig,
  prepareBacktestData,
  prepareCycleDetailData,
  runWeeklyStraddleBacktest,
  runWeeklyStraddleBacktestBatch,
} from "./lib/weeklyStraddleBacktest.js";

const MATURITY_OPTIONS = [
  { value: 7, label: "7D", minDteDays: 4, maxDteDays: 10 },
  { value: 14, label: "14D", minDteDays: 7, maxDteDays: 28 },
  { value: 30, label: "30D", minDteDays: 14, maxDteDays: 60 },
  { value: 60, label: "60D", minDteDays: 45, maxDteDays: 75 },
  { value: 90, label: "90D", minDteDays: 75, maxDteDays: 135 },
  { value: 180, label: "180D", minDteDays: 135, maxDteDays: 240 },
];

const CALENDAR_MATURITY_OPTIONS = [
  { value: "7-14", label: "7–14D", nearDays: 7, farDays: 14, minDteDays: 5, maxDteDays: 10 },
  { value: "7-30", label: "7–30D", nearDays: 7, farDays: 30, minDteDays: 5, maxDteDays: 10 },
  { value: "14-30", label: "14–30D", nearDays: 14, farDays: 30, minDteDays: 7, maxDteDays: 28 },
  { value: "30-60", label: "30–60D", nearDays: 30, farDays: 60, minDteDays: 14, maxDteDays: 60 },
  { value: "30-90", label: "30–90D", nearDays: 30, farDays: 90, minDteDays: 14, maxDteDays: 60 },
  { value: "30-180", label: "30–180D", nearDays: 30, farDays: 180, minDteDays: 14, maxDteDays: 60 },
  { value: "60-90", label: "60–90D", nearDays: 60, farDays: 90, minDteDays: 45, maxDteDays: 75 },
  { value: "60-180", label: "60–180D", nearDays: 60, farDays: 180, minDteDays: 45, maxDteDays: 75 },
  { value: "90-180", label: "90–180D", nearDays: 90, farDays: 180, minDteDays: 75, maxDteDays: 135 },
];

const STRUCTURE_OPTIONS = [
  { value: "straddle", label: "Straddle" },
  { value: "strangle", label: "Strangle" },
  { value: "risk_reversal", label: "Risk reversal" },
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
  { value: "calendar_spread", label: "Calendar spread" },
];

const DELTA_OPTIONS = [
  { value: 0.05, label: "5D" },
  { value: 0.1, label: "10D" },
  { value: 0.15, label: "15D" },
  { value: 0.25, label: "25D" },
  { value: 0.35, label: "35D" },
  { value: 0.45, label: "45D" },
];
const DEFAULT_DELTA_OPTION = DELTA_OPTIONS.find((option) => option.value === 0.25);

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

const ui = reactive({
  structure: "straddle",
  maturityDays: 7,
  targetDelta: 0.25,
  entryWeekday: 5,
  entryHourUtc: 8,
  hedgeEnabled: true,
  hedgeIntervalHours: 24,
  holdToExpiry: false,
  exitHoldDays: 7,
  longOption: false,
  investmentMode: "notional",
});

const maxExitHoldDays = computed(() => {
  return currentMaturity.value.nearDays ?? currentMaturity.value.value;
});

const maturityOptions = computed(() =>
  ui.structure === "calendar_spread" ? CALENDAR_MATURITY_OPTIONS : MATURITY_OPTIONS,
);
const currentMaturity = computed(() =>
  maturityOptions.value.find((option) => String(option.value) === String(ui.maturityDays)) || maturityOptions.value[0],
);
const showDelta = computed(() => !["straddle", "calendar_spread"].includes(ui.structure));
const rollDayOptions = computed(() =>
  [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 180]
    .filter((days) => days <= maxExitHoldDays.value),
);

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

let runDebounce = null;

function updateHedgeInterval(val) {
  ui.hedgeIntervalHours = Number(val);
}

const hedgePct = computed(() => {
  const val = Number(ui.hedgeIntervalHours) || 1;
  return ((val - 1) / 23) * 100 + '%';
});

const mode = ref("single");
const sweepDimension = ref("entry_hour");
const sweepResults = ref([]);
const sweepRunning = ref(false);
const sweepProgress = ref("");
const sweepTiming = ref(null);
let sweepDataCache = null;


const state = reactive({
  error: "",
  progress: "",
});

const result = ref(null);
const preparedData = ref(null);

const SWEEP_DIMENSIONS = [
  { value: "entry_hour", label: "Entry hour" },
  { value: "entry_weekday", label: "Day of week" },
  { value: "maturity", label: "Maturity" },
  { value: "hedge_frequency", label: "Hedge frequency" },
  { value: "delta_band", label: "Strike delta" },
];

const availableSweepDimensions = computed(() =>
  SWEEP_DIMENSIONS.filter((dimension) => dimension.value !== "delta_band" || showDelta.value),
);
const sweepDimensionLabel = computed(() =>
  SWEEP_DIMENSIONS.find((dimension) => dimension.value === sweepDimension.value)?.label || sweepDimension.value,
);

const formatUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const formatNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

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

const maxDrawdown = computed(() => {
  return computeMaxDrawdown(result.value?.cycleSummary);
});

const maturityConfigOverrides = (maturity) => ({
  targetDteDays: maturity.nearDays ?? maturity.value,
  farTargetDteDays: maturity.farDays,
  minWeeklyDteDays: maturity.minDteDays,
  maxWeeklyDteDays: maturity.maxDteDays,
});

const sweepConfigs = computed(() => {
  if (sweepDimension.value === "entry_hour") {
    return HOUR_OPTIONS.map((hour) => ({
      key: `hour-${hour.value}`,
      label: hour.label,
      overrides: { entryHourUtc: hour.value, hourlyOffset: hour.value },
    }));
  }
  if (sweepDimension.value === "entry_weekday") {
    return WEEKDAY_OPTIONS.map((weekday) => ({
      key: `weekday-${weekday.value}`,
      label: weekday.label,
      overrides: { entryWeekday: weekday.value },
    }));
  }
  if (sweepDimension.value === "maturity") {
    return maturityOptions.value.map((maturity) => ({
      key: `maturity-${maturity.value}`,
      label: maturity.label,
      maturityValue: maturity.value,
      overrides: maturityConfigOverrides(maturity),
    }));
  }
  if (sweepDimension.value === "hedge_frequency") {
    return HEDGE_FREQUENCY_OPTIONS.map((frequency) => ({
      key: `hedge-${frequency.value}`,
      label: frequency.label,
      overrides: { hedgeEnabled: true, hedgeIntervalHours: frequency.value },
    }));
  }
  if (!showDelta.value) return [];
  return DELTA_OPTIONS.map((delta) => ({
    key: `delta-${delta.value}`,
    label: delta.label,
    overrides: { targetDelta: delta.value },
  }));
});

const sweepInsights = computed(() => {
  const rows = sweepResults.value.filter((row) => Number.isFinite(row.pnl));
  if (!rows.length) return null;
  let bestPnl = rows[0];
  let bestSharpe = null;
  let profitable = 0;
  const pnlValues = [];
  for (const row of rows) {
    if (row.pnl > bestPnl.pnl) bestPnl = row;
    if (Number.isFinite(row.sharpe) && (!bestSharpe || row.sharpe > bestSharpe.sharpe)) {
      bestSharpe = row;
    }
    if (row.pnl > 0) profitable += 1;
    pnlValues.push(row.pnl);
  }
  const sortedPnl = pnlValues.sort((a, b) => a - b);
  const middle = Math.floor(sortedPnl.length / 2);
  const medianPnl = sortedPnl.length % 2
    ? sortedPnl[middle]
    : (sortedPnl[middle - 1] + sortedPnl[middle]) / 2;
  return {
    bestPnl,
    bestSharpe,
    medianPnl,
    profitable,
    total: rows.length,
  };
});

const strategyLabels = computed(() => {
  const maturity = currentMaturity.value;
  const structure =
    STRUCTURE_OPTIONS.find((option) => option.value === ui.structure) ||
    STRUCTURE_OPTIONS[0];
  const delta =
    DELTA_OPTIONS.find((option) => option.value === Number(ui.targetDelta)) ||
    DEFAULT_DELTA_OPTION;
  const weekday =
    WEEKDAY_OPTIONS.find((option) => option.value === Number(ui.entryWeekday)) ||
    WEEKDAY_OPTIONS[4];
  const side = ui.longOption ? "Long" : "Short";
  const hour = String(ui.entryHourUtc).padStart(2, "0");
  const option = showDelta.value ? `${delta.label} ${structure.label}` : "ATM";

  let chartStrategy = `${side} straddle ${maturity.label}`;
  if (ui.structure === "strangle") {
    chartStrategy = `${side} strangle ${maturity.label} (${delta.label})`;
  } else if (ui.structure === "risk_reversal") {
    chartStrategy = `Risk reversal ${maturity.label} (${delta.label} call ${ui.longOption ? "long" : "short"} / put ${ui.longOption ? "short" : "long"})`;
  } else if (ui.structure === "call" || ui.structure === "put") {
    chartStrategy = `${side} ${ui.structure} ${maturity.label} (${delta.label})`;
  } else if (ui.structure === "calendar_spread") {
    chartStrategy = `${side} ATM calendar spread ${maturity.label}`;
  }

  return {
    instrument: `BTC · ${side} ${structure.label} · ${maturity.label} ${option} · ${ui.investmentMode === "btc" ? "1 BTC" : "$100k"}`,
    entry: `${weekday.label.slice(0, 3)} ${hour}:00`,
    weekday: weekday.label,
    hedge: !ui.hedgeEnabled
      ? "Off"
      : ui.hedgeIntervalHours === 24
        ? `Daily ${hour}:00 · Perp`
        : `Every ${ui.hedgeIntervalHours}h · Perp`,
    exit: ui.holdToExpiry ? "Hold to expiry" : `Roll every ${ui.exitHoldDays}D`,
    chart: `${chartStrategy}, ${ui.hedgeEnabled ? `hedged every ${ui.hedgeIntervalHours}h` : "unhedged"}`,
  };
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
const chartRef = ref(null);
const sweepChartRef = ref(null);
const chartMode = ref("weekly");
const selectedCycle = ref(null);
const cycleDetailRows = ref([]);
const cycleBreakEvens = ref(null);
const cycleContours = ref(null);
const cycleDetailLoading = ref(false);
const cycleDetailError = ref("");
const cycleDetailCache = new Map();
const cycleRows = computed(() => result.value?.cycleSummary || []);

const chartTitle = computed(() => {
  if (selectedCycle.value) {
    const entry = new Date(selectedCycle.value.entryTime).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return `${entry} cycle · hourly detail`;
  }
  return strategyLabels.value.chart;
});

const chartSubtitle = computed(() => {
  if (selectedCycle.value) {
    const legs = selectedCycle.value.legs
      .map((leg) => leg.instrumentName)
      .join(" · ");
    if (cycleBreakEvens.value) {
      const be = cycleBreakEvens.value;
      const fmt = (v) => Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : null;
      const parts = [];
      if (Number.isFinite(be.lower)) parts.push(`BE low ${fmt(be.lower)}`);
      if (Number.isFinite(be.upper)) parts.push(`BE high ${fmt(be.upper)}`);
      if (parts.length) return `${legs}  ·  ${parts.join(" / ")}`;
    }
    return legs;
  }
  const weekday = WEEKDAY_OPTIONS.find(o => o.value === Number(ui.entryWeekday)) || WEEKDAY_OPTIONS[4];
  const entryTime = `${String(ui.entryHourUtc).padStart(2, "0")}:00 UTC`;
  const exit = ui.holdToExpiry
    ? "Held to expiry"
    : `Rolled after ${ui.exitHoldDays}D`;
  const sizing = ui.investmentMode === "btc" ? "1 BTC per leg" : "$100k notional";
  return `Entered ${weekday.label} at ${entryTime} · ${exit} · ${sizing}`;
});

const chartSourceSubtitle = computed(() => {
  if (!result.value) return "Source: Thalex";
  const start = DEFAULT_BACKTEST_CONFIG.start;
  const end = result.value.dataEnd || new Date();
  const formatPeriodDate = (date) => date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Source: Thalex · Backtest: ${formatPeriodDate(start)} – ${formatPeriodDate(end)}`;
});

const buildConfig = (overrides = {}) => {
  const m = currentMaturity.value;
  return normalizeBacktestConfig({
    end: new Date(),
    ...maturityConfigOverrides(m),
    structure: ui.structure,
    targetDelta: Number(ui.targetDelta),
    entryWeekday: Number(ui.entryWeekday),
    entryHourUtc: Number(ui.entryHourUtc),
    hourlyOffset: Number(ui.entryHourUtc),
    hedgeEnabled: ui.hedgeEnabled,
    hedgeIntervalHours: Number(ui.hedgeIntervalHours),
    holdToExpiry: ui.holdToExpiry,
    exitHoldDays: Number(ui.exitHoldDays),
    longOption: ui.longOption,
    sizingMode: ui.investmentMode,
    btcQuantity: 1,
    ...overrides,
  });
};

const runSweep = async () => {
  if (sweepRunning.value || !sweepConfigs.value.length) return;
  sweepRunning.value = true;
  sweepResults.value = [];
  sweepTiming.value = null;
  state.error = "";
  // Let the running state paint before data preparation and synchronous simulations begin.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cells = sweepConfigs.value;
  const sweepEnd = new Date();
  const configs = cells.map((cell) =>
    buildConfig({ ...cell.overrides, end: sweepEnd }),
  );
  const sweepHours = [...new Set(configs.flatMap((config) =>
    hoursFor(config.entryHourUtc, config.hedgeEnabled, config.hedgeIntervalHours),
  ))].sort((a, b) => a - b);
  const sweepHoursKey = sweepHours.join(",");
  const startedAt = performance.now();
  let loadMs = 0;
  let prepareMs = 0;
  let runMs = 0;
  try {
    let sweepPrepared = preparedData.value;
    if (sweepDataCache?.key === sweepHoursKey) {
      sweepPrepared = sweepDataCache.prepared;
    } else if (loadedHoursKey === sweepHoursKey && sweepPrepared) {
      sweepDataCache = {
        key: sweepHoursKey,
        prepared: sweepPrepared,
      };
    } else {
      sweepProgress.value = `Loading ${sweepHours.length} hourly data shards`;
      const loadStartedAt = performance.now();
      const loaded = await loadThalexHistory({
        start: configs[0].start,
        end: configs[0].end,
        hourlyOffsets: sweepHours,
        onProgress: ({ current, total }) => {
          sweepProgress.value = `Loading data ${current}/${total}`;
        },
      });
      loadMs = performance.now() - loadStartedAt;
      sweepProgress.value = "Preparing shared quote universe";
      const prepareStartedAt = performance.now();
      sweepPrepared = prepareBacktestData({
        indexRows: loaded.indexRows,
        quoteSnapshots: loaded.quoteSnapshots,
        instruments: loaded.artifact.instruments,
        config: configs[0],
      });
      prepareMs = performance.now() - prepareStartedAt;
      sweepDataCache = { key: sweepHoursKey, prepared: sweepPrepared };
    }

    const runStartedAt = performance.now();
    sweepProgress.value = `Running ${cells.length} configurations`;
    const batchRuns = configs.map((config) => ({ config }));
    const batchOutputs = runWeeklyStraddleBacktestBatch({
      preparedData: sweepPrepared,
      runs: batchRuns,
    });

    const nextResults = batchOutputs.map((run, index) => {
      const cell = cells[index];
      const thisConfig = configs[index];
      const weeklyReturns = (run.cycleSummary || []).map((cycle) => ({
        pnl: Number(cycle.cyclePnlUsd) || 0,
        hour: thisConfig.entryHourUtc,
        entryDate: cycle.entryTime,
      }));

      return {
        ...cell,
        config: thisConfig,
        sharpe: run.summary.sharpeRatio,
        pnl: run.summary.finalEquityUsd,
        optionPnl: run.summary.cumulativeOptionPnlUsd,
        hedgePnl: run.summary.cumulativeHedgePnlUsd,
        averageEntryIv: run.summary.meanEntryImpliedVol,
        averageSampledRealizedVol: run.summary.meanSampledRealizedVol,
        maxDrawdown: computeMaxDrawdown(run.cycleSummary),
        cycles: run.counts.closedCycles,
        returnOnNotional: run.summary.cumulativeReturnOnNotional,
        weeklyReturns,
      };
    }).filter((row) => row.weeklyReturns.some(({ pnl }) => pnl !== 0));

    runMs = performance.now() - runStartedAt;
    sweepResults.value = nextResults;
    sweepTiming.value = {
      loadMs,
      prepareMs,
      runMs,
      totalMs: performance.now() - startedAt,
      reusedPreparedData: loadMs === 0,
      cells: cells.length,
    };
    sweepProgress.value = "";
  } catch (error) {
    state.error = error?.message || "Sweep failed";
  } finally {
    sweepRunning.value = false;
  }
};

const applySweepResult = (cell) => {
  if (sweepDimension.value === "entry_hour") {
    ui.entryHourUtc = cell.config.entryHourUtc;
  } else if (sweepDimension.value === "entry_weekday") {
    ui.entryWeekday = cell.config.entryWeekday;
  } else if (sweepDimension.value === "maturity") {
    ui.maturityDays = cell.maturityValue;
  } else if (sweepDimension.value === "hedge_frequency") {
    ui.hedgeEnabled = true;
    ui.hedgeIntervalHours = cell.config.hedgeIntervalHours;
  } else if (sweepDimension.value === "delta_band") {
    ui.targetDelta = cell.config.targetDelta;
  }
  mode.value = "single";
};

const switchMode = (nextMode) => {
  mode.value = nextMode;
  selectedCycle.value = null;
  if (nextMode === "single") {
    scheduleBacktest();
  }
};

const runCurrent = () => {
  if (!preparedData.value) return;
  selectedCycle.value = null;
  cycleDetailRows.value = [];
  cycleBreakEvens.value = null;
  cycleContours.value = null;
  cycleDetailCache.clear();
  const config = buildConfig();
  result.value = runWeeklyStraddleBacktest({
    preparedData: preparedData.value,
    config,
  });
};

const closeCycleDetail = () => {
  selectedCycle.value = null;
  cycleDetailRows.value = [];
  cycleBreakEvens.value = null;
  cycleContours.value = null;
  cycleDetailError.value = "";
};

const handleCycleSelect = async (cycle) => {
  if (!cycle || cycleDetailLoading.value) return;
  selectedCycle.value = cycle;
  cycleBreakEvens.value = computeBreakEvens(cycle);
  cycleDetailError.value = "";
  const cacheKey = `${cycle.entryTs}|${cycle.exitTs}`;
  if (cycleDetailCache.has(cacheKey)) {
    const cached = cycleDetailCache.get(cacheKey);
    cycleDetailRows.value = cached.rows;
    cycleContours.value = cached.contours;
    return;
  }

  cycleDetailLoading.value = true;
  cycleDetailRows.value = [];
  try {
    const config = buildConfig({ start: new Date(cycle.entryTime), end: new Date(cycle.exitTime) });
    const loaded = await loadThalexHistory({
      start: config.start,
      end: config.end,
      hourlyOffsets: Array.from({ length: 24 }, (_, hour) => hour),
    });
    const detailData = prepareCycleDetailData({
      plan: cycle,
      indexRows: loaded.indexRows,
      quoteSnapshots: loaded.quoteSnapshots,
      instruments: loaded.artifact.instruments,
      config,
    });
    const rows = buildCycleDetail({ plan: cycle, preparedData: detailData, config });
    const contours = computeZeroMtmContours({
      plan: cycle,
      preparedData: detailData,
      timestamps: rows.map((row) => row.ts),
      price: blackScholesPrice,
      surfaceMode: "sticky_strike",
    });
    cycleDetailCache.set(cacheKey, { rows, contours });
    cycleDetailRows.value = rows;
    cycleContours.value = contours;
  } catch (error) {
    cycleDetailError.value = error?.message || "Unable to load hourly cycle detail";
  } finally {
    cycleDetailLoading.value = false;
  }
};

const loadBacktest = async () => {
  state.error = "";
  state.progress = "Loading data";
  try {
    const config = buildConfig();
    const loaded = await loadThalexHistory({
      start: config.start,
      end: config.end,
      hourlyOffsets: requiredHours.value,
      onProgress: ({ current, total, file }) => {
        state.progress = `Prepared ${current}/${total}: ${file}`;
      },
    });
    state.progress = "Preparing quotes";
    const nextPreparedData = prepareBacktestData({
      indexRows: loaded.indexRows,
      quoteSnapshots: loaded.quoteSnapshots,
      instruments: loaded.artifact.instruments,
      config,
    });
    preparedData.value = nextPreparedData;
    loadedHoursKey = requiredHoursKey.value;
    state.progress = "Running strategy";
    runCurrent();
    state.progress = "";
  } catch (error) {
    state.error = error?.message || "Backtest failed";
  }
};

const scheduleBacktest = () => {
  state.error = "";
  clearTimeout(runDebounce);
  if (mode.value === "sweep") {
    sweepResults.value = [];
    sweepTiming.value = null;
    return;
  }
  runDebounce = setTimeout(() => {
    if (!preparedData.value || requiredHoursKey.value !== loadedHoursKey) {
      loadBacktest();
    } else {
      runCurrent();
    }
  }, 80);
};

let scheduledUiKey = "";
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
    ui.longOption,
    ui.investmentMode,
  ],
  () => {
    const isCalendarMaturity = CALENDAR_MATURITY_OPTIONS.some(
      (option) => String(option.value) === String(ui.maturityDays),
    );
    if (ui.structure === "calendar_spread" && !isCalendarMaturity) {
      ui.maturityDays = CALENDAR_MATURITY_OPTIONS[0].value;
    } else if (ui.structure !== "calendar_spread" && isCalendarMaturity) {
      ui.maturityDays = MATURITY_OPTIONS[0].value;
    }
    if (ui.exitHoldDays > maxExitHoldDays.value) {
      ui.exitHoldDays = maxExitHoldDays.value;
    }
    if (!showDelta.value && sweepDimension.value === "delta_band") {
      sweepDimension.value = "entry_hour";
    }
    if (!ui.hedgeEnabled) chartMode.value = "weekly";

    const uiKey = [
      ui.maturityDays,
      ui.structure,
      ui.targetDelta,
      ui.entryWeekday,
      ui.entryHourUtc,
      ui.hedgeEnabled,
      ui.hedgeIntervalHours,
      ui.holdToExpiry,
      ui.exitHoldDays,
      ui.longOption,
      ui.investmentMode,
    ].join("|");
    if (uiKey === scheduledUiKey) return;
    scheduledUiKey = uiKey;
    scheduleBacktest();
  },
);

watch(sweepDimension, () => {
  sweepResults.value = [];
  sweepTiming.value = null;
  sweepProgress.value = "";
});

function handleSavePng() {
  const date = new Date().toISOString().slice(0, 10);

  if (mode.value === 'sweep') {
    if (!sweepChartRef.value) return;
    const filename = `sweep-${sweepDimension.value}-${date}.png`;
    sweepChartRef.value.exportPng({
      title: `Parameter Sweep: ${sweepDimensionLabel.value}`,
      subtitle: chartSubtitle.value,
      source: chartSourceSubtitle.value,
      metrics: sweepInsights.value ? [
        { label: "BEST PNL", value: `${sweepInsights.value.bestPnl.label} ${formatUsd.format(sweepInsights.value.bestPnl.pnl)}` },
        { label: "BEST SHARPE", value: sweepInsights.value.bestSharpe ? `${sweepInsights.value.bestSharpe.label} ${formatNumber.format(sweepInsights.value.bestSharpe.sharpe)}` : '—' },
        { label: "RUNS", value: String(sweepResults.value.length) },
      ] : [],
      filename,
      scale: 3,
      padding: 24,
    });
    return;
  }

  if (!chartRef.value) return;

  const filename = selectedCycle.value
    ? `cycle-detail-${date}.png`
    : chartMode.value === "hedge"
    ? `hedge-performance-${date}.png`
    : `backtest-${date}.png`;
  chartRef.value.exportPng({
    filename,
    scale: 3,
    title: chartTitle.value,
    subtitle: chartSubtitle.value,
    source: chartSourceSubtitle.value,
    metrics: [
      { label: "FINAL PNL", value: finalPnlValue.value },
      { label: "SHARPE", value: sharpeValue.value },
      { label: "MAX DRAWDOWN", value: maxDdValue.value, muted: true },
    ],
  });
}

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
        <div class="pill instrumentPill" style="position: relative;" @click="toggleMenu('instrument')">
          <span class="pillLabel">Instrument</span>
          <span class="pillValue">{{ strategyLabels.instrument }}</span>
          <div v-if="openMenu === 'instrument'" class="dropdown instrument-dropdown" @click.stop>
            <div class="inst-field">
              <label class="inst-label">Side</label>
              <div class="inst-choices side-choices">
                <div
                  :class="['inst-choice', { active: !ui.longOption }]"
                  @click="ui.longOption = false"
                >
                  Short
                </div>
                <div
                  :class="['inst-choice', { active: ui.longOption }]"
                  @click="ui.longOption = true"
                >
                  Long
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Structure</label>
              <div class="inst-choices structure-choices">
                <div
                  v-for="s in STRUCTURE_OPTIONS"
                  :key="s.value"
                  :class="['inst-choice', { active: ui.structure === s.value }]"
                  @click="ui.structure = s.value"
                >
                  {{ s.label }}
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Maturity</label>
              <div class="inst-choices maturity-choices">
                <div
                  v-for="m in maturityOptions"
                  :key="m.value"
                  :class="['inst-choice', { active: String(ui.maturityDays) === String(m.value) }]"
                  @click="ui.maturityDays = m.value"
                >
                  {{ m.label }}
                </div>
              </div>
            </div>
            <div v-if="showDelta" class="inst-field">
              <label class="inst-label">Delta</label>
              <div class="inst-choices delta-choices">
                <div
                  v-for="d in DELTA_OPTIONS"
                  :key="d.value"
                  :class="['inst-choice', { active: Number(ui.targetDelta) === d.value }]"
                  @click="ui.targetDelta = d.value"
                >
                  {{ d.label }}
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Investment amount</label>
              <div class="inst-choices side-choices">
                <div
                  :class="['inst-choice', { active: ui.investmentMode === 'notional' }]"
                  @click="ui.investmentMode = 'notional'"
                >
                  $100k notional
                </div>
                <div
                  :class="['inst-choice', { active: ui.investmentMode === 'btc' }]"
                  @click="ui.investmentMode = 'btc'"
                >
                  1 BTC
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Entry -->
        <div class="pill entryPill" style="position: relative;" @click="toggleMenu('entry')">
          <span class="pillLabel">Entry</span>
          <span class="pillValue">{{ strategyLabels.entry }}</span>
          <div v-if="openMenu === 'entry'" class="dropdown entry-dropdown" @click.stop>
            <label class="inst-label" style="margin-bottom: 3px;">Weekday</label>
            <div class="inst-choices weekday-choices">
              <div
                v-for="w in WEEKDAY_OPTIONS"
                :key="w.value"
                :class="['inst-choice', { active: Number(ui.entryWeekday) === w.value }]"
                @click="ui.entryWeekday = w.value"
              >
                {{ w.label.slice(0,3) }}
              </div>
            </div>
            <div class="entry-picker">
              <div class="entry-picker__header">
                <span class="entry-picker__day">{{ strategyLabels.weekday }}</span>
                <span class="entry-picker__time">{{ String(ui.entryHourUtc).padStart(2,'0') }}:00</span>
              </div>
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
        </div>

        <!-- Hedge -->
        <div class="pill hedgePill" style="position: relative;" @click="toggleMenu('hedge')">
          <span class="pillLabel">Hedge</span>
          <span class="pillValue">{{ strategyLabels.hedge }}</span>
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
              :value="ui.hedgeIntervalHours"
              @input="updateHedgeInterval(Number($event.target.value))"
              :style="{ '--pct': hedgePct }"
              :disabled="!ui.hedgeEnabled"
              @change="openMenu = null"
            >
            <div class="freq-footer">
              <span class="freq-footer__edge">1h</span>
              <span class="freq-footer__value">Every {{ ui.hedgeIntervalHours }}h</span>
              <span class="freq-footer__edge">24h</span>
            </div>
          </div>
        </div>

        <!-- Exit -->
        <div class="pill exitPill" style="position: relative;" @click="toggleMenu('exit')">
          <span class="pillLabel">Exit</span>
          <span class="pillValue">{{ strategyLabels.exit }}</span>
          <div v-if="openMenu === 'exit'" class="dropdown" @click.stop>
            <div class="freq-toggle-row">
              <span class="freq-row__label">Hold to expiry</span>
              <label class="toggle-switch">
                <input type="checkbox" v-model="ui.holdToExpiry" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div v-if="!ui.holdToExpiry">
              <label class="freq-row__label">Roll every</label>
              <div class="inst-choices exit-day-choices">
                <button
                  v-for="days in rollDayOptions"
                  :key="days"
                  type="button"
                  :class="['inst-choice', { active: ui.exitHoldDays === days }]"
                  @click="ui.exitHoldDays = days; openMenu = null"
                >
                  {{ days }}D
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="spacer"></div>

      <div class="segmented">
        <button
          type="button"
          :class="['segment', { active: mode === 'single' }]"
          @click="switchMode('single')"
        >
          Single run
        </button>
        <button
          type="button"
          :class="['segment', { active: mode === 'sweep' }]"
          @click="switchMode('sweep')"
        >
          Sweep
        </button>
      </div>
      <button class="saveButton topSaveButton" type="button" :disabled="mode === 'single' ? cycleDetailLoading : (sweepRunning || !sweepResults.length)" @click="handleSavePng">
        Save PNG
      </button>
    </div>

    <div class="main">
      <!-- Left metrics column -->
      <div class="metricsColumn">
        <template v-if="mode === 'single'">
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
        </template>
        <template v-else-if="sweepInsights">
          <div class="metric">
            <div class="metricValue">{{ sweepInsights.bestPnl.label }}</div>
            <div class="metricLabel">BEST PNL · {{ formatUsd.format(sweepInsights.bestPnl.pnl) }}</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ sweepInsights.bestSharpe?.label || '—' }}</div>
            <div class="metricLabel">BEST SHARPE · {{ sweepInsights.bestSharpe ? formatNumber.format(sweepInsights.bestSharpe.sharpe) : '—' }}</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ sweepInsights.profitable }}/{{ sweepInsights.total }}</div>
            <div class="metricLabel">PROFIT · {{ formatUsd.format(sweepInsights.medianPnl) }}</div>
          </div>
        </template>
      </div>

      <!-- Chart area -->
      <div class="chartColumn">
        <div v-if="mode === 'single'" class="chartHeader">
          <div class="chartTitleRow">
            <button
              v-if="selectedCycle"
              class="backButton"
              type="button"
              @click="closeCycleDetail"
              title="Back to cycles"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div class="chartTitle">
              <span>{{ chartTitle }}</span>
            </div>
          </div>
          <div class="chartSubtitle">{{ chartSubtitle }}</div>
          <div class="chartSourceSubtitle">{{ chartSourceSubtitle }}</div>
        </div>

        <div v-else class="sweepHeader">
          <div>
            <div class="chartTitle">Parameter sweep</div>
            <div v-if="!sweepResults.length && !sweepRunning" class="chartSubtitle">Compare one dimension while holding the current strategy settings fixed. Click a result to apply it.</div>
          </div>
          <div class="sweepControls">
            <div class="sweepDimensionControl" role="group" aria-label="Sweep dimension">
              <button
                v-for="dimension in availableSweepDimensions"
                :key="dimension.value"
                type="button"
                :class="{ active: sweepDimension === dimension.value }"
                :disabled="sweepRunning"
                @click="sweepDimension = dimension.value"
              >{{ dimension.label }}</button>
            </div>
            <button class="runSweepButton" type="button" :disabled="sweepRunning" @click="runSweep">
              {{ sweepRunning ? sweepProgress || 'Running…' : sweepResults.length ? 'Run' : 'Run sweep' }}
            </button>
          </div>
        </div>

        <WeeklyBacktestChart
          v-if="mode === 'single' && !selectedCycle && chartMode === 'weekly'"
          ref="chartRef"
          :rows="cycleRows"
          :design-spec="true"
          @select="handleCycleSelect"
        />
        <HedgePerformanceChart
          v-else-if="mode === 'single' && !selectedCycle"
          ref="chartRef"
          :rows="cycleRows"
          @select="handleCycleSelect"
        />
        <div v-else-if="mode === 'single' && cycleDetailLoading" class="cycleDetailState">Loading hourly detail…</div>
        <div v-else-if="mode === 'single' && cycleDetailError" class="cycleDetailState error">{{ cycleDetailError }}</div>
        <CycleDetailChart
          v-else-if="mode === 'single'"
          ref="chartRef"
          :rows="cycleDetailRows"
          :break-evens="cycleBreakEvens"
          :zero-mtm-contours="cycleContours"
        />

        <div v-else class="sweepPanel">
          <div v-if="sweepRunning && !sweepResults.length" class="sweepEmpty">{{ sweepProgress || 'Preparing sweep…' }}</div>

          <SweepResultsChart
            v-else-if="sweepResults.length"
            ref="sweepChartRef"
            class="sweepHistogram"
            :rows="sweepResults"
            :dimension="sweepDimension"
            :dimension-label="sweepDimensionLabel"
            @select="applySweepResult"
          />
          <div v-else class="sweepEmpty">Choose a dimension, then run the sweep. Results include PnL, Sharpe, drawdown, and sample size.</div>
          <div v-if="sweepTiming" class="sweepPerformance">
            {{ sweepTiming.cells }} runs in {{ (sweepTiming.totalMs / 1000).toFixed(2) }}s
            · strategy {{ (sweepTiming.runMs / 1000).toFixed(2) }}s
            · {{ sweepTiming.reusedPreparedData ? 'reused loaded data' : `load ${(sweepTiming.loadMs / 1000).toFixed(2)}s · prepare ${(sweepTiming.prepareMs / 1000).toFixed(2)}s` }}
          </div>
        </div>

        <div v-if="mode === 'single' && ui.hedgeEnabled && !selectedCycle" class="chartModeToggle" role="group" aria-label="Chart view">
          <button
            type="button"
            :class="{ active: chartMode === 'weekly' }"
            :aria-pressed="chartMode === 'weekly'"
            @click="chartMode = 'weekly'"
          >
            PnL by cycle
          </button>
          <button
            type="button"
            :class="{ active: chartMode === 'hedge' }"
            :aria-pressed="chartMode === 'hedge'"
            @click="chartMode = 'hedge'"
          >
            Hedge perf
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  --color-bg: #0a0b0e;
  --color-surface: #131316;
  --color-surface-raised: #1a1a1f;
  --color-text: #e8eaed;
  --color-text-muted: #70767d;
  --color-accent: #7dd3fc;
  --color-border-subtle: rgba(255, 255, 255, 0.06);
  --color-border: rgba(255, 255, 255, 0.09);
  --color-border-strong: rgba(255, 255, 255, 0.2);
  --color-overlay: rgba(0, 0, 0, 0.5);
}

:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  color-scheme: dark;
}

.app {
  max-width: none;
  width: 100%;
  min-height: 100vh;
  padding: 0;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;
}

.topBar {
  display: flex;
  align-items: center;
  height: 58px;
  padding: 0 28px;
  border-bottom: 1px solid var(--color-border-subtle);
  gap: 20px;
  flex-shrink: 0;
}

.wordmark {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
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

.instrumentPill { order: 0; }
.hedgePill { order: 1; }
.entryPill { order: 2; }
.exitPill { order: 3; }

.pill {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 1px solid var(--color-border);
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
  border-color: var(--color-border-strong);
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
  border: 1px solid var(--color-border-strong);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.pill select option,
.dropdown select option {
  background: var(--color-bg);
  color: var(--color-text);
}

/* In dropdowns, no borders on inner inputs */
.dropdown select {
  border: 1px solid rgba(255,255,255,0.1);
  background: var(--color-bg);
  color: var(--color-text);
  padding: 6px 8px;
  width: 100%;
  margin-bottom: 4px;
  border-radius: 4px;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  font-size: 12px;
  color-scheme: dark;
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

.instrument-dropdown {
  width: min(460px, calc(100vw - 20px));
  min-width: min(460px, calc(100vw - 20px));
  left: -1px;
  right: auto;
  background: #0a0b0e;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 14px 12px;
}

/* Make the content inside instrument dropdown scale horizontally to the new width */
.instrument-dropdown .inst-field {
  width: 100%;
}
.instrument-dropdown .inst-choices {
  width: 100%;
}

/* Ensure no inner borders on dropdown content */
.dropdown .freq-toggle-row,
.dropdown .freq-row__label,
.dropdown .freq-footer {
  border: none;
}

/* Base dropdown selects are styled via the .dropdown select rule above */

.entry-dropdown {
  min-width: 340px;
  background: #0f0f12;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 18px;
  padding: 10px;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.8),
              0 0 0 1px rgba(255, 255, 255, 0.02);
}

.entry-picker {
  margin-top: 10px;
  background: transparent;
}

.entry-picker__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #131316;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  margin: 2px 2px 8px;
}

.entry-picker__day {
  font-size: 13px;
  font-weight: 600;
  color: #e7e7ea;
}

.entry-picker__time {
  font-size: 12px;
  font-weight: 500;
  color: #71717a;
  font-variant-numeric: tabular-nums;
}

.hour-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  padding: 1px 1px 1px;
}

.hour-grid button {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0;
  background: #131316;
  color: #e7e7ea;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: background 0.12s, border-color 0.12s;
}

.hour-grid button:hover {
  background: #1a1a1f;
  border-color: rgba(255, 255, 255, 0.16);
}

.hour-grid button.active {
  background: #f4f4f5;
  color: #0a0a0b;
  border-color: #f4f4f5;
  font-weight: 700;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
}

.inst-field {
  background: transparent;
  border-radius: 0;
  padding: 0;
  margin-bottom: 16px;
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

.inst-choices {
  display: flex;
  gap: 4px;
}

.side-choices {
  gap: 0;
}
.side-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.side-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.side-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.side-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.delta-choices {
  gap: 0;
}
.delta-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.delta-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.delta-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.delta-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.structure-choices,
.maturity-choices {
  gap: 0;
}
.structure-choices .inst-choice,
.maturity-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.structure-choices .inst-choice {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.15;
}
.structure-choices .inst-choice:first-child,
.maturity-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.structure-choices .inst-choice:last-child,
.maturity-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.structure-choices .inst-choice + .inst-choice,
.maturity-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.structure-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 4px;
}
.structure-choices .inst-choice {
  margin: 0;
  border-radius: 0;
  border: 0;
}
.structure-choices .inst-choice:nth-child(3n + 2),
.structure-choices .inst-choice:nth-child(3n + 3) {
  margin-left: 0;
  border-left: 1px solid rgba(255,255,255,0.18);
}
.structure-choices .inst-choice:nth-child(n + 4) {
  margin-top: 0;
  border-top: 1px solid rgba(255,255,255,0.18);
}

.maturity-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 4px;
}
.maturity-choices .inst-choice {
  margin: 0;
  border: 0;
  border-radius: 0;
}
.maturity-choices .inst-choice:nth-child(3n + 2),
.maturity-choices .inst-choice:nth-child(3n + 3) {
  margin-left: 0;
  border-left: 1px solid rgba(255,255,255,0.18);
}
.maturity-choices .inst-choice:nth-child(n + 4) {
  margin-top: 0;
  border-top: 1px solid rgba(255,255,255,0.18);
}

.weekday-choices .inst-choice {
  font-size: 10px;
  padding: 4px 2px;
}

.exit-day-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.exit-day-choices .inst-choice {
  width: 100%;
  font: inherit;
}

.inst-choice {
  flex: 1;
  text-align: center;
  padding: 5px 6px;
  font-size: 11px;
  background: #0a0b0e;
  color: #e8eaed;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.1s;
  user-select: none;
}

.inst-choice:hover:not(.is-disabled) {
  background: #111114;
  border-color: rgba(255,255,255,0.3);
}

.inst-choice.active {
  background: #7dd3fc;
  color: #000;
  border-color: #7dd3fc;
  font-weight: 500;
}

.inst-choice.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: #0a0b0e;
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
  width: 14px; height: 14px; margin-top: -4px;
  border-radius: 50%; border: none;
  background: var(--handle, #ffffff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.freq-slider::-moz-range-thumb {
  width: 14px; height: 14px;
  border-radius: 50%; border: none;
  background: var(--handle, #ffffff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.06);
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
  align-items: center;
  height: 30px;
  box-sizing: border-box;
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 2px;
}

.segment {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #70767d;
  height: 26px;
  padding: 0 14px;
  line-height: 1;
  border-radius: 6px;
  cursor: pointer;
}

.segment.active {
  background: rgba(255,255,255,0.1);
  color: #e8eaed;
}

.sweepHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 44px;
  padding: 0 4px 5px;
}

.sweepHeader .chartTitle,
.sweepHeader .chartSubtitle {
  text-align: left;
}

.sweepControls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sweepDimensionControl {
  display: flex;
  align-items: center;
  height: 30px;
  box-sizing: border-box;
  padding: 2px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px;
  background: #0d0e11;
}

.sweepDimensionControl button,
.runSweepButton {
  height: 24px;
  box-sizing: border-box;
  border: 0;
  border-radius: 5px;
  padding: 0 11px;
  background: transparent;
  color: #747a82;
  font: 500 11px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.sweepDimensionControl button:hover:not(:disabled) {
  color: #d8dadd;
  background: rgba(255,255,255,0.045);
}

.sweepDimensionControl button.active {
  color: #f0f1f2;
  background: rgba(255,255,255,0.1);
}

.runSweepButton {
  height: 30px;
  min-width: 88px;
  border: 1px solid rgba(125,211,252,0.28);
  color: #7dd3fc;
  background: rgba(125,211,252,0.07);
}

.runSweepButton:hover:not(:disabled) {
  background: rgba(125,211,252,0.13);
  border-color: rgba(125,211,252,0.42);
}

.sweepDimensionControl button:disabled,
.runSweepButton:disabled {
  cursor: default;
  opacity: 0.5;
}

.sweepPanel {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.055);
  border-radius: 8px;
  background: #090a0d;
}

.sweepHistogram {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.sweepEmpty {
  height: 100%;
  display: grid;
  place-items: center;
  color: #666c73;
  font-size: 12px;
}

.sweepPerformance {
  position: absolute;
  right: 12px;
  bottom: 8px;
  padding: 5px 8px;
  border-radius: 5px;
  background: rgba(10,11,14,0.88);
  color: #626870;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
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
  padding: 10px 36px 16px 28px;
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

.chartColumn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.chartHeader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  flex: none;
}

.chartTitle {
  width: 100%;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  color: #e8eaed;
}

.chartSubtitle {
  font-size: 12px;
  color: #70767d;
}

.chartSourceSubtitle {
  font-size: 11px;
  color: #565c63;
}

.chartTitleRow {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 0 36px;
}

.backButton {
  position: absolute;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  color: #70767d;
  cursor: pointer;
  transition: all 0.1s;
}

.backButton:hover {
  color: #7dd3fc;
  border-color: rgba(125, 211, 252, 0.3);
  background: rgba(255, 255, 255, 0.03);
}

.chartModeToggle {
  align-self: center;
  display: flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: rgba(255,255,255,0.05);
}

.chartModeToggle button {
  padding: 5px 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #70767d;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}

.chartModeToggle button.active {
  background: rgba(255,255,255,0.1);
  color: #e8eaed;
}

.saveButton {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: transparent;
  color: #70767d;
  cursor: pointer;
  transition: all 0.1s;
}

.saveButton:hover {
  color: #7dd3fc;
  border-color: rgba(125, 211, 252, 0.3);
  background: rgba(255, 255, 255, 0.03);
}

.topSaveButton {
  height: 30px;
  box-sizing: border-box;
  padding: 0 12px;
  border-radius: 6px;
}

.saveButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.cycleDetailState {
  flex: 1;
  display: grid;
  place-items: center;
  color: #70767d;
  font-size: 13px;
}

.cycleDetailState.error {
  color: #f87171;
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
