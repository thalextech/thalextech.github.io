<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import * as d3 from "d3";
import type { GBMParams } from "../lib/gbm";
import type { PositionLeg } from "../lib/position";
import SimWorker from "../workers/sim.worker?worker";

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
};

const props = defineProps<{
  seed: number;
  params: GBMParams;
  valuationTs?: number;
  muMin?: number;
  muMax?: number;
  volMin?: number;
  volMax?: number;
  histMode?: "price" | "payoff" | "prob";
  colorMin?: number;
  colorMax?: number;
  histBinsMultiplier?: number;
  legs?: PositionLeg[];
  optionPricingByLegId?: Record<string, OptionPricingInput>;
  histBins?: number;
  samplePathLimit?: number;
}>();

const emit = defineEmits<{
  (event: "set-mu", value: number): void;
  (event: "set-vol", value: number): void;
  (event: "guide-update", value: { mu: number; vol: number }): void;
  (
    event: "stats-update",
    value: {
      meanPayoff: number;
      medianPayoff: number;
      maxDrawdown: number;
      maxPayoff: number;
      winRate: number;
    },
  ): void;
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const RISK_FREE_RATE = 0.0;
const MAX_CLOUD_RENDER_PATHS = 500;
const REVEAL_DURATION_MS = 900;
const HISTOGRAM_BIN_COUNT = 100;
const COLOR_T_MIN = 0.15;
const COLOR_T_MAX = 0.85;
const COLOR_T_MID = 0.5;
const CHART_WIDTH = 1120;
const CHART_HEIGHT = 520;
const CHART_MARGIN = { top: 28, right: 86, bottom: 28, left: 34 };
const HISTOGRAM_WIDTH = 212;
const HISTOGRAM_GAP = 36;
const MAIN_WIDTH =
  CHART_WIDTH -
  CHART_MARGIN.left -
  CHART_MARGIN.right -
  HISTOGRAM_WIDTH -
  HISTOGRAM_GAP;
const MAIN_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

type SceneHandles = {
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  defs: d3.Selection<SVGDefsElement, unknown, null, undefined>;
  mainGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  plotGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  interactionLayer: d3.Selection<SVGRectElement, unknown, null, undefined>;
  histogramGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
};

type SimWorkerRequest = {
  id: number;
  seed: number;
  params: GBMParams;
  legs: PositionLeg[];
  optionPricingByLegId: Record<string, OptionPricingInput>;
  valuationTs: number;
  horizonSeconds: number;
  histBins: number;
  histBinsMultiplier: number;
  samplePathLimit: number;
};

type SimBin = {
  x0: number;
  x1: number;
  count: number;
  sumPayoff: number;
  medianPayoff: number;
};

type SimWorkerSuccess = {
  id: number;
  steps: number;
  rows: number;
  sampleRows: number;
  sampledPathsBuffer: ArrayBuffer;
  sampledFinalPricesBuffer: ArrayBuffer;
  sampledPayoffsBuffer: ArrayBuffer;
  bins: SimBin[];
  pathMin: number;
  pathMax: number;
  finalPriceMin: number;
  finalPriceMax: number;
  payoffMin: number;
  payoffMax: number;
  meanPayoff: number;
  medianPayoff: number;
  maxPayoff: number;
  maxDrawdown: number;
  winRate: number;
};

type SimWorkerError = {
  id: number;
  error: string;
};

type SimComputation = {
  steps: number;
  rows: number;
  samplePaths: Float64Array[];
  sampledFinalPrices: Float64Array;
  sampledPayoffs: Float64Array;
  bins: SimBin[];
  pathMin: number;
  pathMax: number;
  finalPriceMin: number;
  finalPriceMax: number;
  payoffMin: number;
  payoffMax: number;
  meanPayoff: number;
  medianPayoff: number;
  maxPayoff: number;
  maxDrawdown: number;
  winRate: number;
};

const sanitizeParamsForWorker = (params: GBMParams): GBMParams => ({
  s0: Number(params.s0),
  mu: Number(params.mu),
  vol: Number(params.vol),
  T: Number(params.T),
  dt: Number(params.dt),
  rows: Number(params.rows),
});

const sanitizeLegsForWorker = (
  legs: PositionLeg[] | undefined,
): PositionLeg[] =>
  (legs ?? []).map((leg) =>
    leg.kind === "option"
      ? {
          id: String(leg.id),
          kind: "option" as const,
          side: leg.side === "sell" ? "sell" : "buy",
          qty: Number(leg.qty),
          optionType: leg.optionType === "put" ? "put" : "call",
          strike: Number(leg.strike),
          premium: Number(leg.premium),
          expiry: leg.expiry,
        }
      : {
          id: String(leg.id),
          kind: "future" as const,
          side: leg.side === "sell" ? "sell" : "buy",
          qty: Number(leg.qty),
          entry: Number(leg.entry),
          stopLoss:
            leg.stopLoss == null || !Number.isFinite(Number(leg.stopLoss))
              ? null
              : Number(leg.stopLoss),
        },
  );

const sanitizeOptionPricingForWorker = (
  pricing: Record<string, OptionPricingInput> | undefined,
): Record<string, OptionPricingInput> => {
  const out: Record<string, OptionPricingInput> = {};
  if (!pricing) return out;
  for (const [legId, value] of Object.entries(pricing)) {
    out[legId] = {
      iv:
        value?.iv == null || !Number.isFinite(Number(value.iv))
          ? null
          : Number(value.iv),
      mark:
        value?.mark == null || !Number.isFinite(Number(value.mark))
          ? null
          : Number(value.mark),
      expirationTs:
        value?.expirationTs == null ||
        !Number.isFinite(Number(value.expirationTs))
          ? null
          : Number(value.expirationTs),
    };
  }
  return out;
};

type InteractionHandlers = {
  pointermove: (event: PointerEvent) => void;
  pointerenter: (event: PointerEvent) => void;
  pointerdown: (event: PointerEvent) => void;
  pointerup: (event: PointerEvent) => void;
  click: (event: PointerEvent) => void;
};

let cloudRevealRaf: number | null = null;
let drawScheduleRaf: number | null = null;
let scene: SceneHandles | null = null;
let interactionHandlers: InteractionHandlers | null = null;
let canvasTransformCache: {
  canvas: HTMLCanvasElement | null;
  backingWidth: number;
  backingHeight: number;
  scaleX: number;
  scaleY: number;
} = {
  canvas: null,
  backingWidth: 0,
  backingHeight: 0,
  scaleX: 1,
  scaleY: 1,
};
let simWorker: Worker | null = null;
let simRequestSeq = 0;
let latestDrawSeq = 0;
const pendingSimRequests = new Map<
  number,
  {
    resolve: (value: SimComputation) => void;
    reject: (reason?: unknown) => void;
  }
>();

const cancelPendingSimRequests = (reason: string): void => {
  if (!pendingSimRequests.size) return;
  const error = new Error(reason);
  for (const { reject } of pendingSimRequests.values()) {
    reject(error);
  }
  pendingSimRequests.clear();
};

const handleWorkerMessage = (
  event: MessageEvent<SimWorkerSuccess | SimWorkerError>,
): void => {
  const payload = event.data;
  const pending = pendingSimRequests.get(payload.id);
  if (!pending) return;
  pendingSimRequests.delete(payload.id);

  if ("error" in payload) {
    pending.reject(new Error(payload.error));
    return;
  }

  const sampledFinalPrices = new Float64Array(payload.sampledFinalPricesBuffer);
  const sampledPayoffs = new Float64Array(payload.sampledPayoffsBuffer);
  const flatPaths = new Float64Array(payload.sampledPathsBuffer);
  const samplePaths: Float64Array[] = new Array(payload.sampleRows);
  for (let r = 0; r < payload.sampleRows; r += 1) {
    const offset = r * payload.steps;
    samplePaths[r] = flatPaths.subarray(offset, offset + payload.steps);
  }

  pending.resolve({
    steps: payload.steps,
    rows: payload.rows,
    samplePaths,
    sampledFinalPrices,
    sampledPayoffs,
    bins: payload.bins,
    pathMin: payload.pathMin,
    pathMax: payload.pathMax,
    finalPriceMin: payload.finalPriceMin,
    finalPriceMax: payload.finalPriceMax,
    payoffMin: payload.payoffMin,
    payoffMax: payload.payoffMax,
    meanPayoff: payload.meanPayoff,
    medianPayoff: payload.medianPayoff,
    maxPayoff: payload.maxPayoff,
    maxDrawdown: payload.maxDrawdown,
    winRate: payload.winRate,
  });
};

const ensureSimWorker = (): Worker => {
  if (simWorker) return simWorker;
  simWorker = new SimWorker();
  simWorker.onmessage = handleWorkerMessage;
  simWorker.onerror = (event) => {
    const err = new Error(event.message || "Simulation worker failed");
    cancelPendingSimRequests(err.message);
    console.error("Simulation worker error", event);
  };
  return simWorker;
};

const requestSimulation = (
  request: Omit<SimWorkerRequest, "id">,
): Promise<SimComputation> => {
  const worker = ensureSimWorker();
  // Worker keeps only latest queued request; supersede any older unresolved calls.
  cancelPendingSimRequests("Simulation request superseded");
  const id = ++simRequestSeq;
  return new Promise<SimComputation>((resolve, reject) => {
    pendingSimRequests.set(id, { resolve, reject });
    worker.postMessage({
      id,
      ...request,
    } satisfies SimWorkerRequest);
  });
};

const ensureScene = (): SceneHandles | null => {
  if (!svgRef.value) return null;
  if (scene != null && scene.svg.node() === svgRef.value) return scene;

  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.attr("preserveAspectRatio", "none");

  const defs = svg.append("defs");
  const mainGroup = svg
    .append("g")
    .attr("transform", `translate(${CHART_MARGIN.left}, ${CHART_MARGIN.top})`);
  const plotGroup = mainGroup.append("g").attr("class", "plot-group");
  const interactionLayer = mainGroup
    .append("rect")
    .attr("class", "interaction-layer")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", MAIN_WIDTH)
    .attr("height", MAIN_HEIGHT)
    .attr("fill", "transparent")
    .style("pointer-events", "all");
  interactionLayer
    .on("pointermove", (event) =>
      interactionHandlers?.pointermove(event as PointerEvent),
    )
    .on("pointerenter", (event) =>
      interactionHandlers?.pointerenter(event as PointerEvent),
    )
    .on("pointerdown", (event) =>
      interactionHandlers?.pointerdown(event as PointerEvent),
    )
    .on("pointerup", (event) =>
      interactionHandlers?.pointerup(event as PointerEvent),
    )
    .on("click", (event) => interactionHandlers?.click(event as PointerEvent));
  const histogramGroup = svg
    .append("g")
    .attr(
      "transform",
      `translate(${CHART_MARGIN.left + MAIN_WIDTH + HISTOGRAM_GAP}, ${CHART_MARGIN.top})`,
    );

  scene = {
    svg,
    defs,
    mainGroup,
    plotGroup,
    interactionLayer,
    histogramGroup,
  };
  return scene;
};

const clearDynamicScene = (sceneHandles: SceneHandles): void => {
  sceneHandles.defs.selectAll("*").remove();
  sceneHandles.plotGroup.selectAll("*").remove();
  sceneHandles.histogramGroup.selectAll("*").remove();
  // Forward/cone value labels are attached at root SVG level.
  sceneHandles.svg.selectAll(".forward-value-label").remove();
};

const updateDynamicScene = (
  sceneHandles: SceneHandles,
  canvas: HTMLCanvasElement,
  canvasCtx: CanvasRenderingContext2D,
  sim: SimComputation,
): void => {
  const { svg, defs, plotGroup, interactionLayer, histogramGroup } =
    sceneHandles;
  let trackingMode = false;
  let isDraggingVol = false;
  let suppressClick = false;
  let isPointerDown = false;
  let dragMu = 0;
  let driftHover = false;
  if (cloudRevealRaf != null) {
    cancelAnimationFrame(cloudRevealRaf);
    cloudRevealRaf = null;
  }
  clearDynamicScene(sceneHandles);

  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const margin = CHART_MARGIN;
  const histogramWidth = HISTOGRAM_WIDTH;
  const mainWidth = MAIN_WIDTH;
  const mainHeight = MAIN_HEIGHT;
  const cssWidth = canvas.clientWidth || width;
  const cssHeight = canvas.clientHeight || height;
  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(cssWidth * deviceScale));
  const backingHeight = Math.max(1, Math.round(cssHeight * deviceScale));
  const scaleX = backingWidth / width;
  const scaleY = backingHeight / height;
  const transformDirty =
    canvasTransformCache.canvas !== canvas ||
    canvasTransformCache.backingWidth !== backingWidth ||
    canvasTransformCache.backingHeight !== backingHeight ||
    canvasTransformCache.scaleX !== scaleX ||
    canvasTransformCache.scaleY !== scaleY;
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  if (transformDirty) {
    canvasCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    canvasTransformCache = {
      canvas,
      backingWidth,
      backingHeight,
      scaleX,
      scaleY,
    };
  }
  canvasCtx.clearRect(0, 0, width, height);
  canvas.style.transform = "none";
  canvas.style.opacity = "1";
  canvas.style.transformOrigin = "0 0";

  const baseline = props.params.s0;
  const histogramMode = props.histMode ?? "payoff";
  const {
    steps,
    rows: totalPathCount,
    samplePaths: paths,
    sampledFinalPrices,
    sampledPayoffs,
    bins,
    pathMin,
    pathMax,
    finalPriceMin,
    finalPriceMax,
    payoffMin,
    payoffMax,
    meanPayoff,
    medianPayoff,
    maxPayoff,
    maxDrawdown,
    winRate,
  } = sim;
  emit("stats-update", {
    meanPayoff,
    medianPayoff,
    maxDrawdown,
    maxPayoff,
    winRate,
  });

  const maxDelta = Math.max(
    Math.abs(pathMin - baseline),
    Math.abs(pathMax - baseline),
  );
  const paddedDelta = maxDelta * 1.02;
  const safeDelta =
    Number.isFinite(paddedDelta) && paddedDelta > 0 ? paddedDelta : 1;
  const targetDomain: [number, number] = [
    baseline - safeDelta,
    baseline + safeDelta,
  ];
  const y = d3.scaleLinear().domain(targetDomain).range([mainHeight, 0]);

  const x = d3.scaleLinear().domain([0, steps]).range([0, mainWidth]);
  const binMin = targetDomain[0];
  const binMax = targetDomain[1];

  const negSpan = Math.abs(Math.min(payoffMin, 0));
  const posSpan = Math.max(payoffMax, 0);
  // Piecewise side scaling:
  // negatives map across the lower half, positives across the upper half,
  // so each side keeps contrast even when payoff tails are asymmetric.
  const colorMin = clamp(props.colorMin ?? COLOR_T_MIN, 0, 1);
  const colorMax = clamp(props.colorMax ?? COLOR_T_MAX, 0, 1);
  const resolvedMin = Math.min(colorMin, colorMax);
  const resolvedMax = Math.max(colorMin, colorMax);
  const colorMid = clamp((resolvedMin + resolvedMax) / 2, 0, 1);
  const negPayoffColorT = d3
    .scaleLinear()
    .domain([-Math.max(negSpan, 1e-9), 0])
    .range([resolvedMin, colorMid])
    .clamp(true);
  const posPayoffColorT = d3
    .scaleLinear()
    .domain([0, Math.max(posSpan, 1e-9)])
    .range([colorMid, resolvedMax])
    .clamp(true);
  const payoffColorRamp = (value: number): string => {
    const t =
      value < 0
        ? negPayoffColorT(value)
        : value > 0
          ? posPayoffColorT(value)
          : colorMid;
    return d3.interpolateRdBu(t);
  };
  const cloudFillForPath = (pathIndex: number): string =>
    payoffColorRamp(sampledPayoffs[pathIndex] ?? 0);
  const priceFormat = d3.format(".2s");
  const payoffFormat = d3.format(".2s");

  const drawCloudPath = (
    path: Float64Array,
    fill: string,
    opacity: number,
  ): void => {
    if (!path.length) return;
    canvasCtx.save();
    canvasCtx.translate(margin.left, margin.top);
    canvasCtx.beginPath();
    canvasCtx.moveTo(x(0), y(baseline));
    for (let i = 0; i < path.length; i += 1) {
      canvasCtx.lineTo(x(i + 1), y(path[i]));
    }
    canvasCtx.lineTo(x(steps), y(baseline));
    canvasCtx.closePath();
    canvasCtx.fillStyle = fill;
    canvasCtx.globalAlpha = opacity;
    canvasCtx.fill();
    canvasCtx.restore();
  };

  const baselineY = y(baseline);

  const maxElapsed = steps * props.params.dt;
  const coneGradientId = `mu-cone-gradient-${props.seed}`;
  const coneGradient = defs
    .append("linearGradient")
    .attr("id", coneGradientId)
    .attr("gradientUnits", "userSpaceOnUse")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", 0)
    .attr("y2", mainHeight);
  const coneCenter = Math.min(0.9, Math.max(0.1, baselineY / mainHeight));
  coneGradient
    .append("stop")
    .attr("offset", Math.max(0, coneCenter - 0.35))
    .attr("stop-color", "#6e8796")
    .attr("stop-opacity", 0.45);
  coneGradient
    .append("stop")
    .attr("offset", coneCenter)
    .attr("stop-color", "#8aa2b1")
    .attr("stop-opacity", 0.85);
  coneGradient
    .append("stop")
    .attr("offset", Math.min(1, coneCenter + 0.35))
    .attr("stop-color", "#6e8796")
    .attr("stop-opacity", 0.45);
  const muClipId = `mu-clip-${props.seed}`;
  defs
    .append("clipPath")
    .attr("id", muClipId)
    .attr("clipPathUnits", "userSpaceOnUse")
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", mainWidth)
    .attr("height", mainHeight);

  const muGuide = plotGroup
    .append("g")
    .attr("class", "mu-guide")
    .attr("clip-path", `url(#${muClipId})`)
    .style("display", "none")
    .style("pointer-events", "none");
  const muConeFill = muGuide
    .append("path")
    .attr("class", "mu-cone-fill")
    .attr("fill", `url(#${coneGradientId})`)
    .attr("fill-opacity", 0.4);
  const muConeUpper = muGuide.append("path").attr("class", "mu-cone-edge");
  const muConeLower = muGuide.append("path").attr("class", "mu-cone-edge");
  const muLine = muGuide
    .append("line")
    .attr("x1", 0)
    .attr("y1", baselineY)
    .attr("x2", mainWidth)
    .attr("y2", baselineY);
  interactionLayer.raise();

  // Meta labels (μ, σ, n) and horizon label are now rendered in HTML header

  const forwardValueLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle");

  const coneUpperLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle")
    .style("display", "none");

  const coneLowerLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle")
    .style("display", "none");

  const updateForwardLabels = (mu: number, vol: number): void => {
    const forward = baseline * Math.exp(mu * maxElapsed);
    const band = vol * Math.sqrt(maxElapsed);
    const upper = forward * Math.exp(band);
    const lower = forward * Math.exp(-band);

    // Forward label
    if (!Number.isFinite(forward) || forward <= 0) {
      forwardValueLabel.style("display", "none");
    } else {
      const rawY = y(forward);
      if (!Number.isFinite(rawY) || rawY < -50 || rawY > mainHeight + 50) {
        forwardValueLabel.style("display", "none");
      } else {
        const forwardY = Math.max(6, Math.min(mainHeight - 6, rawY));
        forwardValueLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + forwardY)
          .text(priceFormat(forward));
      }
    }

    // Upper cone label (+1 std dev)
    if (!Number.isFinite(upper) || upper <= 0) {
      coneUpperLabel.style("display", "none");
    } else {
      const rawUpperY = y(upper);
      if (
        !Number.isFinite(rawUpperY) ||
        rawUpperY < -50 ||
        rawUpperY > mainHeight + 50
      ) {
        coneUpperLabel.style("display", "none");
      } else {
        const upperY = Math.max(6, Math.min(mainHeight - 6, rawUpperY));
        coneUpperLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + upperY)
          .text(priceFormat(upper));
      }
    }

    // Lower cone label (-1 std dev)
    if (!Number.isFinite(lower) || lower <= 0) {
      coneLowerLabel.style("display", "none");
    } else {
      const rawLowerY = y(lower);
      if (
        !Number.isFinite(rawLowerY) ||
        rawLowerY < -50 ||
        rawLowerY > mainHeight + 50
      ) {
        coneLowerLabel.style("display", "none");
      } else {
        const lowerY = Math.max(6, Math.min(mainHeight - 6, rawLowerY));
        coneLowerLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + lowerY)
          .text(priceFormat(lower));
      }
    }
  };

  // Display-only smoothing to fill interior empty histogram bins.
  // Keeps tails untouched and does not affect simulation stats.
  const smoothDisplayBins = (input: SimBin[]): SimBin[] => {
    if (input.length < 3) return input;
    const output = input.map((bin) => ({ ...bin }));
    const maxBridgeGap = 6;

    for (let i = 1; i < output.length - 1; i += 1) {
      if (output[i].count > 0) continue;

      let left = i - 1;
      while (left >= 0 && output[left].count <= 0) left -= 1;
      let right = i + 1;
      while (right < output.length && output[right].count <= 0) right += 1;

      if (left < 0 || right >= output.length) continue;
      if (right - left > maxBridgeGap) continue;

      const span = right - left;
      const t = (i - left) / span;
      const lerp = (a: number, b: number): number => a + (b - a) * t;
      output[i].count = Math.max(
        1,
        Math.round(lerp(output[left].count, output[right].count)),
      );
      output[i].sumPayoff = lerp(output[left].sumPayoff, output[right].sumPayoff);
      output[i].medianPayoff = lerp(
        output[left].medianPayoff,
        output[right].medianPayoff,
      );
    }

    return output;
  };

  const displayBins = smoothDisplayBins(bins);
  const countMax = d3.max(displayBins, (bin) => bin.count) || 1;
  const cloudFillOpacity = 0.6;
  const binCountMax = d3.max(bins, (bin) => bin.count) || 1;
  const opacityScale = d3
    .scaleSqrt()
    .domain([0, binCountMax])
    .range([0.12, cloudFillOpacity])
    .clamp(true);
  const maxAbsAvgPayoff = Math.max(Math.abs(payoffMin), Math.abs(payoffMax));
  const payoffSpan =
    Number.isFinite(maxAbsAvgPayoff) && maxAbsAvgPayoff > 0
      ? maxAbsAvgPayoff * 1.1
      : 1;
  const maxAbsWeightedPayoff =
    d3.max(displayBins, (value) =>
      Math.abs(totalPathCount > 0 ? value.sumPayoff / totalPathCount : 0),
    ) || 1;
  const weightedPayoffSpan =
    Number.isFinite(maxAbsWeightedPayoff) && maxAbsWeightedPayoff > 0
      ? maxAbsWeightedPayoff * 1.1
      : 1;
  const xHist =
    histogramMode === "price"
      ? d3.scaleLinear().domain([0, countMax]).range([0, histogramWidth])
      : histogramMode === "prob"
        ? d3
            .scaleLinear()
            .domain([-weightedPayoffSpan, weightedPayoffSpan])
            .range([0, histogramWidth])
        : d3
            .scaleLinear()
            .domain([-payoffSpan, payoffSpan])
            .range([0, histogramWidth]);
  const xZero = xHist(0);
  const getMedianPayoff = (bin: SimBin): number => bin.medianPayoff;
  const getWeightedPayoff = (bin: SimBin): number =>
    totalPathCount > 0 ? bin.sumPayoff / totalPathCount : 0;
  const barFill = (bin: SimBin): string =>
    payoffColorRamp(getMedianPayoff(bin));
  const binCount = bins.length;
  const invBinSize =
    binCount > 0 && binMax > binMin ? binCount / (binMax - binMin) : 0;
  const findBinIndex = (value: number): number => {
    if (!Number.isFinite(value) || binCount === 0 || invBinSize <= 0) return -1;
    if (value <= binMin) return 0;
    if (value >= binMax) return binCount - 1;
    const idx = Math.floor((value - binMin) * invBinSize);
    return Math.max(0, Math.min(binCount - 1, idx));
  };
  const opacityForPath = (pathIndex: number): number => {
    const finalPrice = sampledFinalPrices[pathIndex];
    if (!Number.isFinite(finalPrice)) return cloudFillOpacity;
    const binIndex = findBinIndex(finalPrice);
    if (binIndex < 0) return cloudFillOpacity;
    return opacityScale(bins[binIndex]?.count ?? 0);
  };
  const barX = (bin: SimBin, progress: number): number => {
    if (histogramMode === "price") return xZero;
    if (histogramMode === "prob") {
      const weighted = getWeightedPayoff(bin) * progress;
      const clamped = Math.min(
        weightedPayoffSpan,
        Math.max(-weightedPayoffSpan, weighted),
      );
      const xValue = xHist(clamped);
      return Math.min(xZero, xValue);
    }
    const median = getMedianPayoff(bin) * progress;
    const clamped = Math.min(payoffSpan, Math.max(-payoffSpan, median));
    const xValue = xHist(clamped);
    return Math.min(xZero, xValue);
  };
  const barWidth = (bin: SimBin, progress: number): number => {
    if (histogramMode === "price") return xHist(bin.count * progress);
    if (histogramMode === "prob") {
      const weighted = getWeightedPayoff(bin) * progress;
      const clamped = Math.min(
        weightedPayoffSpan,
        Math.max(-weightedPayoffSpan, weighted),
      );
      return Math.abs(xHist(clamped) - xZero);
    }
    const median = getMedianPayoff(bin) * progress;
    const clamped = Math.min(payoffSpan, Math.max(-payoffSpan, median));
    return Math.abs(xHist(clamped) - xZero);
  };
  // Snap histogram bars to the pixel grid to avoid anti-aliased seams.
  const histBarTopY = (bin: SimBin): number =>
    Math.floor(y(bin.x1 ?? bin.x0 ?? baseline));
  const histBarBottomY = (bin: SimBin): number =>
    Math.ceil(y(bin.x0 ?? bin.x1 ?? baseline));
  const histBarY = (bin: SimBin): number =>
    Math.min(histBarTopY(bin), histBarBottomY(bin));
  const histBarHeight = (bin: SimBin): number =>
    Math.max(1, Math.abs(histBarBottomY(bin) - histBarTopY(bin)));

  const bars = histogramGroup
    .selectAll("rect")
    .data(displayBins)
    .join("rect")
    .attr("class", "hist-bar")
    .attr("x", (d) => barX(d, 0))
    .attr("y", (d) => histBarY(d))
    .attr("height", (d) => histBarHeight(d))
    .attr("width", 0)
    .attr("fill", (d) => barFill(d))
    .attr("fill-opacity", 0.95)
    .attr("shape-rendering", "crispEdges");

  // Axis: keep axis height aligned to histogram data range in every mode.
  const axisGroup = histogramGroup
    .append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${histogramWidth + 4}, 0)`);
  const safeFinalMin = Number.isFinite(finalPriceMin)
    ? finalPriceMin
    : baseline;
  const safeFinalMax = Number.isFinite(finalPriceMax)
    ? finalPriceMax
    : baseline;
  const dataTopY = y(safeFinalMax); // max price -> top of histogram data
  const dataBottomY = y(safeFinalMin); // min price -> bottom of histogram data

  if (histogramMode !== "price") {
    // Payoff/prob modes use a payoff axis mapped onto the histogram's vertical span.
    const minPayoff = Number.isFinite(payoffMin) ? payoffMin : 0;
    const maxPayoffValue = Number.isFinite(maxPayoff) ? maxPayoff : minPayoff;
    const hasPayoffSpan = maxPayoffValue > minPayoff;
    const axisTopY = dataTopY;
    const axisBottomY = dataBottomY;
    const payoffToY = hasPayoffSpan
      ? d3
          .scaleLinear()
          .domain([minPayoff, maxPayoffValue])
          .range([axisBottomY, axisTopY])
      : null;

    axisGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", axisTopY)
      .attr("y2", axisBottomY);

    axisGroup
      .append("text")
      .attr("x", 8)
      .attr("y", axisTopY)
      .attr("dominant-baseline", "hanging")
      .text(payoffFormat(maxPayoffValue));

    axisGroup
      .append("text")
      .attr("x", 8)
      .attr("y", axisBottomY)
      .attr("dominant-baseline", "alphabetic")
      .text(payoffFormat(minPayoff));

    const rawAverageY =
      payoffToY != null
        ? payoffToY(meanPayoff)
        : (axisTopY + axisBottomY) * 0.5;
    const labelClearance = 14;
    const averageY = Math.max(
      axisTopY + labelClearance,
      Math.min(axisBottomY - labelClearance, rawAverageY),
    );
    axisGroup
      .append("text")
      .attr("x", 8)
      .attr("y", averageY)
      .attr("dominant-baseline", "middle")
      .text(payoffFormat(meanPayoff));
  } else {
    // Price mode: explicit axis limited to histogram data span.
    axisGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", dataTopY)
      .attr("y2", dataBottomY);

    const priceTicks = d3.ticks(safeFinalMin, safeFinalMax, 4);
    for (const tick of priceTicks) {
      axisGroup
        .append("text")
        .attr("x", 8)
        .attr("y", y(tick))
        .attr("dominant-baseline", "middle")
        .text(priceFormat(tick));
    }
  }

  const minMu = props.muMin ?? -0.1;
  const maxMu = props.muMax ?? 0.3;
  const minVol = props.volMin ?? 0.1;
  const maxVol = props.volMax ?? 1;
  const coneHitSlop = 12;
  const driftHitSlop = 10;

  let activeMu = clamp(props.params.mu, minMu, maxMu);
  let activeVol = clamp(props.params.vol, minVol, maxVol);

  const muConeArea = d3
    .area<{ t: number; lower: number; upper: number }>()
    .x((d) => x(d.t / props.params.dt))
    .y0((d) => y(d.lower))
    .y1((d) => y(d.upper));
  const muConeLine = d3
    .line<{ t: number; value: number }>()
    .x((d) => x(d.t / props.params.dt))
    .y((d) => y(d.value));

  const drawMuGuide = (mu: number, vol: number): void => {
    const endPrice = baseline * Math.exp(mu * maxElapsed);
    const endY = y(endPrice);
    muGuide.style("display", "block");
    updateForwardLabels(mu, vol);
    muLine
      .attr("x1", 0)
      .attr("y1", baselineY)
      .attr("x2", mainWidth)
      .attr("y2", endY)
      .style("stroke-width", driftHover ? 4.5 : 2.2)
      .style("stroke-opacity", driftHover ? 1 : 0.85);
    emit("guide-update", { mu, vol });
    const samples = 48;
    const points: { t: number; lower: number; upper: number }[] = [];
    const sigma = vol;
    for (let i = 0; i < samples; i += 1) {
      const t = (i / (samples - 1)) * maxElapsed;
      const center = Math.max(1e-6, baseline * Math.exp(mu * t));
      const band = sigma * Math.sqrt(t);
      const upper = center * Math.exp(band);
      const lower = center * Math.exp(-band);
      points.push({ t, lower, upper });
    }
    muConeFill.attr("d", muConeArea(points));
    muConeUpper.attr(
      "d",
      muConeLine(points.map((point) => ({ t: point.t, value: point.upper }))),
    );
    muConeLower.attr(
      "d",
      muConeLine(points.map((point) => ({ t: point.t, value: point.lower }))),
    );
  };

  const getPointerSample = (
    event: PointerEvent,
  ): { elapsed: number; price: number } | null => {
    const [rawX, rawY] = d3.pointer(
      event,
      interactionLayer.node() as SVGRectElement,
    );
    const clampedX = clamp(rawX, 0, mainWidth);
    const clampedY = clamp(rawY, 0, mainHeight);
    const timeIndex = x.invert(clampedX);
    const elapsed = timeIndex * props.params.dt;
    if (elapsed <= 0) return null;
    const price = y.invert(clampedY);
    if (price <= 0) return null;
    return { elapsed, price };
  };

  const getPointerElapsed = (
    event: PointerEvent,
  ): { elapsed: number; y: number } | null => {
    const [rawX, rawY] = d3.pointer(
      event,
      interactionLayer.node() as SVGRectElement,
    );
    const clampedX = clamp(rawX, 0, mainWidth);
    const timeIndex = x.invert(clampedX);
    const elapsed = timeIndex * props.params.dt;
    if (elapsed <= 0) return null;
    return { elapsed, y: rawY };
  };

  const getConeBounds = (
    elapsed: number,
    mu: number,
    vol: number,
  ): { upperY: number; lowerY: number } => {
    const center = baseline * Math.exp(mu * elapsed);
    const band = vol * Math.sqrt(elapsed);
    const upper = center * Math.exp(band);
    const lower = center * Math.exp(-band);
    return { upperY: y(upper), lowerY: y(lower) };
  };

  const getLineY = (elapsed: number, mu: number): number =>
    y(baseline * Math.exp(mu * elapsed));

  const getConeMetrics = (
    event: PointerEvent,
  ): {
    elapsed: number;
    y: number;
    upperY: number;
    lowerY: number;
    edgeDist: number;
  } | null => {
    const data = getPointerElapsed(event);
    if (!data) return null;
    const bounds = getConeBounds(data.elapsed, activeMu, activeVol);
    const edgeDist = Math.min(
      Math.abs(data.y - bounds.upperY),
      Math.abs(data.y - bounds.lowerY),
    );
    return { ...data, ...bounds, edgeDist };
  };

  const isVolDragZone = (event: PointerEvent): boolean => {
    const metrics = getConeMetrics(event);
    if (!metrics) return false;
    return metrics.edgeDist <= coneHitSlop;
  };

  const isDriftHit = (event: PointerEvent): boolean => {
    const data = getPointerElapsed(event);
    if (!data) return false;
    const lineY = getLineY(data.elapsed, activeMu);
    return Math.abs(data.y - lineY) <= driftHitSlop;
  };

  const updateMuGuide = (event: PointerEvent): void => {
    if (!trackingMode || isPointerDown) return;
    const sample = getPointerSample(event);
    if (!sample) return;
    const mu = Math.log(sample.price / baseline) / sample.elapsed;
    if (!Number.isFinite(mu)) return;
    activeMu = clamp(mu, minMu, maxMu);
    drawMuGuide(activeMu, activeVol);
  };

  const updateVolGuide = (event: PointerEvent, mu: number): void => {
    const sample = getPointerSample(event);
    if (!sample) return;
    const center = baseline * Math.exp(mu * sample.elapsed);
    const deviation = Math.abs(Math.log(sample.price / center));
    const sigma = deviation / Math.sqrt(sample.elapsed);
    if (!Number.isFinite(sigma)) return;
    activeVol = clamp(sigma, minVol, maxVol);
    drawMuGuide(mu, activeVol);
  };

  const updateCursor = (event: PointerEvent): void => {
    const shouldDragVol = isVolDragZone(event);
    const shouldDragDrift = !shouldDragVol && isDriftHit(event);
    driftHover = shouldDragDrift;
    muLine
      .style("stroke-width", driftHover ? 4.5 : 2.2)
      .style("stroke-opacity", driftHover ? 1 : 0.85);
    muConeUpper
      .style("stroke-width", shouldDragVol ? 4 : 1.5)
      .style("stroke-opacity", shouldDragVol ? 1 : 0.55);
    muConeLower
      .style("stroke-width", shouldDragVol ? 4 : 1.5)
      .style("stroke-opacity", shouldDragVol ? 1 : 0.55);
    if (svgRef.value) {
      d3.select(svgRef.value).style(
        "cursor",
        shouldDragVol ? "ns-resize" : shouldDragDrift ? "pointer" : "crosshair",
      );
    }
  };

  const setMuFromPointer = (event: PointerEvent): void => {
    if (!trackingMode) return;
    const sample = getPointerSample(event);
    if (!sample) return;
    const mu = Math.log(sample.price / baseline) / sample.elapsed;
    if (!Number.isFinite(mu)) return;
    const clampedMu = clamp(mu, minMu, maxMu);
    activeMu = clampedMu;
    drawMuGuide(activeMu, activeVol);
    emit("set-mu", clampedMu);
  };

  if (Number.isFinite(props.params.mu)) {
    activeMu = clamp(props.params.mu, minMu, maxMu);
    activeVol = clamp(props.params.vol, minVol, maxVol);
    drawMuGuide(activeMu, activeVol);
  }

  interactionHandlers = {
    pointermove: (event: PointerEvent) => {
      updateCursor(event as PointerEvent);
      if (isDraggingVol) {
        updateVolGuide(event as PointerEvent, dragMu);
        return;
      }
      if (!trackingMode) return;
      updateMuGuide(event as PointerEvent);
    },
    pointerenter: (event: PointerEvent) => {
      updateMuGuide(event as PointerEvent);
      updateCursor(event as PointerEvent);
    },
    pointerdown: (event: PointerEvent) => {
      if (!isVolDragZone(event as PointerEvent)) return;
      isPointerDown = true;
      trackingMode = true;
      dragMu = activeMu;
      isDraggingVol = true;
      suppressClick = true;
      updateVolGuide(event as PointerEvent, dragMu);
    },
    pointerup: () => {
      isPointerDown = false;
      if (!isDraggingVol) return;
      isDraggingVol = false;
      suppressClick = true;
      trackingMode = false;
      emit("set-vol", activeVol);
    },
    click: (event: PointerEvent) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (!trackingMode) {
        if (!isDriftHit(event as PointerEvent)) return;
        trackingMode = true;
        updateMuGuide(event as PointerEvent);
        return;
      }
      setMuFromPointer(event as PointerEvent);
      trackingMode = false;
    },
  };

  const updateHistogram = (progress: number): void => {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    bars
      .attr("x", (d) => barX(d, clampedProgress))
      .attr("width", (d) => barWidth(d, clampedProgress))
      .attr("fill", (d) => barFill(d));
  };

  const totalCloud = paths.length;
  if (!totalCloud && bins.length === 0) return;
  const cloudRenderIndices = d3.range(totalCloud);
  let cloudCursor = 0;

  const drawBatch = (now: number): void => {
    const start = drawBatchStartTs ?? now;
    drawBatchStartTs = start;
    const progress = Math.min(1, (now - start) / REVEAL_DURATION_MS);
    const targetCloud = Math.floor(progress * totalCloud);

    updateHistogram(progress);

    for (let i = cloudCursor; i < targetCloud; i += 1) {
      const pathIndex = cloudRenderIndices[i];
      drawCloudPath(
        paths[pathIndex],
        cloudFillForPath(pathIndex),
        opacityForPath(pathIndex),
      );
    }
    cloudCursor = targetCloud;

    if (progress < 1) {
      cloudRevealRaf = requestAnimationFrame(drawBatch);
      return;
    }
    updateHistogram(1);

    for (let i = cloudCursor; i < totalCloud; i += 1) {
      const pathIndex = cloudRenderIndices[i];
      drawCloudPath(
        paths[pathIndex],
        cloudFillForPath(pathIndex),
        opacityForPath(pathIndex),
      );
    }
    cloudCursor = totalCloud;
    drawBatchStartTs = null;
    cloudRevealRaf = null;
  };

  let drawBatchStartTs: number | null = null;
  cloudRevealRaf = requestAnimationFrame(drawBatch);
};

const draw = async (): Promise<void> => {
  if (!canvasRef.value) return;
  const sceneHandles = ensureScene();
  if (!sceneHandles) return;
  const canvas = canvasRef.value;
  const canvasCtx = canvas.getContext("2d");
  if (!canvasCtx) return;
  const drawSeq = ++latestDrawSeq;

  let sim: SimComputation;
  try {
    sim = await requestSimulation({
      seed: props.seed,
      params: sanitizeParamsForWorker(props.params),
      legs: sanitizeLegsForWorker(props.legs),
      optionPricingByLegId: sanitizeOptionPricingForWorker(
        props.optionPricingByLegId,
      ),
      valuationTs:
        props.valuationTs != null && Number.isFinite(props.valuationTs)
          ? Math.floor(props.valuationTs)
          : Math.floor(Date.now() / 1000),
      horizonSeconds: Math.max(0, props.params.T * SECONDS_PER_YEAR),
      histBins: Math.max(
        10,
        Math.min(400, Math.round(props.histBins ?? HISTOGRAM_BIN_COUNT)),
      ),
      histBinsMultiplier: clamp(
        Number(props.histBinsMultiplier ?? 1),
        1,
        2,
      ),
      samplePathLimit: Math.max(
        1,
        Math.min(
          Math.max(1, Math.round(props.params.rows)),
          Math.round(props.samplePathLimit ?? MAX_CLOUD_RENDER_PATHS),
        ),
      ),
    });
  } catch (error) {
    if (drawSeq === latestDrawSeq) {
      console.error("Failed to compute simulation in worker", error);
    }
    return;
  }

  if (drawSeq !== latestDrawSeq) return;
  updateDynamicScene(sceneHandles, canvas, canvasCtx, sim);
};

const scheduleDraw = (): void => {
  if (drawScheduleRaf != null) return;
  drawScheduleRaf = requestAnimationFrame(() => {
    drawScheduleRaf = null;
    draw();
  });
};

onMounted(draw);
watch(
  () => [
    props.seed,
    props.params.s0,
    props.params.mu,
    props.params.vol,
    props.params.T,
    props.params.dt,
    props.params.rows,
    props.valuationTs,
    props.histBins,
    props.histBinsMultiplier,
    props.samplePathLimit,
    props.histMode,
    props.colorMin,
    props.colorMax,
  ],
  scheduleDraw,
);
watch(() => props.legs, scheduleDraw, { deep: true });
watch(() => props.optionPricingByLegId, scheduleDraw, { deep: true });
onUnmounted(() => {
  if (cloudRevealRaf != null) {
    cancelAnimationFrame(cloudRevealRaf);
    cloudRevealRaf = null;
  }
  if (drawScheduleRaf != null) {
    cancelAnimationFrame(drawScheduleRaf);
    drawScheduleRaf = null;
  }
  if (simWorker != null) {
    simWorker.terminate();
    simWorker = null;
  }
  canvasTransformCache = {
    canvas: null,
    backingWidth: 0,
    backingHeight: 0,
    scaleX: 1,
    scaleY: 1,
  };
  cancelPendingSimRequests("Simulation worker disposed");
  interactionHandlers = null;
  scene = null;
});
</script>

<template>
  <div class="cloud-chart-layer">
    <canvas ref="canvasRef" aria-hidden="true"></canvas>
    <svg ref="svgRef" aria-label="Brownian motion cloud chart"></svg>
  </div>
</template>

<style scoped>
.cloud-chart-layer {
  position: absolute;
  inset: 0;
  font-family: inherit;
}

.cloud-chart-layer svg,
.cloud-chart-layer canvas {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(100% - var(--chart-header-height));
  display: block;
}

.cloud-chart-layer svg {
  cursor: crosshair;
  z-index: 2;
}

.cloud-chart-layer canvas {
  pointer-events: none;
  z-index: 1;
}

:deep(svg) {
  font-family: inherit;
}

:deep(.chart-meta-overlay text) {
  dominant-baseline: alphabetic;
}

:deep(.chart-meta-key) {
  fill: var(--text-muted);
  font-size: 10px;
  font-family: inherit;
}

:deep(.chart-meta-value) {
  fill: rgba(148, 163, 184, 0.95);
  font-size: 10px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

:deep(.grid line) {
  stroke: rgba(255, 255, 255, 0.08);
}

:deep(.grid path) {
  stroke: none;
}

:deep(.baseline) {
  stroke: rgba(126, 211, 255, 0.35);
  stroke-width: 1;
  stroke-dasharray: 4 6;
}

:deep(.paths path) {
  mix-blend-mode: normal;
}

:deep(.mu-guide line) {
  stroke: #fff;
}

:deep(.mu-guide),
:deep(.mu-guide *) {
  pointer-events: none;
}

:deep(.mu-cone-fill) {
  opacity: 1;
}

:deep(.mu-cone-edge) {
  fill: none;
  stroke: rgba(255, 255, 255, 0.55);
  stroke-width: 1.5;
}

:deep(.axis-label) {
  fill: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
}

:deep(.axis text) {
  fill: var(--text-muted);
  font-size: 10px;
  font-family: inherit;
}

:deep(.forward-value-label) {
  fill: rgba(148, 163, 184, 0.88);
  font-size: 10px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

:deep(.axis path),
:deep(.axis line),
:deep(.hist-baseline) {
  stroke: rgba(255, 255, 255, 0.18);
}

:deep(.hist-s0) {
  stroke: rgba(0, 0, 0, 0.35);
  stroke-width: 1;
}
</style>
