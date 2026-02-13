<script setup>
import { computed, onMounted, reactive, watch } from "vue";
import BacktestChart from "./components/BacktestChart.vue";
import {
  DEFAULT_DELTA_TOLERANCE,
  DEFAULT_FREQUENCY_MINUTES,
  DEFAULT_RESOLUTION,
  filterActiveOptions,
  FREQUENCY_OPTIONS,
  loadInstruments,
  RESOLUTION_OPTIONS,
  runBacktestOptionsBasket,
  validateDateRange,
} from "./lib/backtest.js";
import { fetchIndexHistory } from "../../../lib/thalex.js";

const MAX_RANGE_DAYS = 365;
const PREVIEW_POINTS = 120; // chart shows this many points; visible time range adapts with resolution
const VOL_WINDOW = 20; // rolling window for realised vol
const PREVIEW_FETCH_EXTRA = 30; // extra points fetched so realised vol has history
let previewRequestId = 0;
let instrumentsLoaded = false;
let instrumentsPromise = null;

function resolutionSeconds(resolution) {
  const map = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
  };
  return map[resolution] ?? 24 * 60 * 60;
}

const ui = reactive({
  indexName: "BTCUSD",
  startDate: "",
  endDate: "",
  resolution: DEFAULT_RESOLUTION,
  direction: "long",
  deltaTolerance: DEFAULT_DELTA_TOLERANCE,
  frequencyMinutes: DEFAULT_FREQUENCY_MINUTES,
  primaryInstrumentName: "",
  includeSecondInstrument: false,
  secondaryInstrumentName: "",
  loading: false,
  loadingOptions: false,
  loadingPreview: false,
  error: "",
});

const data = reactive({
  allInstruments: [],
  activeOptions: [],
  backtest: null,
  previewIndex: [],
});

const startTs = computed(() => {
  if (!ui.startDate) return null;
  const d = new Date(ui.startDate);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
});

const endTs = computed(() => {
  if (!ui.endDate) return null;
  const d = new Date(ui.endDate);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
});

const dateRangeValid = computed(() => {
  const v = validateDateRange(startTs.value, endTs.value);
  return v.ok;
});

const instrumentByName = computed(() => {
  const map = new Map();
  for (const inst of data.activeOptions) {
    const name = inst?.instrument_name || "";
    if (name) map.set(name, inst);
  }
  return map;
});

const selectedInstruments = computed(() => {
  const first = instrumentByName.value.get(ui.primaryInstrumentName);
  if (!first) return [];
  const list = [first];
  if (
    ui.includeSecondInstrument &&
    ui.secondaryInstrumentName &&
    ui.secondaryInstrumentName !== ui.primaryInstrumentName
  ) {
    const second = instrumentByName.value.get(ui.secondaryInstrumentName);
    if (second) list.push(second);
  }
  return list;
});

const canRunBacktest = computed(() => {
  return dateRangeValid.value && selectedInstruments.value.length > 0 && !ui.loading;
});

const startIv = computed(() => {
  const s = data.backtest?.series;
  if (!s?.length) return null;
  return s[0].iv_close ?? null;
});

const endIv = computed(() => {
  const s = data.backtest?.series;
  if (!s?.length) return null;
  return s[s.length - 1].iv_close ?? null;
});

function setDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  ui.endDate = end.toISOString().slice(0, 10);
  ui.startDate = start.toISOString().slice(0, 10);
}

async function loadPreviewIndex() {
  const requestId = ++previewRequestId;
  ui.loadingPreview = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const resSec = resolutionSeconds(ui.resolution || DEFAULT_RESOLUTION);
    const totalPoints = PREVIEW_POINTS + VOL_WINDOW + PREVIEW_FETCH_EXTRA;
    const from = now - totalPoints * resSec;
    const rows = await fetchIndexHistory({
      index_name: ui.indexName,
      resolution: ui.resolution || DEFAULT_RESOLUTION,
      from,
      to: now,
    });
    if (requestId !== previewRequestId) return;
    data.previewIndex = (rows || []).map((r) => ({
      ts: r.ts,
      date: new Date(r.ts * 1000),
      index_price_close: r.index_price_close,
    }));
  } catch (e) {
    if (requestId !== previewRequestId) return;
    ui.error = e?.message || String(e);
  } finally {
    if (requestId !== previewRequestId) return;
    ui.loadingPreview = false;
  }
}

function getDefaultInstrumentName(excludeName = "") {
  const candidate = data.activeOptions.find(
    (inst) => inst?.instrument_name && inst.instrument_name !== excludeName,
  );
  return candidate?.instrument_name || "";
}

