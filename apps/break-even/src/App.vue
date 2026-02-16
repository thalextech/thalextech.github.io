<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import BreakEvenChart from "./components/BreakEvenChart.vue";
import {
  calcGreeks,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
};
const LOOKBACK_POINT_LIMIT = 360;
const SECONDS_PER_DAY = 24 * 60 * 60;
const MARK_FETCH_CONCURRENCY = 4;
const MARK_REQUEST_LAUNCH_JITTER_MS = 400;
const MARK_REQUEST_MAX_RETRIES = 2;
const MARK_REQUEST_RETRY_DELAY_MS = 1200;
const MARK_REQUEST_TIMEOUT_MS = 45_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ABS_DELTA = 0.55;
const STRIKE_MIN_INDEX_MULTIPLIER = 0.8;
const STRIKE_MAX_INDEX_MULTIPLIER = 1.2;

const ui = reactive({
  resolutionKey: "3600",
  optionMaturity: "",
  loading: false,
  error: "",
});

const data = reactive({
  optionInstruments: [],
  index: {},
  markByInstrument: {},
});

const chartRef = ref(null);
const isInitializing = ref(true);
let prefetchedIndexForInitialLoad = null;
let loadRequestId = 0;

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});
const priceFormatter = new Intl.NumberFormat("en-US", {
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

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  return {
    resolution,
    from: now - seconds * LOOKBACK_POINT_LIMIT,
    to: now,
  };
};

const getLatestIndexPoint = (rows) => {
  if (!Array.isArray(rows) || !rows.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close)) {
      return row;
    }
  }
  return null;
};

const getIndexCloseRange = (rows) => {
  let minClose = Infinity;
  let maxClose = -Infinity;
  for (const row of rows || []) {
    const close = Number(row?.index_price_close);
    if (!Number.isFinite(close)) continue;
    if (close < minClose) minClose = close;
    if (close > maxClose) maxClose = close;
  }
  if (!Number.isFinite(minClose) || !Number.isFinite(maxClose)) return null;
  return { minClose, maxClose };
};

const getStrikeBoundsFromIndexRows = (rows) => {
  const range = getIndexCloseRange(rows);
  if (!range) return null;
  return {
    minStrike: range.minClose * STRIKE_MIN_INDEX_MULTIPLIER,
    maxStrike: range.maxClose * STRIKE_MAX_INDEX_MULTIPLIER,
  };
};

const filterInstrumentsByStrikeBounds = (instruments, bounds) => {
  if (!bounds) return instruments || [];
  const minStrike = Number(bounds?.minStrike);
  const maxStrike = Number(bounds?.maxStrike);
  if (!Number.isFinite(minStrike) || !Number.isFinite(maxStrike)) {
    return instruments || [];
  }
  return (instruments || []).filter((instrument) => {
    const strike = Number(instrument?.strike);
    return (
      Number.isFinite(strike) && strike >= minStrike && strike <= maxStrike
    );
  });
};

const latestMarkValue = (row, fields) => {
  for (const field of fields) {
    const value = row?.[field];
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const getLatestMarkSnapshot = (rows) => {
  if (!Array.isArray(rows) || !rows.length) return null;
  let latestIv = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const iv = latestMarkValue(row, ["iv_close", "iv_open"]);
    if (Number.isFinite(iv)) {
      latestIv = iv;
      break;
    }
  }

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const ts = Number(row?.ts);
    const mark = Number(row?.mark_price_close);
    if (!Number.isFinite(ts) || !Number.isFinite(mark)) continue;
    const iv = latestMarkValue(row, ["iv_close", "iv_open"]);
    return {
      ts,
      mark,
      iv: Number.isFinite(iv) ? iv : latestIv,
    };
  }
  return null;
};

const getIntrinsicAtSpot = (optionType, strike, spot) => {
  if (optionType === "put") return Math.max(strike - spot, 0);
  return Math.max(spot - strike, 0);
};

