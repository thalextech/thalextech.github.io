<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import DfollowChart from "./components/DfollowChart.vue";
import {
  calcGreeks,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", intervalSeconds: 60 },
  300: { label: "5m", resolution: "5m", intervalSeconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", intervalSeconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", intervalSeconds: 60 * 60 },
};
const DEFAULT_POINT_LIMIT = 480;

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  targetMaturity: "",
  targetStrike: "",
  targetType: "put",
  targetAmount: 1,
  period: 12 * 60 * 60,
  threshold: 0.02,
  tolerance: 0.16,
  loading: false,
  error: "",
});

const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  options: [],
  hedges: [],
  targetMark: {},
  hedgeMark: {},
  index: {},
});
const chartRef = ref(null);
const initialized = ref(false);
let loadRequestId = 0;

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});
const strikeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const amountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});
const deltaFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});
const normalizeCreateTimeSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
};

const normalizeInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const type = String(instrument.type || instrument.kind || "").toLowerCase();
  return {
    ...instrument,
    type_normalized: type,
    create_time_s: normalizeCreateTimeSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    ),
    expiration_ts: Number(instrument.expiration_timestamp),
    strike: Number(instrument.strike_price),
    option_type_normalized: String(
      instrument.option_type || "",
    ).toLowerCase(),
  };
};

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const config = RESOLUTION_CONFIG[ui.resolutionKey] || RESOLUTION_CONFIG[300];
  const maxPoints = DEFAULT_POINT_LIMIT;
  const to = now - (now % config.intervalSeconds);
  return {
    resolution: config.resolution,
    from: to - config.intervalSeconds * (maxPoints - 1),
    to,
    maxPoints,
  };
};

const getLatestIndexClose = (rows) => {
  for (let i = (rows?.length || 0) - 1; i >= 0; i -= 1) {
    const close = rows[i]?.index_price_close;
    if (Number.isFinite(close)) return close;
  }
  return null;
};

const optionMaturities = computed(() => {
  const expiries = Array.from(
    new Set(
      data.options
        .map((instrument) => instrument.expiration_ts)
        .filter((ts) => Number.isFinite(ts) && ts > 0),
    ),
  ).sort((a, b) => a - b);

  return expiries.map((ts) => ({
    value: String(ts),
    label: `${maturityFormatter.format(new Date(ts * 1000))} UTC`,
  }));
});

const selectedMaturityTs = computed(() => Number(ui.targetMaturity));

const targetOptionsForMaturity = computed(() =>
  data.options.filter(
    (instrument) => instrument.expiration_ts === selectedMaturityTs.value,
  ),
);

