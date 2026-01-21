<script setup>
import { computed, onMounted, ref, watch } from "vue";
import * as d3 from "d3";
import BasisChart from "./components/BasisChart.vue";
import {
  computeBasisSeries,
  fetchIndexHistory,
  fetchInstrument,
  fetchInstruments,
  fetchMarkHistory,
  indexNameFromInstrumentName,
} from "./lib/thalex.js";

const MIN_POINTS_FOR_RESOLUTION = 50;

const RESOLUTIONS = [
  { label: "1m", value: "1m", seconds: 60 },
  { label: "5m", value: "5m", seconds: 5 * 60 },
  { label: "15m", value: "15m", seconds: 15 * 60 },
  { label: "1h", value: "1h", seconds: 60 * 60 },
  { label: "1d", value: "1d", seconds: 24 * 60 * 60 },
];

const POINTS = 500;

const resolution = ref("1h");
const futureInstruments = ref([]);
const instrumentName = ref("");
const availableResolutions = computed(() => {
  const current = futureInstruments.value.find(
    (i) => i.instrument_name === instrumentName.value,
  );
  if (!current) {
    return RESOLUTIONS;
  }
  const createTimeMs = parseInstrumentCreateTime(current);
  const ageMs = Math.max(0, Date.now() - createTimeMs);
  const allowed = RESOLUTIONS.filter((r) => {
    const requirementMs = r.seconds * MIN_POINTS_FOR_RESOLUTION * 1000;
    return ageMs >= requirementMs;
  });
  return allowed.length ? allowed : RESOLUTIONS;
});

const range = ref(null);
const data = ref([]);
const loading = ref(false);
const error = ref("");

const resolutionSeconds = computed(() => {
  return RESOLUTIONS.find((r) => r.value === resolution.value)?.seconds ?? 3600;
});

function computeRange() {
  const now = Math.floor(Date.now() / 1000);
  const seconds = resolutionSeconds.value;
  return {
    from: now - seconds * POINTS,
    to: now,
    points: POINTS,
    resolution: resolution.value,
  };
}

const rangeLabelFormatter = d3.utcFormat("%d %b %y %H:%M");

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];

  const allowed = availableResolutions.value;
  const resolutionAllowed = allowed.some((r) => r.value === resolution.value);
  if (!resolutionAllowed) {
    const fallback =
      allowed.find((r) => r.value === "1d") ?? allowed[0] ?? RESOLUTIONS[0];
    resolution.value = fallback.value;
    return;
  }

  const nextRange = computeRange();
  range.value = nextRange;

  try {
    const instrument = await fetchInstrument(instrumentName.value);

    const index_name =
      instrument?.underlying ||
      indexNameFromInstrumentName(instrumentName.value);

    const [{ instrument_type, data: mark }, index] = await Promise.all([
      fetchMarkHistory({
        instrument_name: instrumentName.value,
        resolution: resolution.value,
        from: nextRange.from,
        to: nextRange.to,
      }),
      fetchIndexHistory({
        index_name,
        resolution: resolution.value,
        from: nextRange.from,
        to: nextRange.to,
      }),
    ]);

    if (instrument_type !== "future") {
      throw new Error(
        `Instrument type is '${instrument_type}'. Pick a future instrument.`,
      );
    }

    data.value = computeBasisSeries({
      mark,
      index,
      instrument,
      instrument_name: instrumentName.value,
    });

    if (!data.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = [];
  } finally {
    loading.value = false;
  }
}

function parseInstrumentCreateTime(instrument) {
  if (!instrument) return 0;
  const raw = instrument.create_time;
  if (raw === undefined || raw === null) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

onMounted(async () => {
  try {
    const list = await fetchInstruments();
    const now = Math.floor(Date.now() / 1000);

    const filtered = list.filter(
      (i) => i?.type === "future" && i?.underlying === "BTCUSD",
    );

    const prepared = filtered
      .map((instrument) => ({
        ...instrument,
        createTimeMs: parseInstrumentCreateTime(instrument),
      }))
      .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

    futureInstruments.value = prepared;

    const earliestByCreate = prepared.reduce((best, candidate) => {
      if (!best) return candidate;
      if (candidate.createTimeMs < best.createTimeMs) return candidate;
      return best;
    }, null);

    const active = prepared.find((i) => i.expiration_timestamp > now);

    const initialInstrument =
      earliestByCreate || active || prepared[0] || null;

    instrumentName.value =
      initialInstrument?.instrument_name || "BTC-30JAN26";
    resolution.value = "1d";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    instrumentName.value = "BTC-30JAN26";
    resolution.value = "1d";
  }
});

watch(
  () => [resolution.value, instrumentName.value],
  async () => {
    if (!instrumentName.value) return;
    await load();
  },
  { immediate: true },
);

watch(
  () => availableResolutions.value,
  (allowed) => {
    if (!allowed.length) return;
    if (!allowed.some((r) => r.value === resolution.value)) {
      const fallback =
        allowed.find((r) => r.value === "1d") ?? allowed[0] ?? RESOLUTIONS[0];
      resolution.value = fallback.value;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Future basis - thalex</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="instrument">Instrument</label>
          <select id="instrument" v-model="instrumentName">
            <option
              v-for="i in futureInstruments"
              :key="i.instrument_name"
              :value="i.instrument_name"
            >
              {{ i.instrument_name }}
            </option>
            <option v-if="!futureInstruments.length" :value="instrumentName">
              {{ instrumentName || "BTC-26DEC25" }}
            </option>
          </select>
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <select id="resolution" v-model="resolution">
            <option
              v-for="r in availableResolutions"
              :key="r.value"
              :value="r.value"
            >
              {{ r.label }}
            </option>
          </select>
        </div>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </header>

    <BasisChart
      :data="data"
      :instrument-name="instrumentName"
      :range="range"
      :loading="loading"
    />
  </div>
</template>
