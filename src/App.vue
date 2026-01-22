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
const chartRef = ref(null);
const availableResolutions = computed(() => {
  const current = futureInstruments.value.find(
    (i) => i.instrument_name === instrumentName.value,
  );
  if (!current) {
    return RESOLUTIONS;
  }
  const createTimeMs = Number.isFinite(current?.create_time_ms)
    ? current.create_time_ms
    : 0;
  const ageMs = Math.max(0, Date.now() - createTimeMs);
  const allowed = RESOLUTIONS.filter((r) => {
    const requirementMs = r.seconds * MIN_POINTS_FOR_RESOLUTION * 1000;
    return ageMs >= requirementMs;
  });
  return allowed.length ? allowed : RESOLUTIONS;
});

const range = ref(null);
const data = ref([]);
const detailData = ref([]);
const detailRange = ref(null);
const detailResolution = ref("1h");
const DETAIL_TARGET_POINTS = 400;
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

function pickDetailResolution(rangeSeconds) {
  const candidates = availableResolutions.value.length
    ? availableResolutions.value
    : RESOLUTIONS;
  if (!Number.isFinite(rangeSeconds) || rangeSeconds <= 0) {
    return candidates.find((r) => r.value === "1h")?.value || "1h";
  }
  let best = null;
  for (const candidate of candidates) {
    const points = rangeSeconds / candidate.seconds;
    const diff = Math.abs(points - DETAIL_TARGET_POINTS);
    if (
      !best ||
      diff < best.diff ||
      (diff === best.diff && candidate.value === "1h")
    ) {
      best = { value: candidate.value, diff };
    }
  }
  if (!best) {
    return candidates.find((r) => r.value === "1h")?.value || "1h";
  }
  return best.value;
}

async function loadDetail(range) {
  if (!instrumentName.value || !range) return;
  const instrument = await fetchInstrument(instrumentName.value);
  const index_name =
    instrument?.underlying || indexNameFromInstrumentName(instrumentName.value);
  const detailResolutionValue = pickDetailResolution(range.to - range.from);
  detailResolution.value = detailResolutionValue;

  const [detailMarkResult, detailIndex] = await Promise.all([
    fetchMarkHistory({
      instrument_name: instrumentName.value,
      resolution: detailResolutionValue,
      from: range.from,
      to: range.to,
    }),
    fetchIndexHistory({
      index_name,
      resolution: detailResolutionValue,
      from: range.from,
      to: range.to,
    }),
  ]);

  detailData.value = computeBasisSeries({
    mark: detailMarkResult?.data || [],
    index: detailIndex || [],
    instrument,
    instrument_name: instrumentName.value,
  });
}

async function load() {
  if (!instrumentName.value) return;

  loading.value = true;
  error.value = "";
  data.value = [];
  detailData.value = [];
  detailRange.value = null;

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

    detailRange.value = null;
    const detailResolutionValue = pickDetailResolution(
      nextRange.to - nextRange.from,
    );
    detailResolution.value = detailResolutionValue;
    const [markResult, index, detailMarkResult, detailIndex] =
      await Promise.all([
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
        fetchMarkHistory({
          instrument_name: instrumentName.value,
          resolution: detailResolutionValue,
          from: nextRange.from,
          to: nextRange.to,
        }),
        fetchIndexHistory({
          index_name,
          resolution: detailResolutionValue,
          from: nextRange.from,
          to: nextRange.to,
        }),
      ]);

    const { instrument_type, data: mark } = markResult;

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

    detailData.value = computeBasisSeries({
      mark: detailMarkResult?.data || [],
      index: detailIndex || [],
      instrument,
      instrument_name: instrumentName.value,
    });

    if (!data.value.length) {
      throw new Error("No merged datapoints returned for this time range.");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = [];
    detailData.value = [];
  } finally {
    loading.value = false;
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = instrumentName.value || "basis-chart";
  const filename = resolution.value
    ? `${base}-${resolution.value}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
}

async function handleDetailBrush(brushRange) {
  const nextRange = brushRange || range.value;
  detailRange.value = brushRange || null;
  if (!nextRange) return;
  try {
    await loadDetail(nextRange);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    detailData.value = [];
  }
}

onMounted(async () => {
  try {
    const list = await fetchInstruments();
    const now = Math.floor(Date.now() / 1000);

    const filtered = list.filter(
      (i) => i?.type === "future" && i?.underlying === "BTCUSD",
    );

    const prepared = [...filtered].sort(
      (a, b) => a.expiration_timestamp - b.expiration_timestamp,
    );

    futureInstruments.value = prepared;

    const getCreateTimeMs = (instrument) =>
      Number.isFinite(instrument?.create_time_ms)
        ? instrument.create_time_ms
        : Number.POSITIVE_INFINITY;

    const earliestByCreate = prepared.reduce((best, candidate) => {
      if (!best) return candidate;
      return getCreateTimeMs(candidate) < getCreateTimeMs(best)
        ? candidate
        : best;
    }, null);

    const active = prepared.find((i) => i.expiration_timestamp > now);

    const initialInstrument = earliestByCreate || active || prepared[0] || null;

    instrumentName.value = initialInstrument?.instrument_name || "BTC-30JAN26";
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

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="loading || !data.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </header>

    <BasisChart
      ref="chartRef"
      :data="data"
      :detail-data="detailData"
      :detail-range="detailRange"
      :detail-resolution="detailResolution"
      :instrument-name="instrumentName"
      :range="range"
      :loading="loading"
      @brush="handleDetailBrush"
    />
  </div>
</template>
