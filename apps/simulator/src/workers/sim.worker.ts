import { blackScholesGreeks } from "../lib/blackScholes";
import type { GBMParams } from "../lib/gbm";
import type { FutureLeg, OptionLeg, PositionLeg } from "../lib/position";

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
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

type PreparedOptionLeg = {
  sign: number;
  qty: number;
  strike: number;
  optionType: OptionLeg["optionType"];
  iv: number;
  entryPrice: number;
  remainingYears: number;
};

type PreparedFuturePathLeg = {
  sign: number;
  qty: number;
  entry: number | null;
  stopLoss: number | null;
  isBuy: boolean;
};
type TailCandidate = {
  index: number;
  finalPrice: number;
  path: Float64Array;
};

type Rng = () => number;
type Randn = () => number;

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const RISK_FREE_RATE = 0.0;
const TAIL_PATH_POOL_SIZE = 256;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mulberry32 = (seed: number): Rng => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const makeRandn = (rng: Rng): Randn => {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const magnitude = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };
};

const medianOfArray = (values: number[]): number => {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
};

const medianOfTypedArray = (values: Float64Array): number => {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
};

const quantileSorted = (sorted: Float64Array, p: number): number => {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const clampedP = clamp(p, 0, 1);
  const idx = (n - 1) * clampedP;
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
};

const computeAdaptiveBinCount = (
  values: Float64Array,
  rangeMin: number,
  rangeMax: number,
  maxBins: number,
): number => {
  const n = values.length;
  const range = rangeMax - rangeMin;
  if (n < 2 || !Number.isFinite(range) || range <= 0) {
    return clamp(maxBins, 10, 400);
  }

  const sorted = Float64Array.from(values);
  sorted.sort();
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;

  // Freedman-Diaconis bin width.
  let binWidth = 2 * iqr * Math.pow(n, -1 / 3);
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    // Fallback when IQR collapses (heavy concentration / ties).
    binWidth = range / Math.max(10, Math.round(Math.sqrt(n)));
  }
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    return clamp(maxBins, 10, 400);
  }

  const autoBins = Math.ceil(range / binWidth);
  return clamp(autoBins, 10, maxBins);
};

const pickSampleIndices = (rows: number, limit: number, seed: number): number[] => {
  if (rows <= 0) return [];
  if (limit >= rows) return Array.from({ length: rows }, (_, i) => i);

  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const selected = Array.from({ length: limit }, (_, i) => i);
  for (let i = limit; i < rows; i += 1) {
    const j = Math.floor(rng() * (i + 1));
    if (j < limit) selected[j] = i;
  }
  selected.sort((a, b) => a - b);
  return selected;
};

const insertLowTailCandidate = (
  pool: TailCandidate[],
  candidate: TailCandidate,
  limit: number,
): void => {
  if (pool.length === 0) {
    pool.push(candidate);
    return;
  }
  if (pool.length < limit) {
    let i = pool.length - 1;
    while (i >= 0 && candidate.finalPrice < pool[i].finalPrice) i -= 1;
    pool.splice(i + 1, 0, candidate);
    return;
  }
  if (candidate.finalPrice >= pool[pool.length - 1].finalPrice) return;
  let i = pool.length - 2;
  while (i >= 0 && candidate.finalPrice < pool[i].finalPrice) i -= 1;
  pool.splice(i + 1, 0, candidate);
  pool.pop();
};

const insertHighTailCandidate = (
  pool: TailCandidate[],
  candidate: TailCandidate,
  limit: number,
): void => {
  if (pool.length === 0) {
    pool.push(candidate);
    return;
  }
  if (pool.length < limit) {
    let i = pool.length - 1;
    while (i >= 0 && candidate.finalPrice > pool[i].finalPrice) i -= 1;
    pool.splice(i + 1, 0, candidate);
    return;
  }
  if (candidate.finalPrice <= pool[pool.length - 1].finalPrice) return;
  let i = pool.length - 2;
  while (i >= 0 && candidate.finalPrice > pool[i].finalPrice) i -= 1;
  pool.splice(i + 1, 0, candidate);
  pool.pop();
};