const evolveMarkWithTheta = ({
  mark,
  optionType,
  strike,
  spot,
  iv,
  fromTs,
  toTs,
  expiryTs,
}) => {
  if (
    !Number.isFinite(mark) ||
    !Number.isFinite(fromTs) ||
    !Number.isFinite(toTs) ||
    !Number.isFinite(expiryTs)
  ) {
    return null;
  }

  const intrinsic = getIntrinsicAtSpot(optionType, strike, spot);
  let currentMark = Math.max(mark, intrinsic);
  let ts = fromTs;

  while (ts < toTs) {
    const remaining = expiryTs - ts;
    if (remaining <= 0) {
      currentMark = intrinsic;
      break;
    }

    const dtSeconds = Math.min(toTs - ts, remaining);
    let decay = null;

    if (Number.isFinite(iv) && iv > 0) {
      const theta = calcGreeks(
        spot,
        strike,
        Math.max(remaining, 1),
        iv,
        optionType,
      )?.theta;
      if (Number.isFinite(theta)) {
        decay = theta * (dtSeconds / SECONDS_PER_DAY);
      }
    }

    if (!Number.isFinite(decay)) {
      decay = ((intrinsic - currentMark) * dtSeconds) / remaining;
    }

    currentMark += decay;
    if (!Number.isFinite(currentMark) || currentMark < intrinsic) {
      currentMark = intrinsic;
    }
    ts += dtSeconds;
  }

  return Math.max(currentMark, intrinsic);
};

const buildBreakEvenForecast = ({
  optionType,
  strike,
  spot,
  markStart,
  iv,
  startTs,
  expiryTs,
  stepSeconds,
}) => {
  if (
    !Number.isFinite(strike) ||
    !Number.isFinite(spot) ||
    !Number.isFinite(markStart) ||
    !Number.isFinite(startTs) ||
    !Number.isFinite(expiryTs) ||
    !Number.isFinite(stepSeconds) ||
    stepSeconds <= 0
  ) {
    return [];
  }

  const points = [];
  let ts = Math.min(startTs, expiryTs);
  let mark = markStart;

  const pushPoint = () => {
    const breakEven = optionType === "put" ? strike - mark : strike + mark;
    const move = breakEven - spot;
    points.push({
      ts,
      date: new Date(ts * 1000),
      mark,
      iv,
      breakEven,
      move,
      movePct: spot !== 0 ? move / spot : null,
    });
  };

  pushPoint();

  let guard = 0;
  while (ts < expiryTs && guard < 25000) {
    const nextTs = Math.min(expiryTs, ts + stepSeconds);
    const nextMark = evolveMarkWithTheta({
      mark,
      optionType,
      strike,
      spot,
      iv,
      fromTs: ts,
      toTs: nextTs,
      expiryTs,
    });
    if (!Number.isFinite(nextMark)) break;

    ts = nextTs;
    mark = nextMark;
    pushPoint();
    guard += 1;
  }

  return points;
};

const buildHistoricalBreakEvenPoints = ({
  markRows,
  optionType,
  strike,
  spot,
  maxTs,
}) => {
  return (markRows || [])
    .filter(
      (row) =>
        Number.isFinite(row?.ts) &&
        Number.isFinite(row?.mark_price_close) &&
        row.ts <= maxTs,
    )
    .sort((a, b) => a.ts - b.ts)
    .map((row) => {
      const mark = row.mark_price_close;
      const rowIv = latestMarkValue(row, ["iv_close", "iv_open"]);
      const breakEven = optionType === "put" ? strike - mark : strike + mark;
      const move = breakEven - spot;
      return {
        ts: row.ts,
        date: new Date(row.ts * 1000),
        mark,
        iv: Number.isFinite(rowIv) ? rowIv : null,
        breakEven,
        move,
        movePct: spot !== 0 ? move / spot : null,
      };
    });
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
  const byStrikeAndType = new Map();

  for (const instrument of data.optionInstruments) {
    if (instrument?.expiration_ts !== maturityTs) continue;
    const strike = instrument?.strike;
    const optionType = instrument?.option_type_normalized;
    if (!Number.isFinite(strike)) continue;
    if (optionType !== "call" && optionType !== "put") continue;

    const key = `${optionType}:${strike}`;
    const existing = byStrikeAndType.get(key);
    if (!existing) {
      byStrikeAndType.set(key, instrument);
      continue;
    }

    const candidateCreated = Number(instrument?.create_time_s);
    const existingCreated = Number(existing?.create_time_s);
    if (
      Number.isFinite(candidateCreated) &&
      (!Number.isFinite(existingCreated) || candidateCreated < existingCreated)
    ) {
      byStrikeAndType.set(key, instrument);
    }
  }

  return Array.from(byStrikeAndType.values()).sort((a, b) => a.strike - b.strike);
});

