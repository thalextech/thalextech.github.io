<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import PositionBuilder from "../../simulator/src/components/PositionBuilder.vue";
import IndexMarkComboChart from "./components/Chart.vue";
import {
  calcGreeks,
  computeGreeksPnlSeries,
  fetchInstruments,
  fetchIndexHistory,
  fetchLatestIndexPrice,
  fetchLatestMarkPrice,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const RESOLUTION_OPTIONS = Object.entries(RESOLUTION_CONFIG).map(
  ([key, cfg]) => ({
    key,
    label: cfg.label,
  }),
);
const MAIN_POINT_LIMIT = 360;
const DEFAULT_VOL = 0.4;
const DEFAULT_T = 30 / 365.25;
const MARK_CONCURRENCY = 10;
const LOAD_DEBOUNCE_MS = 140;

const ui = reactive({
  resolutionKey: "900",
  loading: false,
  error: "",
});

const positionLegs = ref([
  {
    id: "leg-1",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "call",
    strike: 70000,
    premium: 0,
    expiry: "27 Mar 26",
  },
  {
    id: "leg-2",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "put",
    strike: 70000,
    premium: 0,
    expiry: "27 Mar 26",
  },
]);

const instruments = ref([]);
const tickerByInstrument = ref({});
const indexByName = ref({});
const indexSeries = ref([]);
const comboSeries = ref([]);

let loadRequestId = 0;
let loadTimer = null;
let indexRefreshTimer = null;
let tickerRefreshTimer = null;

const clampQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.abs(n);
};

const parseExpiryToSeconds = (expiry) => {
  if (!expiry || typeof expiry !== "string") return null;
  const parts = expiry.split(" ");
  if (parts.length < 3) return null;
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIdx)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  return Math.floor(Date.UTC(fullYear, monthIdx, day, 8, 0, 0) / 1000);
};

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const strike = Number(instrument.strike_price);
  const expiration = Number(instrument.expiration_timestamp);
  const optionType = (instrument.option_type || "").toLowerCase();
  const type = (instrument.type || instrument.kind || "").toLowerCase();
  if (!instrument.instrument_name) return null;
  const isOption = type === "option" || type === "options" || optionType;
  if (!isOption) return null;
  if (!Number.isFinite(strike) || !Number.isFinite(expiration)) return null;
  return {
    ...instrument,
    strike,
    expiration_ts: expiration,
    option_type_normalized:
      optionType === "put" || optionType === "p" ? "put" : "call",
  };
};

const parsedOptionInstruments = computed(() =>
  (instruments.value || [])
    .map((instrument) => normalizeOptionInstrument(instrument))
    .filter(Boolean)
    .sort((a, b) => a.expiration_ts - b.expiration_ts || a.strike - b.strike),
);

const selectedOptionLegs = computed(() =>
  (positionLegs.value || []).filter((leg) => leg?.kind === "option"),
);

const hasUnsupportedLegs = computed(() =>
  (positionLegs.value || []).some((leg) => leg?.kind !== "option"),
);

const resolveInstrumentForLeg = (leg) => {
  const expiryTs = parseExpiryToSeconds(leg.expiry);
  const strike = Number(leg.strike);
  const optionType = (leg.optionType || "").toLowerCase();
  if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return null;
  if (optionType !== "call" && optionType !== "put") return null;

  return (
    parsedOptionInstruments.value.find(
      (instrument) =>
        instrument.expiration_ts === expiryTs &&
        instrument.strike === strike &&
        instrument.option_type_normalized === optionType,
    ) || null
  );
};

const selectedLegInstruments = computed(() => {
  const result = [];
  for (const leg of selectedOptionLegs.value) {
    const instrument = resolveInstrumentForLeg(leg);
    if (!instrument?.instrument_name) continue;
    const qty = clampQty(leg.qty);
    if (!qty) continue;
    const sideSign = leg.side === "sell" ? -1 : 1;
    result.push({
      label: `${leg.side === "sell" ? "Sell" : "Buy"} ${qty} ${instrument.instrument_name}`,
      instrumentName: instrument.instrument_name,
      signedQty: sideSign * qty,
      qty,
      side: leg.side,
      optionType: instrument.option_type_normalized,
      strike: Number(instrument.strike),
      expirationTs: Number(instrument.expiration_ts),
      underlying: instrument.underlying,
    });
  }
  return result;
});

const selectedInstrumentNames = computed(() =>
  Array.from(
    new Set(selectedLegInstruments.value.map((entry) => entry.instrumentName)),
  ),
);

