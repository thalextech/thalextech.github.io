<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import * as d3 from "d3";
import Greeks from "./components/Greeks.vue";
import {
  calcGreeks,
  fetchInstruments,
  fetchIndexHistory,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  "1h": { label: "1h" },
  "1d": { label: "1d" },
};
const GREEK_OPTIONS = [
  { value: "delta", symbol: "\u03b4" },
  { value: "gamma", symbol: "\u0393" },
  { value: "theta", symbol: "\u0398" },
  { value: "vega", symbol: "\u03bd" },
];
const RANGE_DAYS = 21;
const ONE_HOUR_SECONDS = 60 * 60;
const MAX_1H_POINTS_PER_INSTRUMENT = 72;

const ui = reactive({
  expirationPrimary: "",
  expirationSecondary: "",
  resolution: "1d",
  greek: "delta",
  loading: false,
  error: "",
});

const data = reactive({
  instruments: [],
  indexRows: [],
  markRows: [],
  requestedRange: null,
});
const chartRef = ref(null);
const allowSecondaryLoadOnce = ref(false);

const selectedExpirations = computed(() =>
  Array.from(
    new Set(
      [ui.expirationPrimary, ui.expirationSecondary].filter(
        (expiry) => typeof expiry === "string" && expiry.length,
      ),
    ),
  ),
);

const expirationByValue = computed(() => {
  const map = new Map();
  for (const option of expirationOptions.value) {
    map.set(option.value, option);
  }
  return map;
});

const expirationOptions = computed(() => {
  const map = new Map();
  for (const instrument of data.instruments) {
    if (!instrument || instrument.product !== "OBTCUSD") continue;
    const expiry = instrument.expiry_date;
    const ts = instrument.expiration_timestamp;
    if (!expiry || !Number.isFinite(ts)) continue;
    if (!map.has(expiry)) {
      map.set(expiry, {
        value: expiry,
        label: expiry,
        expiration_timestamp: ts,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.expiration_timestamp - b.expiration_timestamp,
  );
});

const selectedInstruments = computed(() => {
  const selected = new Set(selectedExpirations.value);
  if (!selected.size) return [];
  return data.instruments.filter(
    (instrument) =>
      instrument?.product === "OBTCUSD" &&
      selected.has(instrument?.expiry_date) &&
      (instrument?.option_type || "call").toLowerCase() === "call",
  );
});

const instrumentLookup = computed(() => {
  const map = new Map();
  for (const instrument of data.instruments) {
    if (!instrument?.instrument_name) continue;
    map.set(instrument.instrument_name, instrument);
  }
  return map;
});

const chartRows = computed(() => {
  if (!data.indexRows.length || !data.markRows.length) return [];
  const indexByTs = new Map(data.indexRows.map((row) => [row.ts, row]));
  const lookup = instrumentLookup.value;
  const rows = [];
  const ivAggByTs = new Map();

  for (const mark of data.markRows) {
    const index = indexByTs.get(mark.ts);
    if (!index) continue;
    const instrument = lookup.get(mark.instrument_name);
    if (!instrument) continue;
    const optionType = (instrument.option_type || "call").toLowerCase();
    if (optionType !== "call") continue;
    const strike = Number(instrument.strike_price);
    const tte = instrument.expiration_timestamp - mark.ts;
    const spot = index.index_price_close;
    const iv = mark.iv_close;
    const { delta, gamma, theta, vega } = calcGreeks(
      spot,
      strike,
      tte,
      iv,
      optionType,
    );
    if (!Number.isFinite(delta)) continue;

    const m = spot / strike;
    if (!Number.isFinite(m)) continue;

    rows.push({
      ...index,
      ...mark,
      strike,
      tte,
      expiry_date: instrument.expiry_date,
      expiry_rank: Math.max(
        0,
        selectedExpirations.value.indexOf(instrument.expiry_date),
      ),
      delta,
      gamma,
      theta,
      vega,
      delta_abs: Math.abs(delta),
      m,
      date_time: new Date(mark.ts * 1000),
    });

    if (Number.isFinite(iv)) {
      const agg = ivAggByTs.get(mark.ts) || { sum: 0, count: 0 };
      agg.sum += iv;
      agg.count += 1;
      ivAggByTs.set(mark.ts, agg);
    }
  }

  if (!rows.length) return [];
  const ivMeanByTs = new Map();
  ivAggByTs.forEach((agg, ts) => {
    ivMeanByTs.set(ts, agg.count ? agg.sum / agg.count : null);
  });
  const minTs = rows.reduce(
    (min, row) => (row.ts < min ? row.ts : min),
    rows[0].ts,
  );
  const maxTs = rows.reduce(
    (max, row) => (row.ts > max ? row.ts : max),
    rows[0].ts,
  );
  const denom = maxTs - minTs || 1;

  return rows.map((row) => ({
    ...row,
    iv_mean: ivMeanByTs.get(row.ts),
    opacity: (row.ts - minTs) / denom || 0,
    is_latest: row.ts === maxTs,
  }));
});

const activeGreekSymbol = computed(
  () =>
    GREEK_OPTIONS.find((option) => option.value === ui.greek)?.symbol ||
    GREEK_OPTIONS[0].symbol,
);

const chartTitle = computed(() => "");

const chartSubtitle = computed(() => {
  if (!chartRows.value.length) return "";
  const format = d3.timeFormat("%d %b %y %I:%M %p");
  const minDate = chartRows.value.reduce(
    (min, row) => (row.date_time < min ? row.date_time : min),
    chartRows.value[0].date_time,
  );
  const maxDate = chartRows.value.reduce(
    (max, row) => (row.date_time > max ? row.date_time : max),
    chartRows.value[0].date_time,
  );
  return `${format(minDate)} - ${format(maxDate)}`;
});

const metaSummary = computed(() => {
  if (!selectedExpirations.value.length) return "";
  const expiryCount = selectedExpirations.value.length;
  return `${expiryCount} expiries | ${selectedInstruments.value.length} instruments | ${chartRows.value.length} points`;
});

const chartLoading = computed(() => ui.loading && chartRows.value.length === 0);

function handleSavePng() {
  if (!chartRef.value) return;
  const primary = ui.expirationPrimary || "expiry-a";
  const secondary = ui.expirationSecondary || "expiry-b";
  const filename = `greeks-${primary}-${secondary}-${ui.greek}.png`;
  chartRef.value.exportPng({ filename });
}

const computeRange = (expirationTimestamp) => {
  const now = Math.floor(Date.now() / 1000);
  const safeEnd = Number.isFinite(expirationTimestamp)
    ? Math.min(now, expirationTimestamp - 3600)
    : now;
  const to = Math.max(safeEnd, 0);
  let from = Math.max(0, to - RANGE_DAYS * 24 * 60 * 60);
  if (ui.resolution === "1h") {
    const spanSeconds = MAX_1H_POINTS_PER_INSTRUMENT * ONE_HOUR_SECONDS;
    from = Math.max(0, to - spanSeconds);
  }
  return { from, to };
};

function getExpirationsForLoad() {
  const values = [ui.expirationPrimary, ui.expirationSecondary].filter(
    (expiry) => typeof expiry === "string" && expiry.length,
  );
  const unique = Array.from(new Set(values));
  if (allowSecondaryLoadOnce.value) {
    allowSecondaryLoadOnce.value = false;
    return unique;
  }
  return ui.expirationPrimary ? [ui.expirationPrimary] : [];
}

let requestId = 0;
const markRowsCache = new Map();

async function fetchMarkRows(instruments, range) {
  const results = await Promise.allSettled(
    instruments.map((instrument) =>
      fetchMarkHistory({
        instrument_name: instrument.instrument_name,
        resolution: ui.resolution,
        from: range.from,
        to: range.to,
      }),
    ),
  );

  const rows = [];
  let rateLimitedCount = 0;
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      if (result.reason?.status === 429) {
        rateLimitedCount += 1;
      }
      return;
    }
    const instrumentName = instruments[index].instrument_name;
    const dataRows = Array.isArray(result.value) ? result.value : [];
    dataRows.forEach((row) => {
      rows.push({ ...row, instrument_name: instrumentName });
    });
  });
  return { rows, rateLimitedCount };
}