const currentIndexRows = computed(() => data.index[ui.resolutionKey] || []);
const strikeBoundsForCurrentIndex = computed(() =>
  getStrikeBoundsFromIndexRows(currentIndexRows.value),
);

const latestIndexPoint = computed(() => getLatestIndexPoint(currentIndexRows.value));
const latestSpot = computed(() => latestIndexPoint.value?.index_price_close ?? null);
const latestSpotTs = computed(() => latestIndexPoint.value?.ts ?? null);
const chartIndexData = computed(() =>
  (currentIndexRows.value || [])
    .filter(
      (row) =>
        Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close),
    )
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      ts: row.ts,
      date: new Date(row.ts * 1000),
      value: row.index_price_close,
    })),
);
const chartIndexProjectedData = computed(() => {
  const actual = chartIndexData.value;
  const expiryTs = selectedMaturityTs.value;
  if (!actual.length || !Number.isFinite(expiryTs)) return [];
  const last = actual[actual.length - 1];
  const expiryDate = new Date(expiryTs * 1000);
  if (!(expiryDate > last.date)) return [];
  return [
    { ts: last.ts, date: last.date, value: last.value },
    { ts: expiryTs, date: expiryDate, value: last.value },
  ];
});

const boundedOptionInstrumentsForMaturity = computed(() =>
  filterInstrumentsByStrikeBounds(
    optionInstrumentsForMaturity.value,
    strikeBoundsForCurrentIndex.value,
  ),
);

const breakEvenTracks = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  const spot = latestSpot.value;
  const spotTs = latestSpotTs.value;
  const stepSeconds =
    RESOLUTION_CONFIG[ui.resolutionKey]?.interval_seconds ??
    Number(ui.resolutionKey) ??
    0;

  if (
    !Number.isFinite(expiryTs) ||
    !Number.isFinite(spot) ||
    !Number.isFinite(spotTs) ||
    !Number.isFinite(stepSeconds) ||
    stepSeconds <= 0
  ) {
    return [];
  }

  const tracks = [];

  for (const instrument of boundedOptionInstrumentsForMaturity.value) {
    const optionType = instrument.option_type_normalized;
    const strike = instrument.strike;
    const instrumentName = instrument.instrument_name;
    const markRows = data.markByInstrument[instrumentName] || [];
    const snapshot = getLatestMarkSnapshot(markRows);
    if (!snapshot) continue;

    const anchorTs = Math.max(spotTs, snapshot.ts);
    if (!Number.isFinite(anchorTs) || anchorTs > expiryTs) continue;
    const tteSeconds = Math.max(expiryTs - anchorTs, 1);
    const delta = calcGreeks(
      spot,
      strike,
      tteSeconds,
      snapshot.iv,
      optionType,
    )?.delta;
    if (!Number.isFinite(delta) || Math.abs(delta) >= MAX_ABS_DELTA) continue;
    const isOutOfMoney =
      optionType === "call" ? strike >= spot : strike <= spot;
    if (!isOutOfMoney) continue;

    let markAtAnchor = snapshot.mark;
    if (snapshot.ts < anchorTs) {
      markAtAnchor = evolveMarkWithTheta({
        mark: snapshot.mark,
        optionType,
        strike,
        spot,
        iv: snapshot.iv,
        fromTs: snapshot.ts,
        toTs: anchorTs,
        expiryTs,
      });
    }
    if (!Number.isFinite(markAtAnchor)) continue;

    const projectedPoints = buildBreakEvenForecast({
      optionType,
      strike,
      spot,
      markStart: markAtAnchor,
      iv: snapshot.iv,
      startTs: anchorTs,
      expiryTs,
      stepSeconds,
    });

    if (!projectedPoints.length) continue;
    const historicalPoints = buildHistoricalBreakEvenPoints({
      markRows,
      optionType,
      strike,
      spot,
      maxTs: anchorTs,
    });
    const points = historicalPoints.slice();
    const lastHistoricalTs = points.length ? points[points.length - 1].ts : null;
    for (const point of projectedPoints) {
      if (Number.isFinite(lastHistoricalTs) && point.ts === lastHistoricalTs) {
        continue;
      }
      points.push(point);
    }
    if (!points.length) continue;

    tracks.push({
      instrumentName,
      optionType,
      strike,
      referenceIv: snapshot.iv,
      points,
    });
  }

  return tracks.sort((a, b) => {
    if (a.strike !== b.strike) return a.strike - b.strike;
    if (a.optionType === b.optionType) return 0;
    return a.optionType === "call" ? -1 : 1;
  });
});

