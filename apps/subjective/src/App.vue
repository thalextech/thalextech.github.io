<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { fetchAllInstruments } from "../../../lib/thalex.js";

const API_BASE = "https://thalex.com/api/v2/public";
const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;

const ui = reactive({
  expiryTs: "",
  optionStrike: "",
  adjustedForward: "",
  viewMode: "formula",
  loading: false,
  error: "",
});

const data = reactive({
  options: [],
  ticker: null,
  optionTickers: {},
  spot: null,
  underlying: "BTCUSD",
  lastLoadedAt: null,
});

const adjustedDirty = ref(false);
const muFlash = ref(false);
let muFlashTimer = null;
const strikeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const strikeCompactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getExpiryCode(instrumentName) {
  return String(instrumentName || "").split("-")[1] || "";
}

function normalizeOptionType(value) {
  return String(value || "").toLowerCase() === "put" ? "put" : "call";
}

function buildPublicUrl(path, params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    searchParams.set(key, String(value));
  });
  return `${API_BASE}${path}?${searchParams.toString()}`;
}

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      json?.error?.message || json?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

async function fetchTicker(instrumentName) {
  const url = buildPublicUrl("/ticker", { instrument_name: instrumentName });
  const json = await getJson(url);
  return json?.result || null;
}

async function fetchIndexNow(underlying = "BTCUSD") {
  const url = buildPublicUrl("/index", { underlying });
  const json = await getJson(url);
  return toFiniteNumber(json?.result?.price);
}

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

function calcD3(S, K, T, sigma, r, mu) {
  return (
    (Math.log(S / K) + (r + mu + 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T))
  );
}

function calcD4(S, K, T, sigma, r, mu) {
  return (
    (Math.log(S / K) + (r + mu - 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T))
  );
}

const btcOptions = computed(() => {
  const now = Date.now() / 1000;
  return (data.options || []).filter((option) => {
    if (!option || typeof option !== "object") return false;
    if (option.product !== "OBTCUSD") return false;
    if (option.type !== "option") return false;
    if (!Number.isFinite(option.expiration_timestamp)) return false;
    return option.expiration_timestamp > now;
  });
});

const expiryList = computed(() => {
  const byExpiry = new Map();
  for (const option of btcOptions.value) {
    const ts = Number(option.expiration_timestamp);
    if (!Number.isFinite(ts)) continue;
    if (!byExpiry.has(ts)) {
      byExpiry.set(ts, {
        timestamp: ts,
        code: getExpiryCode(option.instrument_name),
        count: 0,
      });
    }
    byExpiry.get(ts).count += 1;
  }
  return Array.from(byExpiry.values()).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
});

const selectedExpiry = computed(() => {
  return (
    expiryList.value.find((item) => String(item.timestamp) === ui.expiryTs) ||
    null
  );
});

const instrumentOptions = computed(() => {
  if (!selectedExpiry.value) return [];
  const ts = selectedExpiry.value.timestamp;
  return btcOptions.value
    .filter(
      (option) =>
        Number(option.expiration_timestamp) === ts &&
        normalizeOptionType(option.option_type) === "call",
    )
    .slice()
    .sort((a, b) => {
      const strikeDiff = Number(a.strike_price) - Number(b.strike_price);
      if (strikeDiff !== 0) return strikeDiff;
      return normalizeOptionType(a.option_type).localeCompare(
        normalizeOptionType(b.option_type),
      );
    });
});