const activeIndexName = computed(() => {
  const firstUnderlying = selectedLegInstruments.value.find(
    (entry) => entry.underlying,
  )?.underlying;
  return firstUnderlying || "BTCUSD";
});

const chartSubtitle = computed(() => {
  const rows = indexSeries.value;
  if (!rows.length) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const from = fmt.format(rows[0].date);
  const to = fmt.format(rows[rows.length - 1].date);
  return `${from} - ${to}`;
});

const indexDisplay = computed(() => {
  const snapshot = indexByName.value[activeIndexName.value];
  if (!snapshot) return null;
  const data = snapshot.data;
  const price = Number(data?.index_price_close ?? data?.close ?? data?.price);
  if (!Number.isFinite(price)) return null;
  return {
    price,
    fetchedAt: snapshot.fetchedAt,
  };
});

const spot = computed(() => {
  const live = Number(indexDisplay.value?.price);
  return Number.isFinite(live) && live > 0 ? live : 95_000;
});

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

const runWithConcurrency = async (items, limit, worker) => {
  const safeLimit = Math.max(1, Math.floor(limit));
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(safeLimit, queue.length) },
    async () => {
      while (queue.length) {
        const next = queue.shift();
        await worker(next);
      }
    },
  );
  await Promise.all(workers);
};