const breakEvenTitle = "BTC Option Break-Even Forecast";
const breakEvenSubtitle = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  if (!Number.isFinite(expiryTs)) return "";
  const resolutionLabel = RESOLUTION_CONFIG[ui.resolutionKey]?.label || "";
  return `Expiry: ${maturityFormatter.format(new Date(expiryTs * 1000))} UTC | Resolution: ${resolutionLabel} | OTM, |delta| < ${MAX_ABS_DELTA.toFixed(2)}`;
});

const canSavePng = computed(() => breakEvenTracks.value.length > 0);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRetryableRequestError = (error) => {
  if (!error) return false;
  if (RETRYABLE_STATUS.has(Number(error?.status))) return true;
  if (error?.name === "AbortError") return true;
  return error instanceof TypeError;
};

async function fetchWithRetries(
  fetcher,
  { maxRetries = MARK_REQUEST_MAX_RETRIES, isCanceled = null } = {},
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
      await sleep(MARK_REQUEST_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError || new Error("Request failed");
}

async function fetchMarkHistoriesByInstrument({
  instruments,
  resolution,
  from,
  to,
  requestId,
  onInstrumentRows = null,
}) {
  const queue = (instruments || []).filter(
    (instrument) => typeof instrument?.instrument_name === "string",
  );

  if (!queue.length) {
    return { rowsByInstrument: {}, rateLimitedCount: 0 };
  }

  const rowsByInstrument = {};
  let rateLimitedCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      if (requestId !== loadRequestId) return;
      const currentIndex = cursor;
      cursor += 1;
      const instrument = queue[currentIndex];
      const instrumentName = instrument.instrument_name;
      const jitterMs = Math.floor(
        Math.random() * (MARK_REQUEST_LAUNCH_JITTER_MS + 1),
      );
      if (jitterMs > 0) {
        await sleep(jitterMs);
      }

      let rows = [];
      try {
        const fetchedRows = await fetchWithRetries(
          () =>
            fetchMarkHistory({
              instrument_name: instrumentName,
              resolution,
              from,
              to,
              requestOptions: {
                timeoutMs: MARK_REQUEST_TIMEOUT_MS,
                maxRetries: 0,
              },
            }),
          { isCanceled: () => requestId !== loadRequestId },
        );
        rows = Array.isArray(fetchedRows) ? fetchedRows : [];
        if (requestId !== loadRequestId) return;
      } catch (error) {
        if (requestId !== loadRequestId) return;
        if (error?.status === 429) {
          rateLimitedCount += 1;
        }
        rows = [];
      }

      rowsByInstrument[instrumentName] = rows;
      onInstrumentRows?.(rows, {
        instrumentName,
        index: currentIndex,
        total: queue.length,
      });
    }
  };

  const workerCount = Math.min(MARK_FETCH_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { rowsByInstrument, rateLimitedCount };
}

