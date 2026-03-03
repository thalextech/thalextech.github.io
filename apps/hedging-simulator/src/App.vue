<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import HedgingPnlChart from "./components/HedgingPnlChart.vue";
import PositionBuilder from "./components/PositionBuilder.vue";
import { generateGBM, type GBMParams } from "./lib/gbm";
import type { PositionLeg, OptionLeg } from "./lib/position";
import { blackScholesGreeks } from "./lib/blackScholes";
import {
  fetchInstruments,
  fetchLatestIndexPrice,
  fetchLatestMarkPrice,
  type ThalexInstrument,
} from "./lib/thalex";

const defaultParams: GBMParams = {
  s0: 95_000,
  mu: 0.1,
  vol: 0.4,
  T: 14 / 365.25,
  dt: 1 / (365.25 * 24),
  rows: 5000,
};
const driftBounds = { min: -5, max: 5 };
const volBounds = { min: 0.1, max: 1.2 };

const pendingParams = reactive<GBMParams>({ ...defaultParams });
const appliedParams = reactive<GBMParams>({ ...defaultParams });
const ROWS_MIN = 1_000;
const ROWS_MAX = 50_000;
const ROWS_STEP = 1_000;
const ROWS_DEBOUNCE_MS = 160;
const DRAWN_PATHS_MIN = 100;
const DRAWN_PATHS_MAX = 5_000;
const DRAWN_PATHS_STEP = 100;
const TIME_STEPS_MIN = 24;
const TIME_STEPS_MAX = 4000;
const TIME_STEPS_STEP = 24;

const generateSeed = (): number => Math.floor(Math.random() * 1_000_000_000);
const seed = ref(generateSeed());
const chartSectionRef = ref<HTMLElement | null>(null);
const guideMu = ref<number | null>(null);
const guideVol = ref<number | null>(null);
const histogramMode = ref<"price" | "payoff" | "prob">("payoff");
const settingsOpen = ref(false);
const cloudPathLimit = ref(2000);
const colorMinPercent = ref(15);
const colorMaxPercent = ref(85);
const histBinsMultiplier = ref(1);
const defaultTradeInitialized = ref(false);
const positionLegs = ref<PositionLeg[]>([
  {
    id: "leg-1",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "call",
    strike: 70000,
    premium: 0,
    expiry: "27 Feb 26",
  },
  {
    id: "leg-2",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "put",
    strike: 70000,
    premium: 0,
    expiry: "27 Feb 26",
  },
]);
const instruments = ref<ThalexInstrument[]>([]);
const tickerByInstrument = ref<
  Record<string, { data: unknown; fetchedAt: number }>
>({});
const indexByName = ref<Record<string, { data: unknown; fetchedAt: number }>>(
  {},
);

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const regenerate = (): void => {
  seed.value = generateSeed();
};
const applyParams = (): void => {
  Object.assign(appliedParams, pendingParams);
  regenerate();
};

const setMuFromChart = (mu: number): void => {
  if (!Number.isFinite(mu)) return;
  const clamped = clamp(mu, driftBounds.min, driftBounds.max);
  pendingParams.mu = roundTo(clamped, 2);
  applyParams();
};

const setVolFromChart = (vol: number): void => {
  if (!Number.isFinite(vol)) return;
  const clamped = clamp(vol, volBounds.min, volBounds.max);
  pendingParams.vol = roundTo(clamped, 2);
  applyParams();
};

const setMuPercentInput = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const clamped = clamp(value / 100, driftBounds.min, driftBounds.max);
  pendingParams.mu = roundTo(clamped, 4);
  appliedParams.mu = pendingParams.mu;
  regenerate();
};

const setVolPercentInput = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const clamped = clamp(value / 100, volBounds.min, volBounds.max);
  pendingParams.vol = roundTo(clamped, 4);
  appliedParams.vol = pendingParams.vol;
  regenerate();
};

const guideMuPercent = computed(() =>
  ((guideMu.value ?? pendingParams.mu) * 100).toFixed(2),
);
const guideVolPercent = computed(() =>
  ((guideVol.value ?? pendingParams.vol) * 100).toFixed(2),
);
const guideRows = computed(() =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    appliedParams.rows,
  ),
);
const horizonDaysLabel = computed(() => {
  const days = Math.round(appliedParams.T * 365.25);
  return `T+${days}d`;
});
const nLabelRef = ref<HTMLElement | null>(null);
const settingsPopoverRef = ref<HTMLElement | null>(null);
const rowsSlider = ref(appliedParams.rows);
const nPopoverOpen = ref(false);
const nPopoverAnchor = ref<{
  left: number;
  top: number;
  width: number;
  height: number;
} | null>(null);
let nPopoverHideTimer: ReturnType<typeof setTimeout> | null = null;
let rowsApplyTimer: ReturnType<typeof setTimeout> | null = null;
let simSettingsHideTimer: ReturnType<typeof setTimeout> | null = null;
const settingsFocusWithin = ref(false);