const loadSeries = async () => {
  const requestId = ++loadRequestId;

  if (hasUnsupportedLegs.value) {
    ui.error = "Only option legs are supported in Option Strike.";
    indexSeries.value = [];
    comboSeries.value = [];
    return;
  }

  const selected = selectedLegInstruments.value;
  if (!selected.length) {
    ui.error = "";
    indexSeries.value = [];
    comboSeries.value = [];
    return;
  }

  const { resolution, from, to } = getTimestampRange();
  ui.loading = true;
  ui.error = "";

  try {
    const indexRows = await fetchIndexHistory({
      index_name: activeIndexName.value,
      resolution,
      from,
      to,
    });

    const markByInstrument = {};
    await runWithConcurrency(
      selectedInstrumentNames.value,
      MARK_CONCURRENCY,
      async (instrumentName) => {
        markByInstrument[instrumentName] =
          (await fetchMarkHistory({
            instrument_name: instrumentName,
            resolution,
            from,
            to,
          })) || [];
      },
    );

    if (requestId !== loadRequestId) return;

    const indexByTs = new Map(
      (indexRows || [])
        .map((row) => [Number(row?.ts), row])
        .filter(([ts, row]) => Number.isFinite(ts) && row),
    );

    const legSeries = selected
      .map((entry) => {
        const map = new Map();
        for (const row of markByInstrument[entry.instrumentName] || []) {
          const ts = Number(row?.ts);
          const markClose = Number(row?.mark_price_close);
          const markOpen = Number(row?.mark_price_open);
          const ivClose = Number(row?.iv_close);
          const ivOpen = Number(row?.iv_open);
          if (!Number.isFinite(ts) || !Number.isFinite(markClose)) continue;
          map.set(ts, {
            markClose,
            markOpen: Number.isFinite(markOpen) ? markOpen : markClose,
            ivClose: Number.isFinite(ivClose) ? ivClose : null,
            ivOpen: Number.isFinite(ivOpen) ? ivOpen : ivClose,
          });
        }

        const greeksPnlSeries = computeGreeksPnlSeries({
          mark: markByInstrument[entry.instrumentName] || [],
          index: indexRows || [],
          instrument: {
            strike_price: Number(entry.strike),
            expiration_timestamp: Number(entry.expirationTs),
            option_type: entry.optionType,
          },
        });
        const greeksPnlByTs = new Map();
        for (const point of greeksPnlSeries) {
          const ts = Number(point?.ts);
          if (!Number.isFinite(ts)) continue;
          greeksPnlByTs.set(ts, point);
        }

        return {
          signedQty: entry.signedQty,
          label: entry.label,
          optionType: entry.optionType,
          strike: entry.strike,
          byTs: map,
          greeksPnlByTs,
        };
      })
      .filter((entry) => entry.byTs.size > 0);

    if (legSeries.length !== selected.length) {
      indexSeries.value = [];
      comboSeries.value = [];
      ui.error = "Missing mark history for one or more selected legs.";
      return;
    }

    const baseTs = Array.from(legSeries[0].byTs.keys()).sort((a, b) => a - b);
    const top = [];
    const bottom = [];

    for (const ts of baseTs) {
      if (!legSeries.every((entry) => entry.byTs.has(ts))) continue;
      const indexRow = indexByTs.get(ts);
      const indexClose = Number(indexRow?.index_price_close);
      const indexOpen = Number(indexRow?.index_price_open);
      if (!Number.isFinite(indexClose)) continue;

      let totalMark = 0;
      let ivSum = 0;
      let ivCount = 0;
      let totalPL = 0;
      let totalDeltaPL = 0;
      let totalGammaThetaPL = 0;
      let totalVegaPL = 0;
      let totalResidualPL = 0;
      let hasPL = false;
      let hasDeltaPL = false;
      let hasGammaThetaPL = false;
      let hasVegaPL = false;
      let hasResidualPL = false;
      for (const entry of legSeries) {
        const point = entry.byTs.get(ts);
        totalMark += entry.signedQty * Number(point.markClose);
        if (Number.isFinite(point.ivClose)) {
          ivSum += Number(point.ivClose);
          ivCount += 1;
        }

        const legPnlPoint = entry.greeksPnlByTs.get(ts);
        const signedQty = Number(entry.signedQty);
        if (Number.isFinite(legPnlPoint?.PL)) {
          totalPL += signedQty * Number(legPnlPoint.PL);
          hasPL = true;
        }
        if (Number.isFinite(legPnlPoint?.delta_PL)) {
          totalDeltaPL += signedQty * Number(legPnlPoint.delta_PL);
          hasDeltaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.gamma_theta_PL)) {
          totalGammaThetaPL += signedQty * Number(legPnlPoint.gamma_theta_PL);
          hasGammaThetaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.vega_PL)) {
          totalVegaPL += signedQty * Number(legPnlPoint.vega_PL);
          hasVegaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.residual_PL)) {
          totalResidualPL += signedQty * Number(legPnlPoint.residual_PL);
          hasResidualPL = true;
        }
      }

      const date = new Date(ts * 1000);
      const ivClose = ivCount > 0 ? ivSum / ivCount : null;
      top.push({
        ts,
        date,
        index_price_close: indexClose,
        iv_close: ivClose,
      });

      const legs = [];
      let totalDelta = 0;
      let totalGamma = 0;
      let totalTheta = 0;
      let totalVega = 0;
      for (let i = 0; i < selected.length; i += 1) {
        const selectedLeg = selected[i];
        const legPoint = legSeries[i].byTs.get(ts);
        if (!legPoint) continue;
        const tteSeconds = Number(selectedLeg.expirationTs) - ts;
        const greeks = calcGreeks(
          indexClose,
          Number(selectedLeg.strike),
          tteSeconds,
          Number(legPoint.ivClose),
          selectedLeg.optionType,
        );
        const signedDelta = Number.isFinite(greeks?.delta)
          ? Number(greeks.delta) * Number(selectedLeg.signedQty)
          : null;
        const signedGamma = Number.isFinite(greeks?.gamma)
          ? Number(greeks.gamma) * Number(selectedLeg.signedQty)
          : null;
        const signedTheta = Number.isFinite(greeks?.theta)
          ? Number(greeks.theta) * Number(selectedLeg.signedQty)
          : null;
        const signedVega = Number.isFinite(greeks?.vega)
          ? Number(greeks.vega) * Number(selectedLeg.signedQty)
          : null;
        if (Number.isFinite(signedDelta)) totalDelta += Number(signedDelta);
        if (Number.isFinite(signedGamma)) totalGamma += Number(signedGamma);
        if (Number.isFinite(signedTheta)) totalTheta += Number(signedTheta);
        if (Number.isFinite(signedVega)) totalVega += Number(signedVega);

        legs.push({
          label: selectedLeg.label,
          mark: Number(legPoint.markClose),
          signedMark:
            Number(selectedLeg.signedQty) * Number(legPoint.markClose),
          delta: signedDelta,
          gamma: signedGamma,
          theta: signedTheta,
          vega: signedVega,
        });
      }

      bottom.push({
        ts,
        date,
        index_price_open: Number.isFinite(indexOpen) ? indexOpen : null,
        index_price_close: indexClose,
        mark_price_close: totalMark,
        PL: hasPL ? totalPL : null,
        delta_PL: hasDeltaPL ? totalDeltaPL : null,
        gamma_theta_PL: hasGammaThetaPL ? totalGammaThetaPL : null,
        vega_PL: hasVegaPL ? totalVegaPL : null,
        residual_PL: hasResidualPL ? totalResidualPL : null,
        legs,
        total_greeks: {
          delta: totalDelta,
          gamma: totalGamma,
          theta: totalTheta,
          vega: totalVega,
        },
      });
    }

    indexSeries.value = top.slice(-MAIN_POINT_LIMIT);
    comboSeries.value = bottom.slice(-MAIN_POINT_LIMIT);

    if (!indexSeries.value.length || !comboSeries.value.length) {
      ui.error = "No overlapping index/mark history for selected legs.";
    }
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    indexSeries.value = [];
    comboSeries.value = [];
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
};