const prepareLegs = (
  request: SimWorkerRequest,
): {
  hasPositionLegs: boolean;
  optionLegs: PreparedOptionLeg[];
  futureLegs: PreparedFuturePathLeg[];
} => {
  const optionLegs: PreparedOptionLeg[] = [];
  const futureLegs: PreparedFuturePathLeg[] = [];
  const hasPositionLegs = (request.legs?.length ?? 0) > 0;

  for (const leg of request.legs ?? []) {
    if (leg.kind !== "option") {
      const future = leg as FutureLeg;
      const qty =
        Number.isFinite(future.qty) && future.qty > 0 ? future.qty : 0;
      if (qty <= 0) continue;
      const entry = Number.isFinite(future.entry) ? future.entry : null;
      const stopLoss =
        future.stopLoss == null || !Number.isFinite(future.stopLoss)
          ? null
          : future.stopLoss;
      futureLegs.push({
        sign: future.side === "buy" ? 1 : -1,
        qty,
        entry,
        stopLoss,
        isBuy: future.side === "buy",
      });
      continue;
    }

    const option = leg as OptionLeg;
    const qty =
      Number.isFinite(option.qty) && option.qty > 0 ? option.qty : 0;
    const strike = Number(option.strike);
    if (!Number.isFinite(strike) || qty <= 0) continue;
    const sign = option.side === "buy" ? 1 : -1;
    const pricing = request.optionPricingByLegId?.[option.id];
    const iv =
      pricing?.iv != null && Number.isFinite(pricing.iv) && pricing.iv > 0
        ? pricing.iv
        : request.params.vol;
    const entryPrice =
      pricing?.mark != null && Number.isFinite(pricing.mark)
        ? pricing.mark
        : Number.isFinite(option.premium)
          ? option.premium
          : 0;
    const expiryTs =
      pricing?.expirationTs != null && Number.isFinite(pricing.expirationTs)
        ? pricing.expirationTs
        : null;
    const remainingSeconds =
      expiryTs != null
        ? Math.max(0, expiryTs - request.valuationTs - request.horizonSeconds)
        : 0;
    optionLegs.push({
      sign,
      qty,
      strike,
      optionType: option.optionType,
      iv,
      entryPrice,
      remainingYears: remainingSeconds / SECONDS_PER_YEAR,
    });
  }

  return { hasPositionLegs, optionLegs, futureLegs };
};

