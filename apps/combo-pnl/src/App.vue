<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import PositionBuilder from "../../simulator/src/components/PositionBuilder.vue";
import IndexMarkComboChart from "./components/Chart.vue";
import {
  computeGreeksPnlSeries,
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
const RESOLUTION_OPTIONS = Object.entries(RESOLUTION_CONFIG).map(
  ([key, cfg]) => ({
    key,
    label: cfg.label,
  }),
);
const DEFAULT_MAX_POINTS_PER_FETCH = 360;
const MIN_POINTS_PER_FETCH = 100;
const MAX_POINTS_PER_FETCH = 10000;
const DEFAULT_VOL = 0.4;
const DEFAULT_T = 30 / 365.25;
const MARK_CONCURRENCY = 10;
const LOAD_DEBOUNCE_MS = 140;

const ui = reactive({
  resolutionKey: "900",
  maxPoints: DEFAULT_MAX_POINTS_PER_FETCH,
  deltaHedgeEnabled: false,
  showHigherOrderGreeks: false,
  loading: false,
  error: "",
});

const positionLegs = ref([]);

const instruments = ref([]);
const tickerByInstrument = ref({});
const indexByName = ref({});
const indexSeries = ref([]);
const comboBaseSeries = ref([]);
const comboSeries = ref([]);
const indexHistoryRows = ref([]);
const markHistoryByInstrument = ref({});
const chartAnchorTs = ref(null);
const chartBlockRef = ref(null);
const topSettingsMenuRef = ref(null);
const bottomSettingsMenuRef = ref(null);
const settingsOpenTarget = ref(null);
const settingsLeftPx = ref(null);

let loadRequestId = 0;
let loadTimer = null;

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

const formatExpiryFromTs = (expiryTs) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Number(expiryTs) * 1000));

const newLegId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `leg_${Math.random().toString(36).slice(2, 10)}`;
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
    const side = String(leg.side || "buy").toLowerCase();
    const isSell = side === "sell";
    const sideSign = isSell ? -1 : 1;
    result.push({
      label: `${isSell ? "Sell" : "Buy"} ${qty} ${instrument.instrument_name}`,
      instrumentName: instrument.instrument_name,
      signedQty: sideSign * qty,
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

const pickNearestStrike = (strikes, targetPrice) => {
  if (!strikes?.length) return null;
  let chosenStrike = Number(strikes[0]);
  let bestDistance = Math.abs(chosenStrike - targetPrice);
  for (let i = 1; i < strikes.length; i += 1) {
    const strike = Number(strikes[i]);
    const distance = Math.abs(strike - targetPrice);
    if (distance < bestDistance || (distance === bestDistance && strike < chosenStrike)) {
      chosenStrike = strike;
      bestDistance = distance;
    }
  }
  return chosenStrike;
};

const seedDefaultLegs = () => {
  if (selectedOptionLegs.value.length) return;
  const options = parsedOptionInstruments.value;
  if (!options.length) return;

  const now = Math.floor(Date.now() / 1000);
  const target = now + Math.max(1, Math.round(DEFAULT_T * 365.25)) * 24 * 60 * 60;
  const upcoming = options.filter((instrument) => instrument.expiration_ts > now);
  const source = upcoming.length ? upcoming : options;
  const expiries = Array.from(
    new Set(source.map((instrument) => instrument.expiration_ts)),
  ).sort((a, b) => a - b);
  if (!expiries.length) return;

  let chosenExpiry = expiries[0];
  let bestDiff = Math.abs(chosenExpiry - target);
  for (const expiryTs of expiries) {
    const diff = Math.abs(expiryTs - target);
    if (diff < bestDiff) {
      chosenExpiry = expiryTs;
      bestDiff = diff;
    }
  }

  const forExpiry = source.filter(
    (instrument) => instrument.expiration_ts === chosenExpiry,
  );
  const callStrikes = Array.from(
    new Set(
      forExpiry
        .filter((instrument) => instrument.option_type_normalized === "call")
        .map((instrument) => instrument.strike),
    ),
  ).sort((a, b) => a - b);
  const putStrikes = Array.from(
    new Set(
      forExpiry
        .filter((instrument) => instrument.option_type_normalized === "put")
        .map((instrument) => instrument.strike),
    ),
  ).sort((a, b) => a - b);
  const fallbackStrikes = Array.from(
    new Set(forExpiry.map((instrument) => instrument.strike)),
  ).sort((a, b) => a - b);

  const referenceSpot = spot.value;
  const callStrike = pickNearestStrike(
    callStrikes.length ? callStrikes : fallbackStrikes,
    referenceSpot,
  );
  const putStrike = pickNearestStrike(
    putStrikes.length ? putStrikes : fallbackStrikes,
    referenceSpot,
  );
  if (!Number.isFinite(callStrike) || !Number.isFinite(putStrike)) return;

  const expiryLabel = formatExpiryFromTs(chosenExpiry);
  positionLegs.value = [
    {
      id: newLegId(),
      kind: "option",
      side: "buy",
      qty: 1,
      optionType: "call",
      strike: callStrike,
      premium: 0,
      expiry: expiryLabel,
    },
    {
      id: newLegId(),
      kind: "option",
      side: "buy",
      qty: 1,
      optionType: "put",
      strike: putStrike,
      premium: 0,
      expiry: expiryLabel,
    },
  ];
};

const maxPointsPerFetch = computed(() => {
  const points = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(points)) return DEFAULT_MAX_POINTS_PER_FETCH;
  return Math.max(MIN_POINTS_PER_FETCH, Math.min(MAX_POINTS_PER_FETCH, points));
});

const activeResolutionConfig = computed(
  () => RESOLUTION_CONFIG[ui.resolutionKey] || null,
);

const activeResolutionSeconds = computed(() => {
  const fromConfig = Number(activeResolutionConfig.value?.interval_seconds);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromKey = Number(ui.resolutionKey);
  if (Number.isFinite(fromKey) && fromKey > 0) return fromKey;
  return 900;
});

const activeResolutionLabel = computed(() => {
  const label = activeResolutionConfig.value?.label;
  if (label) return label;
  const seconds = activeResolutionSeconds.value;
  return Number.isFinite(seconds) && seconds > 0 ? `${seconds}s` : "n/a";
});

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 900;
  // Align to the candle grid so each resolution fetches a consistent count.
  const to = now - (now % safeSeconds);
  return {
    resolution,
    from: to - safeSeconds * (maxPointsPerFetch.value - 1),
    to,
  };
};