const scheduleLoad = () => {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    loadTimer = null;
    loadSeries();
  }, LOAD_DEBOUNCE_MS);
};

const refreshIndexSnapshot = async () => {
  const indexName = activeIndexName.value;
  if (!indexName) return;
  try {
    const data = await fetchLatestIndexPrice(indexName, "1m");
    if (!data) return;
    indexByName.value = {
      ...indexByName.value,
      [indexName]: { data, fetchedAt: Date.now() },
    };
  } catch (error) {
    console.warn("Failed to refresh index snapshot", error);
  }
};

const refreshSelectedTickers = async () => {
  const names = selectedInstrumentNames.value;
  if (!names.length) return;
  await runWithConcurrency(names, MARK_CONCURRENCY, async (instrumentName) => {
    if (tickerByInstrument.value[instrumentName]) return;
    try {
      const ticker = await fetchLatestMarkPrice(instrumentName);
      if (!ticker) return;
      tickerByInstrument.value = {
        ...tickerByInstrument.value,
        [instrumentName]: {
          data: ticker,
          fetchedAt: Date.now(),
        },
      };
    } catch (error) {
      console.warn("Failed to refresh ticker", instrumentName, error);
    }
  });
};

watch(
  () => [ui.resolutionKey, positionLegs.value],
  () => {
    scheduleLoad();
  },
  { deep: true },
);

watch(
  () => [selectedInstrumentNames.value, activeIndexName.value],
  () => {
    refreshSelectedTickers();
    refreshIndexSnapshot();
  },
  { deep: true, immediate: true },
);

onMounted(async () => {
  const allInstruments = await fetchInstruments();
  instruments.value = (allInstruments || []).filter(
    (instrument) =>
      instrument?.type === "option" && instrument?.underlying === "BTCUSD",
  );

  await refreshIndexSnapshot();
  await refreshSelectedTickers();
  await loadSeries();

  indexRefreshTimer = setInterval(refreshIndexSnapshot, 30_000);
  tickerRefreshTimer = setInterval(refreshSelectedTickers, 30_000);
});

onUnmounted(() => {
  if (loadTimer) clearTimeout(loadTimer);
  if (indexRefreshTimer) clearInterval(indexRefreshTimer);
  if (tickerRefreshTimer) clearInterval(tickerRefreshTimer);
});
</script>

<template>
  <div class="appRoot">
    <div class="builderRow">
      <div class="builderMain">
        <PositionBuilder
          :legs="positionLegs"
          :spot="spot"
          :vol="DEFAULT_VOL"
          :T="DEFAULT_T"
          :instruments="instruments"
          :ticker-by-instrument="tickerByInstrument"
          :index-name="activeIndexName"
          :index-price="indexDisplay?.price ?? null"
          :index-fetched-at="indexDisplay?.fetchedAt ?? null"
          @update:legs="positionLegs = $event"
        />
      </div>
    </div>

    <div class="statusRow" v-if="ui.loading || ui.error">
      <span v-if="ui.loading">Loading mark history...</span>
      <span v-else class="error">{{ ui.error }}</span>
    </div>

    <div class="chartBlock">
      <IndexMarkComboChart
        :index-data="indexSeries"
        :combo-data="comboSeries"
        :option-instrument-name="activeIndexName"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
        :resolution-key="ui.resolutionKey"
        :resolution-options="RESOLUTION_OPTIONS"
        @update:resolution-key="ui.resolutionKey = $event"
      />
    </div>
  </div>
</template>

<style scoped>
.appRoot {
  max-width: 1320px;
  margin: 0 auto;
  padding: 28px 40px 40px;
  color: #e8e8ea;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.builderRow {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.builderMain {
  flex: 1 1 auto;
  min-width: 0;
}

.builderMain :deep(.legs-section) {
  --layout-gap: 8px;
  --leg-row-gap-total: 32px;
  --leg-greeks-gap-total: 44px;
  --strike-greeks-gap: 10px;
}

.chartBlock {
  margin-top: 28px;
  width: min(100%, 960px);
  margin-left: 8px;
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
}

.statusRow {
  min-height: 20px;
  color: #9ea5bc;
  font-size: 14px;
}

.error {
  color: #ff8282;
}

@media (max-width: 900px) {
  .appRoot {
    padding: 18px 14px 20px;
  }

  .builderRow {
    flex-direction: column;
    gap: 10px;
  }

  .chartBlock {
    width: 100%;
    margin-left: 0;
  }
}
</style>
