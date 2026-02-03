<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import OptionPnlChart from "./components/OptionPnlChart.vue";
import StraddleBreakEvenChart from "./components/StraddleBreakEvenChart.vue";
import {
  computeGreeksPnlSeries,
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

const ui = reactive({
  resolutionKey: "3600",
  optionMaturity: "",
  optionStrike: "",
  mode: "straddle",
  loading: false,
  error: "",
});
const data = reactive({
  optionInstruments: [],
  callMark: {},
  putMark: {},
  index: {},
});
const chartRef = ref(null);
const breakEvenChartRef = ref(null);
const isInitializing = ref(true);
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
  indexPrice,
  fallbackStrikes,
}) => {
  const pairedStrikeSet = new Set(
    (fallbackStrikes || [])
      .map((strike) => Number(strike?.value))
      .filter((strike) => Number.isFinite(strike)),
  );
  const calls = (maturityInstruments || [])
    .filter(
      (instrument) =>
        instrument?.option_type_normalized === "call" &&
        Number.isFinite(instrument?.strike) &&
        (pairedStrikeSet.size === 0 || pairedStrikeSet.has(instrument.strike)),
    )
    .sort((a, b) => a.strike - b.strike);

  if (Number.isFinite(indexPrice) && calls.length) {
    const above = [];
    const seenStrikes = new Set();
    for (const instrument of calls) {
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

  return getMiddleStrikeValue(fallbackStrikes);
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
const selectedStrike = computed(() => Number(ui.optionStrike));

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  return data.optionInstruments.filter(
    (instrument) => instrument?.expiration_ts === maturityTs,
  );
});

const optionStrikes = computed(() => {
  const strikeTypes = new Map();
  for (const instrument of optionInstrumentsForMaturity.value) {
    const strike = instrument?.strike;
    const type = instrument?.option_type_normalized;
    if (!Number.isFinite(strike)) continue;
    if (type !== "call" && type !== "put") continue;
    const bucket = strikeTypes.get(strike) || { call: false, put: false };
    bucket[type] = true;
    strikeTypes.set(strike, bucket);
  }
  const strikes = Array.from(strikeTypes.entries())
    .filter(([, bucket]) => bucket.call && bucket.put)
    .map(([strike]) => strike)
    .sort((a, b) => a - b);
  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const selectedCallInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === "call";
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const selectedPutInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === "put";
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const optionInstrumentName = computed(() => {
  const callName = selectedCallInstrument.value?.instrument_name || "";
  if (!callName) return "";
  const parts = callName.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}-STRADDLE`;
  }
  return `${callName}-STRADDLE`;
});

const breakEvenTitle = "BTC Straddle Break-Evens";
const breakEvenSubtitle = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return "";
  return `Expiry: ${maturityFormatter.format(new Date(expiryTs * 1000))} UTC Strike: ${strikeFormatter.format(strike)}`;
});

const latestMarkClose = (rows) => {
  for (let i = (rows?.length || 0) - 1; i >= 0; i -= 1) {
    const value = rows[i]?.mark_price_close;
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const breakEvenMetrics = computed(() => {
  const strike = selectedStrike.value;
  if (!Number.isFinite(strike)) return null;
  const callClose = latestMarkClose(data.callMark[ui.resolutionKey] || []);
  const putClose = latestMarkClose(data.putMark[ui.resolutionKey] || []);
  if (!Number.isFinite(callClose) || !Number.isFinite(putClose)) return null;
  const straddleMark = callClose + putClose;
  return {
    straddleMark,
    breakEvenLow: strike - straddleMark,
    breakEvenHigh: strike + straddleMark,
  };
});

const breakEvenActualData = computed(() =>
  (data.index[ui.resolutionKey] || [])
    .filter((row) => Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close))
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      date: new Date(row.ts * 1000),
      value: row.index_price_close,
      low: row.index_price_low,
      high: row.index_price_high,
    })),
);

const breakEvenProjectedData = computed(() => {
  const actual = breakEvenActualData.value;
  const expiryTs = selectedMaturityTs.value;
  if (!actual.length || !Number.isFinite(expiryTs)) return [];
  const lastActual = actual[actual.length - 1];
  const expiryDate = new Date(expiryTs * 1000);
  if (!(expiryDate > lastActual.date)) return [];
  return [
    { date: lastActual.date, value: lastActual.value },
    { date: expiryDate, value: lastActual.value },
  ];
});

const breakEvenCurrentIndex = computed(() => {
  const actual = breakEvenActualData.value;
  return actual.length ? actual[actual.length - 1].value : null;
});

const canSavePng = computed(() =>
  ui.mode === "breakeven"
    ? breakEvenActualData.value.length > 0
    : mainSeries.value.length > 0,
);

const mainSeries = computed(() => {
  const index = data.index[ui.resolutionKey] || [];
  const callMark = data.callMark[ui.resolutionKey] || [];
  const putMark = data.putMark[ui.resolutionKey] || [];
  const callByTs = new Map();
  const putByTs = new Map();
  let callMinTs = null;
  let callMaxTs = null;
  let putMinTs = null;
  let putMaxTs = null;

  for (const row of callMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    callByTs.set(ts, row);
    if (callMinTs == null || ts < callMinTs) callMinTs = ts;
    if (callMaxTs == null || ts > callMaxTs) callMaxTs = ts;
  }
  for (const row of putMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    putByTs.set(ts, row);
    if (putMinTs == null || ts < putMinTs) putMinTs = ts;
    if (putMaxTs == null || ts > putMaxTs) putMaxTs = ts;
  }

  const result = [];
  for (const point of index) {
    const ts = point?.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts * 1000 < MIN_DATA_DATE.getTime()) continue;
    if (
      Number.isFinite(callMinTs) &&
      Number.isFinite(callMaxTs) &&
      (ts < callMinTs || ts > callMaxTs)
    ) {
      continue;
    }
    if (
      Number.isFinite(putMinTs) &&
      Number.isFinite(putMaxTs) &&
      (ts < putMinTs || ts > putMaxTs)
    ) {
      continue;
    }

    const callPoint = callByTs.get(ts);
    const putPoint = putByTs.get(ts);
    if (!callPoint || !putPoint) continue;

    const straddleMark =
      Number.isFinite(callPoint.mark_price_close) &&
      Number.isFinite(putPoint.mark_price_close)
        ? callPoint.mark_price_close + putPoint.mark_price_close
        : null;
    if (!Number.isFinite(straddleMark)) continue;

    result.push({
      ...point,
      date: new Date(ts * 1000),
      iv_close: Number.isFinite(callPoint.iv_close) ? callPoint.iv_close : null,
      option_mark_price: straddleMark,
    });
  }
  return result.slice(-MAIN_POINT_LIMIT);
});

const straddlePnlSeries = computed(() => {
  const callMark = data.callMark[ui.resolutionKey] || [];
  const putMark = data.putMark[ui.resolutionKey] || [];
  const index = data.index[ui.resolutionKey] || [];
  const callInstrument = selectedCallInstrument.value;
  const putInstrument = selectedPutInstrument.value;
  if (
    !callMark.length ||
    !putMark.length ||
    !index.length ||
    !callInstrument ||
    !putInstrument
  ) {
    return [];
  }

  const callSeries = computeGreeksPnlSeries({
    mark: callMark,
    index,
    instrument: callInstrument,
  });
  const putSeries = computeGreeksPnlSeries({
    mark: putMark,
    index,
    instrument: putInstrument,
  });
  if (!callSeries.length || !putSeries.length) return [];

  const sumNullable = (a, b) => {
    const hasA = Number.isFinite(a);
    const hasB = Number.isFinite(b);
    if (!hasA && !hasB) return null;
    return (hasA ? a : 0) + (hasB ? b : 0);
  };

  const putByTs = new Map(
    putSeries
      .filter((row) => row && Number.isFinite(row.ts))
      .map((row) => [row.ts, row]),
  );

  const merged = [];
  for (const callPoint of callSeries) {
    const ts = callPoint?.ts;
    if (!Number.isFinite(ts)) continue;
    const putPoint = putByTs.get(ts);
    if (!putPoint) continue;

    merged.push({
      ts,
      date: new Date(ts * 1000),
      PL: sumNullable(callPoint.PL, putPoint.PL),
      delta_PL: sumNullable(callPoint.delta_PL, putPoint.delta_PL),
      gamma_theta_PL: sumNullable(
        callPoint.gamma_theta_PL,
        putPoint.gamma_theta_PL,
      ),
      vega_PL: sumNullable(callPoint.vega_PL, putPoint.vega_PL),
      residual_PL: sumNullable(callPoint.residual_PL, putPoint.residual_PL),
    });
  }

  return merged
    .filter((point) => point.date >= MIN_DATA_DATE)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAIN_POINT_LIMIT);
});

async function load({ callInstrument, putInstrument }) {
  if (!callInstrument && !putInstrument) return;
  const requestId = ++loadRequestId;

  ui.loading = true;
  ui.error = "";

  const { resolution, from, to } = getTimestampRange();
  const canUsePrefetchedIndex =
    prefetchedIndexForInitialLoad &&
    prefetchedIndexForInitialLoad.resolutionKey === ui.resolutionKey;
  const prefetchedIndex = canUsePrefetchedIndex
    ? prefetchedIndexForInitialLoad.rows
    : null;
  if (canUsePrefetchedIndex) {
    prefetchedIndexForInitialLoad = null;
  }

  try {
    const indexName =
      callInstrument?.underlying || putInstrument?.underlying || "BTCUSD";
    const callName = callInstrument?.instrument_name || "";
    const putName = putInstrument?.instrument_name || "";

    const indexPromise = prefetchedIndex
      ? Promise.resolve(prefetchedIndex)
      : fetchIndexHistory({
          index_name: indexName,
          resolution,
          from,
          to,
        });

    const [mainIndex, callMark, putMark] = await Promise.all([
      indexPromise,
      callName
        ? fetchMarkHistory({
            instrument_name: callName,
            resolution,
            from,
            to,
          })
        : Promise.resolve([]),
      putName
        ? fetchMarkHistory({
            instrument_name: putName,
            resolution,
            from,
            to,
          })
        : Promise.resolve([]),
    ]);

    if (requestId !== loadRequestId) return;

    data.index[ui.resolutionKey] = mainIndex || [];
    data.callMark[ui.resolutionKey] = callMark || [];
    data.putMark[ui.resolutionKey] = putMark || [];
  } catch (e) {
    if (requestId !== loadRequestId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    data.index = {};
    data.callMark = {};
    data.putMark = {};
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function handleSavePng() {
  const base = optionInstrumentName.value || "straddle";
  const filenameBase = ui.resolutionKey ? `${base}-${ui.resolutionKey}` : base;
  if (ui.mode === "breakeven") {
    if (!breakEvenChartRef.value) return;
    breakEvenChartRef.value.exportPng({
      filename: `${filenameBase}-break-even.png`,
    });
    return;
  }
  if (!chartRef.value) return;
  chartRef.value.exportPng({ filename: `${filenameBase}.png` });
}

onMounted(async () => {
  try {
    const { resolution, from, to } = getTimestampRange();
    const [allInstruments, prefetchedIndex] = await Promise.all([
      fetchInstruments(),
      fetchIndexHistory({
        index_name: "BTCUSD",
        resolution,
        from,
        to,
      }),
    ]);

    data.optionInstruments = allInstruments
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
      rows: prefetchedIndex || [],
    };

    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey]);
    ui.optionStrike = getDefaultStrikeValue({
      maturityInstruments: optionInstrumentsForMaturity.value,
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
  () => [ui.resolutionKey, ui.optionMaturity, ui.optionStrike],
  async () => {
    const callInstrument = selectedCallInstrument.value;
    const putInstrument = selectedPutInstrument.value;
    if (!callInstrument && !putInstrument) return;
    await load({ callInstrument, putInstrument });
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Straddle Analyzer</h1>
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

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !canSavePng"
        >
          Save PNG
        </button>

        <div class="modeToggle" role="group" aria-label="Chart mode">
          <button
            type="button"
            class="modeToggleButton"
            :class="{ active: ui.mode === 'straddle' }"
            @click="ui.mode = 'straddle'"
          >
            Straddle
          </button>
          <button
            type="button"
            class="modeToggleButton"
            :class="{ active: ui.mode === 'breakeven' }"
            @click="ui.mode = 'breakeven'"
          >
            Break-even
          </button>
        </div>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <OptionPnlChart
      v-if="ui.mode === 'straddle'"
      ref="chartRef"
      :data="mainSeries"
      :option-pnl-data="straddlePnlSeries"
      :option-instrument-name="optionInstrumentName"
      :loading="ui.loading"
    />
    <StraddleBreakEvenChart
      v-else
      ref="breakEvenChartRef"
      :actual-data="breakEvenActualData"
      :projected-data="breakEvenProjectedData"
      :break-even-low="breakEvenMetrics?.breakEvenLow"
      :break-even-high="breakEvenMetrics?.breakEvenHigh"
      :current-index="breakEvenCurrentIndex"
      :expiry-ts="selectedMaturityTs"
      :title="breakEvenTitle"
      :subtitle="breakEvenSubtitle"
      :loading="ui.loading"
    />
  </div>
</template>
