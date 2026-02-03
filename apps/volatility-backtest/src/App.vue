<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import BacktestChart from "./components/BacktestChart.vue";
import {
  DEFAULT_DELTA_TOLERANCE,
  DEFAULT_FREQUENCY_MINUTES,
  DEFAULT_RESOLUTION,
  filterActiveOptions,
  FREQUENCY_OPTIONS,
  getLongestDatedStraddle,
  getStrike,
  loadInstruments,
  parseExpirationTs,
  RESOLUTION_OPTIONS,
  runBacktestStraddle,
  validateDateRange,
} from "./lib/backtest.js";
import { fetchIndexHistory } from "../../../lib/thalex.js";

const MAX_RANGE_DAYS = 365;
const PREVIEW_POINTS = 120; // chart shows this many points; visible time range adapts with resolution
const VOL_WINDOW = 20; // rolling window for realised vol
const PREVIEW_FETCH_EXTRA = 30; // extra points fetched so realised vol has history

function resolutionSeconds(resolution) {
  const map = { "1m": 60, "5m": 5 * 60, "15m": 15 * 60, "1h": 60 * 60, "1d": 24 * 60 * 60 };
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
  selectedExpiryTs: null,
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

// Index price at (or closest to) the start of the selected range (for ATM strike selection).
const atmReferencePrice = computed(() => {
  const from = startTs.value;
  const raw = data.previewIndex || [];
  if (from == null || !raw.length) return null;
  const withPrice = raw.filter(
    (r) => Number.isFinite(r.ts) && Number.isFinite(r.index_price_close)
  );
  if (!withPrice.length) return null;
  let best = withPrice[0];
  let bestDist = Math.abs(best.ts - from);
  for (const r of withPrice) {
    const dist = Math.abs(r.ts - from);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best.index_price_close;
});

// All candidate straddles across expiries in the selected range.
// For each expiry we pick the strike closest to ATM (index at start date); fallback to lowest strike if no price.
const availableStraddles = computed(() => {
  if (!Array.isArray(data.activeOptions) || !data.activeOptions.length) return [];
  const byExpiry = new Map();
  for (const inst of data.activeOptions) {
    const expTs = parseExpirationTs(inst);
    if (expTs == null) continue;
    if (!byExpiry.has(expTs)) byExpiry.set(expTs, []);
    byExpiry.get(expTs).push(inst);
  }

  const atm = atmReferencePrice.value;
  const result = [];
  for (const [expTs, group] of byExpiry.entries()) {
    const byStrike = new Map();
    for (const inst of group) {
      const k = getStrike(inst);
      if (k == null) continue;
      if (!byStrike.has(k)) byStrike.set(k, { expiryTs: expTs, strike: k, call: null, put: null });
      const bucket = byStrike.get(k);
      const type = (inst.option_type || "").toLowerCase();
      const name = (inst.instrument_name || "").toUpperCase();
      const isCall =
        type === "call" ? true : type === "put" ? false : name.includes("-C-");
      if (isCall) bucket.call = inst;
      else bucket.put = inst;
    }
    const candidates = [...byStrike.entries()]
      .filter(([, b]) => b.call && b.put)
      .map(([, b]) => b);
    if (!candidates.length) continue;
    let chosen = candidates[0];
    if (atm != null && Number.isFinite(atm)) {
      let bestDist = Infinity;
      for (const b of candidates) {
        const dist = Math.abs(b.strike - atm);
        if (dist < bestDist) {
          bestDist = dist;
          chosen = b;
        }
      }
    } else {
      chosen = candidates.sort((a, b) => a.strike - b.strike)[0];
    }
    result.push(chosen);
  }
  return result.sort((a, b) => a.expiryTs - b.expiryTs);
});

// Selected straddle: by default the longest-dated one, but user can choose another expiry.
const selectedStraddle = computed(() => {
  const list = availableStraddles.value;
  if (!list.length) return null;
  const current = list.find((s) => s.expiryTs === ui.selectedExpiryTs);
  if (current) return current;
  // Default: longest-dated (max expiry), same as original behaviour.
  return list[list.length - 1];
});

const canRunBacktest = computed(() => {
  return dateRangeValid.value && selectedStraddle.value && !ui.loading;
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
  ui.loadingPreview = true;
  data.previewIndex = [];
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
    data.previewIndex = (rows || []).map((r) => ({
      ts: r.ts,
      date: new Date(r.ts * 1000),
      index_price_close: r.index_price_close,
    }));
  } catch (e) {
    ui.error = e?.message || String(e);
  } finally {
    ui.loadingPreview = false;
  }
}

function onRangeSelected(range) {
  if (!range || typeof range.from !== "number" || typeof range.to !== "number") {
    ui.startDate = "";
    ui.endDate = "";
    data.backtest = null;
    ui.selectedExpiryTs = null;
    return;
  }
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  // Preserve time so same-day selections (e.g. 1h resolution) stay valid; date-only made startTs === endTs and disabled Run
  ui.startDate = new Date(from * 1000).toISOString().slice(0, 19);
  ui.endDate = new Date(to * 1000).toISOString().slice(0, 19);
  data.backtest = null;
  loadOptions().then(() => {
    if (dateRangeValid.value && selectedStraddle.value) run();
  });
}

async function loadOptions() {
  if (!startTs.value || !endTs.value) return;
  const v = validateDateRange(startTs.value, endTs.value);
  if (!v.ok) {
    data.activeOptions = [];
    ui.selectedExpiryTs = null;
    return;
  }
  ui.loadingOptions = true;
  ui.error = "";
  data.activeOptions = [];
  try {
    const instruments = await loadInstruments();
    const active = filterActiveOptions(
      instruments,
      ui.indexName,
      startTs.value,
      endTs.value
    );
    data.activeOptions = active.sort((a, b) => {
      const nameA = a.instrument_name || "";
      const nameB = b.instrument_name || "";
      return nameA.localeCompare(nameB);
    });
    if (data.activeOptions.length === 0) {
      ui.error = "No options were active (tradable) for the full date range. Try a shorter range or different index.";
    }
    // Reset selected expiry to default (longest-dated) if current selection is no longer valid.
    const list = availableStraddles.value;
    if (!list.length) {
      ui.selectedExpiryTs = null;
    } else if (!list.some((s) => s.expiryTs === ui.selectedExpiryTs)) {
      ui.selectedExpiryTs = list[list.length - 1].expiryTs;
    }
  } catch (e) {
    ui.error = e?.message || String(e);
  } finally {
    ui.loadingOptions = false;
  }
}

async function run() {
  const straddle = selectedStraddle.value;
  if (!canRunBacktest.value || !straddle) return;
  ui.loading = true;
  ui.error = "";
  data.backtest = null;
  try {
    const result = await runBacktestStraddle({
      callInstrument: straddle.call,
      putInstrument: straddle.put,
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

function formatDate(date) {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

onMounted(() => {
  setDefaultDates();
  loadPreviewIndex();
});

watch(
  () => [ui.indexName, ui.resolution],
  () => {
    loadPreviewIndex();
  },
  { immediate: false }
);

watch(
  () => [ui.indexName, startTs.value, endTs.value],
  () => {
    data.backtest = null;
    if (startTs.value && endTs.value) loadOptions();
  },
  { immediate: false }
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Volatility Arbitrage Backtest</h1>
      </div>
      <p class="subtitle">Select a past date range (max 1 year). The backtest uses the longest-dated straddle available (same strike, same expiry). Set direction and simulate PnL.</p>

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
        Click two points on the index chart to select the backtest date range (max {{ MAX_RANGE_DAYS }} days). Chart shows {{ PREVIEW_POINTS }} points; visible range adapts with resolution. Backtest runs automatically.
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

      <div v-if="availableStraddles.length" class="straddle-detail">
        <div class="straddle-detail-header">
          <h3 class="straddle-detail-title">Straddle used for backtest</h3>
          <div class="straddle-detail-expiry">
            <label for="expirySelect">Expiry</label>
            <select
              id="expirySelect"
              v-model.number="ui.selectedExpiryTs"
            >
              <option
                v-for="s in availableStraddles"
                :key="s.expiryTs"
                :value="s.expiryTs"
              >
                {{ formatDate(new Date(s.expiryTs * 1000)) }}
              </option>
            </select>
          </div>
        </div>
        <p class="straddle-detail-note">
          Strike is at-the-money (closest to index price at start of selected range). You can switch expiry if other straddles are active.
        </p>
        <dl v-if="selectedStraddle" class="straddle-detail-grid">
          <template v-if="atmReferencePrice != null">
            <dt>Reference (index at start)</dt>
            <dd>{{ formatCurrency(atmReferencePrice) }}</dd>
          </template>
          <dt>Strike</dt>
          <dd>{{ formatCurrency(selectedStraddle.strike) }}</dd>
          <dt>Expiry</dt>
          <dd>{{ formatDate(new Date(selectedStraddle.expiryTs * 1000)) }}</dd>
          <dt>Call</dt>
          <dd class="mono">{{ selectedStraddle.call.instrument_name || "—" }}</dd>
          <dt>Put</dt>
          <dd class="mono">{{ selectedStraddle.put.instrument_name || "—" }}</dd>
        </dl>
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
      <div class="hint" style="margin-top: 4px;">
        Rehedge when time elapsed or delta drifts beyond tolerance. With 1d resolution, frequency only reduces rehedges when set longer than 1 day (e.g. 2 days, 1 week).
      </div>

      <div v-if="ui.loadingOptions" class="status">Loading options…</div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </section>

    <section v-if="data.backtest" class="results">
      <div class="summary">
        <h2>Summary</h2>
        <div class="summary-grid">
          <span class="label">Start value</span>
          <span class="value">{{ formatCurrency(data.backtest.startValue) }}</span>
          <span class="label">End value</span>
          <span class="value">{{ formatCurrency(data.backtest.endValue) }}</span>
          <span class="label">PnL</span>
          <span
            class="value"
            :class="data.backtest.pnl != null && data.backtest.pnl < 0 ? 'negative' : 'positive'"
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
            :class="data.backtest.hedgePnl != null && data.backtest.hedgePnl < 0 ? 'negative' : 'positive'"
          >
            {{ formatCurrency(data.backtest.hedgePnl) }}
          </span>
          <span class="label">Cumulative total PnL</span>
          <span
            class="value"
            :class="data.backtest.totalPnl != null && data.backtest.totalPnl < 0 ? 'negative' : 'positive'"
          >
            {{ formatCurrency(data.backtest.totalPnl) }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