function syncInstrumentSelection() {
  if (!data.activeOptions.length) {
    ui.primaryInstrumentName = "";
    ui.includeSecondInstrument = false;
    ui.secondaryInstrumentName = "";
    return;
  }

  if (!instrumentByName.value.has(ui.primaryInstrumentName)) {
    ui.primaryInstrumentName = getDefaultInstrumentName();
  }

  if (!ui.includeSecondInstrument) {
    ui.secondaryInstrumentName = "";
    return;
  }

  if (
    !instrumentByName.value.has(ui.secondaryInstrumentName) ||
    ui.secondaryInstrumentName === ui.primaryInstrumentName
  ) {
    ui.secondaryInstrumentName = getDefaultInstrumentName(ui.primaryInstrumentName);
  }

  if (!ui.secondaryInstrumentName) {
    ui.includeSecondInstrument = false;
  }
}

async function onRangeSelected(range) {
  if (!range || typeof range.from !== "number" || typeof range.to !== "number") {
    ui.startDate = "";
    ui.endDate = "";
    data.backtest = null;
    data.activeOptions = [];
    syncInstrumentSelection();
    return;
  }
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  // Preserve time so same-day selections (e.g. 1h resolution) stay valid; date-only made startTs === endTs and disabled Run
  ui.startDate = new Date(from * 1000).toISOString().slice(0, 19);
  ui.endDate = new Date(to * 1000).toISOString().slice(0, 19);
  data.backtest = null;
  filterOptions();
  if (dateRangeValid.value && selectedInstruments.value.length > 0) {
    await run();
  }
}

function filterOptions() {
  if (!instrumentsLoaded || !startTs.value || !endTs.value) {
    data.activeOptions = [];
    syncInstrumentSelection();
    return;
  }
  const v = validateDateRange(startTs.value, endTs.value);
  if (!v.ok) {
    data.activeOptions = [];
    syncInstrumentSelection();
    return;
  }
  ui.error = "";
  const active = filterActiveOptions(
    data.allInstruments,
    ui.indexName,
    startTs.value,
    endTs.value,
  );
  data.activeOptions = active.sort((a, b) => {
    const nameA = a.instrument_name || "";
    const nameB = b.instrument_name || "";
    return nameA.localeCompare(nameB);
  });
  syncInstrumentSelection();
  if (data.activeOptions.length === 0) {
    ui.error =
      "No options were active (tradable) for the full date range. Try a shorter range or different index.";
  }
}

async function ensureInstrumentsLoaded() {
  if (instrumentsLoaded) return data.allInstruments;
  if (!instrumentsPromise) {
    ui.loadingOptions = true;
    ui.error = "";
    instrumentsPromise = loadInstruments()
      .then((instruments) => {
        data.allInstruments = Array.isArray(instruments) ? instruments : [];
        instrumentsLoaded = true;
        filterOptions();
        return data.allInstruments;
      })
      .catch((e) => {
        ui.error = e?.message || String(e);
        data.allInstruments = [];
        return data.allInstruments;
      })
      .finally(() => {
        ui.loadingOptions = false;
        instrumentsPromise = null;
      });
  }
  return instrumentsPromise;
}

function addSecondInstrument() {
  ui.includeSecondInstrument = true;
  if (
    !ui.secondaryInstrumentName ||
    ui.secondaryInstrumentName === ui.primaryInstrumentName
  ) {
    ui.secondaryInstrumentName = getDefaultInstrumentName(ui.primaryInstrumentName);
  }
  if (!ui.secondaryInstrumentName) {
    ui.includeSecondInstrument = false;
    return;
  }
  data.backtest = null;
}

function removeSecondInstrument() {
  ui.includeSecondInstrument = false;
  ui.secondaryInstrumentName = "";
  data.backtest = null;
}

async function run() {
  const instruments = selectedInstruments.value;
  if (!canRunBacktest.value || !instruments.length) return;
  ui.loading = true;
  ui.error = "";
  data.backtest = null;
  try {
    const result = await runBacktestOptionsBasket({
      instruments,
      startTs: startTs.value,
      endTs: endTs.value,
      direction: ui.direction,
      indexName: ui.indexName,
      resolution: ui.resolution || DEFAULT_RESOLUTION,
      deltaHedgeParams: {
        tolerance: Number(ui.deltaTolerance) || DEFAULT_DELTA_TOLERANCE,
        frequencyMinutes: Number(ui.frequencyMinutes) ?? DEFAULT_FREQUENCY_MINUTES,
      },
    });
    if (result.error) {
      ui.error = result.error;
      return;
    }
    data.backtest = result;
  } catch (e) {
    ui.error = e?.message || String(e);
  } finally {
    ui.loading = false;
  }
}

