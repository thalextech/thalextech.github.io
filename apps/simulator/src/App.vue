<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import CloudChart from "./components/CloudChart.vue";
import PositionBuilder from "./components/PositionBuilder.vue";
import type { GBMParams } from "./lib/gbm";
import type { PositionLeg, OptionLeg } from "./lib/position";
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
const EXPORT_PADDING_LEFT = 120;
const EXPORT_PADDING_TOP = 100;
const EXPORT_PADDING_RIGHT = 56;
const EXPORT_PADDING_BOTTOM = 48;

const generateSeed = (): number => Math.floor(Math.random() * 1_000_000_000);
const seed = ref(generateSeed());
const appMainRef = ref<HTMLElement | null>(null);
const chartSectionRef = ref<HTMLElement | null>(null);
const guideMu = ref<number | null>(null);
const guideVol = ref<number | null>(null);
const histogramMode = ref<"price" | "payoff" | "prob">("payoff");
const settingsOpen = ref(false);
const exportInProgress = ref(false);
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

const SVG_EXPORT_STYLE = `
  svg { font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif; }
  .mu-guide line { stroke: #fff; }
  .mu-cone-fill { opacity: 1; }
  .mu-cone-edge { fill: none; stroke: rgba(255, 255, 255, 0.55); stroke-width: 1.5; }
  .axis text { fill: rgba(148, 163, 184, 0.86); font-size: 11px; }
  .axis path, .axis line, .hist-baseline { stroke: rgba(255, 255, 255, 0.18); }
  .break-even-band { fill: rgba(100, 116, 139, 0.12); }
  .break-even-region text { fill: rgba(148, 163, 184, 0.92); stroke: #0a0b0e; stroke-width: 4; paint-order: stroke; font-size: 11px; }
  .axis .average-payoff-guide { stroke: rgba(226, 232, 240, 0.55); stroke-width: 1; stroke-dasharray: 3 5; }
  .forward-value-label { fill: rgba(148, 163, 184, 0.88); font-size: 11px; font-variant-numeric: tabular-nums; }
`;

const isVisibleForExport = (element: Element): boolean => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement))
    return false;
  if (element.classList.contains("save-png-button")) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0
  );
};

const parseCssPixels = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isRenderableColor = (value: string): boolean =>
  !!value &&
  value !== "transparent" &&
  value !== "rgba(0, 0, 0, 0)" &&
  value !== "hsla(0, 0%, 0%, 0)";

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Failed to render simulator export."));
    image.src = url;
  });

const svgElementToImage = (
  svgElement: SVGSVGElement,
): Promise<HTMLImageElement> => {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  const rect = svgElement.getBoundingClientRect();
  clone.setAttribute("width", String(Math.max(1, Math.ceil(rect.width))));
  clone.setAttribute("height", String(Math.max(1, Math.ceil(rect.height))));
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = SVG_EXPORT_STYLE;
  const defs = clone.querySelector("defs");
  if (defs) defs.insertBefore(style, defs.firstChild);
  else clone.insertBefore(style, clone.firstChild);
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return loadImage(url).finally(() => URL.revokeObjectURL(url));
};

const drawElementBox = (
  ctx: CanvasRenderingContext2D,
  element: Element,
  rootRect: DOMRect,
): void => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement))
    return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const style = window.getComputedStyle(element);
  const x = rect.left - rootRect.left;
  const y = rect.top - rootRect.top;
  const radius = parseCssPixels(style.borderTopLeftRadius);
  if (isRenderableColor(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    drawRoundedRect(ctx, x, y, rect.width, rect.height, radius);
    ctx.fill();
  }
  const borderWidth = parseCssPixels(style.borderTopWidth);
  if (borderWidth > 0 && isRenderableColor(style.borderTopColor)) {
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = borderWidth;
    drawRoundedRect(
      ctx,
      x + borderWidth / 2,
      y + borderWidth / 2,
      Math.max(0, rect.width - borderWidth),
      Math.max(0, rect.height - borderWidth),
      Math.max(0, radius - borderWidth / 2),
    );
    ctx.stroke();
  }
};

