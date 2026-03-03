<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as d3 from "d3";
import HorseRaceChart from "./components/Chart.vue";
import {
  calcGreeks,
  fetchAllInstruments,
  fetchIndexHistory,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const RESOLUTION_OPTIONS = Object.entries(RESOLUTION_CONFIG).map(([key, cfg]) => ({
  key,
  label: cfg.label,
}));

const DEFAULT_MAX_POINTS_PER_FETCH = 360;
const MIN_POINTS_PER_FETCH = 100;
const MAX_POINTS_PER_FETCH = 2000;
const MARK_FETCH_CONCURRENCY = 100;
const MARK_RATE_LIMIT_PER_SECOND = 10;
const MARK_RATE_LIMIT_BURST = 100;
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_MAX_RETRIES = 3;
const REQUEST_RETRY_DELAY_MS = 2000;
const LOAD_DEBOUNCE_MS = 160;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const ui = reactive({
  optionType: "call",
  resolutionKey: "900",
  maxPoints: DEFAULT_MAX_POINTS_PER_FETCH,
  loading: false,
  error: "",
  loadedInstruments: 0,
  totalInstruments: 0,
});

const instruments = ref([]);
const indexSeries = ref([]);
const optionSeries = ref([]);
const progressiveDots = ref(0);
const topSettingsMenuRef = ref(null);
const settingsOpen = ref(false);

let loadRequestId = 0;
let loadTimer = null;
let progressiveDotsTimer = null;

const activeResolutionConfig = computed(
  () => RESOLUTION_CONFIG[ui.resolutionKey] || null,
);

const maxPointsPerFetch = computed(() => {
  const points = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(points)) return DEFAULT_MAX_POINTS_PER_FETCH;
  return Math.max(MIN_POINTS_PER_FETCH, Math.min(MAX_POINTS_PER_FETCH, points));
});

const chartSubtitle = computed(() => {
  const rows = indexSeries.value;
  if (!rows.length) return "";
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const from = fmt(rows[0].date);
  const to = fmt(rows[rows.length - 1].date);
  return `${from} - ${to}`;
});

const loadingLabel = computed(() => {
  if (!ui.loading) return "";
  const dots = ".".repeat(progressiveDots.value);
  if (!ui.totalInstruments) return `Loading${dots}`;
  return `Loading ${ui.loadedInstruments}/${ui.totalInstruments}${dots}`;
});

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 900;
  const to = now - (now % safeSeconds);
  return {
    resolution,
    from: to - safeSeconds * (maxPointsPerFetch.value - 1),
    to,
  };
};

const normalizeTimestampSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return null;
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
};

const sortRowsByTs = (rows) =>
  (rows || [])
    .filter((row) => Number.isFinite(normalizeTimestampSeconds(row?.ts)))
    .slice()
    .sort(
      (a, b) =>
        normalizeTimestampSeconds(a?.ts) - normalizeTimestampSeconds(b?.ts),
    );

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function createRequestRateLimiter({ requestsPerSecond, burst }) {
  const safeRate =
    Number.isFinite(requestsPerSecond) && requestsPerSecond > 0
      ? requestsPerSecond
      : 1;
  const capacity =
    Number.isFinite(burst) && burst > 0 ? Math.floor(burst) : Math.floor(safeRate);
  const refillPerMs = safeRate / 1000;
  let tokens = capacity;
  let lastRefillAt = Date.now();

  const refill = () => {
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefillAt = now;
  };

  const waitForToken = async ({ isCanceled = null } = {}) => {
    while (true) {
      if (isCanceled?.()) return false;
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      const missingTokens = 1 - tokens;
      const waitMs = Math.max(1, Math.ceil(missingTokens / refillPerMs));
      await sleep(waitMs);
    }
  };

  return { waitForToken };
}

function isRetryableRequestError(error) {
  if (!error) return false;
  if (RETRYABLE_STATUS.has(Number(error?.status))) return true;
  if (error?.name === "AbortError") return true;
  return error instanceof TypeError;
}

