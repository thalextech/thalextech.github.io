<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { toCanvas } from "html-to-image";

const API_BASE = import.meta.env.DEV
  ? "/api/v2/public"
  : "https://thalex.com/api/v2/public";
const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;
const DEFAULT_FORWARD_MULTIPLIER = 1.05;
const CHART_MIN_ABS_DELTA = 0.02;
const CHART_MAX_ABS_DELTA = 0.7;
const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];
const OPTION_TYPE_OPTIONS = [
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
];

const ui = reactive({
  underlying: "BTCUSD",
  optionType: "call",
  expiryTs: "",
  optionStrike: "",
  adjustedForward: "",
  vrpPct: "0",
  viewMode: "chart",
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

const selectedUnderlying = computed(() => String(ui.underlying || "BTCUSD"));
const selectedUnderlyingProduct = computed(
  () => `O${selectedUnderlying.value}`,
);
const selectedUnderlyingLabel = computed(() => {
  return (
    UNDERLYING_OPTIONS.find((item) => item.value === selectedUnderlying.value)
      ?.label || selectedUnderlying.value
  );
});
const selectedOptionType = computed(() =>
  normalizeOptionType(ui.optionType),
);

const filteredOptions = computed(() => {
  const now = Date.now() / 1000;
  return (data.options || []).filter((option) => {
    if (!option || typeof option !== "object") return false;
    if (option.type !== "option") return false;
    const byUnderlying = String(option.underlying || "") === selectedUnderlying.value;
    const byProduct = String(option.product || "") === selectedUnderlyingProduct.value;
    if (!byUnderlying && !byProduct) return false;
    if (!Number.isFinite(option.expiration_timestamp)) return false;
    return option.expiration_timestamp > now;
  });
});

const expiryList = computed(() => {
  const byExpiry = new Map();
  for (const option of filteredOptions.value) {
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
  return filteredOptions.value
    .filter(
      (option) =>
        Number(option.expiration_timestamp) === ts &&
        normalizeOptionType(option.option_type) === selectedOptionType.value,
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
const vrpPctValue = computed(() => {
  const value = toFiniteNumber(ui.vrpPct);
  return Number.isFinite(value) ? value : 0;
});

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
  const vrpPct = vrpPctValue.value;
  const valuationIv = Number.isFinite(iv) ? iv - vrpPct / 100 : null;
  const nowTs = Date.now() / 1000;

  const T = Number.isFinite(expirationTs)
    ? (expirationTs - nowTs) / SECONDS_PER_BS_YEAR
    : null;

  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(iv) ||
    !Number.isFinite(valuationIv) ||
    !Number.isFinite(markPrice) ||
    !Number.isFinite(forward) ||
    !Number.isFinite(adjustedForward) ||
    !Number.isFinite(T) ||
    spot <= 0 ||
    strike <= 0 ||
    iv <= 0 ||
    valuationIv <= 0 ||
    forward <= 0 ||
    adjustedForward <= 0 ||
    T <= 0
  ) {
    return null;
  }

  const r = Math.log(forward / spot) / T;
  const mu = Math.log(adjustedForward / forward) / T;
  const lnSk = Math.log(spot / strike);
  const sigma2Half = 0.5 * valuationIv * valuationIv;
  const sigmaSqrtT = valuationIv * Math.sqrt(T);
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
    valuationIv,
    vrpPct,
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

const summaryStats = computed(() => {
  if (!model.value) return [];
  return [
    { label: "Spot (S)", value: formatMoney(model.value.spot, 1, 1) },
    { label: "Forward (F)", value: formatMoney(model.value.forward, 1, 1) },
    { label: "Forward rate (r)", value: formatPercent(model.value.r * 100, 1) },
    { label: "Drift (μ)", value: formatPercent(model.value.mu * 100, 1) },
    { label: "IV (σ)", value: formatPercent(model.value.iv * 100, 1) },
    {
      label: "Vol (est)",
      value: formatPercent(model.value.valuationIv * 100, 1),
    },
  ];
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
  const vrpPct = vrpPctValue.value;
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
    const valuationIv = Number.isFinite(iv) ? iv - vrpPct / 100 : null;
    const markPrice = toFiniteNumber(ticker?.mark_price);
    const forward = toFiniteNumber(ticker?.forward);
    const delta = toFiniteNumber(ticker?.delta);
    const absDelta = Number.isFinite(delta) ? Math.abs(delta) : null;

    const T = Number.isFinite(expirationTs)
      ? (expirationTs - nowTs) / SECONDS_PER_BS_YEAR
      : null;

    if (
      !Number.isFinite(strike) ||
      !Number.isFinite(iv) ||
      !Number.isFinite(valuationIv) ||
      !Number.isFinite(markPrice) ||
      !Number.isFinite(forward) ||
      !Number.isFinite(absDelta) ||
      !Number.isFinite(T) ||
      strike <= 0 ||
      iv <= 0 ||
      valuationIv <= 0 ||
      forward <= 0 ||
      absDelta < CHART_MIN_ABS_DELTA ||
      absDelta > CHART_MAX_ABS_DELTA ||
      T <= 0
    ) {
      continue;
    }

    const r = Math.log(forward / spot) / T;
    const mu = Math.log(adjustedForward / forward) / T;
    const d3 = calcD3(spot, strike, T, valuationIv, r, mu);
    const d4 = calcD4(spot, strike, T, valuationIv, r, mu);
    const nd3 = normalCdf(d3);
    const nd4 = normalCdf(d4);
    const nd3Neg = normalCdf(-d3);
    const nd4Neg = normalCdf(-d4);
    const optionType = normalizeOptionType(option.option_type);
    const call =
      spot * Math.exp(mu * T) * nd3 - strike * Math.exp(-r * T) * nd4;
    const put =
      strike * Math.exp(-r * T) * nd4Neg - spot * Math.exp(mu * T) * nd3Neg;
    const adjusted = optionType === "call" ? call : put;

    rows.push({
      optionType,
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
  const url = buildPublicUrl("/all_instruments");
  const json = await getJson(url);
  data.options = Array.isArray(json?.result) ? json.result : [];
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
        ui.adjustedForward = String(
          Math.round(forward * DEFAULT_FORWARD_MULTIPLIER),
        );
      } else if (Number.isFinite(spot) && spot > 0) {
        ui.adjustedForward = String(
          Math.round(spot * DEFAULT_FORWARD_MULTIPLIER),
        );
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
      ui.error = `No ${selectedUnderlyingLabel.value} options expirations found.`;
      return;
    }

    ui.expiryTs = chooseDefaultExpiryTs();

    data.underlying = selectedUnderlying.value;
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

async function onOptionTypeChange(nextType) {
  const optionType = normalizeOptionType(nextType);
  if (optionType === selectedOptionType.value) return;

  ui.optionType = optionType;
  const selected = selectedStrike.value;
  const hasSelectedStrike = instrumentOptions.value.some(
    (option) => Number(option.strike_price) === selected,
  );
  if (!hasSelectedStrike) chooseDefaultStrike();
  adjustedDirty.value = false;
  await loadMarketForSelected();
}

async function onUnderlyingChange(nextUnderlying) {
  const underlying = String(nextUnderlying || "BTCUSD");
  if (underlying === selectedUnderlying.value) return;

  ui.underlying = underlying;
  ui.error = "";

  if (!expiryList.value.length) {
    ui.expiryTs = "";
    ui.optionStrike = "";
    data.ticker = null;
    data.optionTickers = {};
    data.spot = null;
    ui.error = `No ${selectedUnderlyingLabel.value} options expirations found.`;
    return;
  }

  ui.expiryTs = chooseDefaultExpiryTs();
  data.spot = null;
  chooseDefaultStrike();
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

const screenshotRef = ref(null);
const savingPng = ref(false);

async function handleSavePng() {
  const node = screenshotRef.value;
  if (!node || savingPng.value) return;
  savingPng.value = true;
  // .capturing hides scrollbars and forces inner scroll containers visible
  // so cloned DOM doesn't render scrollbars into the PNG.
  node.classList.add("capturing");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const pixelRatio = 4;
    const padding = 32;
    // scrollWidth/Height covers content that overflows the node's box
    // (e.g. .topControls with width: max-content on narrow viewports).
    const contentWidth = Math.max(node.scrollWidth, node.offsetWidth);
    const contentHeight = Math.max(node.scrollHeight, node.offsetHeight);
    const source = await toCanvas(node, {
      pixelRatio,
      backgroundColor: "#000",
      cacheBust: true,
      width: contentWidth,
      height: contentHeight,
    });

    const padPx = padding * pixelRatio;
    const out = document.createElement("canvas");
    out.width = source.width + padPx * 2;
    out.height = source.height + padPx * 2;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, padPx, padPx);

    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    if (!blob) return;
    const expiryCode = selectedExpiry.value?.code || "expiry";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `subjective-${ui.underlying}-${expiryCode}-${ui.viewMode}.png`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Failed to export PNG", err);
  } finally {
    node.classList.remove("capturing");
    savingPng.value = false;
  }
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
  <div class="app subjectiveApp" ref="screenshotRef">
    <header class="header">
      <div class="titleRow">
        <h1>Subjective Valuation</h1>
        <div class="titleRight">
          <div class="updatedStamp">Last modified: {{ formatUpdated(data.lastLoadedAt) }}</div>
          <button
            class="headerActionButton"
            type="button"
            @click="handleSavePng"
            :disabled="savingPng || ui.loading"
            title="Save screenshot as PNG"
          >
            {{ savingPng ? "..." : "Save PNG" }}
          </button>
          <button class="headerRefreshButton" type="button" @click="refreshInputs" :disabled="ui.loading">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <div class="layoutFrame">
      <section class="topDashboard" :class="{ loading: ui.loading }">
        <div class="topGrid" aria-label="Inputs and parameters">
          <div class="topControls" :class="{ chartMode: ui.viewMode === 'chart' }">
            <div class="controlBlock">
              <div class="viewToggle underlyingToggle" role="group" aria-label="Underlying">
                <button
                  v-for="underlying in UNDERLYING_OPTIONS"
                  :key="underlying.value"
                  type="button"
                  class="viewToggleButton"
                  :class="{ active: selectedUnderlying === underlying.value }"
                  @click="onUnderlyingChange(underlying.value)"
                >
                  {{ underlying.label }}
                </button>
              </div>
            </div>

            <div class="controlBlock">
              <div class="viewToggle optionTypeToggle" role="group" aria-label="Option type">
                <button
                  v-for="optionType in OPTION_TYPE_OPTIONS"
                  :key="optionType.value"
                  type="button"
                  class="viewToggleButton"
                  :class="{ active: selectedOptionType === optionType.value }"
                  @click="onOptionTypeChange(optionType.value)"
                >
                  {{ optionType.label }}
                </button>
              </div>
            </div>

            <div class="controlBlock controlBlockInputs">
              <div class="field fieldExpiry">
                <label for="expiry">Expiry</label>
                <select id="expiry" v-model="ui.expiryTs" @change="onExpiryChange">
                  <option v-for="expiry in expiryList" :key="expiry.timestamp" :value="String(expiry.timestamp)">
                    {{ expiry.code }}
                  </option>
                </select>
              </div>

              <div class="field fieldStrike" v-if="ui.viewMode === 'formula'">
                <label for="option-strike">Strike</label>
                <select id="option-strike" v-model="ui.optionStrike" @change="onStrikeChange">
                  <option v-for="strike in strikeOptions" :key="strike.value" :value="strike.value">
                    {{ strike.label }}
                  </option>
                  <option v-if="!strikeOptions.length" :value="ui.optionStrike">{{ ui.optionStrike }}</option>
                </select>
              </div>

              <div class="field fEstField">
                <label class="fEstLabel" for="adjustedForward">F<sub>est</sub> =</label>
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

              <div class="field vrpField">
                <label class="vrpLabel" for="vrp">VRP =</label>
                <input
                  id="vrp"
                  class="vrpInput"
                  type="number"
                  inputmode="decimal"
                  step="0.1"
                  min="0"
                  max="100"
                  :value="ui.vrpPct"
                  @input="ui.vrpPct = $event.target.value"
                />
                <span>%</span>
              </div>
            </div>

            <div class="controlBlock">
              <div class="viewToggle modeToggleWide" role="group" aria-label="Display mode">
                <button type="button" class="viewToggleButton" :class="{ active: ui.viewMode === 'formula' }" @click="ui.viewMode = 'formula'">
                  Formula
                </button>
                <button type="button" class="viewToggleButton" :class="{ active: ui.viewMode === 'chart' }" @click="ui.viewMode = 'chart'">
                  Chart
                </button>
              </div>
            </div>
          </div>

          <div v-if="summaryStats.length" class="paramsGrid">
            <div v-for="stat in summaryStats" :key="stat.label" class="paramStat">
              <div class="paramLabel">{{ stat.label }}</div>
              <div class="paramValue">{{ stat.value }}</div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="ui.viewMode === 'formula'" class="formulaSection" :class="{ loading: ui.loading }">
        <table class="formulaTable">
          <tbody>
            <tr>
              <td class="formulaCell">
                <div class="equationRow">
                  <span class="eqLhs eqLhsD">d₃ =</span>
                  <div class="eqFraction">
                    <div class="eqNum">ln(S/K) + (r + μ + σ²/2)T</div>
                    <div class="eqDiv"></div>
                    <div class="eqDen">σ√T</div>
                  </div>
                </div>
              </td>
              <td class="formulaCell">
                <div class="equationRow" v-if="model" :class="{ flash: muFlash }">
                  <span class="eqLhs eqLhsD">{{ model.optionType === "put" ? "N(−d₃)" : "N(d₃)" }} =</span>
                  <div class="eqValue">
                    {{ formatProbability(model.optionType === "put" ? model.nd3Neg : model.nd3, 2) }}
                    <span class="eqCompare">// N(d₁) {{ formatProbability(model.nd1, 2) }}</span>
                  </div>
                </div>
              </td>
            </tr>

            <tr>
              <td class="formulaCell">
                <div class="equationRow">
                  <span class="eqLhs eqLhsD">d₄ =</span>
                  <div class="eqFraction">
                    <div class="eqNum">ln(S/K) + (r + μ − σ²/2)T</div>
                    <div class="eqDiv"></div>
                    <div class="eqDen">σ√T</div>
                  </div>
                </div>
              </td>
              <td class="formulaCell">
                <div class="equationRow" v-if="model">
                  <span class="eqLhs eqLhsD">{{ model.optionType === "put" ? "N(−d₄)" : "N(d₄)" }} =</span>
                  <div class="eqValue">
                    {{ formatProbability(model.optionType === "put" ? model.nd4Neg : model.nd4, 2) }}
                    <span class="eqCompare">// N(d₂) {{ formatProbability(model.nd2, 2) }}</span>
                  </div>
                </div>
              </td>
            </tr>

            <tr>
              <td class="formulaCell">
                <div class="equationRow">
                  <span class="eqLhs eqLhsC">{{ selectedOptionType === "put" ? "P" : "C" }} =</span>
                  <div class="eqValue eqValueFormula">
                    <template v-if="selectedOptionType === 'put'">
                      Ke<sup>−rT</sup>N(−d₄) − Se<sup>μT</sup>N(−d₃)
                    </template>
                    <template v-else>
                      Se<sup>μT</sup>N(d₃) − Ke<sup>−rT</sup>N(d₄)
                    </template>
                  </div>
                </div>
              </td>
              <td class="formulaCell">
                <template v-if="model">
                  <div class="equationRow">
                    <span class="eqLhs eqLhsC">{{ model.optionType === "put" ? "P" : "C" }} =</span>
                    <div class="eqValue eqValueAnswer">{{ formatMoney(model.subjectivePrice, 0) }}</div>
                  </div>
                  <div class="eqMeta">
                    <span class="metaWas">// was {{ formatMoney(model.markPrice, 0) }}</span>
                    <span class="metaDiff" :class="{ pos: model.edge > 0, neg: model.edge < 0 }">
                      Diff: {{ formatMoney(model.edge, 0) }} ({{ formatPercent(model.edgePct, 1) }})
                    </span>
                  </div>
                </template>
                <div class="empty" v-else>Waiting for complete market inputs.</div>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="ui.loading" class="overlay">Loading market inputs...</div>
      </section>

      <section v-else class="chartSection" :class="{ loading: ui.loading }">
        <template v-if="chartBars.length">
          <div class="chartCard">
            <div class="chartHeader">
              <div class="chartTitle">Adjusted prices by strike</div>
              <div class="chartLegend">
                <div class="legendItem"><span class="legendSwatch legendSwatchMarket"></span><span>Market price</span></div>
                <div class="legendItem"><span class="legendSwatch legendSwatchAdjusted"></span><span>Adjusted valuation</span></div>
              </div>
            </div>

            <div class="strikeChartWrap">
              <div class="strikeChartFrame">
                <div class="strikePlot">
                  <div class="strikeHead">
                    <div v-for="bar in chartBars" :key="`head-${bar.optionType}-${bar.strike}`" class="strikeHeadItem">
                      <div class="barDataLabels">
                        <div class="barDataValue barDataMarket" :title="`Current mark price: ${formatMoney(bar.market, 0)}`">
                          {{ formatMoney(bar.market, 0) }}
                        </div>
                        <div class="barDataValue barDataAdjusted" :title="`Adjusted price: ${formatMoney(bar.adjusted, 0)}`">
                          {{ formatMoney(bar.adjusted, 0) }}
                        </div>
                        <div
                          class="barDataValue barDataUpside"
                          :class="{ pos: bar.edge > 0, neg: bar.edge < 0 }"
                          :title="`Upside: ${formatPercent(bar.edgePct, 1)}`"
                        >
                          {{ formatPercent(bar.edgePct, 1) }}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="strikeBody">
                    <div class="strikeChart">
                      <div v-for="bar in chartBars" :key="`${bar.optionType}-${bar.strike}`" class="strikeColumn">
                      <div class="strikeBars">
                        <div class="bar barMarket" :style="{ height: `${bar.marketPct}%` }"></div>
                        <div
                          v-if="bar.adjustedTopPct > 0"
                          class="bar barAdjusted"
                          :style="{ height: `${bar.adjustedTopPct}%`, bottom: `${bar.marketPct}%` }"
                        ></div>
                      </div>

                      <div class="strikeLabel">{{ bar.strikeLabel }}</div>
                    </div>
                  </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <div v-else class="empty">No strike valuations available for chart mode.</div>

        <div v-if="ui.loading" class="overlay">Loading market inputs...</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.subjectiveApp {
  --content-width: min(1200px, calc(100vw - 48px));
  --control-width: 176px;
  --eq-size: 28px;
  --eq-comment-size: 20px;
  --formula-font: "Cambria Math", "STIX Two Text", "Times New Roman", Times, serif;
  --ui-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  min-height: 100vh;
  background: #000;
  color: #e8e8ea;
}

.header {
  position: relative;
  padding-bottom: 10px;
  margin-bottom: 8px;
}

.header::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 100vw;
  border-bottom: 1px solid rgba(255, 255, 255, 0.52);
  transform: translateX(-50%);
  pointer-events: none;
}

.titleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.titleRight {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.updatedStamp {
  color: #a3aab9;
  font: 12px var(--ui-font);
  white-space: nowrap;
}

.headerRefreshButton {
  height: 36px;
  width: 36px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font: 600 18px var(--ui-font);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.headerRefreshButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.headerActionButton {
  height: 36px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font: 600 13px var(--ui-font);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  white-space: nowrap;
}

.headerActionButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.layoutFrame {
  width: var(--content-width);
  margin: 0 auto;
}

.subjectiveApp.capturing,
.subjectiveApp.capturing * {
  scrollbar-width: none;
}

.subjectiveApp.capturing ::-webkit-scrollbar,
.subjectiveApp.capturing::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.subjectiveApp.capturing .strikeChartWrap {
  overflow: visible;
}

.topDashboard {
  padding: 2px 10px 14px;
  display: flex;
  justify-content: center;
}

.topGrid {
  width: 100%;
  display: grid;
  gap: 16px;
  justify-items: center;
}

.topControls {
  width: max-content;
  max-width: 100%;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin: 0 auto 36px;
}

.topControls.chartMode {
  width: 100%;
  justify-content: space-between;
}

.topControls.chartMode .controlBlockInputs {
  flex: 1;
  justify-content: center;
}

.controlBlock {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.controlBlockInputs {
  flex-wrap: wrap;
}

.controlDivider {
  height: 56px;
  border-left: 0.5px solid;
  opacity: 0.25;
}

.paramsGrid {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  justify-content: stretch;
  gap: 0;
  margin-bottom: 36px;
}

.paramCol {
  display: grid;
  gap: 8px;
}

.paramStat {
  position: relative;
  display: grid;
  gap: 8px;
  padding: 0 24px;
}

.paramStat + .paramStat {
  border-left: 0;
}

.paramStat + .paramStat::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 0.5px solid;
  opacity: 0.25;
}

.field {
  width: var(--control-width);
  box-sizing: border-box;
  height: 56px;
  padding: 0 18px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.fieldExpiry {
  min-width: 0;
}

.fieldStrike {
  min-width: 0;
}

.fieldExpiry,
.fieldStrike {
  position: relative;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.fieldExpiry::after,
.fieldStrike::after {
  content: "";
  position: absolute;
  top: 50%;
  right: 18px;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid #aeb6c8;
  border-bottom: 1.5px solid #aeb6c8;
  pointer-events: none;
  transform: translateY(-65%) rotate(45deg);
}

.fieldExpiry:hover,
.fieldStrike:hover {
  border-color: rgba(255, 255, 255, 0.26);
  background: #131923;
}

.fieldExpiry:focus-within,
.fieldStrike:focus-within {
  border-color: rgba(125, 211, 252, 0.72);
  box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.1);
}

.field label {
  color: rgba(226, 232, 240, 0.72);
  font: 600 18px var(--ui-font);
  white-space: nowrap;
}

.field select,
.fEstInput,
.vrpInput {
  border: 0;
  background: transparent;
  color: #f8fafc;
  font: 600 16px var(--ui-font);
  outline: none;
}

.field select {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: 10px 24px 10px 0;
  cursor: pointer;
  color-scheme: dark;
  text-overflow: ellipsis;
}

.field select option {
  background: #0f1318;
  color: #f8fafc;
}

.fEstField {
  width: var(--control-width);
  margin: 0;
  white-space: nowrap;
}

.fEstLabel {
  font: 600 18px var(--ui-font);
}

.fEstInput {
  flex: 1;
  min-width: 0;
}

.vrpField {
  width: var(--control-width);
  margin: 0;
  white-space: nowrap;
}

.vrpLabel {
  font: 600 18px var(--ui-font);
}

.vrpInput {
  flex: 1;
  min-width: 0;
}

.fEstInput::-webkit-outer-spin-button,
.fEstInput::-webkit-inner-spin-button,
.vrpInput::-webkit-outer-spin-button,
.vrpInput::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.fEstInput[type="number"],
.vrpInput[type="number"] {
  -moz-appearance: textfield;
}

.viewToggle {
  width: var(--control-width);
  height: 56px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: #0f1318;
  display: inline-flex;
  overflow: hidden;
}

.viewToggleButton {
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0 18px;
  color: rgba(226, 232, 240, 0.72);
  background: transparent;
  font: 600 18px var(--ui-font);
  cursor: pointer;
}

.underlyingToggle {
  width: var(--control-width);
}

.modeToggleWide {
  width: calc(var(--control-width) + 28px);
}

.underlyingToggle .viewToggleButton {
  flex: 1;
}

.viewToggleButton + .viewToggleButton {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.viewToggleButton.active {
  color: #f8fafc;
  background: #131923;
}

.paramLine {
  display: grid;
  grid-template-columns: max-content max-content;
  align-items: baseline;
  gap: 8px;
}

.paramLabel {
  color: #9ea7ba;
  font: 600 18px var(--ui-font);
}

.paramValue {
  color: #e6ebf4;
  font: 650 19px var(--ui-font);
}

.formulaSection,
.chartSection {
  position: relative;
  width: 100%;
  padding: 2px 10px 18px;
  box-sizing: border-box;
}

.formulaTable {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0 clamp(24px, 4.5vh, 52px);
}

.formulaCell {
  width: 50%;
  text-align: center;
  vertical-align: middle;
  padding: 0 6px;
}

.equationRow {
  display: inline-flex;
  align-items: center;
  gap: 14px;
}

.eqLhs {
  min-width: 2.35ch;
  text-align: right;
  color: #f0f2f9;
  font: italic 700 var(--eq-size) / 1 var(--formula-font);
}

.eqLhsD {
  font-size: var(--eq-size);
}

.eqLhsC {
  font-size: var(--eq-size);
}

.eqFraction {
  display: inline-grid;
  justify-items: center;
}

.eqNum,
.eqDen {
  color: #e1e4f1;
  font: italic 400 var(--eq-size) / 1.25 var(--formula-font);
  white-space: nowrap;
}

.eqDiv {
  width: 100%;
  height: 1px;
  margin: 6px 0 9px;
  background: #f0f2f9;
}

.eqValue {
  color: #f0f2f9;
  text-align: left;
  white-space: nowrap;
  font: italic 600 var(--eq-size) / 1.2 var(--formula-font);
}

.eqValueFormula {
  font: italic 400 var(--eq-size) / 1.25 var(--formula-font);
}

.eqValueFormula sup {
  font-size: 1em;
  line-height: 1;
}

.eqCompare {
  margin-left: 14px;
  color: #9096a8;
  font-size: var(--eq-comment-size);
  line-height: 1;
}

.eqMeta {
  display: inline-flex;
  align-items: baseline;
  gap: 22px;
  padding-left: calc(2.35ch + 14px);
  margin-top: 10px;
  white-space: nowrap;
}

.metaWas {
  color: #8a90a1;
  font: italic 600 var(--eq-comment-size) / 1 var(--formula-font);
}

.metaDiff {
  font: italic 700 20px/1 var(--formula-font);
}

@keyframes muPulse {
  0% {
    text-shadow: 0 0 0 rgba(111, 157, 255, 0);
  }
  35% {
    text-shadow: 0 0 8px rgba(111, 157, 255, 0.65), 0 0 20px rgba(111, 157, 255, 0.35);
  }
  100% {
    text-shadow: 0 0 0 rgba(111, 157, 255, 0);
  }
}

.flash {
  animation: muPulse 900ms ease;
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
  font-size: 14px;
  z-index: 10;
}

.chartCard {
  width: 100%;
  background: #000;
  padding: 14px 10px 10px;
  box-sizing: border-box;
}

.chartHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
}

.chartTitle {
  color: #f6f8fc;
  font: 700 22px/1.2 var(--ui-font);
}

.chartLegend {
  display: inline-flex;
  align-items: center;
  gap: 22px;
  color: #d4dae8;
  font: 14px var(--ui-font);
}

.legendItem {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.legendSwatch {
  width: 16px;
  height: 16px;
}

.legendSwatchMarket {
  background: #eceff5;
}

.legendSwatchAdjusted {
  background: #050607;
  border: 1.1px solid #eceff5;
}

.strikeChartWrap {
  overflow-x: auto;
  overflow-y: visible;
  padding: 6px 6px 4px;
}

.strikeChartFrame {
  min-height: 500px;
}

.strikePlot {
  min-height: 470px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 18px;
  align-items: stretch;
}

.strikeHead {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(64px, 1fr);
  gap: 8px;
  width: max-content;
  min-width: 100%;
}

.strikeHeadItem {
  display: grid;
}

.strikeBody {
  position: relative;
  min-height: 354px;
}

.strikeChart {
  min-height: 354px;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(64px, 1fr);
  gap: 8px;
  align-items: end;
  width: max-content;
  min-width: 100%;
  position: relative;
  z-index: 1;
}

.strikeColumn {
  min-height: 354px;
  display: grid;
  grid-template-rows: 1fr auto;
  gap: 10px;
  align-items: end;
}

.barDataLabels {
  display: grid;
  justify-items: center;
  gap: 3px;
  white-space: nowrap;
  font-family: var(--ui-font);
}

.barDataValue {
  font-variant-numeric: tabular-nums;
}

.barDataMarket {
  color: #aeb6c8;
  font-size: 13px;
  font-weight: 600;
}

.barDataAdjusted {
  color: #f2f5fc;
  font-size: 16px;
  font-weight: 700;
}

.barDataUpside {
  color: #8f97ab;
  font-size: 13px;
  font-weight: 600;
}

.strikeBars {
  position: relative;
  --bar-width: 46%;
  --bar-max-width: 28px;
  min-height: 320px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.bar {
  position: absolute;
  bottom: 0;
  box-sizing: border-box;
  min-height: 2px;
  border-radius: 0 !important;
}

.barMarket {
  width: var(--bar-width);
  max-width: var(--bar-max-width);
  background: #eceff5;
  z-index: 1;
}

.barAdjusted {
  width: var(--bar-width);
  max-width: var(--bar-max-width);
  background: #050607;
  border: 1.1px solid #eceff5;
  border-bottom-width: 0;
  z-index: 2;
}

.strikeLabel {
  text-align: center;
  color: #d3d9e6;
  font: 13px var(--ui-font);
  white-space: nowrap;
  padding-top: 10px;
}

@media (max-width: 1120px) {
  .subjectiveApp {
    --eq-size: 22px;
  }

  .layoutFrame {
    width: calc(100vw - 20px);
  }

  .formulaTable,
  .formulaTable tbody,
  .formulaTable tr,
  .formulaTable td {
    display: block;
    width: 100%;
    box-sizing: border-box;
  }

  .formulaCell {
    padding: 0;
    margin-bottom: 10px;
  }

  .topGrid {
    width: min(400px, 100%);
    gap: 12px;
  }

  .topControls {
    width: 100%;
    gap: 10px;
  }

  .topControls.chartMode {
    justify-content: center;
  }

  .topControls.chartMode .controlBlockInputs {
    flex: initial;
    justify-content: flex-start;
  }

  .controlBlock,
  .controlBlockInputs {
    width: 100%;
  }

  .controlDivider {
    display: none;
  }

  .paramsGrid {
    grid-template-columns: 1fr;
    justify-items: start;
    gap: 8px;
  }

  .paramCol {
    width: 100%;
    gap: 6px;
  }

  .paramStat {
    width: 100%;
    padding: 0;
  }

  .paramStat + .paramStat {
    border-left: 0;
    border-top: 0;
  }

  .paramStat + .paramStat::before {
    left: 0;
    right: 0;
    top: 0;
    bottom: auto;
    width: auto;
    height: 0;
    border-left: 0;
    border-top: 0.5px solid;
    opacity: 0.25;
  }

  .field,
  .fEstField,
  .vrpField,
  .viewToggle,
  .underlyingToggle {
    height: 44px;
  }

  .field,
  .fEstField,
  .vrpField,
  .viewToggle,
  .underlyingToggle {
    width: 100%;
  }

  .field label,
  .fEstLabel,
  .vrpLabel,
  .viewToggleButton {
    font-size: 14px;
  }

  .field select,
  .fEstInput,
  .vrpInput {
    font-size: 12px;
  }

  .paramLabel {
    font-size: 14px;
  }

  .paramValue {
    font-size: 15px;
  }

  .eqMeta {
    padding-left: 0;
    margin-top: 4px;
    font-size: 14px;
  }

  .metaWas,
  .metaDiff {
    font-size: 16px;
  }

  .overlay {
    position: fixed;
  }

  .chartHeader {
    flex-direction: column;
    gap: 10px;
  }

  .chartTitle {
    font-size: 18px;
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

  .strikeChartFrame {
    min-height: 360px;
  }

  .strikePlot {
    min-height: 360px;
    gap: 12px;
  }

  .strikeHead {
    grid-auto-columns: minmax(48px, 1fr);
    gap: 6px;
  }

  .strikeBody {
    min-height: 242px;
  }

  .strikeColumn {
    min-height: 242px;
  }

  .strikeBars {
    --bar-width: 52%;
    --bar-max-width: 24px;
    min-height: 220px;
  }

  .barDataAdjusted {
    font-size: 12px;
  }

  .barDataMarket,
  .barDataUpside,
  .strikeLabel {
    font-size: 10px;
  }
}
</style>