const drawText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  rect: DOMRect,
  style: CSSStyleDeclaration,
  rootRect: DOMRect,
): void => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || rect.width <= 0 || rect.height <= 0) return;
  ctx.fillStyle = style.color || "#fff";
  ctx.font = style.font;
  ctx.textAlign = style.textAlign === "right" ? "right" : "left";
  ctx.textBaseline = "alphabetic";
  const fontSize = parseCssPixels(style.fontSize) || 12;
  const x =
    rect.left - rootRect.left + (ctx.textAlign === "right" ? rect.width : 0);
  const y = rect.top - rootRect.top + rect.height - fontSize * 0.18;
  ctx.fillText(trimmed, x, y);
  ctx.textAlign = "left";
};

const drawFormValue = (
  ctx: CanvasRenderingContext2D,
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  rootRect: DOMRect,
): void => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const value =
    element instanceof HTMLSelectElement
      ? (element.selectedOptions[0]?.textContent ?? element.value)
      : element.value;
  const fontSize = parseCssPixels(style.fontSize) || 12;
  const x =
    rect.left -
    rootRect.left +
    (style.textAlign === "right" ? rect.width - 8 : 8);
  const y = rect.top - rootRect.top + rect.height / 2 + fontSize * 0.35;
  ctx.fillStyle = style.color || "#fff";
  ctx.font = style.font;
  ctx.textAlign = style.textAlign === "right" ? "right" : "left";
  ctx.fillText(value, x, y);
  ctx.textAlign = "left";
};

const renderElementToCanvas = async (
  ctx: CanvasRenderingContext2D,
  element: Element,
  rootRect: DOMRect,
): Promise<void> => {
  if (!isVisibleForExport(element)) return;

  drawElementBox(ctx, element, rootRect);

  if (element instanceof HTMLCanvasElement) {
    const rect = element.getBoundingClientRect();
    ctx.drawImage(
      element,
      rect.left - rootRect.left,
      rect.top - rootRect.top,
      rect.width,
      rect.height,
    );
    return;
  }

  if (element instanceof SVGSVGElement) {
    const rect = element.getBoundingClientRect();
    const image = await svgElementToImage(element);
    ctx.drawImage(
      image,
      rect.left - rootRect.left,
      rect.top - rootRect.top,
      rect.width,
      rect.height,
    );
    return;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    drawFormValue(ctx, element, rootRect);
  }

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      drawText(ctx, text, rect, window.getComputedStyle(element), rootRect);
    } else if (node instanceof Element) {
      await renderElementToCanvas(ctx, node, rootRect);
    }
  }
};

const downloadCanvas = (canvas: HTMLCanvasElement, filename: string): void => {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
};

const exportElementScreenshot = async (
  element: HTMLElement,
  filename: string,
): Promise<void> => {
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width <= 0 || height <= 0) return;

  await document.fonts?.ready;

  const scale = 4;
  const exportWidth = width + EXPORT_PADDING_LEFT + EXPORT_PADDING_RIGHT;
  const exportHeight = height + EXPORT_PADDING_TOP + EXPORT_PADDING_BOTTOM;
  const output = document.createElement("canvas");
  output.width = Math.round(exportWidth * scale);
  output.height = Math.round(exportHeight * scale);
  const ctx = output.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, exportWidth, exportHeight);
  ctx.save();
  ctx.translate(EXPORT_PADDING_LEFT, EXPORT_PADDING_TOP);
  await renderElementToCanvas(ctx, element, rect);
  ctx.restore();
  downloadCanvas(output, filename);
};

