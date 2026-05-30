<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import BinaryOptionChart from "./components/BinaryOptionChart.vue";
import {
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const DEFAULT_POINT_LIMIT = 480;
const MIN_POINT_LIMIT = 60;
const MAX_POINT_LIMIT = 2000;

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", intervalSeconds: 60 },
  300: { label: "5m", resolution: "5m", intervalSeconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", intervalSeconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", intervalSeconds: 60 * 60 },
};

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  optionName: "",
  maxPoints: DEFAULT_POINT_LIMIT,
  loading: false,
  error: "",
});

const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  options: [],
  optionMark: {},
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

const normalizeCreateTimeSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
};

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const type = String(instrument.type || instrument.kind || "").toLowerCase();
  if (type !== "option") return null;
  return {
    ...instrument,
    type_normalized: type,
    create_time_s: normalizeCreateTimeSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    ),
    expiration_ts: Number(instrument.expiration_timestamp),
    strike: Number(instrument.strike_price),
    option_type_normalized:
      String(instrument.option_type || "").toLowerCase() === "put"
        ? "put"
        : "call",
  };
};

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const config = RESOLUTION_CONFIG[ui.resolutionKey] || RESOLUTION_CONFIG[3600];
  const maxPoints = Math.max(
    MIN_POINT_LIMIT,
    Math.min(MAX_POINT_LIMIT, Math.floor(Number(ui.maxPoints)) || DEFAULT_POINT_LIMIT),
  );
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

const optionLabel = (instrument) => {
  const expiry = Number.isFinite(instrument?.expiration_ts)
    ? maturityFormatter.format(new Date(instrument.expiration_ts * 1000))
    : "Expiry";
  const type = instrument?.option_type_normalized === "put" ? "Put" : "Call";
  const strike = Number.isFinite(instrument?.strike)
    ? strikeFormatter.format(instrument.strike)
    : "-";
  return `${expiry} ${strike} ${type}`;
};

const selectedOption = computed(
  () =>
    data.options.find((option) => option.instrument_name === ui.optionName) ||
    null,
);

const selectedOptionType = computed(() =>
  selectedOption.value?.option_type_normalized === "put" ? "put" : "call",
);

const chartSubtitle = computed(() => {
  if (!selectedOption.value) return "";
  const transform = selectedOptionType.value === "put" ? "N(-d2)" : "N(d2)";
  return `${selectedOption.value.instrument_name} ${transform}`;
});

const canSavePng = computed(() => binarySeries.value.length > 0);

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - tau);
}

function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

function calcD2({ spot, strike, expiration, ts, iv }) {
  if (!Number.isFinite(spot) || !Number.isFinite(strike)) return null;
  const tte = expiration - ts;
  if (!Number.isFinite(tte)) return null;
  if (tte <= 0) {
    return spot >= strike ? Infinity : -Infinity;
  }
  const tau = tte / SECONDS_PER_YEAR;
  if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(tau) || tau <= 0) {
    return null;
  }
  const sqrtTau = Math.sqrt(tau);
  const d1 =
    (Math.log(spot / strike) + 0.5 * iv * iv * tau) / (iv * sqrtTau);
  return d1 - iv * sqrtTau;
}