const strikeOptions = computed(() => {
  const seen = new Set();
  const strikes = [];
  for (const option of instrumentOptions.value) {
    const strike = Number(option?.strike_price);
    if (!Number.isFinite(strike) || seen.has(strike)) continue;
    seen.add(strike);
    strikes.push(strike);
  }
  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const selectedStrike = computed(() => toFiniteNumber(ui.optionStrike));

const selectedInstrument = computed(() => {
  if (!instrumentOptions.value.length) return null;
  const selected = selectedStrike.value;
  if (!Number.isFinite(selected)) return instrumentOptions.value[0] || null;
  return (
    instrumentOptions.value.find(
      (item) => Number(item.strike_price) === selected,
    ) ||
    instrumentOptions.value[0] ||
    null
  );
});

const adjustedForwardValue = computed(() => toFiniteNumber(ui.adjustedForward));

const model = computed(() => {
  const instrument = selectedInstrument.value;
  const ticker = data.ticker;
  const spot = toFiniteNumber(data.spot);
  const adjustedForward = adjustedForwardValue.value;

  if (!instrument || !ticker) return null;

  const strike = toFiniteNumber(instrument.strike_price);
  const expirationTs = toFiniteNumber(instrument.expiration_timestamp);
  const iv = toFiniteNumber(ticker.iv);
  const markPrice = toFiniteNumber(ticker.mark_price);
  const forward = toFiniteNumber(ticker.forward);
  const optionType = normalizeOptionType(instrument.option_type);
  const nowTs = Date.now() / 1000;

  const T = Number.isFinite(expirationTs)
    ? (expirationTs - nowTs) / SECONDS_PER_BS_YEAR
    : null;

  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(iv) ||
    !Number.isFinite(markPrice) ||
    !Number.isFinite(forward) ||
    !Number.isFinite(adjustedForward) ||
    !Number.isFinite(T) ||
    spot <= 0 ||
    strike <= 0 ||
    iv <= 0 ||
    forward <= 0 ||
    adjustedForward <= 0 ||
    T <= 0
  ) {
    return null;
  }

  const r = Math.log(forward / spot) / T;
  const mu = Math.log(adjustedForward / spot) / T - r;
  const lnSk = Math.log(spot / strike);
  const sigma2Half = 0.5 * iv * iv;
  const sigmaSqrtT = iv * Math.sqrt(T);
  const numD1 = lnSk + (r + sigma2Half) * T;
  const numD2 = lnSk + (r - sigma2Half) * T;

  const numD3 = lnSk + (r + mu + sigma2Half) * T;
  const numD4 = lnSk + (r + mu - sigma2Half) * T;

  const d1 = numD1 / sigmaSqrtT;
  const d2 = numD2 / sigmaSqrtT;
  const d3 = numD3 / sigmaSqrtT;
  const d4 = numD4 / sigmaSqrtT;
  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const nd3 = normalCdf(d3);
  const nd4 = normalCdf(d4);
  const nd3Neg = normalCdf(-d3);
  const nd4Neg = normalCdf(-d4);

  const callLeg1 = spot * Math.exp(mu * T) * nd3;
  const callLeg2 = strike * Math.exp(-r * T) * nd4;
  const putLeg1 = strike * Math.exp(-r * T) * nd4Neg;
  const putLeg2 = spot * Math.exp(mu * T) * nd3Neg;

  const call = callLeg1 - callLeg2;
  const put = putLeg1 - putLeg2;
  const subjectivePrice = optionType === "call" ? call : put;

  const edge = subjectivePrice - markPrice;
  const edgePct =
    markPrice > 0 ? (subjectivePrice / markPrice - 1) * 100 : null;

  return {
    optionType,
    strike,
    spot,
    iv,
    forward,
    markPrice,
    adjustedForward,
    T,
    r,
    mu,
    lnSk,
    sigma2Half,
    sigmaSqrtT,
    numD1,
    numD2,
    numD3,
    numD4,
    d1,
    d2,
    d3,
    d4,
    nd1,
    nd2,
    nd3,
    nd4,
    nd3Neg,
    nd4Neg,
    callLeg1,
    callLeg2,
    putLeg1,
    putLeg2,
    call,
    put,
    subjectivePrice,
    edge,
    edgePct,
  };
});

function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return "-";
  const threshold = 0.5 * 10 ** -decimals;
  const normalized = Math.abs(value) < threshold ? 0 : value;
  return normalized.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatCompactNumber(value, decimals = 2, compactDecimals = 1) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) {
    return `${formatNumber(value / 1000, compactDecimals)}k`;
  }
  return formatNumber(value, decimals);
}

function formatMoney(value, decimals = 0, compactDecimals = 1) {
  if (!Number.isFinite(value)) return "-";
  return `$${formatCompactNumber(value, decimals, compactDecimals)}`;
}

function formatSignedMoney(value, decimals = 0, compactDecimals = 1) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${formatCompactNumber(Math.abs(value), decimals, compactDecimals)}`;
}

function formatPercent(value, decimals = 2) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, decimals)}%`;
}