const toggleSettings = (target) => {
  settingsOpenTarget.value =
    settingsOpenTarget.value === target ? null : target;
};

const alignSettingsToBuilderMinusX = () => {
  const chartBlockEl = chartBlockRef.value;
  if (!chartBlockEl) return;
  const chartRect = chartBlockEl.getBoundingClientRect();
  const removeBtn = document.querySelector(".builderMain .remove-btn");
  if (!(removeBtn instanceof HTMLElement)) return;
  const removeRect = removeBtn.getBoundingClientRect();
  const centeredLeft =
    removeRect.left - chartRect.left + (removeRect.width - 22) / 2;
  if (!Number.isFinite(centeredLeft)) return;
  settingsLeftPx.value = Math.round(centeredLeft);
};

const settingsWrapStyle = computed(() => {
  if (!Number.isFinite(settingsLeftPx.value)) return {};
  return {
    left: `${settingsLeftPx.value}px`,
    right: "auto",
  };
});

const handleDocumentPointerDown = (event) => {
  if (!settingsOpenTarget.value) return;
  const target = event?.target;
  if (!(target instanceof Node)) return;
  const activeMenuRef =
    settingsOpenTarget.value === "bottom"
      ? bottomSettingsMenuRef.value
      : topSettingsMenuRef.value;
  if (!activeMenuRef?.contains(target)) {
    settingsOpenTarget.value = null;
  }
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

const loadInitialAnchoredIndexSnapshot = async () => {
  try {
    const { resolution, from, to } = getTimestampRange();
    const rows = await fetchIndexHistory({
      index_name: "BTCUSD",
      resolution,
      from,
      to,
    });
    const sorted = sortRowsByTs(rows);
    if (!sorted.length) return;
    indexHistoryRows.value = sorted;
    const anchored = sorted[0];
    const price = Number(
      anchored?.index_price_close ?? anchored?.close ?? anchored?.price,
    );
    if (!Number.isFinite(price)) return;
    const ts = normalizeTimestampSeconds(anchored?.ts);
    indexByName.value = {
      BTCUSD: {
        data: {
          ...anchored,
          index_price_close: price,
          ts: Number.isFinite(ts) ? ts : anchored.ts,
        },
        fetchedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
      },
    };
  } catch {
    // Non-fatal: if snapshot fetch fails, seedDefaultLegs falls back to spot.
  }
};

const getAnchorRow = (rows, anchorTs) => {
  if (!rows?.length) return null;
  if (!Number.isFinite(anchorTs)) return rows[0] ?? null;
  const normalizedAnchorTs = normalizeTimestampSeconds(anchorTs);
  if (!Number.isFinite(normalizedAnchorTs)) return rows[0] ?? null;
  const firstAtOrAfter = rows.find(
    (row) => normalizeTimestampSeconds(row?.ts) >= normalizedAnchorTs,
  );
  return firstAtOrAfter ?? rows[rows.length - 1] ?? null;
};

const resolveEffectiveAnchorTs = () => {
  const explicitAnchor = normalizeTimestampSeconds(chartAnchorTs.value);
  if (Number.isFinite(explicitAnchor)) return explicitAnchor;
  const firstIndexTs = normalizeTimestampSeconds(
    indexHistoryRows.value?.[0]?.ts,
  );
  return Number.isFinite(firstIndexTs) ? firstIndexTs : null;
};

const rebuildBuilderSnapshots = () => {
  const nextTickerByInstrument = {};
  const effectiveAnchorTs = resolveEffectiveAnchorTs();

  for (const instrumentName of selectedInstrumentNames.value) {
    const rows = markHistoryByInstrument.value[instrumentName] || [];
    const row = getAnchorRow(rows, effectiveAnchorTs);
    if (!row) continue;
    const ts = normalizeTimestampSeconds(row?.ts);
    const markClose = Number(
      row?.mark_price_close ?? row?.close ?? row?.mark_price,
    );
    const ivClose = Number(
      row?.iv_close ?? row?.iv ?? row?.mark_iv ?? row?.implied_volatility,
    );
    const data = { ...row };
    if (Number.isFinite(ts)) data.ts = ts;
    if (Number.isFinite(markClose)) data.mark_price_close = markClose;
    if (Number.isFinite(ivClose)) data.iv_close = ivClose;
    nextTickerByInstrument[instrumentName] = {
      data,
      fetchedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
    };
  }
  tickerByInstrument.value = nextTickerByInstrument;

  const indexName = activeIndexName.value;
  if (!indexName) {
    indexByName.value = {};
    return;
  }
  const indexRow = getAnchorRow(indexHistoryRows.value, effectiveAnchorTs);
  const indexClose = Number(
    indexRow?.index_price_close ?? indexRow?.close ?? indexRow?.price,
  );
  const indexTs = normalizeTimestampSeconds(indexRow?.ts);
  if (indexRow && Number.isFinite(indexClose)) {
    indexByName.value = {
      [indexName]: {
        data: {
          ...indexRow,
          index_price_close: indexClose,
          ts: Number.isFinite(indexTs) ? indexTs : indexRow?.ts,
        },
        fetchedAt: Number.isFinite(indexTs) ? indexTs * 1000 : Date.now(),
      },
    };
  } else {
    indexByName.value = {};
  }
};

const applyTimeBasedDeltaHedge = (rows, intervalSeconds) => {
  const points = Array.isArray(rows) ? rows : [];
  const safeInterval = Number(intervalSeconds);
  const nextRows = points.map((row) => ({
    ...row,
    hedge_PL: 0,
    hedge_cumulative_PL: 0,
    hedge_realized_cumulative: 0,
    hedge_unrealized: 0,
    hedged_mark_price_close: Number(row?.mark_price_close),
    hedge_ratio: null,
    hedge_rehedge: false,
  }));

  let hedgePosition = 0;
  let avgEntryPrice = null;
  let lastRehedgeTs = null;
  let realizedHedgePnl = 0;
  let prevTotalHedgePnl = 0;

  for (let i = 0; i < nextRows.length; i += 1) {
    const row = nextRows[i];
    const indexClose = Number(row?.index_price_close);
    const combinedDelta = Number(row?.combined_delta);
    const shouldRehedge =
      Number.isFinite(indexClose) &&
      Number.isFinite(combinedDelta) &&
      (i === 0 ||
        !Number.isFinite(lastRehedgeTs) ||
        !Number.isFinite(safeInterval) ||
        safeInterval <= 0 ||
        row.ts - lastRehedgeTs >= safeInterval);

    if (shouldRehedge) {
      const targetPosition = -combinedDelta;
      const tradeQty = targetPosition - hedgePosition;
      const hasTrade = Math.abs(tradeQty) > 1e-12;

      if (hasTrade) {
        const hasOpenPosition = Math.abs(hedgePosition) > 1e-12;
        const sameDirection = hasOpenPosition && hedgePosition * tradeQty > 0;

        if (!hasOpenPosition || sameDirection) {
          const entryPrice = Number.isFinite(avgEntryPrice)
            ? avgEntryPrice
            : indexClose;
          const prevNotional = hasOpenPosition
            ? Math.abs(hedgePosition) * entryPrice
            : 0;
          const nextQtyAbs = Math.abs(hedgePosition + tradeQty);
          const nextNotional = prevNotional + Math.abs(tradeQty) * indexClose;
          avgEntryPrice = nextQtyAbs > 0 ? nextNotional / nextQtyAbs : null;
          hedgePosition += tradeQty;
        } else {
          const closingQty = Math.min(Math.abs(hedgePosition), Math.abs(tradeQty));
          const entryPrice = Number.isFinite(avgEntryPrice)
            ? avgEntryPrice
            : indexClose;

          if (hedgePosition > 0) {
            realizedHedgePnl += closingQty * (indexClose - entryPrice);
          } else {
            realizedHedgePnl += closingQty * (entryPrice - indexClose);
          }

          const remainingQtyAbs = Math.abs(tradeQty) - closingQty;
          if (remainingQtyAbs <= 1e-12) {
            hedgePosition += tradeQty;
            if (Math.abs(hedgePosition) <= 1e-12) {
              hedgePosition = 0;
              avgEntryPrice = null;
            }
          } else {
            hedgePosition = Math.sign(tradeQty) * remainingQtyAbs;
            avgEntryPrice = indexClose;
          }
        }
      }

      lastRehedgeTs = row.ts;
      row.hedge_ratio = hedgePosition;
      row.hedge_rehedge = true;
    }

    const unrealizedHedgePnl =
      Number.isFinite(indexClose) &&
      Math.abs(hedgePosition) > 1e-12 &&
      Number.isFinite(avgEntryPrice)
        ? hedgePosition * (indexClose - avgEntryPrice)
        : 0;
    const totalHedgePnl = realizedHedgePnl + unrealizedHedgePnl;
    const periodHedgePnl = i === 0 ? 0 : totalHedgePnl - prevTotalHedgePnl;
    prevTotalHedgePnl = totalHedgePnl;

    row.hedge_PL = periodHedgePnl;
    row.hedge_unrealized = unrealizedHedgePnl;
    row.hedge_realized_cumulative = realizedHedgePnl;
    row.hedge_cumulative_PL = totalHedgePnl;

    const optionMark = Number(row?.mark_price_close);
    row.hedged_mark_price_close = Number.isFinite(optionMark)
      ? optionMark + totalHedgePnl
      : totalHedgePnl;

    const optionPL = Number(row?.PL);
    row.PL = Number.isFinite(optionPL) ? optionPL + periodHedgePnl : periodHedgePnl;
  }

  return nextRows;
};

const rebuildDisplayedComboSeries = () => {
  comboSeries.value = ui.deltaHedgeEnabled
    ? applyTimeBasedDeltaHedge(
        comboBaseSeries.value,
        activeResolutionSeconds.value,
      )
    : [...comboBaseSeries.value];
};

const loadSeries = async () => {
  const requestId = ++loadRequestId;

  if (hasUnsupportedLegs.value) {
    ui.error = "Only option legs are supported in Option Strike.";
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
    return;
  }

  const selected = selectedLegInstruments.value;
  if (!selected.length) {
    ui.error = "";
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
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

    indexHistoryRows.value = sortRowsByTs(indexRows);
    const sortedMarkByInstrument = {};
    for (const [instrumentName, rows] of Object.entries(markByInstrument)) {
      sortedMarkByInstrument[instrumentName] = sortRowsByTs(rows);
    }
    markHistoryByInstrument.value = sortedMarkByInstrument;
    rebuildBuilderSnapshots();

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
          const ivClose = Number(row?.iv_close);
          if (!Number.isFinite(ts) || !Number.isFinite(markClose)) continue;
          map.set(ts, {
            markClose,
            ivClose: Number.isFinite(ivClose) ? ivClose : null,
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
      comboBaseSeries.value = [];
      comboSeries.value = [];
      ui.error = "Missing mark history for one or more selected legs.";
      rebuildBuilderSnapshots();
      return;
    }

    const baseTs = Array.from(legSeries[0].byTs.keys()).sort((a, b) => a - b);
    const top = [];
    const bottom = [];

    for (const ts of baseTs) {
      if (!legSeries.every((entry) => entry.byTs.has(ts))) continue;
      const indexRow = indexByTs.get(ts);
      const indexClose = Number(indexRow?.index_price_close);
      if (!Number.isFinite(indexClose)) continue;

      let totalMark = 0;
      let ivSum = 0;
      let ivCount = 0;
      let totalPL = 0;
      let totalDeltaPL = 0;
      let totalGammaThetaPL = 0;
      let totalVegaPL = 0;
      let totalVannaPL = 0;
      let totalCharmPL = 0;
      let totalVommaPL = 0;
      let totalResidualPL = 0;
      let totalCombinedDelta = 0;
      let totalCombinedGamma = 0;
      let hasPL = false;
      let hasDeltaPL = false;
      let hasGammaThetaPL = false;
      let hasVegaPL = false;
      let hasVannaPL = false;
      let hasCharmPL = false;
      let hasVommaPL = false;
      let hasResidualPL = false;
      let hasCombinedDelta = false;
      let hasCombinedGamma = false;
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
        if (Number.isFinite(legPnlPoint?.vanna_PL)) {
          totalVannaPL += signedQty * Number(legPnlPoint.vanna_PL);
          hasVannaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.charm_PL)) {
          totalCharmPL += signedQty * Number(legPnlPoint.charm_PL);
          hasCharmPL = true;
        }
        if (Number.isFinite(legPnlPoint?.vomma_PL)) {
          totalVommaPL += signedQty * Number(legPnlPoint.vomma_PL);
          hasVommaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.residual_PL)) {
          totalResidualPL += signedQty * Number(legPnlPoint.residual_PL);
          hasResidualPL = true;
        }
        if (Number.isFinite(legPnlPoint?.delta)) {
          totalCombinedDelta += signedQty * Number(legPnlPoint.delta);
          hasCombinedDelta = true;
        }
        if (Number.isFinite(legPnlPoint?.gamma)) {
          totalCombinedGamma += signedQty * Number(legPnlPoint.gamma);
          hasCombinedGamma = true;
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

      bottom.push({
        ts,
        date,
        index_price_close: indexClose,
        mark_price_close: totalMark,
        iv_close: ivClose,
        PL: hasPL ? totalPL : null,
        delta_PL: hasDeltaPL ? totalDeltaPL : null,
        gamma_theta_PL: hasGammaThetaPL ? totalGammaThetaPL : null,
        vega_PL: hasVegaPL ? totalVegaPL : null,
        vanna_PL: hasVannaPL ? totalVannaPL : null,
        charm_PL: hasCharmPL ? totalCharmPL : null,
        vomma_PL: hasVommaPL ? totalVommaPL : null,
        residual_PL: hasResidualPL ? totalResidualPL : null,
        combined_delta: hasCombinedDelta ? totalCombinedDelta : null,
        combined_gamma: hasCombinedGamma ? totalCombinedGamma : null,
      });
    }

    indexSeries.value = top;
    comboBaseSeries.value = bottom;
    rebuildDisplayedComboSeries();

    if (!indexSeries.value.length || !comboSeries.value.length) {
      ui.error = "No overlapping index/mark history for selected legs.";
    }
    rebuildBuilderSnapshots();
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
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

watch(
  () => [ui.resolutionKey, maxPointsPerFetch.value, positionLegs.value],
  () => {
    scheduleLoad();
  },
  { deep: true },
);

watch(
  () => [ui.deltaHedgeEnabled, activeResolutionSeconds.value],
  () => {
    rebuildDisplayedComboSeries();
  },
);

watch(
  () => [
    chartAnchorTs.value,
    selectedInstrumentNames.value,
    activeIndexName.value,
    indexHistoryRows.value,
    markHistoryByInstrument.value,
  ],
  () => {
    rebuildBuilderSnapshots();
  },
  { deep: true },
);

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  window.addEventListener("resize", alignSettingsToBuilderMinusX);
  const allInstruments = await fetchAllInstruments();
  instruments.value = (allInstruments || []).filter(
    (instrument) =>
      instrument?.type === "option" && instrument?.underlying === "BTCUSD",
  );

  await loadInitialAnchoredIndexSnapshot();
  seedDefaultLegs();
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  await loadSeries();
  await nextTick();
  alignSettingsToBuilderMinusX();
});

onUnmounted(() => {
  if (loadTimer) clearTimeout(loadTimer);
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  window.removeEventListener("resize", alignSettingsToBuilderMinusX);
});

watch(
  () => positionLegs.value,
  async () => {
    await nextTick();
    alignSettingsToBuilderMinusX();
  },
  { deep: true },
);
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
        >
          <template #footer-actions>
            <button
              type="button"
              class="deltaHedgeButton"
              :class="{ deltaHedgeButtonActive: ui.deltaHedgeEnabled }"
              :title="`Rebalance every ${activeResolutionLabel}`"
              @click="ui.deltaHedgeEnabled = !ui.deltaHedgeEnabled"
            >
              {{ ui.deltaHedgeEnabled ? "− Delta hedge" : "+ Delta hedge" }}
            </button>
          </template>
        </PositionBuilder>
      </div>
    </div>

    <div class="statusRow" v-if="ui.loading || ui.error">
      <span v-if="ui.loading">Loading mark history...</span>
      <span v-else class="error">{{ ui.error }}</span>
    </div>

    <div class="chartBlock" ref="chartBlockRef">
      <div
        class="settingsWrap settingsWrap--chart"
        ref="topSettingsMenuRef"
        :style="settingsWrapStyle"
      >
        <button
          class="settingsButton settingsButton--icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpenTarget === 'top' ? 'true' : 'false'"
          @click="toggleSettings('top')"
        ></button>
        <div v-if="settingsOpenTarget === 'top'" class="settingsDropdown">
          <div class="settingsHint">
            Choose the number of data points to load: {{ maxPointsPerFetch }}
          </div>
          <input
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
      <div
        class="settingsWrap settingsWrap--chart-lower"
        ref="bottomSettingsMenuRef"
        :style="settingsWrapStyle"
      >
        <button
          class="settingsButton settingsButton--icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpenTarget === 'bottom' ? 'true' : 'false'"
          @click="toggleSettings('bottom')"
        ></button>
        <div v-if="settingsOpenTarget === 'bottom'" class="settingsDropdown">
          <div class="settingsToggleRow">
            <span class="settingsToggleLabel">Show higher-order greeks</span>
            <button
              type="button"
              class="settingsToggleButton"
              :class="{ settingsToggleButtonActive: ui.showHigherOrderGreeks }"
              @click="ui.showHigherOrderGreeks = !ui.showHigherOrderGreeks"
            >
              {{ ui.showHigherOrderGreeks ? "On" : "Off" }}
            </button>
          </div>
        </div>
      </div>

      <IndexMarkComboChart
        :index-data="indexSeries"
        :combo-data="comboSeries"
        :delta-hedge-enabled="ui.deltaHedgeEnabled"
        :option-instrument-name="activeIndexName"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
        :resolution-key="ui.resolutionKey"
        :resolution-options="RESOLUTION_OPTIONS"
        :show-higher-order-greeks="ui.showHigherOrderGreeks"
        @update:resolution-key="ui.resolutionKey = $event"
        @update:time-anchor-ts="chartAnchorTs = $event"
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

.settingsWrap--chart-lower {
  position: absolute;
  top: calc(47% + 8px);
  right: 40px;
  z-index: 25;
}

.settingsTitle {
  font-size: 10px;
  color: #a9abb6;
  font-weight: 600;
  margin-bottom: 10px;
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

.settingsToggleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.settingsToggleLabel {
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
}

.settingsToggleButton {
  min-width: 44px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid #2a2f3b;
  background: #12161e;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.settingsToggleButtonActive {
  border-color: #2f855a;
  background: #163125;
  color: #8ad5a1;
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

.deltaHedgeButton {
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(226, 232, 240, 0.7);
  font-size: 10px;
  cursor: pointer;
  box-shadow: none;
}

.deltaHedgeButton:hover {
  color: #fff;
}

.deltaHedgeButtonActive {
  color: #8ad5a1;
}

.builderMain :deep(.legs-section) {
  --layout-gap: 8px;
  --leg-row-gap-total: 32px;
  --leg-greeks-gap-total: 44px;
  --strike-greeks-gap: 10px;
}

.builderMain :deep(.index-summary) {
  font-size: 10px;
}

.builderMain :deep(.index-label) {
  font-size: 10px;
}

.builderMain :deep(.index-value) {
  font-size: 10px;
}

.builderMain :deep(.index-time) {
  font-size: 10px;
}

.builderMain :deep(.leg-greek-header) {
  font-size: 10px;
}

.builderMain :deep(.leg-greek-value) {
  font-size: 10px;
}

.builderMain :deep(.leg-greeks) {
  font-size: 10px;
}

.builderMain :deep(.total-greeks) {
  font-size: 10px;
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

  .settingsWrap--chart {
    right: 12px;
  }

  .settingsWrap--chart-lower {
    right: 12px;
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