function buildBinarySeries({ indexRows, markRows, option }) {
  if (!option) return [];
  const markByTs = new Map(
    (markRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );
  const rows = [];

  for (const indexPoint of indexRows || []) {
    const ts = Number(indexPoint?.ts);
    const markPoint = markByTs.get(ts);
    if (!markPoint) continue;
    const spot = Number(indexPoint.index_price_close);
    const strike = Number(option.strike);
    const d2 = calcD2({
      spot,
      strike,
      expiration: Number(option.expiration_ts),
      ts,
      iv: Number(markPoint.iv_close),
    });
    if (!Number.isFinite(d2) && d2 !== Infinity && d2 !== -Infinity) continue;
    const nd2 =
      option.option_type_normalized === "put" ? normalCdf(-d2) : normalCdf(d2);
    if (!Number.isFinite(nd2)) continue;

    const inTheMoney =
      option.option_type_normalized === "put" ? spot < strike : spot > strike;
    rows.push({
      ts,
      date: new Date(ts * 1000),
      indexPrice: spot,
      strike,
      iv: Number(markPoint.iv_close),
      d2,
      nd2,
      inTheMoney,
      optionType: option.option_type_normalized,
    });
  }

  return rows;
}

const binarySeries = computed(() =>
  buildBinarySeries({
    indexRows: data.index[ui.resolutionKey] || [],
    markRows: data.optionMark[ui.resolutionKey] || [],
    option: selectedOption.value,
  }),
);

const slugValue = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function handleSavePng() {
  if (!chartRef.value) return;
  const parts = [
    selectedOption.value?.instrument_name || "binary",
    selectedOptionType.value === "put" ? "n_minus_d2" : "n_d2",
    RESOLUTION_CONFIG[ui.resolutionKey]?.label || ui.resolutionKey,
  ].map(slugValue);
  chartRef.value.exportPng({ filename: `${parts.join("-")}.png` });
}

const chooseDefaultOption = () => {
  const options = data.options;
  if (!options.length) {
    ui.optionName = "";
    return;
  }

  const latestIndex = getLatestIndexClose(data.index[ui.resolutionKey] || []);
  const now = Math.floor(Date.now() / 1000);
  const targetExpiry = now + 28 * 24 * 60 * 60;
  const candidates = options.filter((option) => option.expiration_ts > now);
  const pool = candidates.length ? candidates : options;

  let best = pool[0];
  let bestScore = Infinity;
  for (const option of pool) {
    const expiryScore = Math.abs(option.expiration_ts - targetExpiry) / 86400;
    const strikeScore = Number.isFinite(latestIndex)
      ? Math.abs(option.strike - latestIndex) / Math.max(1, latestIndex)
      : 0;
    const typeScore = option.option_type_normalized === "call" ? 0 : 0.02;
    const score = expiryScore + strikeScore * 20 + typeScore;
    if (score < bestScore) {
      best = option;
      bestScore = score;
    }
  }
  ui.optionName = best?.instrument_name || "";
};

const rebuildOptions = () => {
  data.options = (allInstruments.value || [])
    .map(normalizeOptionInstrument)
    .filter(Boolean)
    .filter((instrument) => instrument.underlying === underlying.value)
    .sort(
      (a, b) =>
        (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
        (a.strike || 0) - (b.strike || 0) ||
        String(a.option_type_normalized).localeCompare(
          String(b.option_type_normalized),
        ),
    );
};

async function loadChartData() {
  const option = selectedOption.value;
  if (!option) return;

  const requestId = ++loadRequestId;
  ui.loading = true;
  ui.error = "";
  const { resolution, from, to, maxPoints } = getTimestampRange();

  try {
    const [indexRows, markRows] = await Promise.all([
      fetchIndexHistory({
        index_name: option.underlying || underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
      fetchMarkHistory({
        instrument_name: option.instrument_name,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
    ]);

    if (requestId !== loadRequestId) return;
    data.index[ui.resolutionKey] = indexRows || [];
    data.optionMark[ui.resolutionKey] = markRows || [];
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    data.index[ui.resolutionKey] = [];
    data.optionMark[ui.resolutionKey] = [];
  } finally {
    if (requestId === loadRequestId) ui.loading = false;
  }
}

async function switchUnderlying(next) {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((option) => option.value === next)) return;
  underlying.value = next;
  data.index = {};
  data.optionMark = {};
  rebuildOptions();
  ui.loading = true;
  ui.error = "";

  try {
    const { resolution, from, to, maxPoints } = getTimestampRange();
    data.index[ui.resolutionKey] =
      (await fetchIndexHistory({
        index_name: underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      })) || [];
    chooseDefaultOption();
    await loadChartData();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.loading = false;
  }
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
    rebuildOptions();
    chooseDefaultOption();
    initialized.value = true;
    await loadChartData();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    initialized.value = true;
  }
});

watch(
  () => [ui.resolutionKey, ui.optionName, ui.maxPoints],
  async () => {
    if (!initialized.value) return;
    await loadChartData();
  },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>Binary Options</h1>
    </header>

    <div class="workspace">
      <div class="chartToolbar">
        <div class="toolbarGroup">
          <div class="segmented" role="group" aria-label="Underlying">
            <button
              v-for="opt in UNDERLYING_OPTIONS"
              :key="opt.value"
              type="button"
              :class="{ active: underlying === opt.value }"
              :disabled="ui.loading && underlying !== opt.value"
              @click="switchUnderlying(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>

          <label class="instrumentControl">
            <span>Instrument</span>
            <select v-model="ui.optionName">
              <option
                v-for="instrument in data.options"
                :key="instrument.instrument_name"
                :value="instrument.instrument_name"
              >
                {{ optionLabel(instrument) }}
              </option>
            </select>
          </label>
        </div>

        <div class="toolbarGroup">
          <div class="segmented" role="group" aria-label="Resolution">
            <button
              v-for="key in Object.keys(RESOLUTION_CONFIG)"
              :key="key"
              type="button"
              :class="{ active: ui.resolutionKey === key }"
              @click="ui.resolutionKey = key"
            >
              {{ RESOLUTION_CONFIG[key].label }}
            </button>
          </div>

          <label class="pointSlider">
            <span>{{ ui.maxPoints }} points</span>
            <input
              v-model.number="ui.maxPoints"
              type="range"
              :min="MIN_POINT_LIMIT"
              :max="MAX_POINT_LIMIT"
              step="20"
            />
          </label>
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

      <BinaryOptionChart
        ref="chartRef"
        :data="binarySeries"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
      />
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
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
  padding: 18px 0 20px;
}

.header h1 {
  margin: 0;
  color: #f7f7f8;
  font-size: 30px;
  font-weight: 760;
  line-height: 1.05;
  text-align: center;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(900px, 1fr);
  grid-template-rows: auto minmax(720px, 1fr);
  gap: 10px;
  height: min(980px, calc(100vh - 92px));
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

.toolbarGroup {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.segmented {
  display: inline-flex;
  height: 31px;
  overflow: hidden;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
}

.segmented button,
.saveButton {
  height: 100%;
  border: 0;
  background: transparent;
  color: #f0f1f4;
  cursor: pointer;
  padding: 0 18px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
}

.segmented button + button {
  border-left: 1px solid #2e2e32;
}

.segmented .active {
  background: #252529;
  color: #fff;
}

.saveButton {
  height: 31px;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
}

.saveButton:disabled,
.segmented button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.instrumentControl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 310px;
}

.instrumentControl span,
.pointSlider span {
  color: #aeb0b8;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.instrumentControl select {
  width: 245px;
  min-height: 31px;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
  color: #f0f1f4;
  padding: 0 10px;
  font-size: 12px;
  font-family: inherit;
}

.instrumentControl select:focus {
  outline: none;
  border-color: #6d86ff;
}

.pointSlider {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.pointSlider input {
  width: 170px;
  accent-color: #7aa2ff;
}

.workspace :deep(.chartWrap) {
  grid-column: 1;
  grid-row: 2;
  height: 100%;
}

.workspace :deep(.chartSvg) {
  height: 100%;
}

.error {
  grid-column: 1;
  grid-row: 2;
  align-self: start;
  justify-self: center;
  margin-top: 18px;
  padding: 8px 12px;
  border: 1px solid rgba(253, 164, 175, 0.3);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.2);
  color: #fda4af;
  font-size: 13px;
  line-height: 1.35;
}
</style>