function formatProbability(value, decimals = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${formatNumber(value * 100, decimals)}%`;
}

function formatStrikeLabel(value) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) {
    return `${strikeCompactFormatter.format(value / 1000)}k`;
  }
  return formatNumber(value, 0);
}

function formatUpdated(ts) {
  if (!Number.isFinite(ts)) return "-";
  return new Date(ts).toLocaleString();
}

const chartBars = computed(() => {
  const spot = toFiniteNumber(data.spot);
  const adjustedForward = adjustedForwardValue.value;
  const nowTs = Date.now() / 1000;
  const tickers = data.optionTickers || {};

  if (!Number.isFinite(spot) || spot <= 0) return [];
  if (!Number.isFinite(adjustedForward) || adjustedForward <= 0) return [];

  const rows = [];
  for (const option of instrumentOptions.value) {
    const instrumentName = String(option?.instrument_name || "");
    const ticker = tickers[instrumentName];
    const strike = toFiniteNumber(option?.strike_price);
    const expirationTs = toFiniteNumber(option?.expiration_timestamp);
    const iv = toFiniteNumber(ticker?.iv);
    const markPrice = toFiniteNumber(ticker?.mark_price);
    const forward = toFiniteNumber(ticker?.forward);

    const T = Number.isFinite(expirationTs)
      ? (expirationTs - nowTs) / SECONDS_PER_BS_YEAR
      : null;

    if (
      !Number.isFinite(strike) ||
      !Number.isFinite(iv) ||
      !Number.isFinite(markPrice) ||
      !Number.isFinite(forward) ||
      !Number.isFinite(T) ||
      strike <= 0 ||
      iv <= 0 ||
      forward <= 0 ||
      T <= 0
    ) {
      continue;
    }

    const r = Math.log(forward / spot) / T;
    const mu = Math.log(adjustedForward / spot) / T - r;
    const d3 = calcD3(spot, strike, T, iv, r, mu);
    const d4 = calcD4(spot, strike, T, iv, r, mu);
    const nd3 = normalCdf(d3);
    const nd4 = normalCdf(d4);
    const adjusted =
      spot * Math.exp(mu * T) * nd3 - strike * Math.exp(-r * T) * nd4;

    rows.push({
      strike,
      strikeLabel: formatStrikeLabel(strike),
      market: Math.max(0, markPrice),
      adjusted: Math.max(0, adjusted),
    });
  }

  rows.sort((a, b) => a.strike - b.strike);
  const maxPrice = rows.reduce(
    (max, row) => Math.max(max, row.market, row.adjusted),
    0,
  );
  const scale = maxPrice > 0 ? maxPrice : 1;

  return rows.map((row) => ({
    ...row,
    edge: row.adjusted - row.market,
    edgePct: row.market > 0 ? (row.adjusted / row.market - 1) * 100 : null,
    marketPct: (row.market / scale) * 100,
    adjustedPct: (row.adjusted / scale) * 100,
    adjustedTopPct: (Math.max(0, row.adjusted - row.market) / scale) * 100,
  }));
});

function chooseDefaultStrike() {
  const options = instrumentOptions.value;
  if (!options.length) {
    ui.optionStrike = "";
    return;
  }

  const spot = toFiniteNumber(data.spot);
  if (Number.isFinite(spot)) {
    let best = options[0];
    let bestDist = Math.abs(Number(options[0].strike_price) - spot);
    for (let i = 1; i < options.length; i += 1) {
      const dist = Math.abs(Number(options[i].strike_price) - spot);
      if (dist < bestDist) {
        best = options[i];
        bestDist = dist;
      }
    }
    ui.optionStrike = String(Number(best.strike_price));
    return;
  }

  ui.optionStrike = String(Number(options[0].strike_price));
}

function chooseDefaultExpiryTs() {
  if (!expiryList.value.length) return "";
  const target = Date.now() / 1000 + 30 * 24 * 60 * 60;
  let best = expiryList.value[0];
  let bestDiff = Math.abs(best.timestamp - target);
  for (let i = 1; i < expiryList.value.length; i += 1) {
    const diff = Math.abs(expiryList.value[i].timestamp - target);
    if (diff < bestDiff) {
      best = expiryList.value[i];
      bestDiff = diff;
    }
  }
  return String(best.timestamp);
}

async function loadUniverse() {
  const instruments = await fetchAllInstruments();
  data.options = Array.isArray(instruments) ? instruments : [];
}

async function fetchTickersForOptions(options) {
  const instrumentNames = Array.from(
    new Set(
      (options || [])
        .map((option) => String(option?.instrument_name || ""))
        .filter(Boolean),
    ),
  );
  if (!instrumentNames.length) return {};

  const settled = await Promise.allSettled(
    instrumentNames.map((instrumentName) => fetchTicker(instrumentName)),
  );

  const tickerMap = {};
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    tickerMap[instrumentNames[index]] = result.value;
  });

  return tickerMap;
}

async function loadMarketForSelected({ preserveAdjusted = false } = {}) {
  const instrument = selectedInstrument.value;
  if (!instrument) {
    data.ticker = null;
    data.optionTickers = {};
    return;
  }

  ui.loading = true;
  ui.error = "";

  try {
    data.underlying = String(instrument.underlying || "BTCUSD");
    const expiryOptions = instrumentOptions.value;

    const [spot, tickerMap] = await Promise.all([
      fetchIndexNow(data.underlying),
      fetchTickersForOptions(expiryOptions),
    ]);

    let ticker = tickerMap[instrument.instrument_name] || null;
    if (!ticker) {
      ticker = await fetchTicker(instrument.instrument_name);
      if (ticker) tickerMap[instrument.instrument_name] = ticker;
    }

    data.spot = spot;
    data.ticker = ticker;
    data.optionTickers = tickerMap;

    if (!preserveAdjusted && !adjustedDirty.value) {
      const forward = toFiniteNumber(ticker?.forward);
      if (Number.isFinite(forward) && forward > 0) {
        ui.adjustedForward = String(Math.round(forward));
      } else if (Number.isFinite(spot) && spot > 0) {
        ui.adjustedForward = String(Math.round(spot));
      }
    }

    data.lastLoadedAt = Date.now();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
    data.ticker = null;
  } finally {
    ui.loading = false;
  }
}

async function initialize() {
  ui.loading = true;
  ui.error = "";

  try {
    await loadUniverse();

    if (!expiryList.value.length) {
      ui.error = "No BTC options expirations found.";
      return;
    }

    ui.expiryTs = chooseDefaultExpiryTs();

    data.underlying = "BTCUSD";
    data.spot = await fetchIndexNow(data.underlying);

    chooseDefaultStrike();
    adjustedDirty.value = false;

    await loadMarketForSelected();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.loading = false;
  }
}

async function onExpiryChange() {
  chooseDefaultStrike();
  await loadMarketForSelected({ preserveAdjusted: true });
}

async function onStrikeChange() {
  adjustedDirty.value = false;
  await loadMarketForSelected();
}

function onAdjustedForwardInput(event) {
  ui.adjustedForward = event.target.value;
  adjustedDirty.value = true;
}

async function refreshInputs() {
  await loadMarketForSelected();
}

onMounted(async () => {
  await initialize();
});

watch(
  () => model.value?.mu,
  (next, prev) => {
    if (!Number.isFinite(next) || !Number.isFinite(prev)) return;
    if (Math.abs(next - prev) < 1e-12) return;

    if (muFlashTimer) clearTimeout(muFlashTimer);
    muFlash.value = false;
    requestAnimationFrame(() => {
      muFlash.value = true;
      muFlashTimer = setTimeout(() => {
        muFlash.value = false;
        muFlashTimer = null;
      }, 900);
    });
  },
);

onUnmounted(() => {
  if (muFlashTimer) clearTimeout(muFlashTimer);
});
</script>

<template>
  <div class="app subjectiveApp">
    <header class="header">
      <div class="titleRow">
        <h1>Subjective Valuation</h1>
        <div class="titleRight">
          <div class="updatedStamp">
            Last modified: {{ formatUpdated(data.lastLoadedAt) }}
          </div>
          <button
            class="headerRefreshButton"
            type="button"
            @click="refreshInputs"
            :disabled="ui.loading"
          >
            <span aria-hidden="true">↻</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <section class="topDashboard" :class="{ loading: ui.loading }">
      <div class="controls controlsTop">
        <div class="field">
          <label for="expiry">Expiry</label>
          <select id="expiry" v-model="ui.expiryTs" @change="onExpiryChange">
            <option
              v-for="expiry in expiryList"
              :key="expiry.timestamp"
              :value="String(expiry.timestamp)"
            >
              {{ expiry.code }}
            </option>
          </select>
        </div>

        <div class="field" v-if="ui.viewMode === 'formula'">
          <label for="option-strike">Strike</label>
          <select
            id="option-strike"
            v-model="ui.optionStrike"
            @change="onStrikeChange"
          >
            <option
              v-for="strike in strikeOptions"
              :key="strike.value"
              :value="strike.value"
            >
              {{ strike.label }}
            </option>
            <option v-if="!strikeOptions.length" :value="ui.optionStrike">
              {{ ui.optionStrike }}
            </option>
          </select>
        </div>

        <div class="field fEstField" v-if="model">
          <label class="fEstLabel" for="adjustedForward"
            >F<sub>est</sub> =</label
          >
          <input
            id="adjustedForward"
            class="fEstInput"
            type="number"
            inputmode="decimal"
            step="100"
            min="0"
            :value="ui.adjustedForward"
            @input="onAdjustedForwardInput"
          />
        </div>

        <div class="viewToggle" role="group" aria-label="Display mode">
          <button
            type="button"
            class="viewToggleButton"
            :class="{ active: ui.viewMode === 'formula' }"
            @click="ui.viewMode = 'formula'"
          >
            Formula
          </button>
          <button
            type="button"
            class="viewToggleButton"
            :class="{ active: ui.viewMode === 'chart' }"
            @click="ui.viewMode = 'chart'"
          >
            Chart
          </button>
        </div>
      </div>

      <div
        v-if="model"
        class="chartParamsRow"
        :class="{ 'chartParamsRow--formula': ui.viewMode === 'formula' }"
        aria-label="Input parameters"
      >
        <div class="chartParam">
          <span class="chartParamLabel">Spot (S)</span>
          <span class="chartParamValue">{{
            formatMoney(model.spot, 1, 1)
          }}</span>
        </div>
        <div class="chartParam">
          <span class="chartParamLabel">Forward (F)</span>
          <span class="chartParamValue">{{
            formatMoney(model.forward, 1, 1)
          }}</span>
        </div>
        <div class="chartParam">
          <span class="chartParamLabel">r</span>
          <span class="chartParamValue">{{
            formatPercent(model.r * 100, 1)
          }}</span>
        </div>
        <div class="chartParam">
          <span class="chartParamLabel">μ</span>
          <span class="chartParamValue">{{
            formatPercent(model.mu * 100, 1)
          }}</span>
        </div>
        <div class="chartParam">
          <span class="chartParamLabel">T</span>
          <span class="chartParamValue">{{ formatNumber(model.T, 4) }}y</span>
        </div>
        <div class="chartParam">
          <span class="chartParamLabel">σ</span>
          <span class="chartParamValue">{{
            formatPercent(model.iv * 100, 1)
          }}</span>
        </div>
      </div>
    </section>

    <section
      v-if="ui.viewMode === 'formula'"
      class="formulaMatrix"
      :class="{ loading: ui.loading }"
    >
      <div class="formulaCell formulaCell--left">
        <div
          class="equationCard equationCard--symbolic equationCard--matrixLeft"
        >
          <div class="equationRow">
            <span class="eqLhs">d₃ =</span>
            <div class="eqFraction">
              <div class="eqNum">ln(S/K) + (r + μ + σ²/2)T</div>
              <div class="eqDivLine"></div>
              <div class="eqDen">σ√T</div>
            </div>
          </div>
        </div>
      </div>
      <div class="formulaCell formulaCell--right">
        <template v-if="model">
          <div
            class="equationCard equationCard--symbolic equationCard--filled"
            :class="{ flash: muFlash }"
          >
            <div class="equationRow">
              <span class="eqLhs">d₃ =</span>
              <div class="eqValue">
                N(d₃) = {{ formatProbability(model.nd3, 2) }}
                <span class="eqCompare"
                  >// N(d₁) {{ formatProbability(model.nd1, 2) }}</span
                >
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="formulaCell formulaCell--left">
        <div
          class="equationCard equationCard--symbolic equationCard--matrixLeft"
        >
          <div class="equationRow">
            <span class="eqLhs">d₄ =</span>
            <div class="eqFraction">
              <div class="eqNum">ln(S/K) + (r + μ − σ²/2)T</div>
              <div class="eqDivLine"></div>
              <div class="eqDen">σ√T</div>
            </div>
          </div>
        </div>
      </div>
      <div class="formulaCell formulaCell--right">
        <template v-if="model">
          <div class="equationCard equationCard--symbolic equationCard--filled">
            <div class="equationRow">
              <span class="eqLhs">d₄ =</span>
              <div class="eqValue">
                N(d₄) = {{ formatProbability(model.nd4, 2) }}
                <span class="eqCompare"
                  >// N(d₂) {{ formatProbability(model.nd2, 2) }}</span
                >
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="formulaCell formulaCell--left">
        <div class="answerCard answerCard--symbolic equationCard--matrixLeft">
          <div class="answerValue">
            C =
            <span class="eqInline"
              >Se<sup>μT</sup>N(d₃) − Ke<sup>−rT</sup>N(d₄)</span
            >
          </div>
        </div>
      </div>
      <div class="formulaCell formulaCell--right">
        <template v-if="model">
          <div class="answerCard">
            <div class="answerValue">
              C = {{ formatMoney(model.subjectivePrice, 0) }}
              <span class="marketComment"
                >// was {{ formatMoney(model.markPrice, 0) }}</span
              >
              <span
                class="answerEdgeInline"
                :class="{ pos: model.edge > 0, neg: model.edge < 0 }"
              >
                Diff: {{ formatMoney(model.edge, 0) }} ({{
                  formatPercent(model.edgePct, 1)
                }})
              </span>
            </div>
          </div>
        </template>
        <div class="empty" v-else>Waiting for complete market inputs.</div>
      </div>

      <div v-if="ui.loading" class="overlay">Loading market inputs...</div>
    </section>

    <section v-else class="chartMatrix" :class="{ loading: ui.loading }">
      <template v-if="chartBars.length">
        <div class="distributionCard">
          <div class="distributionHeader">
            <div class="distributionTitleBlock">
              <div class="distributionTitle">Adjusted prices by strike</div>
            </div>
            <div class="chartLegend">
              <div class="legendItem">
                <span class="legendSwatch legendSwatch--market"></span>
                <span>Market price</span>
              </div>
              <div class="legendItem">
                <span class="legendSwatch legendSwatch--adjusted"></span>
                <span>Adjusted valuation</span>
              </div>
            </div>
          </div>

          <div class="strikeChartWrap">
            <div class="strikeChart">
              <div
                v-for="bar in chartBars"
                :key="bar.strike"
                class="strikeColumn"
              >
                <div class="barDataLabels">
                  <div class="barDataRow">
                    <span class="barDataMain">{{ formatMoney(bar.adjusted, 0) }}</span>
                  </div>
                  <div class="barDataRow">
                    <span
                      class="barDataMuted"
                      :class="{ pos: bar.edge > 0, neg: bar.edge < 0 }"
                    >
                      {{ formatPercent(bar.edgePct, 1) }}
                    </span>
                  </div>
                </div>

                <div class="strikeBars">
                  <div
                    class="bar barMarket"
                    :style="{ height: `${bar.marketPct}%` }"
                  ></div>
                  <div
                    v-if="bar.adjustedTopPct > 0"
                    class="bar barAdjusted"
                    :style="{
                      height: `${bar.adjustedTopPct}%`,
                      bottom: `${bar.marketPct}%`,
                    }"
                  ></div>
                </div>

                <div class="strikeLabel">{{ bar.strikeLabel }}</div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="empty">
        No strike valuations available for chart mode.
      </div>

      <div v-if="ui.loading" class="overlay">Loading market inputs...</div>
    </section>
  </div>
</template>

<style scoped>
.subjectiveApp {
  max-width: none;
  background: #000;
  min-height: 100vh;
  color: #e8e8ea;
  --formula-font:
    "Cambria Math", "STIX Two Text", "Times New Roman", Times, serif;
}

.header {
  border-bottom: 1px solid rgba(255, 255, 255, 0.52);
  padding-bottom: 10px;
  margin-bottom: 8px;
}

.titleRow {
  width: 100%;
  align-items: center;
  justify-content: space-between;
}

.titleRight {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.formulaMatrix {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(120px, auto));
  column-gap: 0;
  row-gap: 72px;
  width: min(1700px, 100%);
  margin: 0 auto;
  padding: 10px 8px 24px;
  min-height: calc(100vh - 280px);
  align-items: center;
}

.formulaCell {
  min-width: 0;
  display: flex;
  align-items: center;
}

.formulaCell--left {
  justify-content: center;
}

.formulaCell--right {
  justify-content: flex-start;
  padding-left: 42px;
}

.equationCard--matrixLeft,
.answerCard.equationCard--matrixLeft {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.formulaCell .equationCard,
.formulaCell .answerCard {
  font-family: var(--formula-font);
}

.topDashboard {
  width: min(1300px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 2px 8px 14px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
}

.controlsTop {
  margin: 0;
  justify-content: center;
  width: 100%;
}

.updatedStamp {
  text-align: right;
  color: #a3aab9;
  font-size: 12px;
  letter-spacing: 0.01em;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  white-space: nowrap;
}

.headerRefreshButton {
  min-height: 36px;
  height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.headerRefreshButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.controlsTop .field {
  min-height: 56px;
  height: 56px;
  padding: 0 18px;
  align-items: center;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
}

.controlsTop .field label {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  font-size: 18px;
  font-weight: 600;
  color: rgba(226, 232, 240, 0.72);
}

.controlsTop .field select {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  font-size: 16px;
  line-height: 1;
  font-weight: 600;
  color: #f8fafc;
  padding-right: 0;
}

.controlsTop .saveButton {
  min-height: 56px;
  height: 56px;
  padding: 0 18px;
  font-size: 18px;
  font-weight: 600;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.viewToggle {
  display: inline-flex;
  height: 56px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: #0f1318;
  overflow: hidden;
}

.viewToggleButton {
  border: 0;
  background: transparent;
  color: rgba(226, 232, 240, 0.72);
  font-size: 18px;
  font-weight: 600;
  padding: 0 18px;
  cursor: pointer;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.viewToggleButton + .viewToggleButton {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.viewToggleButton.active {
  color: #f8fafc;
  background: #131923;
}

.metaRow {
  width: 100%;
  margin-top: 4px;
  display: flex;
  justify-content: center;
}

.chartParamsRow {
  width: min(1700px, 100%);
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  align-items: center;
  margin-top: 4px;
  padding: 0 4px;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.chartParam {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}

.chartParamLabel {
  color: #9ea7ba;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.chartParamValue {
  color: #e6ebf4;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.chartParamsRow--formula .chartParamLabel {
  font-size: 18px;
}

.chartParamsRow--formula .chartParamValue {
  font-size: 19px;
}

.paramsTable {
  width: auto;
  border-collapse: separate;
  border-spacing: 34px 8px;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.paramsTable th {
  text-align: left;
  color: #a4acbc;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.12;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.paramsTable td {
  text-align: left;
  color: #e3e8f1;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.fEstField {
  min-height: 56px;
  height: 56px;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
}

.fEstLabel {
  color: rgba(226, 232, 240, 0.72);
  font-size: 18px;
  line-height: 1;
  font-style: normal;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  letter-spacing: 0.01em;
}

.fEstInput {
  appearance: none;
  min-width: 170px;
  width: 210px;
  height: 100%;
  background: transparent;
  border: 0;
  color: #f8fafc;
  font-size: 17px;
  line-height: 1;
  padding: 0;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  font-style: normal;
  font-weight: 700;
}

.fEstInput:focus {
  outline: none;
}

.fEstInput::-webkit-outer-spin-button,
.fEstInput::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.fEstInput[type="number"] {
  -moz-appearance: textfield;
}

.equationCard {
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
}

.equationCard--symbolic {
  min-height: 0;
  width: fit-content;
  max-width: 100%;
}

.equationCard--symbolic .equationRow {
  justify-content: center;
}

.equationCard--symbolic .eqFraction {
  flex: 0 0 auto;
  min-width: 0;
  display: inline-grid;
  justify-items: center;
}

.equationCard--symbolic .eqNum,
.equationCard--symbolic .eqDen {
  width: max-content;
}

.equationCard--symbolic .eqDivLine {
  width: 100%;
}

.equationCard.flash {
  animation: muPulse 900ms ease;
}

@keyframes muPulse {
  0% {
    text-shadow: 0 0 0 rgba(111, 157, 255, 0);
  }
  35% {
    text-shadow:
      0 0 8px rgba(111, 157, 255, 0.65),
      0 0 20px rgba(111, 157, 255, 0.35);
  }
  100% {
    text-shadow: 0 0 0 rgba(111, 157, 255, 0);
  }
}

.equationRow {
  display: flex;
  align-items: center;
  gap: 14px;
}

.eqLhs {
  color: #f0f2f9;
  font-size: 40px;
  line-height: 1;
  font-style: italic;
  font-family: var(--formula-font);
  flex: 0 0 auto;
  min-width: 2.35ch;
  text-align: right;
}

.eqFraction {
  min-width: 0;
  flex: 1 1 auto;
}

.eqNum {
  color: #e1e4f1;
  font-size: 28px;
  line-height: 1.25;
  font-style: italic;
  font-family: var(--formula-font);
  white-space: nowrap;
}

.eqDivLine {
  height: 1px;
  margin: 6px 0 9px;
  background: #f0f2f9;
}

.eqDen {
  color: #e1e4f1;
  font-size: 28px;
  line-height: 1.2;
  font-style: italic;
  font-family: var(--formula-font);
}

.eqValue {
  color: #f0f2f9;
  font-size: 32px;
  line-height: 1.2;
  font-style: italic;
  font-family: var(--formula-font);
  white-space: nowrap;
  min-width: 14.2ch;
  text-align: left;
}

.eqCompare {
  margin-left: 14px;
  color: #9096a8;
  font-size: 0.62em;
  display: inline-block;
  transform: translateY(-1px);
  font-family: var(--formula-font);
}

.n {
  color: inherit;
  font-style: inherit;
  font-family: inherit;
  font-size: 1em;
  font-weight: inherit;
}

.eqResult {
  margin-top: 8px;
  color: #d6dae9;
  font-size: 28px;
  line-height: 1.2;
  font-style: italic;
}

.equationCard--filled .eqResult {
  padding-left: 0;
}

.answerCard {
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
}

.answerCard--symbolic {
  margin-top: 0;
  width: fit-content;
  max-width: 100%;
}

.answerCard--symbolic .answerValue {
  text-align: center;
}

.answerValue {
  font-size: 38px;
  line-height: 1.15;
  font-style: italic;
  font-family: var(--formula-font);
}

.eqInline {
  color: #f0f2f9;
  font-size: 0.68em;
  font-family: var(--formula-font);
}

.marketComment {
  margin-left: 14px;
  color: #8a90a1;
  font-size: 0.64em;
  display: inline-block;
  transform: translateY(-1px);
  font-family: var(--formula-font);
}

.answerEdgeInline {
  margin-left: 14px;
  font-size: 0.56em;
  line-height: 1;
  display: inline-block;
  transform: translateY(-1px);
}

.empty {
  color: #9094a1;
  font-size: 18px;
  padding-top: 8px;
}

.pos {
  color: #83d171;
}

.neg {
  color: #ff8f8f;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 38%);
  border-radius: 0;
  font-size: 14px;
  z-index: 10;
}

.chartMatrix {
  position: relative;
  width: min(1700px, 100%);
  margin: 0 auto;
  min-height: calc(100vh - 280px);
  padding: 8px 10px 28px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
}

.distributionCard {
  background: #000;
  border: 0;
  border-radius: 0;
  padding: 18px 16px 14px;
  width: 100%;
}

.distributionHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 8px;
}

.distributionTitleBlock {
  display: grid;
  gap: 4px;
}

.distributionEyebrow {
  color: #afb6c7;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.distributionTitle {
  color: #f6f8fc;
  font-size: 22px;
  line-height: 1.15;
  font-weight: 700;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.chartLegend {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 22px;
  font-size: 14px;
  color: #d4dae8;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  margin-top: 2px;
}

.legendItem {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.legendSwatch {
  width: 16px;
  height: 16px;
  border-radius: 4px;
}

.legendSwatch--market {
  background: #eceff5;
}

.legendSwatch--adjusted {
  background: #050607;
  border: 1.1px solid #eceff5;
}

.strikeChartWrap {
  flex: 1 1 auto;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 6px 6px 4px;
}

.strikeChart {
  height: 100%;
  min-height: 500px;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(64px, 1fr);
  gap: 8px;
  align-items: end;
  width: max-content;
  min-width: 100%;
}

.strikeColumn {
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 10px;
  align-items: end;
  min-height: 470px;
}

.barDataLabels {
  display: grid;
  justify-items: center;
  gap: 2px;
  white-space: nowrap;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.barDataRow {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.barDataMain {
  color: #f2f5fc;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.barDataMuted {
  color: #8f97ab;
  font-size: 13px;
  font-weight: 600;
}

.strikeBars {
  position: relative;
  --bar-width: 46%;
  --bar-max-width: 28px;
  height: 100%;
  min-height: 320px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bar {
  position: absolute;
  bottom: 0;
  border-radius: 0 !important;
  box-sizing: border-box;
  min-height: 2px;
}

.barMarket {
  width: var(--bar-width);
  max-width: var(--bar-max-width);
  background: #eceff5;
  z-index: 1;
  border-radius: 0 !important;
}

.barAdjusted {
  width: var(--bar-width);
  max-width: var(--bar-max-width);
  background: #050607;
  border: 1.1px solid #eceff5;
  border-bottom-width: 0;
  z-index: 2;
  border-radius: 0 !important;
}

.strikeLabel {
  text-align: center;
  color: #d3d9e6;
  font-size: 13px;
  letter-spacing: 0.01em;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
  white-space: nowrap;
  border: 0 !important;
  outline: 0;
  box-shadow: none;
  padding-top: 10px;
  margin-top: 4px;
}

@media (max-width: 1120px) {
  .formulaMatrix {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
    row-gap: 28px;
    min-height: auto;
    padding-bottom: 18px;
  }

  .formulaCell--right {
    justify-content: center;
    padding-left: 0;
  }

  .equationCard--matrixLeft,
  .answerCard.equationCard--matrixLeft {
    align-items: center;
  }

  .formulaCell .answerCard,
  .formulaCell .equationCard {
    text-align: center;
  }

  .formulaCell .equationRow {
    justify-content: center;
  }

  .overlay {
    position: fixed;
    inset: 0;
  }

  .formulaMatrix {
    min-height: auto;
  }

  .eqLhs {
    font-size: 34px;
  }

  .eqNum,
  .eqDen {
    font-size: 24px;
  }

  .eqValue {
    font-size: 27px;
  }

  .eqResult {
    font-size: 24px;
  }

  .answerValue {
    font-size: 30px;
  }

  .fEstField {
    min-height: 46px;
    height: 46px;
  }

  .controlsTop .field {
    min-height: 44px;
    height: 44px;
    padding: 8px 12px;
    border-radius: 12px;
  }

  .controlsTop .field label {
    font-size: 14px;
  }

  .controlsTop .field select {
    font-size: 12px;
  }

  .controlsTop .saveButton {
    min-height: 44px;
    height: 44px;
    font-size: 14px;
    padding: 0 14px;
    border-radius: 12px;
  }

  .viewToggle {
    height: 44px;
    border-radius: 12px;
  }

  .viewToggleButton {
    font-size: 14px;
    padding: 0 14px;
  }

  .chartParamsRow {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px 12px;
  }

  .chartParamLabel,
  .chartParamValue {
    font-size: 14px;
  }

  .chartParamsRow--formula .chartParamLabel {
    font-size: 16px;
  }

  .chartParamsRow--formula .chartParamValue {
    font-size: 17px;
  }

  .fEstLabel {
    font-size: 14px;
  }

  .fEstInput {
    font-size: 13px;
    min-width: 140px;
    width: 170px;
  }

  .titleRight {
    gap: 8px;
  }

  .headerRefreshButton {
    height: 30px;
    min-height: 30px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: 10px;
    gap: 6px;
  }

  .marketComment {
    display: block;
    margin-left: 0;
    margin-top: 2px;
    font-size: 16px;
  }

  .chartMatrix {
    min-height: auto;
    padding: 6px 2px 18px;
    justify-content: flex-start;
  }

  .distributionCard {
    border-radius: 0;
    border: 0;
    background: #000;
    padding: 12px 10px 10px;
  }

  .distributionHeader {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .distributionTitle {
    font-size: 18px;
  }

  .distributionEyebrow {
    font-size: 11px;
  }

  .chartLegend {
    font-size: 12px;
    gap: 14px;
  }

  .legendSwatch {
    width: 12px;
    height: 12px;
  }

  .strikeChart {
    min-height: 360px;
    grid-auto-columns: minmax(48px, 1fr);
    gap: 6px;
  }

  .strikeColumn {
    min-height: 360px;
  }

  .strikeBars {
    --bar-width: 52%;
    --bar-max-width: 24px;
    min-height: 220px;
  }

  .barDataMain {
    font-size: 12px;
  }

  .barDataMuted {
    font-size: 10px;
  }

  .strikeLabel {
    font-size: 12px;
    padding-top: 8px;
  }
}
</style>