const isSettingsFocusActive = (): boolean => {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return !!(active && settingsPopoverRef.value?.contains(active));
};

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));
const simTimeSteps = ref(
  clampInt(
    Math.round(appliedParams.T / appliedParams.dt),
    TIME_STEPS_MIN,
    TIME_STEPS_MAX,
  ),
);

const setSimTimeSteps = (value: number): void => {
  const next = clampInt(
    Math.round(value / TIME_STEPS_STEP) * TIME_STEPS_STEP,
    TIME_STEPS_MIN,
    TIME_STEPS_MAX,
  );
  simTimeSteps.value = next;
  const nextDt = appliedParams.T / next;
  if (!Number.isFinite(nextDt) || nextDt <= 0) return;
  pendingParams.dt = nextDt;
  appliedParams.dt = nextDt;
  regenerate();
};

const setCloudPathLimit = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const snapped = Math.round(value / DRAWN_PATHS_STEP) * DRAWN_PATHS_STEP;
  const hardClamped = clampInt(snapped, DRAWN_PATHS_MIN, DRAWN_PATHS_MAX);
  cloudPathLimit.value = clampInt(
    hardClamped,
    DRAWN_PATHS_MIN,
    Math.max(DRAWN_PATHS_MIN, appliedParams.rows),
  );
};

const setColorMinPercent = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clamp(roundTo(value, 1), 0, colorMaxPercent.value - 1);
  colorMinPercent.value = next;
};

const setColorMaxPercent = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clamp(roundTo(value, 1), colorMinPercent.value + 1, 100);
  colorMaxPercent.value = next;
};

const setHistBinsMultiplier = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clamp(roundTo(value, 2), 1, 2);
  histBinsMultiplier.value = next;
};

const clearSimSettingsHideTimer = (): void => {
  if (!simSettingsHideTimer) return;
  clearTimeout(simSettingsHideTimer);
  simSettingsHideTimer = null;
};

const showSimSettings = (): void => {
  clearSimSettingsHideTimer();
  settingsOpen.value = true;
};

const scheduleSimSettingsHide = (): void => {
  if (settingsFocusWithin.value || isSettingsFocusActive()) return;
  clearSimSettingsHideTimer();
  simSettingsHideTimer = setTimeout(() => {
    if (settingsFocusWithin.value || isSettingsFocusActive()) return;
    settingsOpen.value = false;
  }, 1000);
};

const toggleSimSettings = (): void => {
  clearSimSettingsHideTimer();
  settingsOpen.value = !settingsOpen.value;
};

const handleSettingsFocusIn = (): void => {
  settingsFocusWithin.value = true;
  showSimSettings();
};

const handleSettingsFocusOut = (): void => {
  if (typeof requestAnimationFrame === "undefined") {
    settingsFocusWithin.value = isSettingsFocusActive();
    if (!settingsFocusWithin.value) scheduleSimSettingsHide();
    return;
  }
  requestAnimationFrame(() => {
    settingsFocusWithin.value = isSettingsFocusActive();
    if (
      !settingsFocusWithin.value &&
      !settingsPopoverRef.value?.matches(":hover")
    ) {
      scheduleSimSettingsHide();
    }
  });
};

const clearNPopoverHideTimer = (): void => {
  if (!nPopoverHideTimer) return;
  clearTimeout(nPopoverHideTimer);
  nPopoverHideTimer = null;
};

const scheduleNPopoverHide = (): void => {
  clearNPopoverHideTimer();
  nPopoverHideTimer = setTimeout(() => {
    nPopoverOpen.value = false;
  }, 140);
};

const clearRowsApplyTimer = (): void => {
  if (!rowsApplyTimer) return;
  clearTimeout(rowsApplyTimer);
  rowsApplyTimer = null;
};

const clampRows = (value: number): number => {
  const snapped = Math.round(value / ROWS_STEP) * ROWS_STEP;
  return clamp(snapped, ROWS_MIN, ROWS_MAX);
};

const applyRowsValue = (value: number): void => {
  const next = clampRows(value);
  if (pendingParams.rows === next && appliedParams.rows === next) return;
  pendingParams.rows = next;
  appliedParams.rows = next;
  regenerate();
};

const scheduleRowsApply = (value: number): void => {
  clearRowsApplyTimer();
  rowsApplyTimer = setTimeout(() => {
    applyRowsValue(value);
  }, ROWS_DEBOUNCE_MS);
};