const simulate = (request: SimWorkerRequest): SimWorkerSuccess => {
  const steps = Math.max(1, Math.floor(request.params.T / request.params.dt));
  const rows = Math.max(1, Math.floor(request.params.rows));
  const baseline = request.params.s0;
  const histBinsCap = clamp(Math.round(request.histBins), 10, 400);
  const histBinsMultiplier = clamp(
    Number(request.histBinsMultiplier ?? 1),
    1,
    2,
  );
  const samplePathLimit = clamp(Math.round(request.samplePathLimit), 1, rows);

  const finalPrices = new Float64Array(rows);
  const payoffs = new Float64Array(rows);

  const drift =
    (request.params.mu - 0.5 * request.params.vol * request.params.vol) *
    request.params.dt;
  const volStep = request.params.vol * Math.sqrt(request.params.dt);
  const rng = mulberry32(request.seed);
  const randn = makeRandn(rng);

  const { hasPositionLegs, optionLegs, futureLegs } = prepareLegs(request);

  const sampledIndices = pickSampleIndices(rows, samplePathLimit, request.seed);
  const sampledSet = new Set<number>(sampledIndices);
  const sampledPathByIndex = new Map<number, Float64Array>();
  const lowTailPool: TailCandidate[] = [];
  const highTailPool: TailCandidate[] = [];

  let pathMin = baseline;
  let pathMax = baseline;
  let finalPriceMin = Number.POSITIVE_INFINITY;
  let finalPriceMax = Number.NEGATIVE_INFINITY;
  let payoffMin = Number.POSITIVE_INFINITY;
  let payoffMax = Number.NEGATIVE_INFINITY;
  let payoffSum = 0;
  let wins = 0;
  let maxDrawdown = 0;

  for (let r = 0; r < rows; r += 1) {
    const path = new Float64Array(steps);
    let s = baseline;
    let peak = baseline;
    let worstDrawdown = 0;

    for (let c = 0; c < steps; c += 1) {
      const z = randn();
      s *= Math.exp(drift + volStep * z);
      path[c] = s;

      if (s < pathMin) pathMin = s;
      if (s > pathMax) pathMax = s;

      if (s > peak) peak = s;
      if (peak > 0) {
        const drawdown = (peak - s) / peak;
        if (drawdown > worstDrawdown) worstDrawdown = drawdown;
      }
    }

    if (worstDrawdown > maxDrawdown) maxDrawdown = worstDrawdown;

    finalPrices[r] = s;
    if (s < finalPriceMin) finalPriceMin = s;
    if (s > finalPriceMax) finalPriceMax = s;

    let total = 0;
    if (!hasPositionLegs) {
      total = s - baseline;
    } else {
      for (const leg of optionLegs) {
        const modelPrice = blackScholesGreeks(
          s,
          leg.strike,
          leg.remainingYears,
          leg.iv,
          RISK_FREE_RATE,
          leg.optionType,
        ).price;
        total += leg.sign * leg.qty * (modelPrice - leg.entryPrice);
      }

      for (const leg of futureLegs) {
        const entryPrice = leg.entry ?? s;
        let exitPrice = s;
        if (leg.stopLoss != null) {
          if (leg.isBuy) {
            for (let c = 0; c < steps; c += 1) {
              const value = path[c];
              if (Number.isFinite(value) && value <= leg.stopLoss) {
                exitPrice = leg.stopLoss;
                break;
              }
            }
          } else {
            for (let c = 0; c < steps; c += 1) {
              const value = path[c];
              if (Number.isFinite(value) && value >= leg.stopLoss) {
                exitPrice = leg.stopLoss;
                break;
              }
            }
          }
        }
        total += leg.sign * leg.qty * (exitPrice - entryPrice);
      }
    }

    payoffs[r] = total;
    payoffSum += total;
    if (total > 0) wins += 1;
    if (total < payoffMin) payoffMin = total;
    if (total > payoffMax) payoffMax = total;

    if (sampledSet.has(r)) {
      sampledPathByIndex.set(r, path);
    }
    if (rows > samplePathLimit) {
      const tailCandidate: TailCandidate = {
        index: r,
        finalPrice: s,
        path: path.slice(),
      };
      insertLowTailCandidate(lowTailPool, tailCandidate, TAIL_PATH_POOL_SIZE);
      insertHighTailCandidate(highTailPool, tailCandidate, TAIL_PATH_POOL_SIZE);
    }

  }

  if (!Number.isFinite(payoffMin)) payoffMin = 0;
  if (!Number.isFinite(payoffMax)) payoffMax = 0;
  if (!Number.isFinite(finalPriceMin)) finalPriceMin = baseline;
  if (!Number.isFinite(finalPriceMax)) finalPriceMax = baseline;

  const meanPayoff = rows > 0 ? payoffSum / rows : 0;
  const medianPayoff = medianOfTypedArray(payoffs);
  const maxPayoff = payoffMax;
  const winRate = rows > 0 ? wins / rows : 0;

  const maxDelta = Math.max(
    Math.abs(pathMin - baseline),
    Math.abs(pathMax - baseline),
  );
  const paddedDelta = maxDelta * 1.02;
  const safeDelta =
    Number.isFinite(paddedDelta) && paddedDelta > 0 ? paddedDelta : 1;
  const binMin = baseline - safeDelta;
  const binMax = baseline + safeDelta;
  const baseBins = computeAdaptiveBinCount(
    finalPrices,
    binMin,
    binMax,
    histBinsCap,
  );
  const histBins = clamp(
    Math.round(baseBins * histBinsMultiplier),
    10,
    histBinsCap,
  );
  const binSize = (binMax - binMin) / histBins;
  const invBinSize = binSize > 0 ? 1 / binSize : 0;

  const counts = new Uint32Array(histBins);
  const sums = new Float64Array(histBins);
  const payoffLists: number[][] = Array.from({ length: histBins }, () => []);

  const findBinIndex = (value: number): number => {
    if (!Number.isFinite(value) || value <= binMin) return 0;
    if (value >= binMax) return histBins - 1;
    if (invBinSize <= 0) return 0;
    const idx = Math.floor((value - binMin) * invBinSize);
    if (idx < 0) return 0;
    if (idx >= histBins) return histBins - 1;
    return idx;
  };

  for (let i = 0; i < rows; i += 1) {
    const idx = findBinIndex(finalPrices[i]);
    counts[idx] += 1;
    sums[idx] += payoffs[i];
    payoffLists[idx].push(payoffs[i]);
  }

  const bins: SimBin[] = new Array(histBins);
  for (let i = 0; i < histBins; i += 1) {
    const x0 = binMin + i * binSize;
    const x1 = i === histBins - 1 ? binMax : x0 + binSize;
    bins[i] = {
      x0,
      x1,
      count: counts[i],
      sumPayoff: sums[i],
      medianPayoff: medianOfArray(payoffLists[i]),
    };
  }

  const sampleIndexSet = new Set<number>(sampledIndices);
  if (rows > samplePathLimit) {
    // Add mild-tail representatives so the cloud better matches histogram width
    // without forcing extremely rare min/max outliers.
    const lowTailAnchor = lowTailPool[lowTailPool.length - 1];
    const highTailAnchor = highTailPool[highTailPool.length - 1];
    if (lowTailAnchor) sampleIndexSet.add(lowTailAnchor.index);
    if (highTailAnchor) sampleIndexSet.add(highTailAnchor.index);
  }
  const sampleIndices = Array.from(sampleIndexSet).sort((a, b) => a - b);

  const tailPathByIndex = new Map<number, Float64Array>();
  for (const candidate of lowTailPool) {
    tailPathByIndex.set(candidate.index, candidate.path);
  }
  for (const candidate of highTailPool) {
    tailPathByIndex.set(candidate.index, candidate.path);
  }

  const sampleRows = sampleIndices.length;
  const sampledPaths = new Float64Array(sampleRows * steps);
  const sampledFinalPrices = new Float64Array(sampleRows);
  const sampledPayoffs = new Float64Array(sampleRows);

  for (let i = 0; i < sampleRows; i += 1) {
    const pathIndex = sampleIndices[i];
    let path = sampledPathByIndex.get(pathIndex) ?? tailPathByIndex.get(pathIndex);
    if (!path) {
      path = new Float64Array(steps);
    }
    sampledPaths.set(path, i * steps);
    sampledFinalPrices[i] = finalPrices[pathIndex] ?? baseline;
    sampledPayoffs[i] = payoffs[pathIndex] ?? 0;
  }

  return {
    id: request.id,
    steps,
    rows,
    sampleRows,
    sampledPathsBuffer: sampledPaths.buffer,
    sampledFinalPricesBuffer: sampledFinalPrices.buffer,
    sampledPayoffsBuffer: sampledPayoffs.buffer,
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
  };
};

const scope = self as DedicatedWorkerGlobalScope;
let queuedRequest: SimWorkerRequest | null = null;
let processing = false;

const processQueue = (): void => {
  if (processing) return;
  processing = true;
  while (queuedRequest != null) {
    const request = queuedRequest;
    queuedRequest = null;
    try {
      const response = simulate(request);
      scope.postMessage(response, [
        response.sampledPathsBuffer,
        response.sampledFinalPricesBuffer,
        response.sampledPayoffsBuffer,
      ]);
    } catch (error) {
      const response: SimWorkerError = {
        id: request.id,
        error: error instanceof Error ? error.message : "Unknown worker error",
      };
      scope.postMessage(response);
    }
  }
  processing = false;
};

scope.onmessage = (event: MessageEvent<SimWorkerRequest>): void => {
  queuedRequest = event.data;
  processQueue();
};