const targetStrikes = computed(() => {
  const strikes = Array.from(
    new Set(
      targetOptionsForMaturity.value
        .filter(
          (instrument) => instrument.option_type_normalized === ui.targetType,
        )
        .map((instrument) => instrument.strike)
        .filter((strike) => Number.isFinite(strike)),
    ),
  ).sort((a, b) => a - b);

  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const targetInstrument = computed(() => {
  const strike = Number(ui.targetStrike);
  return (
    data.options.find(
      (instrument) =>
        instrument.expiration_ts === selectedMaturityTs.value &&
        instrument.strike === strike &&
        instrument.option_type_normalized === ui.targetType,
    ) || null
  );
});

const targetInstrumentName = computed({
  get() {
    return targetInstrument.value?.instrument_name || "";
  },
  set(nextName) {
    const instrument = data.options.find(
      (option) => option.instrument_name === nextName,
    );
    if (!instrument) return;
    ui.targetMaturity = String(instrument.expiration_ts);
    ui.targetStrike = String(instrument.strike);
    ui.targetType = instrument.option_type_normalized === "call" ? "call" : "put";
  },
});

const hedgeInstrument = computed(
  () => data.hedges[0] || null,
);

const targetTitle = computed(() => targetInstrument.value?.instrument_name || "");
const thresholdValue = computed(() => {
  const value = Number(ui.threshold);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
});
const toleranceValue = computed(() => {
  const value = Number(ui.tolerance);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(thresholdValue.value, value);
});
const periodHours = computed(() => {
  const period = Number(ui.period);
  if (!Number.isFinite(period)) return "0h";
  if (period < 3600) return `${Math.round(period / 60)}m`;
  return `${Math.round((period / 3600) * 10) / 10}h`;
});

const chartSubtitle = computed(() => {
  if (!targetTitle.value) return "";
  return `${targetTitle.value} x ${amountFormatter.format(Number(ui.targetAmount))}, threshold ${deltaFormatter.format(thresholdValue.value)}, tolerance ${deltaFormatter.format(toleranceValue.value)}, period ${periodHours.value}`;
});

const thalexUrl = computed(() => {
  let url = "https://thalex.com/exchange/bots?strategy=dfollow";

  if (targetInstrumentName.value) {
    url += `&target_instrument=${targetInstrumentName.value}`
  }

  if (ui.targetAmount) {
    url += `&amount=${ui.targetAmount}`
  }

  if (ui.period) {
    url += `&period=${ui.period}`;
  }

  if (thresholdValue.value) {
    url += `&threshold=${thresholdValue.value}`;
  }

  if (toleranceValue.value) {
    url += `&tolerance=${toleranceValue.value}`;
  }

  return url;
});

const slugValue = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const optionDelta = ({ instrument, markPoint, indexPoint }) => {
  const spot = Number(indexPoint?.index_price_close);
  const strike = Number(instrument?.strike);
  const expiration = Number(instrument?.expiration_ts);
  const ts = Number(markPoint?.ts);
  const iv = Number(markPoint?.iv_close);
  const optionType =
    instrument?.option_type_normalized === "put" ? "put" : "call";
  const greeks = calcGreeks(spot, strike, expiration - ts, iv, optionType);
  return Number.isFinite(greeks.delta) ? greeks.delta : null;
};

const unitDelta = ({ instrument, markPoint, indexPoint }) => {
  if (!instrument) return null;
  if (instrument.type_normalized === "option") {
    return optionDelta({ instrument, markPoint, indexPoint });
  }
  return 1;
};

const markClose = (row, fallback = null) => {
  const value = Number(row?.mark_price_close);
  if (Number.isFinite(value)) return value;
  return Number.isFinite(fallback) ? fallback : null;
};

function buildDfollowSimulation({
  indexRows,
  targetRows,
  hedgeRows,
  target,
  hedge,
  settings,
}) {
  if (!target || !hedge) return { rows: [], trades: [] };

  const indexByTs = new Map(
    (indexRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );
  const targetByTs = new Map(
    (targetRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );
  const hedgeByTs = new Map(
    (hedgeRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );

  const timestamps = Array.from(targetByTs.keys())
    .filter((ts) => indexByTs.has(ts) && hedgeByTs.has(ts))
    .sort((a, b) => a - b);

  let position = 0;
  let cash = 0;
  let initialTargetPrice = null;

  let breachStartTs = null;
  const rows = [];
  const trades = [];

  for (const ts of timestamps) {
    const indexPoint = indexByTs.get(ts);
    const targetPoint = targetByTs.get(ts);
    const hedgePoint = hedgeByTs.get(ts);
    const hedgePrice = markClose(hedgePoint, indexPoint.index_price_close);
    const targetPrice = markClose(targetPoint);
    const targetUnitDelta = unitDelta({
      instrument: target,
      markPoint: targetPoint,
      indexPoint,
    });
    const hedgeUnitDelta = unitDelta({
      instrument: hedge,
      markPoint: hedgePoint,
      indexPoint,
    });

    if (!Number.isFinite(targetUnitDelta) || !Number.isFinite(hedgeUnitDelta)) {
      continue;
    }
    if (!Number.isFinite(hedgePrice) || !Number.isFinite(targetPrice)) continue;
    if (Math.abs(hedgeUnitDelta) < 1e-8) continue;
    if (!Number.isFinite(initialTargetPrice)) initialTargetPrice = targetPrice;

    const targetAmount = Number(settings.targetAmount);
    const safeTargetAmount = Number.isFinite(targetAmount) ? targetAmount : 0;
    const targetDelta = targetUnitDelta * safeTargetAmount;
    const portfolioDeltaBefore = position * hedgeUnitDelta;
    const deviationBefore = portfolioDeltaBefore - targetDelta;
    const absDeviation = Math.abs(deviationBefore);
    const thresholdInput = Number(settings.threshold);
    const toleranceInput = Number(settings.tolerance);
    const periodInput = Number(settings.period);
    const threshold = Number.isFinite(thresholdInput)
      ? Math.max(0, thresholdInput)
      : 0;
    const tolerance =
      Number.isFinite(toleranceInput) && toleranceInput > 0
        ? Math.max(threshold, toleranceInput)
        : 0;
    const period = Number.isFinite(periodInput) ? Math.max(0, periodInput) : 0;

    const outsideTolerance = tolerance > 0 && absDeviation > tolerance;
    const outsideThreshold = absDeviation > threshold;
    let trigger = null;

    if (outsideTolerance) {
      trigger = "tolerance";
    } else if (outsideThreshold) {
      if (breachStartTs == null) breachStartTs = ts;
      if (ts - breachStartTs >= period) trigger = "period";
    } else {
      breachStartTs = null;
    }

    let tradeAmount = 0;
    if (trigger) {
      const nextPosition = targetDelta / hedgeUnitDelta;
      tradeAmount = nextPosition - position;
      cash -= tradeAmount * hedgePrice;
      position = nextPosition;
      breachStartTs = null;
      trades.push({
        ts,
        date: new Date(ts * 1000),
        trigger,
        tradeAmount,
        position,
        targetDelta,
        deviationBefore,
        hedgePrice,
      });
    }

    const botPnl = cash + position * hedgePrice;
    const optionPnl = Number.isFinite(initialTargetPrice)
      ? safeTargetAmount * (targetPrice - initialTargetPrice)
      : 0;
    const cumulativePnl = optionPnl - botPnl;

    rows.push({
      ts,
      date: new Date(ts * 1000),
      indexPrice: indexPoint.index_price_close,
      hedgePrice,
      targetPrice,
      targetDelta,
      portfolioDelta: position * hedgeUnitDelta,
      deviation: position * hedgeUnitDelta - targetDelta,
      targetUnitDelta,
      hedgeUnitDelta,
      position,
      cash,
      botPnl,
      optionPnl,
      cumulativePnl,
      tradeAmount,
    });
  }

  return { rows, trades };
}

const simulation = computed(() =>
  buildDfollowSimulation({
    indexRows: data.index[ui.resolutionKey] || [],
    targetRows: data.targetMark[ui.resolutionKey] || [],
    hedgeRows: data.hedgeMark[ui.resolutionKey] || [],
    target: targetInstrument.value,
    hedge: hedgeInstrument.value,
    settings: ui,
  }),
);

const simulationRows = computed(() => simulation.value.rows);
const trades = computed(() => simulation.value.trades);

const canSavePng = computed(() => simulationRows.value.length > 0);

function handleSavePng() {
  if (!chartRef.value) return;
  const base = targetInstrument.value?.instrument_name || "dfollow";
  const parts = [
    base,
    "dfollow",
    `period_${periodHours.value}`,
    `threshold_${thresholdValue.value}`,
    `tolerance_${toleranceValue.value}`,
  ].map(slugValue);
  chartRef.value.exportPng({ filename: `${parts.join("-")}.png` });
}

const chooseClosestStrike = () => {
  const latestIndex = getLatestIndexClose(data.index[ui.resolutionKey] || []);
  const strikes = targetStrikes.value;
  if (!strikes.length) {
    ui.targetStrike = "";
    return;
  }
  if (!Number.isFinite(latestIndex)) {
    ui.targetStrike = strikes[Math.floor(strikes.length / 2)].value;
    return;
  }

  let best = strikes[0];
  let bestDistance = Infinity;
  for (const strike of strikes) {
    const numeric = Number(strike.value);
    const distance = Math.abs(numeric - latestIndex);
    if (distance < bestDistance) {
      best = strike;
      bestDistance = distance;
    }
  }
  ui.targetStrike = best.value;
};

const chooseDefaultMaturity = () => {
  const maturities = optionMaturities.value.map((maturity) => Number(maturity.value));
  if (!maturities.length) {
    ui.targetMaturity = "";
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);
  const currentMonth = nowDate.getUTCMonth();
  const targetMonth = (currentMonth + 1) % 12;
  const targetYear = nowDate.getUTCFullYear() + (currentMonth === 11 ? 1 : 0);
  const targetMonthMaturities = maturities.filter((ts) => {
    const date = new Date(ts * 1000);
    return (
      date.getUTCFullYear() === targetYear &&
      date.getUTCMonth() === targetMonth
    );
  });
  if (targetMonthMaturities.length) {
    ui.targetMaturity = String(targetMonthMaturities[targetMonthMaturities.length - 1]);
    return;
  }

  const target = now + 28 * 24 * 60 * 60;
  const upcoming = maturities.filter((ts) => ts > now);
  const candidates = upcoming.length ? upcoming : maturities;
  const best = candidates.reduce((currentBest, ts) => {
    if (!Number.isFinite(currentBest)) return ts;
    return Math.abs(ts - target) < Math.abs(currentBest - target)
      ? ts
      : currentBest;
  }, NaN);
  ui.targetMaturity = String(best);
};

const rebuildInstruments = () => {
  const normalized = (allInstruments.value || [])
    .map(normalizeInstrument)
    .filter(Boolean)
    .filter((instrument) => instrument.underlying === underlying.value);

  data.options = normalized
    .filter((instrument) => instrument.type_normalized === "option")
    .sort(
      (a, b) =>
        (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
        (a.strike || 0) - (b.strike || 0),
    );

  data.hedges = normalized
    .filter((instrument) => instrument.type_normalized === "perpetual")
    .sort(
      (a, b) =>
        String(a.instrument_name).localeCompare(String(b.instrument_name)),
    );
};

async function loadSimulation() {
  const target = targetInstrument.value;
  const hedge = hedgeInstrument.value;
  if (!target || !hedge) return;

  const requestId = ++loadRequestId;
  ui.loading = true;
  ui.error = "";

  const { resolution, from, to, maxPoints } = getTimestampRange();
  try {
    const [indexRows, targetMarkRows, hedgeMarkRows] = await Promise.all([
      fetchIndexHistory({
        index_name: target.underlying || underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
      fetchMarkHistory({
        instrument_name: target.instrument_name,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
      fetchMarkHistory({
        instrument_name: hedge.instrument_name,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
    ]);

    if (requestId !== loadRequestId) return;
    data.index[ui.resolutionKey] = indexRows || [];
    data.targetMark[ui.resolutionKey] = targetMarkRows || [];
    data.hedgeMark[ui.resolutionKey] = hedgeMarkRows || [];
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    data.index[ui.resolutionKey] = [];
    data.targetMark[ui.resolutionKey] = [];
    data.hedgeMark[ui.resolutionKey] = [];
  } finally {
    if (requestId === loadRequestId) ui.loading = false;
  }
}

async function switchUnderlying(next) {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((option) => option.value === next)) return;
  underlying.value = next;
  data.index = {};
  data.targetMark = {};
  data.hedgeMark = {};
  rebuildInstruments();
  chooseDefaultMaturity();
  chooseClosestStrike();
  await loadSimulation();
}

onMounted(async () => {
  try {
    const { resolution, from, to, maxPoints } = getTimestampRange();
    const [instruments, indexRows] = await Promise.all([
      fetchInstruments(),
      fetchIndexHistory({
        index_name: underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
    ]);
    allInstruments.value = instruments || [];
    data.index[ui.resolutionKey] = indexRows || [];
    rebuildInstruments();
    chooseDefaultMaturity();
    chooseClosestStrike();
    initialized.value = true;
    await loadSimulation();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    initialized.value = true;
  }
});

watch(
  () => [
    ui.resolutionKey,
    ui.targetMaturity,
    ui.targetStrike,
    ui.targetType,
  ],
  async () => {
    if (!initialized.value) return;
    await loadSimulation();
  },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Delta Follower Simulator</h1>
      </div>
    </header>

    <div class="workspace">
      <div class="chartToolbar">
        <div class="underlyingToggle" role="group" aria-label="Underlying">
          <button
            v-for="opt in UNDERLYING_OPTIONS"
            :key="opt.value"
            type="button"
            class="underlyingButton"
            :class="{ underlyingButtonActive: underlying === opt.value }"
            :disabled="ui.loading && underlying !== opt.value"
            @click="switchUnderlying(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>

        <div class="resolutionToggle" role="group" aria-label="Resolution">
          <button
            v-for="key in Object.keys(RESOLUTION_CONFIG)"
            :key="key"
            type="button"
            class="toolbarButton"
            :class="{ toolbarButtonActive: ui.resolutionKey === key }"
            @click="ui.resolutionKey = key"
          >
            {{ RESOLUTION_CONFIG[key].label }}
          </button>
        </div>

        <button
          class="saveButton"
          type="button"
          :disabled="ui.loading || !canSavePng"
          @click="handleSavePng"
        >
          Save PNG
        </button>
      </div>

      <DfollowChart
        ref="chartRef"
        :data="simulationRows"
        :trades="trades"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
      />

      <aside class="configPanel" aria-label="Delta follower configuration">
        <p class="botDescription">
          Replicates the delta of the target option with the perpetual. The bot
          allows delta to drift within the threshold for the selected period,
          then trades the perpetual back toward the target delta. If deviation
          exceeds tolerance, it hedges immediately.
        </p>

        <label class="panelField">
          <span>Target Instrument</span>
          <select v-model="targetInstrumentName">
            <option
              v-for="instrument in data.options"
              :key="instrument.instrument_name"
              :value="instrument.instrument_name"
            >
              {{ instrument.instrument_name }}
            </option>
          </select>
        </label>

        <label class="panelField">
          <span>Amount</span>
          <div class="inputShell">
            <input v-model.number="ui.targetAmount" type="number" step="0.01" />
            <span>contracts</span>
          </div>
        </label>

        <label class="panelField">
          <span>Period</span>
          <input
            v-model.number="ui.period"
            class="rangeInput"
            type="range"
            min="60"
            max="86400"
            step="60"
          />
          <div class="rangeLabels">
            <span>1m</span>
            <strong>{{ periodHours }}</strong>
            <span>24h</span>
          </div>
        </label>

        <label class="panelField">
          <span>
            Threshold
            <span
              class="infoDot infoDotTooltip"
              tabindex="0"
              data-tooltip="The bot allows the deltas to stay outside of [target_delta - threshold, target_delta + threshold] for period seconds before making any adjustments to the portfolio."
            >i</span>
          </span>
          <input v-model.number="ui.threshold" type="number" min="0" step="0.01" />
        </label>

        <label class="panelField">
          <span>
            Tolerance
            <span
              class="infoDot infoDotTooltip"
              tabindex="0"
              data-tooltip="If the deltas are outside of [target_delta - tolerance, target_delta + tolerance], the bot will hedge them immediately, without waiting period seconds. Set to 0 to disable immediate hedging."
            >i</span>
          </span>
          <input v-model.number="ui.tolerance" type="number" min="0" step="0.01" />
        </label>

        <div v-if="ui.error" class="error">{{ ui.error }}</div>

        <a :href="thalexUrl" class="tradeThalexButton" target="_blank">Trade on Thalex</a>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.app {
  max-width: none;
  width: 100%;
  padding: 18px 16px 20px;
}

.header {
  margin-bottom: 12px;
  padding: 16px 0 18px;
}

.titleRow {
  justify-content: center;
}

.titleRow h1 {
  font-size: 26px;
  text-align: center;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(900px, 1fr) 320px;
  grid-template-rows: auto minmax(720px, 1fr);
  gap: 10px 14px;
  height: min(980px, calc(100vh - 82px));
  min-height: 780px;
  overflow-x: auto;
}

.chartToolbar {
  grid-column: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.chartToolbar .underlyingToggle,
.resolutionToggle {
  display: inline-flex;
  height: 31px;
  overflow: hidden;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
}

.chartToolbar .underlyingButton,
.toolbarButton {
  height: 100%;
  border: 0;
  background: transparent;
  color: #f0f1f4;
  cursor: pointer;
  padding: 0 18px;
  font-size: 12px;
  font-weight: 500;
}

.chartToolbar .underlyingButton + .underlyingButton,
.toolbarButton + .toolbarButton {
  border-left: 1px solid #2e2e32;
}

.chartToolbar .underlyingButtonActive,
.toolbarButtonActive {
  background: #252529;
  color: #fff;
  font-weight: 500;
}

.toolbarButton {
  padding: 0 13px;
}

.chartToolbar .saveButton {
  height: 31px;
  padding: 0 16px;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
  color: #f0f1f4;
  font-size: 12px;
  font-weight: 500;
}

.tradeThalexButton {
  height: 31px;
  padding: 0 16px;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
  color: #f0f1f4;
  font-size: 12px;
  font-weight: 500;
  display: flex;
  align-items: center;
  text-decoration: none;
}

.workspace :deep(.chartWrap) {
  grid-column: 1;
  grid-row: 2;
  height: 100%;
}

.workspace :deep(.chartSvg) {
  height: 100%;
}

.configPanel {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  padding: 22px 20px;
  background: #020204;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  overflow-y: auto;
}

.botDescription {
  margin: 0 0 2px;
  color: #bfc2cb;
  font-size: 13px;
  line-height: 1.45;
}

.panelField {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.panelField > span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f2f3f5;
  font-size: 14px;
  font-weight: 650;
}

.infoDot {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1.5px solid #e5e7eb;
  border-radius: 50%;
  color: #e5e7eb;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.infoDotTooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  padding: 10px 12px;
  border: 1px solid #3f3f43;
  border-radius: 8px;
  background: #08090d;
  color: #e5e7eb;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.infoDotTooltip:hover::after,
.infoDotTooltip:focus-visible::after {
  opacity: 1;
  transform: translateY(0);
}

.panelField select,
.panelField input {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  border: 1px solid #3f3f43;
  border-radius: 10px;
  background: transparent;
  color: #f3f4f6;
  padding: 0 14px;
  font-size: 14px;
  font-family: inherit;
}

.panelField select {
  color: #a6a6ad;
}

.panelField select:focus,
.panelField input:focus {
  outline: none;
  border-color: #6d86ff;
}

.inputShell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 42px;
  border: 1px solid #3f3f43;
  border-radius: 10px;
  overflow: hidden;
}

.inputShell input {
  border: 0;
  border-radius: 0;
  min-height: 40px;
}

.inputShell span {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  padding: 0 14px;
  border-left: 1px solid #3f3f43;
  color: #d7d7dc;
  font-size: 13px;
  font-weight: 650;
}

.rangeInput {
  -webkit-appearance: none;
  appearance: none;
  min-height: 18px;
  padding: 0;
  border: 0;
  cursor: pointer;
}

.rangeInput::-webkit-slider-runnable-track {
  height: 7px;
  background: #4a4a4a;
  border-radius: 999px;
}

.rangeInput::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 22px;
  height: 22px;
  margin-top: -7.5px;
  border: 3px solid #6d86ff;
  border-radius: 50%;
  background: #050506;
}

.rangeInput::-moz-range-track {
  height: 7px;
  background: #4a4a4a;
  border-radius: 999px;
}

.rangeInput::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border: 3px solid #6d86ff;
  border-radius: 50%;
  background: #050506;
}

.rangeLabels {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #a9abb6;
  font-size: 13px;
}

.rangeLabels strong {
  color: #f3f4f6;
  font-size: 12px;
  font-weight: 650;
  padding: 5px 12px;
  border: 1px solid #35353a;
  border-radius: 8px;
  background: #060607;
}

</style>