const setRowsFromSlider = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clampRows(value);
  rowsSlider.value = next;
  scheduleRowsApply(next);
};

const flushRowsFromSlider = (): void => {
  clearRowsApplyTimer();
  applyRowsValue(rowsSlider.value);
};

const handleNLabelEnter = (): void => {
  if (!nLabelRef.value || !chartSectionRef.value) return;
  const labelRect = nLabelRef.value.getBoundingClientRect();
  const sectionRect = chartSectionRef.value.getBoundingClientRect();
  nPopoverAnchor.value = {
    left: labelRect.left - sectionRect.left,
    top: labelRect.top - sectionRect.top,
    width: labelRect.width,
    height: labelRect.height,
  };
  clearNPopoverHideTimer();
  nPopoverOpen.value = true;
};

const handleNLabelLeave = (): void => {
  scheduleNPopoverHide();
};

const handleNPopoverMouseEnter = (): void => {
  clearNPopoverHideTimer();
  nPopoverOpen.value = true;
};

const handleNPopoverMouseLeave = (): void => {
  scheduleNPopoverHide();
};

const parseExpiryToSeconds = (expiry?: string): number | null => {
  if (!expiry) return null;
  const parts = expiry.split(" ");
  if (parts.length < 3) return null;
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIdx)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, monthIdx, day));
  return Math.floor(date.getTime() / 1000);
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
};

const extractTickerIV = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.iv_close,
    record.iv,
    record.mark_iv,
    record.implied_volatility,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value > 3 ? value / 100 : value;
  }
  return null;
};

const extractTickerMark = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.mark_price_close,
    record.close,
    record.mark_price,
    record.mark,
    record.last,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
};

type ResolvedInstrument = {
  instrument_name: string;
  index_name?: string;
  option_type?: "call" | "put";
  strike_price?: number;
  expiration_timestamp?: number;
  create_time?: number;
};

const monthMap: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const parseInstrumentFromName = (name: string): ResolvedInstrument | null => {
  const match = name.match(/^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!match) return null;
  const [, dd, mmm, yy, strikeStr, cp] = match;
  const day = Number(dd);
  const month = monthMap[mmm.toLowerCase()];
  const year = 2000 + Number(yy);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  )
    return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike)) return null;
  const expiration = Math.floor(Date.UTC(year, month, day, 8, 0, 0) / 1000);
  return {
    instrument_name: name,
    option_type: cp === "P" ? "put" : "call",
    strike_price: strike,
    expiration_timestamp: expiration,
  };
};

const parseTimestampToSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const num = Number(value);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12
        ? Math.floor(asNumber / 1000)
        : Math.floor(asNumber);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
};

const formatExpiryFromTs = (tsSeconds: number): string => {
  const date = new Date(tsSeconds * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
};

const normalizeInstrument = (
  instrument: ThalexInstrument,
): ResolvedInstrument | null => {
  if (!instrument?.instrument_name) return null;
  const optionTypeRaw = instrument.option_type?.toLowerCase?.();
  const optionType =
    optionTypeRaw === "p" || optionTypeRaw === "put"
      ? "put"
      : optionTypeRaw === "c" || optionTypeRaw === "call"
        ? "call"
        : undefined;
  const strike = Number(instrument.strike_price);
  let expiration = Number(instrument.expiration_timestamp);
  const createTime = parseTimestampToSeconds(instrument.create_time);
  if (Number.isFinite(expiration) && expiration > 1e12) {
    expiration = Math.floor(expiration / 1000);
  }
  if (optionType && Number.isFinite(strike) && Number.isFinite(expiration)) {
    return {
      instrument_name: instrument.instrument_name,
      index_name: instrument.index_name,
      option_type: optionType,
      strike_price: strike,
      expiration_timestamp: expiration,
      create_time: createTime ?? undefined,
    };
  }
  const parsed = parseInstrumentFromName(instrument.instrument_name);
  if (!parsed) return null;
  return {
    ...parsed,
    index_name: instrument.index_name,
    create_time: createTime ?? undefined,
  };
};

const normalizedOptionInstruments = computed<ResolvedInstrument[]>(() =>
  instruments.value
    .map((instrument) => normalizeInstrument(instrument))
    .filter((instrument): instrument is ResolvedInstrument => !!instrument),
);

const optionLegs = computed(() =>
  positionLegs.value.filter((leg): leg is OptionLeg => leg.kind === "option"),
);

const MARK_RETRY_DELAY_MS = 1500;
const MARK_RETRY_MAX = 2;
const markFetchInFlight = new Set<string>();
const markRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const markRetryAttempts = new Map<string, number>();

const clearMarkRetry = (name: string): void => {
  const timer = markRetryTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    markRetryTimers.delete(name);
  }
  markRetryAttempts.delete(name);
};