async function load() {
  const maturityTs = selectedMaturityTs.value;
  if (!Number.isFinite(maturityTs)) return;

  const requestId = ++loadRequestId;
  ui.loading = true;
  ui.error = "";

  const maturityInstruments = optionInstrumentsForMaturity.value;
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
    const indexPromise = prefetchedIndex
      ? Promise.resolve(prefetchedIndex)
      : fetchIndexHistory({
          index_name: "BTCUSD",
          resolution,
          from,
          to,
        });

    const indexRows = await indexPromise;
    if (requestId !== loadRequestId) return;
    const normalizedIndexRows = Array.isArray(indexRows) ? indexRows : [];
    const strikeBounds = getStrikeBoundsFromIndexRows(normalizedIndexRows);
    const boundedMaturityInstruments = filterInstrumentsByStrikeBounds(
      maturityInstruments,
      strikeBounds,
    );
    data.index[ui.resolutionKey] = normalizedIndexRows;
    data.markByInstrument = {};

    const { rowsByInstrument, rateLimitedCount } =
      await fetchMarkHistoriesByInstrument({
      instruments: boundedMaturityInstruments,
      resolution,
      from,
      to,
      requestId,
      onInstrumentRows: (rows, { instrumentName }) => {
        if (requestId !== loadRequestId) return;
        data.markByInstrument[instrumentName] = rows;
      },
    });

    if (requestId !== loadRequestId) return;

    data.markByInstrument = rowsByInstrument || {};
    if (rateLimitedCount > 0) {
      ui.error = `Rate limited by Thalex (429) on ${rateLimitedCount} instrument request(s). Data streamed partially; try again in a moment for full coverage.`;
    }
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    data.index = {};
    data.markByInstrument = {};
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const expiryTs = selectedMaturityTs.value;
  const datePart = Number.isFinite(expiryTs)
    ? new Date(expiryTs * 1000).toISOString().slice(0, 10)
    : "expiry";
  chartRef.value.exportPng({
    filename: `break-even-${datePart}-${ui.resolutionKey}.png`,
  });
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
      .filter((instrument) => instrument?.type === "option")
      .filter((instrument) => instrument?.underlying === "BTCUSD")
      .map(normalizeOptionInstrument)
      .sort(
        (a, b) =>
          (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
          (a.strike || 0) - (b.strike || 0),
      );

    data.index[ui.resolutionKey] = Array.isArray(prefetchedIndex)
      ? prefetchedIndex
      : [];
    prefetchedIndexForInitialLoad = {
      resolutionKey: ui.resolutionKey,
      rows: Array.isArray(prefetchedIndex) ? prefetchedIndex : [],
    };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const oneWeekAhead = nowSeconds + 7 * 24 * 60 * 60;
    const expiries = optionMaturities.value
      .map((option) => Number(option.value))
      .filter((ts) => Number.isFinite(ts));
    const upcomingExpiries = expiries.filter((ts) => ts > nowSeconds);
    const candidateExpiries = upcomingExpiries.length ? upcomingExpiries : expiries;
    const closestExpiry = candidateExpiries.reduce((best, ts) => {
      if (!Number.isFinite(best)) return ts;
      const bestDistance = Math.abs(best - oneWeekAhead);
      const currentDistance = Math.abs(ts - oneWeekAhead);
      return currentDistance < bestDistance ? ts : best;
    }, NaN);

    if (Number.isFinite(closestExpiry)) {
      ui.optionMaturity = String(closestExpiry);
    }
  } finally {
    isInitializing.value = false;
    if (ui.optionMaturity) {
      await load();
    }
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
  () => [ui.resolutionKey, ui.optionMaturity],
  async () => {
    if (isInitializing.value) return;
    if (!ui.optionMaturity) return;
    await load();
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Break-even Analyzer</h1>
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
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <BreakEvenChart
      ref="chartRef"
      :tracks="breakEvenTracks"
      :index-data="chartIndexData"
      :index-projected-data="chartIndexProjectedData"
      :spot-price="latestSpot"
      :spot-ts="latestSpotTs"
      :expiry-ts="selectedMaturityTs"
      :title="breakEvenTitle"
      :subtitle="breakEvenSubtitle"
      :loading="ui.loading"
    />
  </div>
</template>