function buildMarkCacheKey({ expiry, resolution }) {
  return `${expiry}|${resolution}`;
}

async function load() {
  const expirationsToLoad = getExpirationsForLoad();
  if (!expirationsToLoad.length) return;
  const selected = new Set(expirationsToLoad);
  const instruments = data.instruments.filter(
    (instrument) =>
      instrument?.product === "OBTCUSD" &&
      selected.has(instrument?.expiry_date) &&
      (instrument?.option_type || "call").toLowerCase() === "call",
  );
  if (!instruments.length) {
    ui.error = "No instruments available for the selected expiries.";
    return;
  }

  const current = (requestId += 1);
  ui.loading = true;
  ui.error = "";
  data.indexRows = [];
  data.markRows = [];

  const expiryTimestamps = expirationsToLoad
    .map((value) => expirationByValue.value.get(value)?.expiration_timestamp)
    .filter((value) => Number.isFinite(value));
  const referenceExpiryTs = expiryTimestamps.length
    ? Math.max(...expiryTimestamps)
    : instruments[0].expiration_timestamp;
  const range = computeRange(referenceExpiryTs);
  data.requestedRange = range;

  try {
    const indexRows = await fetchIndexHistory({
      index_name: "BTCUSD",
      resolution: ui.resolution,
      from: range.from,
      to: range.to,
    });

    if (current !== requestId) return;
    data.indexRows = indexRows || [];

    const instrumentsByExpiry = new Map();
    for (const instrument of instruments) {
      const expiry = instrument?.expiry_date;
      if (!expiry) continue;
      const bucket = instrumentsByExpiry.get(expiry) || [];
      bucket.push(instrument);
      instrumentsByExpiry.set(expiry, bucket);
    }

    let totalRateLimitedCount = 0;
    for (const expiry of expirationsToLoad) {
      const expiryInstruments = instrumentsByExpiry.get(expiry) || [];
      if (!expiryInstruments.length) continue;
      const cacheKey = buildMarkCacheKey({
        expiry,
        resolution: ui.resolution,
      });
      if (markRowsCache.has(cacheKey)) continue;

      const markResult = await fetchMarkRows(expiryInstruments, range);
      if (current !== requestId) return;
      totalRateLimitedCount += markResult?.rateLimitedCount || 0;
      markRowsCache.set(cacheKey, markResult?.rows || []);
    }

    const combinedMarkRows = [];
    for (const expiry of expirationsToLoad) {
      const cacheKey = buildMarkCacheKey({
        expiry,
        resolution: ui.resolution,
      });
      const cachedRows = markRowsCache.get(cacheKey) || [];
      combinedMarkRows.push(...cachedRows);
    }
    data.markRows = combinedMarkRows;

    if (!data.indexRows.length || !data.markRows.length) {
      if (totalRateLimitedCount > 0) {
        throw new Error(
          `Rate limited by Thalex (429) while loading ${totalRateLimitedCount} instrument request(s). Please wait a bit and retry.`,
        );
      }
      throw new Error("No datapoints returned for this range.");
    }
  } catch (error) {
    if (current !== requestId) return;
    if (error?.status === 429) {
      ui.error = "Rate limited by Thalex (429). Please wait a bit and retry.";
    } else {
      ui.error = error instanceof Error ? error.message : String(error);
    }
    data.indexRows = [];
    data.markRows = [];
  } finally {
    if (current === requestId) {
      ui.loading = false;
    }
  }
}