const setTickerSnapshot = (name: string, ticker: unknown): void => {
  tickerByInstrument.value = {
    ...tickerByInstrument.value,
    [name]: { data: ticker, fetchedAt: Date.now() },
  };
};

const fetchMarkSnapshot = async (name: string): Promise<boolean> => {
  if (markFetchInFlight.has(name)) return false;
  markFetchInFlight.add(name);
  try {
    const ticker = await fetchLatestMarkPrice(name);
    if (!ticker) return false;
    if (!selectedInstrumentNames.value.includes(name)) return false;
    setTickerSnapshot(name, ticker);
    clearMarkRetry(name);
    return true;
  } catch (error) {
    console.warn("Failed to fetch ticker", name, error);
    return false;
  } finally {
    markFetchInFlight.delete(name);
  }
};

const scheduleMarkRetry = (name: string): void => {
  if (markRetryTimers.has(name)) return;
  const attempts = markRetryAttempts.get(name) ?? 0;
  if (attempts >= MARK_RETRY_MAX) return;
  markRetryAttempts.set(name, attempts + 1);
  const timer = setTimeout(async () => {
    markRetryTimers.delete(name);
    if (!selectedInstrumentNames.value.includes(name)) {
      markRetryAttempts.delete(name);
      return;
    }
    if (tickerByInstrument.value[name]) {
      clearMarkRetry(name);
      return;
    }
    const ok = await fetchMarkSnapshot(name);
    if (!ok) scheduleMarkRetry(name);
  }, MARK_RETRY_DELAY_MS);
  markRetryTimers.set(name, timer);
};

const resolveInstrumentForLeg = (leg: OptionLeg): ResolvedInstrument | null => {
  const expirySeconds = parseExpiryToSeconds(leg.expiry);
  if (!expirySeconds) return null;
  const strike = Number(leg.strike);
  if (!Number.isFinite(strike)) return null;
  const type = leg.optionType?.toLowerCase();

  const candidates = normalizedOptionInstruments.value.filter((instrument) => {
    if (type && instrument.option_type?.toLowerCase() !== type) return false;
    if (Number(instrument.strike_price) !== strike) return false;
    if (!Number.isFinite(Number(instrument.expiration_timestamp))) return false;
    const diff = Math.abs(
      Number(instrument.expiration_timestamp) - expirySeconds,
    );
    return diff <= 12 * 60 * 60;
  });

  return candidates[0] ?? null;
};

const selectedInstruments = computed(
  () =>
    optionLegs.value
      .map(resolveInstrumentForLeg)
      .filter(Boolean) as ResolvedInstrument[],
);

const selectedInstrumentNames = computed(() =>
  Array.from(
    new Set(
      selectedInstruments.value.map((instrument) => instrument.instrument_name),
    ),
  ),
);

const selectedIndexNames = computed<string[]>(() =>
  Array.from(
    new Set(
      selectedInstruments.value
        .map((instrument) => instrument.index_name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        ),
    ),
  ),
);

const FORCED_INDEX_NAME = "BTCUSD";

const inferIndexName = (instrumentName: string): string | null => {
  if (!instrumentName) return null;
  const base = instrumentName.split("-")[0];
  if (!base) return null;
  if (base.endsWith("USD")) return base;
  return `${base}USD`;
};

const resolvedIndexNames = computed<string[]>(() => {
  if (FORCED_INDEX_NAME) return [FORCED_INDEX_NAME];
  if (selectedIndexNames.value.length) return selectedIndexNames.value;
  const inferred = selectedInstrumentNames.value
    .map(inferIndexName)
    .filter((name): name is string => !!name);
  return inferred.length ? Array.from(new Set(inferred)) : [];
});

const extractIndexPrice = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.index_price_close,
    record.close,
    record.index_price,
    record.price,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const indexDisplay = computed(() => {
  const name = resolvedIndexNames.value[0];
  if (!name) return null;
  const snapshot = indexByName.value[name];
  if (!snapshot) return null;
  const price = extractIndexPrice(snapshot.data);
  if (!Number.isFinite(price)) return null;
  return {
    name,
    price: Number(price),
    fetchedAt: snapshot.fetchedAt,
  };
});

const activeIndexName = computed<string | null>(
  () => resolvedIndexNames.value[0] ?? null,
);
const activeIndexSnapshot = computed<{
  data: unknown;
  fetchedAt: number;
} | null>(() => {
  const name = activeIndexName.value;
  if (!name) return null;
  return indexByName.value[name] ?? null;
});