async function fetchWithRetries(
  fetcher,
  { maxRetries = REQUEST_MAX_RETRIES, isCanceled = null } = {},
) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (isCanceled?.()) {
      const canceledError = new Error("Request canceled");
      canceledError.canceled = true;
      throw canceledError;
    }
    try {
      return await fetcher();
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < maxRetries &&
        isRetryableRequestError(error) &&
        !isCanceled?.();
      if (!canRetry) throw error;
      await sleep(REQUEST_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error("Request failed");
}

const buildInstrumentSeries = ({ instrument, markRows, indexByTs }) => {
  const strike = Number(instrument?.strike_price);
  const expirationTs = Number(instrument?.expiration_timestamp);
  const optionType = (instrument?.option_type || "").toLowerCase();
  if (!Number.isFinite(strike) || !Number.isFinite(expirationTs)) return null;
  if (optionType !== "call" && optionType !== "put") return null;

  const points = [];
  for (const row of sortRowsByTs(markRows)) {
    const ts = normalizeTimestampSeconds(row?.ts);
    if (!Number.isFinite(ts)) continue;
    const indexRow = indexByTs.get(ts);
    if (!indexRow) continue;
    const mark = Number(row?.mark_price_close);
    if (!Number.isFinite(mark) || mark <= 0) continue;

    const spot = Number(indexRow?.index_price_close);
    const iv = Number(row?.iv_close);
    const tteSeconds = expirationTs - ts;
    let deltaAbs = null;

    if (
      Number.isFinite(spot) &&
      spot > 0 &&
      Number.isFinite(iv) &&
      Number.isFinite(tteSeconds) &&
      tteSeconds > 0
    ) {
      const greeks = calcGreeks(spot, strike, tteSeconds, iv, optionType);
      if (Number.isFinite(greeks?.delta)) {
        deltaAbs = Math.abs(Number(greeks.delta));
      }
    }

    points.push({
      ts,
      date: new Date(ts * 1000),
      mark,
      index_price: spot,
      delta_abs: deltaAbs,
    });
  }

  if (points.length < 2) return null;

  return {
    instrument_name: instrument.instrument_name,
    strike,
    expiration_timestamp: expirationTs,
    expiry_date: instrument.expiry_date,
    option_type: optionType,
    points,
  };
};

const loadSeries = async () => {
  const requestId = ++loadRequestId;
  const { resolution, from, to } = getTimestampRange();
  const isCanceled = () => requestId !== loadRequestId;

  ui.loading = true;
  ui.error = "";
  ui.loadedInstruments = 0;
  ui.totalInstruments = 0;
  indexSeries.value = [];
  optionSeries.value = [];

  try {
    if (!instruments.value.length) {
      const allInstruments = await fetchWithRetries(
        () => fetchAllInstruments(),
        {
          isCanceled,
        },
      );
      if (isCanceled()) return;
      instruments.value = Array.isArray(allInstruments) ? allInstruments : [];
    }

    const typeFilter = String(ui.optionType || "call").toLowerCase();
    const optionUniverse = (instruments.value || []).filter((instrument) => {
      const optionType = (instrument?.option_type || "").toLowerCase();
      const isOption =
        (instrument?.type || "").toLowerCase() === "option" &&
        instrument?.underlying === "BTCUSD";
      const expirationTs = Number(instrument?.expiration_timestamp);
      return (
        isOption &&
        optionType === typeFilter &&
        Number.isFinite(expirationTs) &&
        expirationTs > from
      );
    });

    if (!optionUniverse.length) {
      throw new Error(`No BTCUSD ${typeFilter} instruments found.`);
    }

    const fetchedIndexRows = await fetchWithRetries(
      () =>
        fetchIndexHistory({
          index_name: "BTCUSD",
          resolution,
          from,
          to,
          requestOptions: {
            timeoutMs: REQUEST_TIMEOUT_MS,
            maxRetries: 0,
          },
        }),
      { isCanceled },
    );
    if (isCanceled()) return;

    const sortedIndexRows = sortRowsByTs(fetchedIndexRows)
      .map((row) => {
        const ts = normalizeTimestampSeconds(row?.ts);
        const value = Number(row?.index_price_close);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;
        return {
          ts,
          date: new Date(ts * 1000),
          index_price_close: value,
        };
      })
      .filter(Boolean);

    if (!sortedIndexRows.length) {
      throw new Error("No index history points returned for this range.");
    }

    indexSeries.value = sortedIndexRows;
    const indexByTs = new Map(sortedIndexRows.map((row) => [row.ts, row]));

    ui.totalInstruments = optionUniverse.length;

    const rateLimiter = createRequestRateLimiter({
      requestsPerSecond: MARK_RATE_LIMIT_PER_SECOND,
      burst: MARK_RATE_LIMIT_BURST,
    });

    let nextJobIndex = 0;
    const nextJob = () => {
      if (nextJobIndex >= optionUniverse.length) return null;
      const instrument = optionUniverse[nextJobIndex];
      nextJobIndex += 1;
      return instrument;
    };

    const worker = async () => {
      while (true) {
        if (isCanceled()) return;
        const instrument = nextJob();
        if (!instrument) return;

        const hasToken = await rateLimiter.waitForToken({ isCanceled });
        if (!hasToken || isCanceled()) return;

        try {
          const rows = await fetchWithRetries(
            () =>
              fetchMarkHistory({
                instrument_name: instrument.instrument_name,
                resolution,
                from,
                to,
                requestOptions: {
                  timeoutMs: REQUEST_TIMEOUT_MS,
                  maxRetries: 0,
                },
              }),
            { isCanceled },
          );
          if (isCanceled()) return;

          const series = buildInstrumentSeries({
            instrument,
            markRows: rows || [],
            indexByTs,
          });
          if (series) {
            optionSeries.value = [...optionSeries.value, series];
          }
        } catch (_error) {
          // Skip failed instrument fetches but keep progressive loading alive.
        } finally {
          if (!isCanceled()) {
            ui.loadedInstruments += 1;
          }
        }
      }
    };

    const workerCount = Math.min(optionUniverse.length, MARK_FETCH_CONCURRENCY);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (isCanceled()) return;

    if (!optionSeries.value.length) {
      ui.error =
        "No option mark histories could be aligned with index data for this selection.";
    }
  } catch (error) {
    if (isCanceled()) return;
    ui.error = error instanceof Error ? error.message : String(error);
    indexSeries.value = [];
    optionSeries.value = [];
  } finally {
    if (!isCanceled()) {
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

const startProgressiveDots = () => {
  if (progressiveDotsTimer) return;
  const sequence = [1, 2, 3, 0];
  let sequenceIndex = 0;
  progressiveDots.value = sequence[sequenceIndex];
  progressiveDotsTimer = setInterval(() => {
    sequenceIndex = (sequenceIndex + 1) % sequence.length;
    progressiveDots.value = sequence[sequenceIndex];
  }, 400);
};

const stopProgressiveDots = () => {
  if (progressiveDotsTimer) {
    clearInterval(progressiveDotsTimer);
    progressiveDotsTimer = null;
  }
  progressiveDots.value = 0;
};

const toggleSettings = () => {
  settingsOpen.value = !settingsOpen.value;
};

const handleDocumentPointerDown = (event) => {
  if (!settingsOpen.value) return;
  const target = event?.target;
  if (!(target instanceof Node)) return;
  if (!topSettingsMenuRef.value?.contains(target)) {
    settingsOpen.value = false;
  }
};

watch(
  () => [ui.optionType, ui.resolutionKey, maxPointsPerFetch.value],
  () => {
    scheduleLoad();
  },
);

watch(
  () => ui.loading,
  (isLoading) => {
    if (isLoading) startProgressiveDots();
    else stopProgressiveDots();
  },
  { immediate: true },
);

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  await loadSeries();
});

onUnmounted(() => {
  if (loadTimer) clearTimeout(loadTimer);
  stopProgressiveDots();
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
});
</script>

<template>
  <div class="appRoot">
    <header class="controlsRow">
      <div class="controlGroup">
        <span class="controlLabel">Type</span>
        <button
          type="button"
          class="pillButton"
          :class="{ pillButtonActive: ui.optionType === 'call' }"
          @click="ui.optionType = 'call'"
        >
          Calls
        </button>
        <button
          type="button"
          class="pillButton"
          :class="{ pillButtonActive: ui.optionType === 'put' }"
          @click="ui.optionType = 'put'"
        >
          Puts
        </button>
      </div>

      <div class="controlGroup">
        <label class="controlLabel" for="resolutionSelect">Resolution</label>
        <select
          id="resolutionSelect"
          class="selectControl"
          v-model="ui.resolutionKey"
        >
          <option
            v-for="option in RESOLUTION_OPTIONS"
            :key="option.key"
            :value="option.key"
          >
            {{ option.label }}
          </option>
        </select>
      </div>

    </header>

    <div class="statusRow" v-if="ui.loading || ui.error">
      <span v-if="ui.loading">{{ loadingLabel }}</span>
      <span v-else class="error">{{ ui.error }}</span>
    </div>

    <div class="chartBlock">
      <div class="settingsWrap settingsWrap--chart" ref="topSettingsMenuRef">
        <button
          class="settingsButton settingsButton--icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpen ? 'true' : 'false'"
          @click="toggleSettings"
        ></button>
        <div v-if="settingsOpen" class="settingsDropdown">
          <div class="settingsHint">
            Choose the number of data points to load: {{ maxPointsPerFetch }}
          </div>
          <input
            id="pointRange"
            v-model.number="ui.maxPoints"
            class="settingsSlider"
            type="range"
            :min="MIN_POINTS_PER_FETCH"
            :max="MAX_POINTS_PER_FETCH"
            step="10"
          />
          <div class="settingsRange">
            <span>{{ MIN_POINTS_PER_FETCH }}</span>
            <span>{{ MAX_POINTS_PER_FETCH }}</span>
          </div>
        </div>
      </div>

      <HorseRaceChart
        :index-data="indexSeries"
        :option-series="optionSeries"
        :option-type="ui.optionType"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
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
  gap: 12px;
}

.controlsRow {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  flex-wrap: wrap;
}

.controlGroup {
  display: flex;
  align-items: center;
  gap: 8px;
}

.controlLabel {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #a9abb6;
}

.pillButton {
  border: 1px solid #2a2f3b;
  background: #111723;
  color: #c9ceda;
  border-radius: 999px;
  height: 30px;
  min-width: 68px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.pillButtonActive {
  border-color: #2f855a;
  background: #163125;
  color: #8ad5a1;
}

.selectControl {
  border: 1px solid #2a2f3b;
  background: #111723;
  color: #d8dce8;
  border-radius: 8px;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
}

.chartBlock {
  width: min(100%, 1200px);
  position: relative;
}

.settingsWrap {
  position: relative;
}

.settingsButton {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(226, 232, 240, 0.7);
  cursor: pointer;
  box-shadow: none;
}

.settingsButton:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.settingsButton--icon {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}

.settingsButton--icon::before {
  content: "";
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #e8ebf2;
}

.settingsDropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 240px;
  border: 0.5px solid rgba(255, 255, 255, 0.9);
  background: #080a0f;
  border-radius: 6px;
  padding: 10px 12px 12px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
  z-index: 20;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}

.settingsWrap--chart {
  position: absolute;
  top: 5px;
  right: 40px;
  z-index: 25;
}

.settingsHint {
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  margin-bottom: 6px;
}

.settingsSlider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 14px;
  background: transparent;
  cursor: pointer;
}

.settingsSlider:focus {
  outline: none;
}

.settingsSlider::-webkit-slider-runnable-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.45);
  border-radius: 999px;
}

.settingsSlider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 8px;
  height: 8px;
  margin-top: -3px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}

.settingsSlider::-moz-range-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.45);
  border-radius: 999px;
}

.settingsSlider::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}

.settingsRange {
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
}

.statusRow {
  min-height: 20px;
  color: #9ea5bc;
  font-size: 13px;
}

.error {
  color: #ff8282;
}

@media (max-width: 900px) {
  .appRoot {
    padding: 18px 14px 20px;
  }

  .settingsWrap--chart {
    right: 12px;
  }
}
</style>
