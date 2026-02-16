<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import ReplicationCostChart from "./components/ReplicationCostChart.vue";
import {
  calcGreeks,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const MAIN_POINT_LIMIT = 360;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");

const THRESHOLD_OPTIONS = [
  { value: 0, label: "0" },
  { value: 0.01, label: "0.01" },
  { value: 0.02, label: "0.02" },
  { value: 0.05, label: "0.05" },
  { value: 0.1, label: "0.10" },
  { value: 0.2, label: "0.20" },
];

const FREQUENCY_OPTIONS = [
  { value: 0, label: "Continuous" },
  { value: 15, label: "15 min" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "1 day" },
  { value: 10080, label: "1 week" },
];

const resolutionIntervalMinutes = computed(() => {
  const config = RESOLUTION_CONFIG[ui.resolutionKey];
  const sec = config?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  return sec > 0 ? sec / 60 : 0;
});

const frequencyOptionsFiltered = computed(() => {
  const minMinutes = resolutionIntervalMinutes.value;
  return FREQUENCY_OPTIONS.filter(
    (opt) => opt.value === 0 || opt.value >= minMinutes,
  );
});

const ui = reactive({
  resolutionKey: "900",
  optionMaturity: "",
  optionStrike: "",
  optionType: "call",
  deltaThreshold: 0.05,
  frequencyMinutes: 0,
  loading: false,
  error: "",
});
const data = reactive({
  optionInstruments: [],
  optionMark: {},
  optionMarkKey: {},
  index: {},
  indexKey: {},
});
const chartRef = ref(null);
const isInitializing = ref(true);
const showPnlMode = ref(false);
let prefetchedIndexForInitialLoad = null;
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
  if (!instrument || typeof instrument !== "object") return instrument;
  return {
    ...instrument,
    create_time_s: normalizeCreateTimeSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    ),
    expiration_ts: Number(instrument.expiration_timestamp),
    strike: Number(instrument.strike_price),
    option_type_normalized: (instrument.option_type || "call").toLowerCase(),
  };
};

const getOldestOptionInstrument = (instruments) => {
  let oldest = null;
  for (const instrument of instruments || []) {
    const created = Number(instrument?.create_time_s);
    if (!oldest || created < Number(oldest.create_time_s)) {
      oldest = instrument;
    }
  }
  return oldest;
};

const getMiddleStrikeValue = (strikes) => {
  if (!strikes?.length) return "";
  const midIndex = Math.floor(strikes.length / 2);
  return strikes[midIndex]?.value ?? "";
};

const getLatestIndexClose = (rows) => {
  if (!rows?.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = rows[i]?.index_price_close;
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const getDefaultStrikeValue = ({
  maturityInstruments,
  optionType,
  indexPrice,
  fallbackStrikes,
}) => {
  const typedInstruments = (maturityInstruments || [])
    .filter(
      (instrument) =>
        instrument?.option_type_normalized === optionType &&
        Number.isFinite(instrument?.strike),
    )
    .sort((a, b) => a.strike - b.strike);

  if (Number.isFinite(indexPrice) && typedInstruments.length) {
    const above = [];
    const seenStrikes = new Set();
    for (const instrument of typedInstruments) {
      if (instrument.strike <= indexPrice) continue;
      if (seenStrikes.has(instrument.strike)) continue;
      seenStrikes.add(instrument.strike);
      above.push(instrument);
      if (above.length === 2) break;
    }
    if (above.length) {
      let selected = above[0];
      for (const candidate of above.slice(1)) {
        const candidateCreated = Number(candidate?.create_time_s);
        const selectedCreated = Number(selected?.create_time_s);
        if (
          Number.isFinite(candidateCreated) &&
          (!Number.isFinite(selectedCreated) ||
            candidateCreated < selectedCreated)
        ) {
          selected = candidate;
        }
      }
      if (Number.isFinite(selected?.strike)) {
        return String(selected.strike);
      }
    }
  }

  const typedStrikes = Array.from(
    new Set(typedInstruments.map((instrument) => instrument.strike)),
  )
    .sort((a, b) => a - b)
    .map((strike) => ({ value: String(strike) }));
  const strikeOptions = typedStrikes.length ? typedStrikes : fallbackStrikes;
  return getMiddleStrikeValue(strikeOptions);
};

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  return {
    resolution,
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };
};

const optionMaturities = computed(() => {
  const expirations = Array.from(
    new Set(
      data.optionInstruments
        .map((instrument) => instrument?.expiration_ts)
        .filter((ts) => Number.isFinite(ts) && ts > 0),
    ),
  ).sort((a, b) => a - b);
  return expirations.map((ts) => ({
    value: String(ts),
    label: `${maturityFormatter.format(new Date(ts * 1000))} UTC`,
  }));
});

const selectedMaturityTs = computed(() => Number(ui.optionMaturity));

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  return data.optionInstruments.filter(
    (instrument) => instrument?.expiration_ts === maturityTs,
  );
});