const defaultStraddleSpec = computed<{ strike: number; expiry: string } | null>(
  () => {
    const spot = Number(indexDisplay.value?.price);
    // Wait for a live index spot so ATM is selected from real market level.
    if (!Number.isFinite(spot) || spot <= 0) return null;

    const instrumentsForIndex = normalizedOptionInstruments.value.filter(
      (instrument) => {
        if (!activeIndexName.value) return true;
        return instrument.index_name === activeIndexName.value;
      },
    );
    const source = instrumentsForIndex.length
      ? instrumentsForIndex
      : normalizedOptionInstruments.value;
    if (!source.length) return null;

    let targetExpiryTs: number | null = null;
    let oldestCreate = Number.POSITIVE_INFINITY;
    for (const instrument of source) {
      const create = Number(instrument.create_time);
      const expiryTs = Number(instrument.expiration_timestamp);
      if (!Number.isFinite(create) || !Number.isFinite(expiryTs)) continue;
      if (create < oldestCreate) {
        oldestCreate = create;
        targetExpiryTs = expiryTs;
      }
    }
    if (!Number.isFinite(targetExpiryTs)) {
      const fallbackExpiries = source
        .map((instrument) => Number(instrument.expiration_timestamp))
        .filter((ts) => Number.isFinite(ts));
      if (!fallbackExpiries.length) return null;
      targetExpiryTs = Math.min(...fallbackExpiries);
    }
    if (!Number.isFinite(targetExpiryTs)) return null;

    const expiryInstruments = source.filter(
      (instrument) =>
        Number(instrument.expiration_timestamp) === targetExpiryTs,
    );
    const callStrikes = new Set<number>();
    const putStrikes = new Set<number>();
    for (const instrument of expiryInstruments) {
      const strike = Number(instrument.strike_price);
      if (!Number.isFinite(strike)) continue;
      if (instrument.option_type === "call") callStrikes.add(strike);
      if (instrument.option_type === "put") putStrikes.add(strike);
    }

    const strikes = Array.from(callStrikes).filter((strike) =>
      putStrikes.has(strike),
    );
    if (!strikes.length) {
      strikes.push(
        ...expiryInstruments
          .map((instrument) => Number(instrument.strike_price))
          .filter((strike) => Number.isFinite(strike)),
      );
    }
    if (!strikes.length) return null;

    let nearestStrike = strikes[0];
    let bestDistance = Math.abs(nearestStrike - spot);
    for (let i = 1; i < strikes.length; i += 1) {
      const strike = strikes[i];
      const distance = Math.abs(strike - spot);
      if (
        distance < bestDistance ||
        (distance === bestDistance && strike < nearestStrike)
      ) {
        nearestStrike = strike;
        bestDistance = distance;
      }
    }

    return {
      strike: nearestStrike,
      expiry: formatExpiryFromTs(Number(targetExpiryTs)),
    };
  },
);

const optionPricingByLegId = computed<Record<string, OptionPricingInput>>(
  () => {
    const map: Record<string, OptionPricingInput> = {};
    for (const leg of optionLegs.value) {
      const instrument = resolveInstrumentForLeg(leg);
      const tickerSnapshot =
        instrument?.instrument_name != null
          ? tickerByInstrument.value[instrument.instrument_name]
          : null;
      const expirationFromInstrument = Number(instrument?.expiration_timestamp);
      const expirationTs = Number.isFinite(expirationFromInstrument)
        ? expirationFromInstrument
        : parseExpiryToSeconds(leg.expiry);

      map[leg.id] = {
        iv: extractTickerIV(tickerSnapshot?.data),
        mark: extractTickerMark(tickerSnapshot?.data),
        expirationTs,
      };
    }
    return map;
  },
);

const quoteValuationTs = computed<number>(() => {
  const fetchedAtMs: number[] = [];
  const indexFetchedAt = activeIndexSnapshot.value?.fetchedAt;
  if (Number.isFinite(indexFetchedAt)) {
    fetchedAtMs.push(Number(indexFetchedAt));
  }

  for (const name of selectedInstrumentNames.value) {
    const fetchedAt = tickerByInstrument.value[name]?.fetchedAt;
    if (Number.isFinite(fetchedAt)) {
      fetchedAtMs.push(Number(fetchedAt));
    }
  }

  if (!fetchedAtMs.length) {
    return Math.floor(Date.now() / 1000);
  }

  // Use the oldest available quote timestamp so all inputs are valued on the same as-of clock.
  return Math.floor(Math.min(...fetchedAtMs) / 1000);
});

type SimulatedIndexPoint = {
  ts: number;
  date: Date;
  index_price_close: number;
};

type HedgeDailyBar = {
  ts: number;
  date: Date;
  gammaPnl: number;
  thetaPnl: number;
  totalPnl: number;
};

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