onMounted(async () => {
  try {
    const all = await fetchInstruments();
    data.instruments = Array.isArray(all) ? all : [];
    const options = expirationOptions.value;
    if (!options.length) {
      ui.error = "No option expirations found.";
      return;
    }
    const now = Date.now() / 1000;
    const target = now + 30 * 24 * 60 * 60;
    const upcoming = options.filter(
      (option) => option.expiration_timestamp > now,
    );
    const pickFrom = upcoming.length ? upcoming : options;
    const closest = pickFrom.reduce((best, option) => {
      if (!best) return option;
      const bestDiff = Math.abs(best.expiration_timestamp - target);
      const optionDiff = Math.abs(option.expiration_timestamp - target);
      return optionDiff < bestDiff ? option : best;
    }, null);
    const primary = (closest || options[0]).value;
    const primaryIndex = options.findIndex((option) => option.value === primary);
    const secondaryFallback =
      options[primaryIndex + 1] || options[primaryIndex - 1] || options[0];
    allowSecondaryLoadOnce.value = true;
    ui.expirationPrimary = primary;
    ui.expirationSecondary =
      secondaryFallback?.value === primary ? "" : secondaryFallback?.value || "";
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  }
});

watch(
  () => [ui.expirationPrimary, ui.resolution],
  async () => {
    if (!ui.expirationPrimary) return;
    await load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Options {{ activeGreekSymbol }} vs moneyness</h1>
        <div
          v-if="chartSubtitle || metaSummary"
          class="titleMetaGroup"
        >
          <div v-if="chartSubtitle" class="meta">{{ chartSubtitle }}</div>
          <div v-if="metaSummary" class="meta">{{ metaSummary }}</div>
        </div>
      </div>

      <div class="controls">
        <div class="field">
          <label for="expiration-primary">Expiry A</label>
          <select id="expiration-primary" v-model="ui.expirationPrimary">
            <option
              v-for="option in expirationOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option
              v-if="!expirationOptions.length"
              :value="ui.expirationPrimary"
            >
              {{ ui.expirationPrimary || "No expirations" }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="expiration-secondary">Expiry B</label>
          <select id="expiration-secondary" v-model="ui.expirationSecondary">
            <option value="">None</option>
            <option
              v-for="option in expirationOptions"
              :key="`secondary-${option.value}`"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option
              v-if="!expirationOptions.length"
              :value="ui.expirationSecondary"
            >
              {{ ui.expirationSecondary || "No expirations" }}
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

        <div class="greekSymbolGrid" role="group" aria-label="Greek">
          <button
            v-for="option in GREEK_OPTIONS"
            :key="option.value"
            type="button"
            class="greekSymbolButton"
            :class="{ active: ui.greek === option.value }"
            @click="ui.greek = option.value"
          >
            {{ option.symbol }}
          </button>
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !chartRows.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <Greeks
      ref="chartRef"
      :data="chartRows"
      :title="chartTitle"
      subtitle=""
      :loading="chartLoading"
      x-mode="m"
      :greek="ui.greek"
      :resolution="ui.resolution"
    />
  </div>
</template>

<style scoped>
.titleMetaGroup {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.greekSymbolGrid {
  display: inline-grid;
  grid-auto-flow: column;
  gap: 8px;
}

.greekSymbolButton {
  border: 1px solid var(--border);
  background: color-mix(in oklab, var(--panel), #1b1f2f 35%);
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  width: 44px;
  height: 40px;
  border-radius: 10px;
  cursor: pointer;
}

.greekSymbolButton.active {
  color: var(--text);
  font-weight: 600;
}
</style>
