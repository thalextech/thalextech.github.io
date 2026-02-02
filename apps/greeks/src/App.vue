<script setup>
import { computed, onMounted, reactive, watch } from "vue";
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

const ui = reactive({
  expiration: "",
  resolution: "1h",
  xMode: "m",
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
  if (!ui.expiration) return [];
  return data.instruments.filter(
    (instrument) =>
      instrument?.product === "OBTCUSD" &&
      instrument?.expiry_date === ui.expiration,
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
    if ((instrument.option_type || "call").toLowerCase() !== "call") continue;
    const strike = Number(instrument.strike_price);
    const tte = instrument.expiration_timestamp - mark.ts;
    const spot = index.index_price_close;
    const iv = mark.iv_close;
    const { delta, gamma, theta, vega } = calcGreeks(
      spot,
      strike,
      tte,
      iv,
      "call",
    );
    if (!Number.isFinite(delta)) continue;

    const m = spot / strike;
    if (!Number.isFinite(m)) continue;

    rows.push({
      ...index,
      ...mark,
      strike,
      tte,
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

const chartTitle = computed(() => {
  const greek = activeGreekSymbol.value;
  if (!chartRows.value.length) return `Options ${greek} vs moneyness`;
  const name = chartRows.value[0]?.instrument_name || "";
  return name.slice(0, 11) || `Options ${greek} vs moneyness`;
});

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
  if (!selectedInstruments.value.length) return "";
  return `${selectedInstruments.value.length} instruments | ${chartRows.value.length} points`;
});

const chartLoading = computed(() => ui.loading && chartRows.value.length === 0);

const computeRange = (expirationTimestamp) => {
  const now = Math.floor(Date.now() / 1000);
  const safeEnd = Number.isFinite(expirationTimestamp)
    ? Math.min(now, expirationTimestamp - 3600)
    : now;
  const to = Math.max(safeEnd, 0);
  const from = Math.max(0, to - RANGE_DAYS * 24 * 60 * 60);
  return { from, to };
};

let requestId = 0;

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
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const instrumentName = instruments[index].instrument_name;
    const dataRows = Array.isArray(result.value) ? result.value : [];
    dataRows.forEach((row) => {
      rows.push({ ...row, instrument_name: instrumentName });
    });
  });
  return rows;
}

async function load() {
  if (!ui.expiration) return;
  const instruments = selectedInstruments.value;
  if (!instruments.length) {
    ui.error = "No instruments available for this expiration.";
    return;
  }

  const current = (requestId += 1);
  ui.loading = true;
  ui.error = "";
  data.indexRows = [];
  data.markRows = [];

  const range = computeRange(instruments[0].expiration_timestamp);
  data.requestedRange = range;

  try {
    const [indexRows, markRows] = await Promise.all([
      fetchIndexHistory({
        index_name: "BTCUSD",
        resolution: ui.resolution,
        from: range.from,
        to: range.to,
      }),
      fetchMarkRows(instruments, range),
    ]);

    if (current !== requestId) return;
    data.indexRows = indexRows || [];
    data.markRows = markRows || [];

    if (!data.indexRows.length || !data.markRows.length) {
      throw new Error("No datapoints returned for this range.");
    }
  } catch (error) {
    if (current !== requestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
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
    ui.expiration = (closest || options[0]).value;
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  }
});

watch(
  () => [ui.expiration, ui.resolution],
  async () => {
    if (!ui.expiration) return;
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
        <div v-if="metaSummary" class="meta">{{ metaSummary }}</div>
      </div>

      <div class="controls">
        <div class="field">
          <label for="expiration">Expiration</label>
          <select id="expiration" v-model="ui.expiration">
            <option
              v-for="option in expirationOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option v-if="!expirationOptions.length" :value="ui.expiration">
              {{ ui.expiration || "No expirations" }}
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

        <div class="field">
          <label for="xmode">X-axis</label>
          <select id="xmode" v-model="ui.xMode">
            <option value="strike">strike</option>
            <option value="m">moneyness (S/K)</option>
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
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <Greeks
      :data="chartRows"
      :title="chartTitle"
      :subtitle="chartSubtitle"
      :loading="chartLoading"
      :x-mode="ui.xMode"
      :greek="ui.greek"
      :resolution="ui.resolution"
    />
  </div>
</template>

<style scoped>
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