const optionStrikes = computed(() => {
  const strikes = Array.from(
    new Set(
      optionInstrumentsForMaturity.value.map(
        (instrument) => instrument?.strike,
      ),
    ),
  ).sort((a, b) => a - b);
  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const selectedStrike = computed(() => Number(ui.optionStrike));

const optionTypes = [
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
];

const selectedOptionInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  const type = ui.optionType;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === type;
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const optionInstrumentName = computed(
  () => selectedOptionInstrument.value?.instrument_name || "",
);

const mainSeries = computed(() => {
  const index = data.index[ui.resolutionKey] || [];
  const optionMark = data.optionMark[ui.resolutionKey] || [];
  const instrument = selectedOptionInstrument.value;
  if (!instrument) return [];

  const strike = Number(instrument.strike);
  const expiration = Number(instrument.expiration_ts);
  const optionType =
    instrument.option_type_normalized === "put" ? "put" : "call";

  const optionDataByTs = new Map();
  let optionMinTs = null;
  let optionMaxTs = null;
  for (const row of optionMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    optionDataByTs.set(ts, {
      iv_close: row.iv_close,
      mark_price_open: row.mark_price_open,
      mark_price_close: row.mark_price_close,
    });
    if (optionMinTs == null || ts < optionMinTs) optionMinTs = ts;
    if (optionMaxTs == null || ts > optionMaxTs) optionMaxTs = ts;
  }

  const result = [];
  for (const point of index) {
    const ts = point.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts * 1000 < MIN_DATA_DATE.getTime()) continue;
    if (
      Number.isFinite(optionMinTs) &&
      Number.isFinite(optionMaxTs) &&
      (ts < optionMinTs || ts > optionMaxTs)
    ) {
      continue;
    }
    const optionData = optionDataByTs.get(point.ts);
    if (!optionData) continue;

    const date = new Date(ts * 1000);
    const tteSeconds = expiration - ts;
    const greeks = calcGreeks(
      point.index_price_close,
      strike,
      tteSeconds,
      optionData.iv_close,
      optionType,
    );

    result.push({
      ...point,
      date,
      iv_close: optionData.iv_close ?? null,
      option_mark_open: optionData.mark_price_open ?? null,
      option_mark_close: optionData.mark_price_close ?? null,
      option_mark_price: optionData.mark_price_close ?? null,
      delta: greeks.delta ?? null,
      gamma: greeks.gamma ?? null,
    });
  }
  return result.slice(-MAIN_POINT_LIMIT);
});

const replicationSeries = computed(() => {
  const series = mainSeries.value;
  if (!series.length) return [];

  const threshold = Number(ui.deltaThreshold) || 0;
  const frequencySec = (Number(ui.frequencyMinutes) || 0) * 60;

  let initialMark = null;
  let currentHedgePos = 0;
  let lastRehedgeTs = -Infinity;
  let qBuyCum = 0;
  let vBuyCum = 0;
  let qSellCum = 0;
  let vSellCum = 0;
  let avgBuyPrice = null;

  const result = [];
  for (const point of series) {
    if (!Number.isFinite(point.index_price_close)) continue;
    if (!Number.isFinite(point.option_mark_close)) continue;
    if (initialMark == null) {
      if (Number.isFinite(point.option_mark_open)) {
        initialMark = point.option_mark_open;
      } else if (Number.isFinite(point.option_mark_close)) {
        initialMark = point.option_mark_close;
      }
    }

    const currentDelta = Number.isFinite(point.delta) ? point.delta : 0;
    const targetHedge = -currentDelta;
    
    // Check triggers
    const deviation = Math.abs(currentHedgePos - targetHedge);
    const timeTrigger = frequencySec > 0 && (point.ts - lastRehedgeTs >= frequencySec);
    const thresholdTrigger = deviation > threshold;
    const isFirst = lastRehedgeTs === -Infinity;
    
    const shouldRehedge = isFirst || timeTrigger || thresholdTrigger;
    
    let q = 0;
    if (shouldRehedge) {
      q = targetHedge - currentHedgePos;
    }
    
    const qBuy = q > 0 ? q : 0;
    const qSell = q < 0 ? -q : 0;
    const price = point.index_price_close;
    const vBuy = qBuy * price;
    const vSell = qSell * price;

    qBuyCum += qBuy;
    vBuyCum += vBuy;
    qSellCum += qSell;
    vSellCum += vSell;
    if (qBuyCum > 0) {
      avgBuyPrice = vBuyCum / qBuyCum;
    }
    const effectiveBuyPrice = Number.isFinite(avgBuyPrice)
      ? avgBuyPrice
      : price;
      
    const hedgePosition = currentHedgePos; 
    
    if (shouldRehedge) {
      currentHedgePos = targetHedge;
      lastRehedgeTs = point.ts;
    }

    const realized = vSellCum - qSellCum * effectiveBuyPrice;
    const unrealized = hedgePosition * (price - effectiveBuyPrice);
    const hedgePnlCumul = realized + unrealized;
    const replicationCost = -hedgePnlCumul;
    const optionMarkChange =
      initialMark != null ? point.option_mark_close - initialMark : null;
    const shortOptionPnl =
      initialMark != null ? initialMark - point.option_mark_close : null;
    const hedgePnl = -hedgePnlCumul;
    const totalPnl = Number.isFinite(shortOptionPnl)
      ? shortOptionPnl + hedgePnl
      : null;

    result.push({
      ...point,
      replication_cost: replicationCost,
      option_mark_change: optionMarkChange,
      short_option_pnl: shortOptionPnl,
      hedge_pnl: hedgePnl,
      total_pnl: totalPnl,
    });
  }

  return result;
});

async function load(instrument) {
  if (!instrument) return;
  const requestId = ++loadRequestId;

  const resolutionKey = ui.resolutionKey;
  const indexName = instrument?.underlying || "BTCUSD";
  const optionName = instrument?.instrument_name || "";
  const cachedIndex = data.index[resolutionKey];
  const cachedMark = data.optionMark[resolutionKey];
  const canUseCachedIndex =
    Array.isArray(cachedIndex) &&
    cachedIndex.length &&
    data.indexKey[resolutionKey] === indexName;
  const canUseCachedMark =
    Array.isArray(cachedMark) &&
    cachedMark.length &&
    data.optionMarkKey[resolutionKey] === optionName;

  if (canUseCachedIndex && canUseCachedMark) {
    return;
  }

  ui.loading = true;
  ui.error = "";

  const { resolution, from, to } = getTimestampRange();
  const canUsePrefetchedIndex =
    prefetchedIndexForInitialLoad &&
    prefetchedIndexForInitialLoad.resolutionKey === resolutionKey &&
    prefetchedIndexForInitialLoad.indexName === indexName;
  const prefetchedIndex = canUsePrefetchedIndex
    ? prefetchedIndexForInitialLoad.rows
    : null;
  if (canUsePrefetchedIndex) {
    prefetchedIndexForInitialLoad = null;
  }

  try {
    const indexPromise = canUseCachedIndex
      ? Promise.resolve(cachedIndex)
      : prefetchedIndex
        ? Promise.resolve(prefetchedIndex)
        : fetchIndexHistory({
            index_name: indexName,
            resolution,
            from,
            to,
          });
    const [mainIndex, optionMark] = await Promise.all([
      indexPromise,
      canUseCachedMark
        ? Promise.resolve(cachedMark)
        : optionName
          ? fetchMarkHistory({
              instrument_name: optionName,
              resolution,
              from,
              to,
            })
          : Promise.resolve([]),
    ]);

    if (requestId !== loadRequestId) return;

    data.index[resolutionKey] = mainIndex || [];
    data.indexKey[resolutionKey] = indexName;
    data.optionMark[resolutionKey] = optionMark || [];
    data.optionMarkKey[resolutionKey] = optionName;
  } catch (e) {
    if (requestId !== loadRequestId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    data.index[resolutionKey] = [];
    data.optionMark[resolutionKey] = [];
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = optionInstrumentName.value || "dhedge-replication";
  const filename = ui.resolutionKey
    ? `${base}-${ui.resolutionKey}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

onMounted(async () => {
  try {
    const { resolution, from, to } = getTimestampRange();
    const [all_instruments, prefetchedIndex] = await Promise.all([
      fetchInstruments(),
      fetchIndexHistory({
        index_name: "BTCUSD",
        resolution,
        from,
        to,
      }),
    ]);
    data.optionInstruments = all_instruments
      .filter((i) => i?.type === "option" && i?.underlying === "BTCUSD")
      .map(normalizeOptionInstrument)
      .sort(
        (a, b) =>
          (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
          (a.strike || 0) - (b.strike || 0),
      );

    const oldest = getOldestOptionInstrument(data.optionInstruments);
    if (oldest && Number.isFinite(oldest.expiration_ts)) {
      ui.optionMaturity = String(oldest.expiration_ts);
    }
    data.index[ui.resolutionKey] = prefetchedIndex || [];
    prefetchedIndexForInitialLoad = {
      resolutionKey: ui.resolutionKey,
      indexName: "BTCUSD",
      rows: prefetchedIndex || [],
    };
    data.indexKey[ui.resolutionKey] = "BTCUSD";
    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey]);
    ui.optionStrike = getDefaultStrikeValue({
      maturityInstruments: optionInstrumentsForMaturity.value,
      optionType: ui.optionType,
      indexPrice: latestIndexClose,
      fallbackStrikes: optionStrikes.value,
    });
  } finally {
    isInitializing.value = false;
  }
});

watch(
  optionMaturities,
  (maturities) => {
    if (!maturities.length) {
      ui.optionMaturity = "";
      return;
    }
    const maturityValues = maturities.map((maturity) => maturity.value);
    if (maturityValues.includes(ui.optionMaturity)) return;
    const oldest = getOldestOptionInstrument(data.optionInstruments);
    ui.optionMaturity =
      oldest && Number.isFinite(oldest.expiration_ts)
        ? String(oldest.expiration_ts)
        : maturities[0].value;
  },
  { immediate: true },
);

watch(
  optionStrikes,
  (strikes) => {
    if (isInitializing.value) return;
    if (!strikes.length) {
      ui.optionStrike = "";
      return;
    }
    if (strikes.some((strike) => strike.value === ui.optionStrike)) return;
    ui.optionStrike = getMiddleStrikeValue(strikes);
  },
  { immediate: true },
);

watch(
  () => [ui.resolutionKey, ui.optionMaturity, ui.optionStrike, ui.optionType],
  async () => {
    const instrument = selectedOptionInstrument.value;
    if (!instrument) return;
    await load(instrument);
  },
  { immediate: false },
);

watch(ui.resolutionKey, () => {
  const valid = frequencyOptionsFiltered.value.some(
    (opt) => opt.value === ui.frequencyMinutes,
  );
  if (!valid) {
    ui.frequencyMinutes = 0;
  }
});
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Option Replication Cost</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="option-maturity">Maturity</label>
          <select id="option-maturity" v-model="ui.optionMaturity">
            <option
              v-for="maturity in optionMaturities"
              :key="maturity.value"
              :value="maturity.value"
            >
              {{ maturity.label }}
            </option>
            <option v-if="!optionMaturities.length" :value="ui.optionMaturity">
              {{ ui.optionMaturity }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="option-strike">Strike</label>
          <select id="option-strike" v-model="ui.optionStrike">
            <option
              v-for="strike in optionStrikes"
              :key="strike.value"
              :value="strike.value"
            >
              {{ strike.label }}
            </option>
            <option v-if="!optionStrikes.length" :value="ui.optionStrike">
              {{ ui.optionStrike }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="option-type">Type</label>
          <select id="option-type" v-model="ui.optionType">
            <option
              v-for="type in optionTypes"
              :key="type.value"
              :value="type.value"
            >
              {{ type.label }}
            </option>
            <option v-if="!optionTypes.length" :value="ui.optionType">
              {{ ui.optionType }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="ui.resolutionKey">
            <option
              v-for="key in Object.keys(RESOLUTION_CONFIG)"
              :key="key"
              :value="key"
            >
              {{ RESOLUTION_CONFIG[key].label }}
            </option>
          </select>
        </div>

        <div class="modeToggle" role="group" aria-label="Chart mode">
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: !showPnlMode }"
            @click="showPnlMode = false"
          >
            Mark
          </button>
          <button
            class="modeToggleButton"
            type="button"
            :class="{ active: showPnlMode }"
            @click="showPnlMode = true"
          >
            Pnl
          </button>
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

      <div class="controls hedge-row">
        <div class="field">
          <label for="delta-threshold">Threshold</label>
          <select id="delta-threshold" v-model.number="ui.deltaThreshold">
            <option
              v-for="opt in THRESHOLD_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="freq-min">Freq</label>
          <select id="freq-min" v-model.number="ui.frequencyMinutes">
            <option
              v-for="opt in frequencyOptionsFiltered"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <ReplicationCostChart
      ref="chartRef"
      :data="mainSeries"
      :replication-data="replicationSeries"
      :option-instrument-name="optionInstrumentName"
      :loading="ui.loading"
      :show-pnl-mode="showPnlMode"
    />
  </div>
</template>

<style scoped>
.hedge-row {
  margin-top: 10px;
}
</style>