function formatCurrency(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

onMounted(async () => {
  setDefaultDates();
  await Promise.all([ensureInstrumentsLoaded(), loadPreviewIndex()]);
});

watch(
  () => [ui.indexName, ui.resolution],
  () => {
    void loadPreviewIndex();
  },
  { immediate: false },
);

watch(
  [() => ui.indexName, startTs, endTs],
  () => {
    data.backtest = null;
    filterOptions();
  },
  { immediate: false },
);

watch(
  () => ui.resolution,
  () => {
    data.backtest = null;
  },
  { immediate: false },
);

watch(
  [
    () => ui.primaryInstrumentName,
    () => ui.includeSecondInstrument,
    () => ui.secondaryInstrumentName,
  ],
  () => {
    syncInstrumentSelection();
    data.backtest = null;
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Volatility Arbitrage Backtest</h1>
      </div>
      <p class="subtitle">
        Select a past date range (max 1 year), then pick one or two option
        instruments active for that full range. Set direction and simulate PnL.
      </p>

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
              v-for="opt in RESOLUTION_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="hint">
        Click two points on the index chart to select the backtest date range
        (max {{ MAX_RANGE_DAYS }} days). Chart shows
        {{ PREVIEW_POINTS }} points; visible range adapts with resolution.
        Backtest runs automatically.
      </div>
    </header>

    <BacktestChart
      :index-data="data.previewIndex"
      :resolution="ui.resolution"
      :preview-points="PREVIEW_POINTS"
      :backtest="data.backtest"
      :loading="ui.loadingPreview || ui.loading"
      @range-selected="onRangeSelected"
    />

    <section class="backtest-controls">
      <div class="controls options-row">
        <div class="field">
          <label for="direction">Direction</label>
          <select id="direction" v-model="ui.direction">
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </div>

        <button
          class="saveButton"
          type="button"
          :disabled="!canRunBacktest"
          @click="run"
        >
          {{ ui.loading ? "Running…" : "Run backtest" }}
        </button>
      </div>

      <div v-if="data.activeOptions.length" class="straddle-detail">
        <div class="straddle-detail-header">
          <h3 class="straddle-detail-title">Option instruments</h3>
        </div>

        <div class="field">
          <label for="primaryInstrument">Instrument 1</label>
          <div class="controls options-row" style="align-items: end">
            <select id="primaryInstrument" v-model="ui.primaryInstrumentName">
              <option
                v-for="inst in data.activeOptions"
                :key="inst.instrument_name"
                :value="inst.instrument_name"
              >
                {{ inst.instrument_name }}
              </option>
            </select>
            <button
              v-if="!ui.includeSecondInstrument"
              class="saveButton"
              type="button"
              @click="addSecondInstrument"
            >
              +
            </button>
            <button
              v-else
              class="saveButton"
              type="button"
              @click="removeSecondInstrument"
            >
              −
            </button>
          </div>
        </div>

        <div v-if="ui.includeSecondInstrument" class="field">
          <label for="secondaryInstrument">Instrument 2 (optional)</label>
          <select
            id="secondaryInstrument"
            v-model="ui.secondaryInstrumentName"
          >
            <option
              v-for="inst in data.activeOptions"
              :key="`second-${inst.instrument_name}`"
              :value="inst.instrument_name"
              :disabled="inst.instrument_name === ui.primaryInstrumentName"
            >
              {{ inst.instrument_name }}
            </option>
          </select>
        </div>
      </div>

      <div class="controls hedge-row">
        <div class="field">
          <label for="deltaTolerance">Delta tolerance</label>
          <input
            id="deltaTolerance"
            v-model="ui.deltaTolerance"
            type="number"
            min="0"
            max="1"
            step="0.01"
            placeholder="0.05"
          />
        </div>

        <div class="field">
          <label for="frequency">Hedge frequency</label>
          <select id="frequency" v-model.number="ui.frequencyMinutes">
            <option
              v-for="opt in FREQUENCY_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="hint" style="margin-top: 4px">
        Rehedge when time elapsed or delta drifts beyond tolerance. With 1d
        resolution, frequency only reduces rehedges when set longer than 1 day
        (e.g. 2 days, 1 week).
      </div>

      <div v-if="ui.loadingOptions" class="status">Loading options…</div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </section>

    <section v-if="data.backtest" class="results">
      <div class="summary">
        <h2>Summary</h2>
        <div class="summary-grid">
          <span class="label">Start value</span>
          <span class="value">{{
            formatCurrency(data.backtest.startValue)
          }}</span>
          <span class="label">End value</span>
          <span class="value">{{
            formatCurrency(data.backtest.endValue)
          }}</span>
          <span class="label">PnL</span>
          <span
            class="value"
            :class="
              data.backtest.pnl != null && data.backtest.pnl < 0
                ? 'negative'
                : 'positive'
            "
          >
            {{ formatCurrency(data.backtest.pnl) }}
          </span>
          <span class="label">IV (start)</span>
          <span class="value">
            {{ startIv != null ? formatPercent(startIv) : "—" }}
          </span>
          <span class="label">IV (end)</span>
          <span class="value">
            {{ endIv != null ? formatPercent(endIv) : "—" }}
          </span>
          <span class="label">Delta hedge PnL</span>
          <span
            class="value"
            :class="
              data.backtest.hedgePnl != null && data.backtest.hedgePnl < 0
                ? 'negative'
                : 'positive'
            "
          >
            {{ formatCurrency(data.backtest.hedgePnl) }}
          </span>
          <span class="label">Cumulative total PnL</span>
          <span
            class="value"
            :class="
              data.backtest.totalPnl != null && data.backtest.totalPnl < 0
                ? 'negative'
                : 'positive'
            "
          >
            {{ formatCurrency(data.backtest.totalPnl) }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