const handleSavePng = (): void => {
  if (!appMainRef.value || exportInProgress.value) return;
  exportInProgress.value = true;
  void exportElementScreenshot(
    appMainRef.value,
    `simulator-${histogramMode.value}.png`,
  )
    .catch((error) => {
      console.error("Failed to export simulator PNG", error);
    })
    .finally(() => {
      exportInProgress.value = false;
    });
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

const updateGuide = (payload: { mu: number; vol: number }): void => {
  guideMu.value = payload.mu;
  guideVol.value = payload.vol;
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

const selectedTradeLegs = computed(() =>
  optionLegs.value
    .map((leg) => {
      const instrument = resolveInstrumentForLeg(leg);
      if (!instrument?.instrument_name) return null;
      const qty = Math.max(0, Number(leg.qty) || 0);
      if (!qty) return null;
      return {
        instrument,
        signedQty: leg.side === "sell" ? -qty : qty,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        instrument: ResolvedInstrument;
        signedQty: number;
      } => Boolean(entry),
    ),
);

const tradeExpirationForInstrument = (
  instrument: ResolvedInstrument,
): string | null => {
  const fromName = instrument.instrument_name.match(/^[A-Z]+-(\d{2}[A-Z]{3}\d{2})-/);
  if (fromName?.[1]) return fromName[1];
  const ts = Number(instrument.expiration_timestamp);
  if (!Number.isFinite(ts)) return null;
  return formatExpiryFromTs(ts).replace(/\s+/g, "").toUpperCase();
};

const thalexUrl = computed(() => {
  if (!selectedTradeLegs.value.length) return undefined;
  const firstInstrument = selectedTradeLegs.value[0].instrument;
  const underlyingName = firstInstrument.index_name ?? underlying.value;
  const expiration = tradeExpirationForInstrument(firstInstrument);
  if (!expiration) return undefined;

  let url = `https://thalex.com/exchange/options?underlying=${underlyingName}&expiration=${expiration}`;

  selectedTradeLegs.value.forEach(({ instrument, signedQty }, index) => {
    url += `&instruments[${index}][0]=${instrument.instrument_name}&instruments[${index}][1]=${signedQty}`;
  });

  return url;
});

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
] as const;
type UnderlyingValue = (typeof UNDERLYING_OPTIONS)[number]["value"];

const underlying = ref<UnderlyingValue>("BTCUSD");

const resolvedIndexNames = computed<string[]>(() => [underlying.value]);

const switchUnderlying = (next: UnderlyingValue): void => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  underlying.value = next;
  positionLegs.value = [];
  defaultTradeInitialized.value = false;
};

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
  <main ref="appMainRef" class="app-main">
    <header class="top-bar">
      <div class="top-bar-content">
        <div class="wordmark">Simulator</div>
        <div class="top-divider" aria-hidden="true"></div>
        <div class="underlying-toggle" role="group" aria-label="Underlying">
          <button
            v-for="opt in UNDERLYING_OPTIONS"
            :key="opt.value"
            type="button"
            class="underlying-button"
            :class="{ 'underlying-button--active': underlying === opt.value }"
            @click="switchUnderlying(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="top-spacer"></div>
        <button
          type="button"
          class="save-png-button"
          :disabled="exportInProgress"
          @click="handleSavePng"
        >
          {{ exportInProgress ? "Saving..." : "Save PNG" }}
        </button>
        <a
          v-if="thalexUrl"
          :href="thalexUrl"
          class="trade-thalex-button"
          target="_blank"
          rel="noopener"
        >
          Trade on Thalex
        </a>
      </div>
    </header>

    <div class="workspace-container">
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

      <div class="simulation-main">
        <section ref="chartSectionRef" class="chart-section">
          <div class="chart-header">
            <div class="chart-header-left">
              <button
                type="button"
                class="sim-settings-btn"
                :aria-expanded="settingsOpen"
                aria-label="Simulation settings"
                @mouseenter="showSimSettings"
                @mouseleave="scheduleSimSettingsHide"
                @click="toggleSimSettings"
              >
                ⚙
              </button>
              <div class="chart-meta">
                <span class="chart-meta-key">μ</span>
                <span class="chart-meta-value">{{ guideMuPercent }}%</span>
                <span class="chart-meta-key">σ</span>
                <span class="chart-meta-value">{{ guideVolPercent }}%</span>
                <span
                  ref="nLabelRef"
                  class="chart-meta-n"
                  @pointerenter="handleNLabelEnter"
                  @pointerleave="handleNLabelLeave"
                >
                  <span class="chart-meta-key">n</span>
                  <span class="chart-meta-value">{{ guideRows }}</span>
                </span>
                <span class="chart-horizon-label">{{ horizonDaysLabel }}</span>
              </div>
            </div>
          </div>
          <div class="histogram-toggle" role="group" aria-label="Histogram view">
            <button
              type="button"
              :class="{ 'is-active': histogramMode === 'price' }"
              :aria-pressed="histogramMode === 'price'"
              @click="histogramMode = 'price'"
            >
              Price
            </button>
            <button
              type="button"
              :class="{ 'is-active': histogramMode === 'payoff' }"
              :aria-pressed="histogramMode === 'payoff'"
              @click="histogramMode = 'payoff'"
            >
              Pnl
            </button>
            <button
              type="button"
              :class="{ 'is-active': histogramMode === 'prob' }"
              :aria-pressed="histogramMode === 'prob'"
              @click="histogramMode = 'prob'"
            >
              Prob
            </button>
          </div>
          <div
        v-if="settingsOpen"
        class="sim-settings-popover"
        ref="settingsPopoverRef"
        @mouseenter="showSimSettings"
        @mouseleave="scheduleSimSettingsHide"
        @focusin="handleSettingsFocusIn"
        @focusout="handleSettingsFocusOut"
      >
        <div class="sim-settings-row">
          <label for="time-steps">Time steps</label>
          <input
            id="time-steps"
            class="sim-settings-input"
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
        </div>
        <div class="sim-settings-row">
          <label for="paths-drawn">Paths drawn</label>
          <input
            id="paths-drawn"
            class="sim-settings-input"
            type="number"
            :min="DRAWN_PATHS_MIN"
            :max="Math.min(DRAWN_PATHS_MAX, appliedParams.rows)"
            :step="DRAWN_PATHS_STEP"
            :value="cloudPathLimit"
            @change="
              setCloudPathLimit(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setCloudPathLimit(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </div>
        <div class="sim-settings-row">
          <label for="color-min">Color min %</label>
          <input
            id="color-min"
            class="sim-settings-input"
            type="number"
            min="0"
            max="99"
            step="1"
            :value="colorMinPercent"
            @change="
              setColorMinPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setColorMinPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </div>
        <div class="sim-settings-row">
          <label for="color-max">Color max %</label>
          <input
            id="color-max"
            class="sim-settings-input"
            type="number"
            min="1"
            max="100"
            step="1"
            :value="colorMaxPercent"
            @change="
              setColorMaxPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setColorMaxPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </div>
        <div class="sim-settings-row">
          <label for="bins-mult">Bins x</label>
          <input
            id="bins-mult"
            class="sim-settings-input"
            type="number"
            min="1"
            max="2"
            step="0.05"
            :value="histBinsMultiplier"
            @change="
              setHistBinsMultiplier(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setHistBinsMultiplier(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </div>
      </div>
      <div
        v-if="nPopoverOpen && nPopoverAnchor"
        class="rows-popover"
        :style="{
          left: `${nPopoverAnchor.left + nPopoverAnchor.width / 2}px`,
          top: `${nPopoverAnchor.top + nPopoverAnchor.height}px`,
        }"
        @mouseenter="handleNPopoverMouseEnter"
        @mouseleave="handleNPopoverMouseLeave"
      >
        <div class="rows-popover-head">
          <span class="rows-popover-label">Number of paths:</span>
          <span class="rows-popover-value">{{ guideRows }}</span>
        </div>
        <input
          class="rows-popover-slider"
          type="range"
          :min="ROWS_MIN"
          :max="ROWS_MAX"
          :step="ROWS_STEP"
          :value="rowsSlider"
          @input="
            setRowsFromSlider(Number(($event.target as HTMLInputElement).value))
          "
          @change="flushRowsFromSlider"
        />
        <div class="rows-popover-scale">
          <span>{{ ROWS_MIN }}</span>
          <span>{{ ROWS_MAX }}</span>
        </div>
      </div>
          <CloudChart
        :seed="seed"
        :params="appliedParams"
        :valuationTs="quoteValuationTs"
        :samplePathLimit="cloudPathLimit"
        :muMin="driftBounds.min"
        :muMax="driftBounds.max"
        :volMin="volBounds.min"
        :volMax="volBounds.max"
        :histMode="histogramMode"
        :colorMin="colorMinPercent / 100"
        :colorMax="colorMaxPercent / 100"
        :histBinsMultiplier="histBinsMultiplier"
        :legs="positionLegs"
        :optionPricingByLegId="optionPricingByLegId"
        @set-mu="setMuFromChart"
        @set-vol="setVolFromChart"
        @guide-update="updateGuide"
          />
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  --color-bg: #0a0b0e;
  --color-surface: #131316;
  --color-text: #e8eaed;
  --color-text-muted: #70767d;
  --color-border: rgba(255, 255, 255, 0.09);
  --color-border-strong: rgba(255, 255, 255, 0.2);
}

:global(body) {
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  color-scheme: dark;
}

.app-main {
  /*
   * Scale continuously from 1080px to 1920px of usable content. Avoid a
   * breakpoint jump when browser zoom changes the CSS viewport width.
   */
  --workspace-max-width: clamp(1136px, calc(100vw - 584px), 1976px);
  --text-primary: var(--color-text);
  --text-muted: var(--color-text-muted);
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  min-height: 100vh;
  background: var(--color-bg);
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}

:deep(input),
:deep(select),
:deep(textarea),
:deep(button) {
  font-family: inherit;
}

:deep(button) {
  appearance: none;
  border: none;
  border-radius: 0;
  padding: 0;
  font-weight: inherit;
  font-size: inherit;
  color: inherit;
  background: none;
  cursor: pointer;
  box-shadow: none;
}

.builder-section {
  width: 100%;
  min-width: 0;
  /* Place the first fixed-width combo control on the shared workspace grid. */
  padding: 20px 0 8px max(0px, calc(3.035714% - 8px));
  overflow-x: auto;
}

.top-bar {
  --top-control-height: 32px;
  width: 100%;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.top-bar-content {
  display: flex;
  align-items: center;
  width: 100%;
  height: 58px;
  margin: 0 auto;
  padding: 0 28px;
  gap: 20px;
}

.workspace-container {
  width: 100%;
  max-width: var(--workspace-max-width);
  margin: 0 auto;
  padding: 0 28px 28px;
}

.wordmark {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.top-divider {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.08);
}

.top-spacer {
  flex: 1;
}

.underlying-toggle {
  box-sizing: border-box;
  height: var(--top-control-height);
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
}

.underlying-button {
  box-sizing: border-box;
  height: 100%;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 0 14px;
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.underlying-button + .underlying-button {
  border-left: 1px solid var(--color-border);
}

.underlying-button:hover:not(.underlying-button--active) {
  color: var(--color-text);
  background: var(--color-surface);
}

.underlying-button--active {
  background: var(--color-surface);
  color: var(--color-text);
  font-weight: 600;
}

.trade-thalex-button {
  box-sizing: border-box;
  height: var(--top-control-height);
  padding: 0 13px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

.trade-thalex-button:hover {
  border-color: var(--color-border-strong);
}

.simulation-main {
  display: block;
}

.chart-header {
  display: flex;
  align-items: center;
  height: var(--chart-header-height);
  /* Align settings with the first combo control. */
  padding: 0 8px 0 3.035714%;
  position: relative;
  z-index: 8;
}

.chart-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.chart-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.chart-meta-key {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.chart-meta-value {
  color: rgba(148, 163, 184, 0.95);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.chart-meta-n {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: 4px;
}

.chart-meta-n:hover {
  background: rgba(255, 255, 255, 0.06);
}

.chart-horizon-label {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.sim-settings-btn {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 7px;
  line-height: 1;
  flex-shrink: 0;
  transform: translateY(1px);
}

.sim-settings-btn:hover {
  color: var(--text-primary);
}

.save-png-button {
  box-sizing: border-box;
  flex-shrink: 0;
  height: var(--top-control-height);
  padding: 0 13px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.save-png-button:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.save-png-button:disabled {
  cursor: default;
  opacity: 0.45;
}

.sim-settings-popover {
  position: absolute;
  top: calc(var(--chart-header-height) + 4px);
  left: 8px;
  z-index: 12;
  width: 220px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  display: grid;
  gap: 8px;
}

.sim-settings-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 10px;
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0;
}

.sim-settings-input {
  width: 92px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border-strong);
  background: #111114;
  color: var(--text-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}

.sim-settings-input::-webkit-inner-spin-button,
.sim-settings-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.chart-section {
  position: relative;
  width: 100%;
  max-width: var(--workspace-max-width);
  min-width: 0;
  margin: 0;
  --chart-header-height: 40px;
  height: auto;
  min-height: 0;
  aspect-ratio: 2 / 1;
}

.chart-section svg {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(100% - var(--chart-header-height));
  display: block;
  cursor: crosshair;
  z-index: 2;
}

.chart-section canvas {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(100% - var(--chart-header-height));
  display: block;
  pointer-events: none;
  z-index: 1;
}

.rows-popover {
  position: absolute;
  z-index: 12;
  width: 220px;
  padding: 10px 12px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(9, 13, 20, 0.96);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  transform: translate(-50%, 8px);
  backdrop-filter: blur(4px);
}

.rows-popover-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  column-gap: 8px;
  row-gap: 4px;
  margin-bottom: 8px;
}

.rows-popover-label {
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.rows-popover-value {
  font-size: 10px;
  color: #f1f5f9;
  font-variant-numeric: tabular-nums;
}

.rows-popover-slider {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  height: 16px;
  cursor: pointer;
}

.rows-popover-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.rows-popover-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(2, 6, 23, 0.9);
  background: #f8fafc;
  margin-top: -4px;
}

.rows-popover-slider::-moz-range-track {
  height: 4px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.rows-popover-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(2, 6, 23, 0.9);
  background: #f8fafc;
}

.rows-popover-slider:focus-visible {
  outline: none;
}

.rows-popover-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 2px rgba(248, 250, 252, 0.28);
}

.rows-popover-slider:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 2px rgba(248, 250, 252, 0.28);
}

.rows-popover-scale {
  margin-top: 2px;
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: rgba(148, 163, 184, 0.9);
  font-variant-numeric: tabular-nums;
}

.histogram-toggle {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9;
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  border: none;
  background: #000000;
}

.histogram-toggle button {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}

.histogram-toggle button.is-active {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.12);
}

@media (max-width: 900px) {
  .top-bar-content {
    padding: 0 16px;
    gap: 12px;
  }

  .builder-section {
    padding-left: max(0px, calc(3.035714% - 8px));
  }

  .workspace-container {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@media (max-width: 640px) {
  .top-bar-content {
    flex-wrap: wrap;
    height: auto;
    min-height: 58px;
    padding-top: 10px;
    padding-bottom: 10px;
  }

  .top-divider {
    display: none;
  }

  .top-spacer {
    display: none;
  }

  .trade-thalex-button {
    margin-left: 0;
  }

  .workspace-container {
    display: block;
    padding: 0 16px 28px;
  }

  .builder-section {
    padding-right: 0;
    padding-left: max(0px, calc(3.035714% - 8px));
  }

  .simulation-main {
    display: block;
  }

  .chart-section {
    height: auto;
    min-height: 0;
    aspect-ratio: 1.9 / 1;
    flex: none;
    width: 100%;
    --chart-header-height: 36px;
  }
}
</style>

<style>
body {
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}
</style>