const simulatedIndexSeries = computed<SimulatedIndexPoint[]>(() => {
  const params: GBMParams = {
    s0: Number(appliedParams.s0),
    mu: Number(appliedParams.mu),
    vol: Number(appliedParams.vol),
    T: Number(appliedParams.T),
    dt: Number(appliedParams.dt),
    rows: 1,
  };
  if (
    !Number.isFinite(params.s0) ||
    !Number.isFinite(params.mu) ||
    !Number.isFinite(params.vol) ||
    !Number.isFinite(params.T) ||
    !Number.isFinite(params.dt) ||
    params.s0 <= 0 ||
    params.T <= 0 ||
    params.dt <= 0
  ) {
    return [];
  }

  const sim = generateGBM(params, seed.value);
  const path = sim.paths[0];
  if (!path?.length) return [];

  const startTs = Number.isFinite(quoteValuationTs.value)
    ? quoteValuationTs.value
    : Math.floor(Date.now() / 1000);
  const stepSeconds = Math.max(1, Math.round(params.dt * SECONDS_PER_YEAR));
  const rows: SimulatedIndexPoint[] = [
    {
      ts: startTs,
      date: new Date(startTs * 1000),
      index_price_close: params.s0,
    },
  ];

  for (let i = 0; i < path.length; i += 1) {
    const ts = startTs + (i + 1) * stepSeconds;
    rows.push({
      ts,
      date: new Date(ts * 1000),
      index_price_close: Number(path[i]),
    });
  }

  return rows;
});

const dailyHedgeBars = computed<HedgeDailyBar[]>(() => {
  const series = simulatedIndexSeries.value;
  if (series.length < 2) return [];

  const optionDefs = optionLegs.value
    .map((leg) => {
      const pricing = optionPricingByLegId.value[leg.id];
      const iv =
        pricing?.iv != null && Number.isFinite(pricing.iv) && pricing.iv > 0
          ? pricing.iv
          : Number(appliedParams.vol);
      const expirationTs =
        pricing?.expirationTs != null && Number.isFinite(pricing.expirationTs)
          ? Number(pricing.expirationTs)
          : parseExpiryToSeconds(leg.expiry);
      const strike = Number(leg.strike);
      const qty = Number(leg.qty);
      if (
        !Number.isFinite(strike) ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        !Number.isFinite(iv) ||
        iv <= 0 ||
        !Number.isFinite(expirationTs ?? NaN)
      ) {
        return null;
      }
      return {
        sign: leg.side === "buy" ? 1 : -1,
        qty,
        strike,
        optionType: leg.optionType,
        iv,
        expirationTs: Number(expirationTs),
      };
    })
    .filter(
      (
        leg,
      ): leg is {
        sign: number;
        qty: number;
        strike: number;
        optionType: OptionLeg["optionType"];
        iv: number;
        expirationTs: number;
      } => !!leg,
    );

  const bucketMap = new Map<number, { gammaPnl: number; thetaPnl: number; totalPnl: number }>();

  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const next = series[i];
    const prevSpot = Number(prev.index_price_close);
    const nextSpot = Number(next.index_price_close);
    if (!Number.isFinite(prevSpot) || !Number.isFinite(nextSpot)) continue;

    const dS = nextSpot - prevSpot;
    const dtDays = (next.ts - prev.ts) / SECONDS_PER_DAY;
    let stepGammaPnl = 0;
    let stepThetaPnl = 0;

    for (const leg of optionDefs) {
      const timeToExpiryYears = Math.max(
        0,
        (leg.expirationTs - prev.ts) / SECONDS_PER_YEAR,
      );
      if (timeToExpiryYears <= 0) continue;

      const greeks = blackScholesGreeks(
        prevSpot,
        leg.strike,
        timeToExpiryYears,
        leg.iv,
        0,
        leg.optionType,
      );
      const signedQty = leg.sign * leg.qty;
      const gammaPnl = signedQty * 0.5 * greeks.gamma * dS * dS;
      const rawTheta = signedQty * greeks.theta * dtDays;
      const thetaPnl = rawTheta;
      stepGammaPnl += gammaPnl;
      stepThetaPnl += thetaPnl;
    }

    const dayTs = Math.floor(next.ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const prevBucket = bucketMap.get(dayTs) ?? {
      gammaPnl: 0,
      thetaPnl: 0,
      totalPnl: 0,
    };
    prevBucket.gammaPnl += stepGammaPnl;
    prevBucket.thetaPnl += stepThetaPnl;
    prevBucket.totalPnl += stepGammaPnl + stepThetaPnl;
    bucketMap.set(dayTs, prevBucket);
  }

  return Array.from(bucketMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, values]) => ({
      ts,
      date: new Date(ts * 1000),
      gammaPnl: values.gammaPnl,
      thetaPnl: values.thetaPnl,
      totalPnl: values.totalPnl,
    }));
});

const subtitleFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const chartSubtitle = computed(() => {
  const rows = simulatedIndexSeries.value;
  if (rows.length < 2) return "";
  const start = rows[0].date;
  const end = rows[rows.length - 1].date;
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  return `${subtitleFormatter.format(start)} - ${subtitleFormatter.format(end)} (${days.toFixed(1)} days)`;
});

const shortestExpiryDays = computed<number | null>(() => {
  const nowTs = Math.floor(Date.now() / 1000);
  const expiries = optionLegs.value
    .map((leg) => {
      const instrumentExpiry = Number(
        resolveInstrumentForLeg(leg)?.expiration_timestamp,
      );
      if (Number.isFinite(instrumentExpiry)) return instrumentExpiry;
      return parseExpiryToSeconds(leg.expiry);
    })
    .filter((ts): ts is number => Number.isFinite(ts) && ts > nowTs);
  if (!expiries.length) return null;
  const minTs = Math.min(...expiries);
  const days = Math.ceil((minTs - nowTs) / (24 * 60 * 60));
  return Math.max(1, days);
});

watch(
  () => indexDisplay.value?.price,
  (price) => {
    if (!Number.isFinite(price)) return;
    const next = Number(price);
    if (Math.abs(appliedParams.s0 - next) < 1e-9) return;
    pendingParams.s0 = next;
    appliedParams.s0 = next;
    regenerate();
  },
  { immediate: true },
);

watch(
  defaultStraddleSpec,
  (spec) => {
    if (defaultTradeInitialized.value || !spec) return;
    positionLegs.value = [
      {
        id: "leg-1",
        kind: "option",
        side: "buy",
        qty: 1,
        optionType: "call",
        strike: spec.strike,
        premium: 0,
        expiry: spec.expiry,
      },
      {
        id: "leg-2",
        kind: "option",
        side: "buy",
        qty: 1,
        optionType: "put",
        strike: spec.strike,
        premium: 0,
        expiry: spec.expiry,
      },
    ];
    defaultTradeInitialized.value = true;
  },
  { immediate: true },
);

watch(
  shortestExpiryDays,
  (minDays) => {
    if (!Number.isFinite(minDays) || minDays == null) return;
    const nextT = Number(minDays) / 365.25;
    const nextDt = nextT / simTimeSteps.value;
    if (
      Math.abs(appliedParams.T - nextT) < 1e-9 &&
      Math.abs(appliedParams.dt - nextDt) < 1e-12
    )
      return;
    pendingParams.T = nextT;
    appliedParams.T = nextT;
    if (Number.isFinite(nextDt) && nextDt > 0) {
      pendingParams.dt = nextDt;
      appliedParams.dt = nextDt;
    }
    regenerate();
  },
  { immediate: true },
);

