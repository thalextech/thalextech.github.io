<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import OptionPnlChart from "./components/OptionPnLChart.vue";
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
const MAIN_POINT_LIMIT = 300;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");

const ui = reactive({
  resolution: "3600",
  optionMaturity: "",
  optionStrike: "",
  optionType: "call",
  loading: false,
  error: "",
});
const data = reactive({
  optionInstruments: [],
  optionInstrument: null,
  optionMark: {},
  index: {},
});
const chartRef = ref(null);

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});
const strikeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const getOldestOptionInstrument = (instruments) => {
  let oldest = null;
  for (const instrument of instruments || []) {
    const created = Number(instrument?.create_time_ms);
    if (!oldest || created < Number(oldest?.create_time_ms)) {
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

const optionMaturities = computed(() => {
  const expirations = Array.from(
    new Set(
      data.optionInstruments.map((instrument) =>
        Number(instrument?.expiration_timestamp),
      ),
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
    (instrument) => Number(instrument?.expiration_timestamp) === maturityTs,
  );
});

const optionStrikes = computed(() => {
  const strikes = Array.from(
    new Set(
      optionInstrumentsForMaturity.value.map((instrument) =>
        Number(instrument?.strike_price),
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
      const expirationMatch =
        Number(instrument.expiration_timestamp) === maturityTs;
      const strikeMatch = Number(instrument.strike_price) === strike;
      const typeMatch = instrument.option_type === type;
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const optionInstrumentName = computed(
  () => selectedOptionInstrument.value?.instrument_name || "",
);

const mainSeries = computed(() => {
  const index = data.index[ui.resolution] || [];
  const optionMark = data.optionMark[ui.resolution] || [];
  const optionDataByTs = new Map(
    optionMark.map((row) => [
      row.ts,
      { iv_close: row.iv_close, option_mark_price: row.mark_price_close },
    ]),
  );
  const optionTsRange = optionMark.reduce(
    (acc, row) => {
      const ts = row?.ts;
      if (!Number.isFinite(ts)) return acc;
      return {
        min: acc.min == null || ts < acc.min ? ts : acc.min,
        max: acc.max == null || ts > acc.max ? ts : acc.max,
      };
    },
    { min: null, max: null },
  );
  const optionMinDate =
    optionTsRange.min != null ? new Date(optionTsRange.min * 1000) : null;
  const optionMaxDate =
    optionTsRange.max != null ? new Date(optionTsRange.max * 1000) : null;
  const series = index.map((point) => {
    const optionData = optionDataByTs.get(point.ts);
    return {
      ...point,
      date: new Date(point.ts * 1000),
      iv_close: optionData?.iv_close ?? null,
      option_mark_price: optionData?.option_mark_price ?? null,
    };
  });
  const filtered = series.filter((point) => {
    if (!(point.date instanceof Date)) return false;
    if (point.date < MIN_DATA_DATE) return false;
    if (optionMinDate && optionMaxDate) {
      return point.date >= optionMinDate && point.date <= optionMaxDate;
    }
    return true;
  });
  return filtered.slice(-MAIN_POINT_LIMIT);
});

const optionPnlSeries = computed(() => {
  const mark = data.optionMark[ui.resolution] || [];
  const index = data.index[ui.resolution] || [];
  if (!mark.length || !index.length || !data.optionInstrument) return [];
  const series = computeGreeksPnlSeries({
    mark,
    index,
    instrument: data.optionInstrument || {},
  });
  const filtered = series.filter(
    (point) => point.date instanceof Date && point.date >= MIN_DATA_DATE,
  );
  return filtered.slice(-MAIN_POINT_LIMIT);
});

async function load() {
  if (!data.optionInstrument) return;

  ui.loading = true;
  ui.error = "";
  data.optionMark = {};
  data.index = {};

  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolution];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolution) ?? 0;
  const timestampRange = {
    from: now - seconds * MAIN_POINT_LIMIT,
    to: now,
  };

  try {
    const optionInstrument = data.optionInstrument;
    const indexName = optionInstrument?.underlying || "BTCUSD";
    const optionName = optionInstrumentName.value;
    const [mainIndex, optionMark] = await Promise.all([
      fetchIndexHistory({
        index_name: indexName,
        resolution,
        from: timestampRange.from,
        to: timestampRange.to,
      }),
      optionName
        ? fetchMarkHistory({
            instrument_name: optionName,
            resolution,
            from: timestampRange.from,
            to: timestampRange.to,
          })
        : Promise.resolve([]),
    ]);
    data.index[ui.resolution] = mainIndex || [];
    data.optionMark[ui.resolution] = optionMark || [];

    if (!mainSeries.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    ui.error = e instanceof Error ? e.message : String(e);
    data.index = {};
    data.optionMark = {};
  } finally {
    ui.loading = false;
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = optionInstrumentName.value || "option-pnl";
  const filename = ui.resolution
    ? `${base}-${ui.resolution}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

onMounted(async () => {
  const all_instruments = await fetchInstruments();
  data.optionInstruments = all_instruments
    .filter((i) => i?.type === "option" && i?.underlying === "BTCUSD")
    .sort(
      (a, b) =>
        (a.expiration_timestamp || 0) - (b.expiration_timestamp || 0) ||
        (a.strike_price || 0) - (b.strike_price || 0),
    );

  const oldest = getOldestOptionInstrument(data.optionInstruments);
  if (oldest && Number.isFinite(oldest.expiration_timestamp)) {
    ui.optionMaturity = String(oldest.expiration_timestamp);
    ui.optionStrike = getMiddleStrikeValue(optionStrikes.value);
    ui.optionType = (oldest.option_type || "call").toLowerCase();
    data.optionInstrument = oldest;
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
      oldest && Number.isFinite(oldest.expiration_timestamp)
        ? String(oldest.expiration_timestamp)
        : maturities[0].value;
  },
  { immediate: true },
);

watch(
  optionStrikes,
  (strikes) => {
    if (!strikes.length) {
      ui.optionStrike = "";
      return;
    }
    if (strikes.some((strike) => strike.value === ui.optionStrike)) return;
    ui.optionStrike = getMiddleStrikeValue(strikes);
  },
  { immediate: true },
);

if (!ui.optionType) {
  ui.optionType = "call";
}

watch(
  () => [ui.resolution, ui.optionMaturity, ui.optionStrike, ui.optionType],
  async () => {
    data.optionInstrument = selectedOptionInstrument.value;
    if (!data.optionInstrument) return;
    await load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Mark Options</h1>
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
          <select id="resolution" v-model="ui.resolution">
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
          :disabled="ui.loading || !mainSeries.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <OptionPnlChart
      ref="chartRef"
      :data="mainSeries"
      :option-pnl-data="optionPnlSeries"
      :option-instrument-name="optionInstrumentName"
      :loading="ui.loading"
    />
  </div>
</template>