watch(
  () => appliedParams.rows,
  (rows) => {
    rowsSlider.value = rows;
    if (cloudPathLimit.value > rows) {
      cloudPathLimit.value = clampInt(rows, DRAWN_PATHS_MIN, DRAWN_PATHS_MAX);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  clearNPopoverHideTimer();
  clearRowsApplyTimer();
  clearSimSettingsHideTimer();
  for (const timer of markRetryTimers.values()) {
    clearTimeout(timer);
  }
  markRetryTimers.clear();
  markRetryAttempts.clear();
  markFetchInFlight.clear();
});

onMounted(async () => {
  try {
    instruments.value = await fetchInstruments();
  } catch (error) {
    console.error("Failed to load Thalex instruments", error);
  }
});

watch(
  selectedInstrumentNames,
  async (names) => {
    if (!names.length) {
      for (const name of Array.from(markRetryTimers.keys())) {
        clearMarkRetry(name);
      }
      return;
    }
    const active = new Set(names);
    for (const name of Array.from(markRetryTimers.keys())) {
      if (!active.has(name)) clearMarkRetry(name);
    }
    await Promise.all(
      names.map(async (name) => {
        if (tickerByInstrument.value[name]) return;
        const ok = await fetchMarkSnapshot(name);
        if (!ok) scheduleMarkRetry(name);
      }),
    );
  },
  { immediate: true },
);

watch(
  resolvedIndexNames,
  async (names) => {
    if (!names.length) return;
    const updates: Record<string, { data: unknown; fetchedAt: number }> = {
      ...indexByName.value,
    };
    await Promise.all(
      names.map(async (name) => {
        if (updates[name]) return;
        try {
          const indexPrice = await fetchLatestIndexPrice(name);
          if (indexPrice)
            updates[name] = { data: indexPrice, fetchedAt: Date.now() };
        } catch (error) {
          console.warn("Failed to fetch index price", name, error);
        }
      }),
    );
    indexByName.value = updates;
  },
  { immediate: true },
);
</script>

<template>
  <main class="app-main">
    <section class="builder-section">
      <PositionBuilder
        v-model:legs="positionLegs"
        :spot="appliedParams.s0"
        :vol="appliedParams.vol"
        :T="appliedParams.T"
        :instruments="instruments"
        :tickerByInstrument="tickerByInstrument"
        :indexName="activeIndexName"
        :indexPrice="indexDisplay?.price ?? null"
        :indexFetchedAt="activeIndexSnapshot?.fetchedAt ?? null"
      />
    </section>

    <section class="chart-section">
      <div class="chart-header">
        <div class="chart-meta">
          <label class="chart-input" for="mu-input">
            <span class="chart-meta-key">μ</span>
            <input
              id="mu-input"
              class="chart-input-field"
              type="number"
              :min="driftBounds.min * 100"
              :max="driftBounds.max * 100"
              step="0.1"
              :value="guideMuPercent"
              @change="
                setMuPercentInput(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
              @blur="
                setMuPercentInput(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
            />
            <span class="chart-meta-suffix">%</span>
          </label>

          <label class="chart-input" for="vol-input">
            <span class="chart-meta-key">σ</span>
            <input
              id="vol-input"
              class="chart-input-field"
              type="number"
              :min="volBounds.min * 100"
              :max="volBounds.max * 100"
              step="0.1"
              :value="guideVolPercent"
              @change="
                setVolPercentInput(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
              @blur="
                setVolPercentInput(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
            />
            <span class="chart-meta-suffix">%</span>
          </label>

          <label class="chart-input chart-input--steps" for="time-steps">
            <span class="chart-meta-key">n</span>
            <input
              id="time-steps"
              class="chart-input-field"
              type="number"
              :min="TIME_STEPS_MIN"
              :max="TIME_STEPS_MAX"
              :step="TIME_STEPS_STEP"
              :value="simTimeSteps"
              @change="
                setSimTimeSteps(Number(($event.target as HTMLInputElement).value))
              "
              @blur="
                setSimTimeSteps(Number(($event.target as HTMLInputElement).value))
              "
            />
          </label>

          <span class="chart-horizon-label">{{ horizonDaysLabel }}</span>

          <button type="button" class="chart-action-btn" @click="regenerate">
            Regenerate
          </button>
        </div>
      </div>

      <HedgingPnlChart
        :index-data="simulatedIndexSeries"
        :hedge-bars="dailyHedgeBars"
        :title="activeIndexName ?? 'Simulated Index'"
        :subtitle="chartSubtitle"
      />
    </section>
  </main>
</template>

<style scoped>
.app-main {
  --text-primary: var(--text);
  --text-muted: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1200px;
  width: 100%;
  margin: 32px auto 64px;
  padding: 0 16px;
  min-height: 100vh;
}

:deep(input),
:deep(select),
:deep(textarea),
:deep(button) {
  font-family: inherit;
}

.builder-section {
  width: 100%;
  min-width: 0;
  overflow-x: auto;
}

.chart-section {
  width: 100%;
  max-width: 1200px;
  min-width: 0;
  margin: 0;
  margin-right: auto;
}

.chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0 2px 10px;
}

.chart-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  font-size: 11px;
}

.chart-meta-key {
  color: rgba(148, 163, 184, 0.92);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.chart-meta-suffix {
  color: rgba(148, 163, 184, 0.92);
  font-size: 10px;
}

.chart-meta-value {
  color: rgba(148, 163, 184, 0.95);
  font-variant-numeric: tabular-nums;
}

.chart-input {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.chart-input-field {
  width: 76px;
  padding: 4px 6px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(15, 20, 30, 0.9);
  color: var(--text-primary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}

.chart-input-field::-webkit-inner-spin-button,
.chart-input-field::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.chart-input--steps .chart-input-field {
  width: 84px;
}

.chart-horizon-label {
  color: rgba(148, 163, 184, 0.92);
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
}

.chart-action-btn {
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  background: rgba(15, 20, 30, 0.92);
  color: rgba(226, 232, 240, 0.95);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 6px 10px;
  cursor: pointer;
}

.chart-action-btn:hover {
  border-color: rgba(255, 255, 255, 0.36);
  color: #fff;
}

@media (max-width: 900px) {
  .app-main {
    margin: 24px auto 48px;
    padding: 0 12px;
  }
}

@media (max-width: 640px) {
  .chart-meta {
    gap: 8px;
  }
}
</style>
