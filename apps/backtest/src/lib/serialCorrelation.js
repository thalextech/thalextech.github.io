import { HOUR_SECONDS } from "./ivRv.js";

const HOURS_PER_DAY = 24;
const HOURS_PER_WEEK = 7 * HOURS_PER_DAY;
const DEFAULT_VARIANCE_PROFILE_HARMONICS = 8;

export const RETURN_ADJUSTMENT = Object.freeze({
  RAW: "raw",
  MEAN: "mean_adjusted",
  VARIANCE_STANDARDIZED: "variance_standardized",
});

const normalizeOptionalWeekday = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : null;
};

const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

const sampleVariance = (values) => {
  if (values.length < 2) return null;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (values.length - 1);
};

const pearsonCorrelation = (pairs) => {
  if (pairs.length < 3) return null;
  const firstMean = mean(pairs.map((pair) => pair.first));
  const secondMean = mean(pairs.map((pair) => pair.second));
  let covariance = 0;
  let firstSquares = 0;
  let secondSquares = 0;
  for (const pair of pairs) {
    const firstDeviation = pair.first - firstMean;
    const secondDeviation = pair.second - secondMean;
    covariance += firstDeviation * secondDeviation;
    firstSquares += firstDeviation ** 2;
    secondSquares += secondDeviation ** 2;
  }
  const denominator = Math.sqrt(firstSquares * secondSquares);
  return denominator > 0 ? covariance / denominator : null;
};

const varianceFromStats = ({ count, sum, sumSquares }) => count > 1
  ? (sumSquares - sum ** 2 / count) / (count - 1)
  : null;

const quantileSorted = (values, probability) => {
  if (!values.length) return null;
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const weight = index - lower;
  return values[lower]
    + (values[Math.min(lower + 1, values.length - 1)] - values[lower]) * weight;
};

const createSeededRandom = (seed = 1) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
};

const resolveReturnAdjustment = ({ adjustment, deseasonalize }) => {
  if (Object.values(RETURN_ADJUSTMENT).includes(adjustment)) return adjustment;
  return deseasonalize === false ? RETURN_ADJUSTMENT.RAW : RETURN_ADJUSTMENT.MEAN;
};

const weeklyBucketIndex = ({ weekday, hour }) => weekday * HOURS_PER_DAY + hour;

const normalizeBarHours = (value) => {
  const hours = Math.max(1, Math.trunc(Number(value) || 1));
  return HOURS_PER_DAY % hours === 0 ? hours : 1;
};

const smoothWeeklyLogVariance = (
  logVariances,
  harmonics = DEFAULT_VARIANCE_PROFILE_HARMONICS,
) => {
  const count = logVariances.length;
  const maximumHarmonic = Math.min(
    Math.max(0, Math.trunc(Number(harmonics) || 0)),
    Math.floor((count - 1) / 2),
  );
  const intercept = mean(logVariances);
  const coefficients = Array.from({ length: maximumHarmonic }, (_, index) => {
    const harmonic = index + 1;
    const scale = 2 / count;
    return {
      harmonic,
      cosine: scale * logVariances.reduce((sum, value, bucket) =>
        sum + value * Math.cos(2 * Math.PI * harmonic * bucket / count), 0),
      sine: scale * logVariances.reduce((sum, value, bucket) =>
        sum + value * Math.sin(2 * Math.PI * harmonic * bucket / count), 0),
    };
  });
  return logVariances.map((_, bucket) => Math.exp(
    intercept + coefficients.reduce((sum, coefficient) => {
      const phase = 2 * Math.PI * coefficient.harmonic * bucket / count;
      return sum
        + coefficient.cosine * Math.cos(phase)
        + coefficient.sine * Math.sin(phase);
    }, 0),
  ));
};

export function buildHourlyLogReturns(rows = [], {
  adjustment,
  barHours = 1,
  deseasonalize,
  varianceProfileHarmonics = DEFAULT_VARIANCE_PROFILE_HARMONICS,
} = {}) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const ts = Number(row?.ts);
    const open = Number(row?.open);
    const close = Number(row?.close);
    if (
      !Number.isFinite(ts)
      || !Number.isInteger(ts / HOUR_SECONDS)
      || !Number.isFinite(open)
      || !Number.isFinite(close)
      || open <= 0
      || close <= 0
    ) continue;
    const date = new Date(ts * 1000);
    byTimestamp.set(ts, {
      ts,
      date,
      weekday: date.getUTCDay(),
      hour: date.getUTCHours(),
      rawReturn: Math.log(close / open),
    });
  }
  const hourlyReturns = [...byTimestamp.values()].sort((first, second) => first.ts - second.ts);
  const normalizedBarHours = normalizeBarHours(barHours);
  const barReturns = normalizedBarHours === 1
    ? hourlyReturns
    : hourlyReturns.flatMap((anchor) => {
      let rawReturn = 0;
      for (let offset = 0; offset < normalizedBarHours; offset += 1) {
        const component = byTimestamp.get(anchor.ts + offset * HOUR_SECONDS);
        if (!component) return [];
        rawReturn += component.rawReturn;
      }
      return [{ ...anchor, rawReturn, barHours: normalizedBarHours }];
    });
  const returnAdjustment = resolveReturnAdjustment({ adjustment, deseasonalize });
  if (returnAdjustment === RETURN_ADJUSTMENT.RAW) {
    return barReturns.map((row) => ({ ...row, value: row.rawReturn }));
  }

  const valuesByBucket = new Map();
  for (const row of barReturns) {
    const key = `${row.weekday}-${row.hour}`;
    if (!valuesByBucket.has(key)) valuesByBucket.set(key, []);
    valuesByBucket.get(key).push(row.rawReturn);
  }
  const meansByBucket = new Map(
    [...valuesByBucket].map(([key, values]) => [key, mean(values)]),
  );
  const meanAdjustedReturns = barReturns.map((row) => ({
    ...row,
    value: row.rawReturn - meansByBucket.get(`${row.weekday}-${row.hour}`),
  }));
  if (returnAdjustment === RETURN_ADJUSTMENT.MEAN) return meanAdjustedReturns;

  const pooledVariance = sampleVariance(meanAdjustedReturns.map((row) => row.value));
  const adjustedValuesByBucket = Array.from({ length: HOURS_PER_WEEK }, () => []);
  meanAdjustedReturns.forEach((row) => {
    adjustedValuesByBucket[weeklyBucketIndex(row)].push(row.value);
  });
  const logVariances = adjustedValuesByBucket.map((values) => {
    const bucketVariance = sampleVariance(values);
    const usableVariance = Number.isFinite(bucketVariance) && bucketVariance > 0
      ? bucketVariance
      : pooledVariance;
    return Math.log(Number.isFinite(usableVariance) && usableVariance > 0 ? usableVariance : 1);
  });
  const smoothedVariances = smoothWeeklyLogVariance(
    logVariances,
    varianceProfileHarmonics,
  );
  return meanAdjustedReturns.map((row) => ({
    ...row,
    value: row.value / Math.sqrt(smoothedVariances[weeklyBucketIndex(row)]),
  }));
}

export function buildComplete24HourWindows(
  hourlyReturns = [],
  closeHour = 0,
  closeWeekday = null,
  { anchorMode = "close", barHours = 1 } = {},
) {
  const normalizedCloseHour = Math.max(0, Math.min(23, Math.trunc(Number(closeHour) || 0)));
  const normalizedCloseWeekday = normalizeOptionalWeekday(closeWeekday);
  const forwardFromAnchor = anchorMode === "start";
  const normalizedBarHours = normalizeBarHours(barHours);
  const barsPerWindow = Math.floor(HOURS_PER_DAY / normalizedBarHours);
  const returnByTimestamp = new Map(hourlyReturns.map((row) => [row.ts, row]));
  const windows = [];
  for (const anchor of hourlyReturns) {
    if (
      anchor.hour !== normalizedCloseHour
      || (normalizedCloseWeekday !== null && anchor.weekday !== normalizedCloseWeekday)
    ) continue;
    const values = [];
    const startTs = forwardFromAnchor
      ? anchor.ts
      : anchor.ts - (barsPerWindow - 1) * normalizedBarHours * HOUR_SECONDS;
    for (let bar = 0; bar < barsPerWindow; bar += 1) {
      const row = returnByTimestamp.get(
        startTs + bar * normalizedBarHours * HOUR_SECONDS,
      );
      if (!row) {
        values.length = 0;
        break;
      }
      values.push(row.value);
    }
    if (values.length !== barsPerWindow) continue;
    windows.push({
      startTs,
      endTs: startTs + (HOURS_PER_DAY - 1) * HOUR_SECONDS,
      values,
    });
  }
  return windows;
}

export function buildVarianceRatioCurve(hourlyReturns = [], { maxHours = 168 } = {}) {
  const sorted = [...hourlyReturns].sort((first, second) => first.ts - second.ts);
  const oneHourVariance = sampleVariance(sorted.map((row) => row.value));
  const maximum = Math.max(1, Math.trunc(Number(maxHours) || 168));
  const contiguousRuns = [];
  for (const row of sorted) {
    const current = contiguousRuns.at(-1);
    if (!current || row.ts !== current.endTs + HOUR_SECONDS) {
      contiguousRuns.push({ endTs: row.ts, values: [row.value] });
    } else {
      current.values.push(row.value);
      current.endTs = row.ts;
    }
  }

  return Array.from({ length: maximum }, (_, index) => {
    const horizon = index + 1;
    const returns = [];
    for (const run of contiguousRuns) {
      if (run.values.length < horizon) continue;
      let total = run.values.slice(0, horizon).reduce((sum, value) => sum + value, 0);
      returns.push(total);
      for (let end = horizon; end < run.values.length; end += 1) {
        total += run.values[end] - run.values[end - horizon];
        returns.push(total);
      }
    }
    const variance = sampleVariance(returns);
    return {
      horizon,
      count: returns.length,
      variance,
      ratio: Number.isFinite(variance) && oneHourVariance > 0
        ? variance / (horizon * oneHourVariance)
        : null,
    };
  });
}

const buildHorizonStats = (values) => Array.from({ length: HOURS_PER_DAY }, (_, index) => {
  const horizon = index + 1;
  const returns = [];
  let total = values.slice(0, horizon).reduce((sum, value) => sum + value, 0);
  returns.push(total);
  for (let end = horizon; end < values.length; end += 1) {
    total += values[end] - values[end - horizon];
    returns.push(total);
  }
  return {
    count: returns.length,
    sum: returns.reduce((sum, value) => sum + value, 0),
    sumSquares: returns.reduce((sum, value) => sum + value ** 2, 0),
  };
});

const combineStats = (target, source) => {
  target.count += source.count;
  target.sum += source.sum;
  target.sumSquares += source.sumSquares;
};

export function buildDayBootstrapVarianceRatios(hourlyReturns = [], {
  closeHour = 0,
  closeWeekday = null,
  anchorMode = "close",
  replications = 400,
  confidence = 0.95,
  seed = 94721,
} = {}) {
  const windows = buildComplete24HourWindows(
    hourlyReturns,
    closeHour,
    closeWeekday,
    { anchorMode },
  );
  const blockStats = windows.map((window) => buildHorizonStats(window.values));
  const pointStats = Array.from(
    { length: HOURS_PER_DAY },
    () => ({ count: 0, sum: 0, sumSquares: 0 }),
  );
  blockStats.forEach((day) => day.forEach((stats, index) => combineStats(pointStats[index], stats)));
  const pointOneHourVariance = varianceFromStats(pointStats[0]);
  const pointRows = pointStats.map((stats, index) => {
    const horizon = index + 1;
    const variance = varianceFromStats(stats);
    return {
      horizon,
      count: stats.count,
      variance,
      oneHourVariance: pointOneHourVariance,
      ratio: Number.isFinite(variance) && pointOneHourVariance > 0
        ? variance / (horizon * pointOneHourVariance)
        : null,
    };
  });

  const replicationCount = Math.max(0, Math.trunc(Number(replications) || 0));
  if (windows.length < 2 || replicationCount < 20) {
    return pointRows.map((row) => ({
      ...row,
      ciLower: null,
      ciUpper: null,
      significantBelowOne: null,
      bootstrapWindows: windows.length,
      bootstrapReplications: replicationCount,
    }));
  }

  const estimates = Array.from({ length: HOURS_PER_DAY }, () => []);
  const random = createSeededRandom(seed);
  for (let replication = 0; replication < replicationCount; replication += 1) {
    const combined = Array.from(
      { length: HOURS_PER_DAY },
      () => ({ count: 0, sum: 0, sumSquares: 0 }),
    );
    for (let sample = 0; sample < blockStats.length; sample += 1) {
      const day = blockStats[Math.floor(random() * blockStats.length)];
      day.forEach((stats, index) => combineStats(combined[index], stats));
    }
    const oneHourVariance = varianceFromStats(combined[0]);
    combined.forEach((stats, index) => {
      const variance = varianceFromStats(stats);
      const ratio = variance / ((index + 1) * oneHourVariance);
      if (Number.isFinite(ratio)) estimates[index].push(ratio);
    });
  }

  const alpha = Math.max(0.001, Math.min(0.499, (1 - confidence) / 2));
  return pointRows.map((row, index) => {
    const values = estimates[index].sort((first, second) => first - second);
    const ciLower = quantileSorted(values, alpha);
    const ciUpper = quantileSorted(values, 1 - alpha);
    return {
      ...row,
      ciLower,
      ciUpper,
      significantBelowOne: Number.isFinite(ciUpper) ? ciUpper < 1 : null,
      bootstrapWindows: windows.length,
      bootstrapReplications: values.length,
    };
  });
}

export function buildCloseHourVr24Range(hourlyReturns = [], {
  closeWeekday = null,
  anchorMode = "close",
  barHours = 1,
} = {}) {
  const normalizedBarHours = normalizeBarHours(barHours);
  const barsPerWindow = Math.floor(HOURS_PER_DAY / normalizedBarHours);
  const rows = Array.from({ length: HOURS_PER_DAY }, (_, closeHour) => {
    const windows = buildComplete24HourWindows(
      hourlyReturns,
      closeHour,
      closeWeekday,
      { anchorMode, barHours: normalizedBarHours },
    );
    const hourlyValues = windows.flatMap((window) => window.values);
    const dailyValues = windows.map((window) =>
      window.values.reduce((sum, value) => sum + value, 0),
    );
    const baseBarVariance = sampleVariance(hourlyValues);
    const dailyVariance = sampleVariance(dailyValues);
    return {
      closeHour,
      barHours: normalizedBarHours,
      windowCount: windows.length,
      ratio: Number.isFinite(dailyVariance) && baseBarVariance > 0
        ? dailyVariance / (barsPerWindow * baseBarVariance)
        : null,
    };
  }).filter((row) => Number.isFinite(row.ratio));
  if (!rows.length) return null;
  const sorted = [...rows].sort((first, second) => first.ratio - second.ratio);
  return {
    rows,
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
}

export function buildForwardVarianceRatioSeasonality(rows = [], {
  adjustment,
  barHours = 1,
  deseasonalize,
  varianceProfileHarmonics = DEFAULT_VARIANCE_PROFILE_HARMONICS,
} = {}) {
  const hourlyReturns = buildHourlyLogReturns(rows, {
    adjustment,
    barHours,
    deseasonalize,
    varianceProfileHarmonics,
  });
  return Array.from({ length: 7 }, (_, weekday) =>
    buildCloseHourVr24Range(hourlyReturns, {
      closeWeekday: weekday,
      anchorMode: "start",
      barHours,
    })?.rows.map((row) => ({
      ...row,
      weekday,
      hour: row.closeHour,
    })) || [],
  ).flat();
}

export function buildHourlySerialCorrelationSeasonality(rows = []) {
  const returns = buildHourlyLogReturns(rows, {
    adjustment: RETURN_ADJUSTMENT.RAW,
  });
  return Array.from({ length: 7 }, (_, weekday) =>
    Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
      const windows = buildComplete24HourWindows(returns, hour, weekday, {
        anchorMode: "start",
      });
      const correlations = windows.map((window) => pearsonCorrelation(
        window.values.slice(0, -1).map((value, index) => ({
          first: value,
          second: window.values[index + 1],
        })),
      )).filter(Number.isFinite);
      const correlation = mean(correlations);
      return {
        weekday,
        hour,
        count: correlations.length,
        pairCount: correlations.length * (HOURS_PER_DAY - 1),
        correlation,
        values: correlations,
      };
    }),
  ).flat();
}

export function calculateVarianceRatioDashboard(rows = [], {
  adjustment,
  deseasonalize,
  varianceProfileHarmonics = DEFAULT_VARIANCE_PROFILE_HARMONICS,
  closeHour = 0,
  closeWeekday = null,
  anchorMode = "close",
  bootstrapReplications = 400,
} = {}) {
  const normalizedCloseHour = Math.max(0, Math.min(23, Math.trunc(Number(closeHour) || 0)));
  const normalizedCloseWeekday = normalizeOptionalWeekday(closeWeekday);
  const returnAdjustment = resolveReturnAdjustment({ adjustment, deseasonalize });
  const hourlyReturns = buildHourlyLogReturns(rows, {
    adjustment: returnAdjustment,
    varianceProfileHarmonics,
  });
  const dayBootstrapRows = buildDayBootstrapVarianceRatios(hourlyReturns, {
    closeHour: normalizedCloseHour,
    closeWeekday: normalizedCloseWeekday,
    anchorMode,
    replications: bootstrapReplications,
  });
  const varianceRatios = dayBootstrapRows.map((row) => ({
    ...row,
    estimator: anchorMode === "start" ? "entry_hour_forward" : "close_hour_anchored",
  }));
  const baseHeadline = varianceRatios[HOURS_PER_DAY - 1] || null;
  const returnsHavePriceUnits = returnAdjustment !== RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED;
  const annualizedHourlyVolatility = returnsHavePriceUnits
    && Number.isFinite(baseHeadline?.oneHourVariance)
    ? Math.sqrt(365 * HOURS_PER_DAY * baseHeadline.oneHourVariance)
    : null;
  const annualizedDailyVolatility = returnsHavePriceUnits
    && Number.isFinite(baseHeadline?.variance)
    ? Math.sqrt(365 * baseHeadline.variance)
    : null;
  const headline = baseHeadline ? {
    ...baseHeadline,
    estimator: anchorMode === "start" ? "forward_daily" : "anchored_daily",
    varianceDifference: 1 - baseHeadline.ratio,
    annualizedHourlyVolatility,
    annualizedDailyVolatility,
    volatilityDifferencePoints: Number.isFinite(annualizedHourlyVolatility)
      && Number.isFinite(annualizedDailyVolatility)
      ? (annualizedHourlyVolatility - annualizedDailyVolatility) * 100
      : null,
  } : null;
  const intradayRows = varianceRatios.slice(1);
  const trough = intradayRows.length
    ? intradayRows.reduce((minimum, row) => row.ratio < minimum.ratio ? row : minimum)
    : null;
  return {
    varianceRatios,
    headline,
    termStructureVr24: varianceRatios[HOURS_PER_DAY - 1] || null,
    trough,
    closeHourRange: buildCloseHourVr24Range(hourlyReturns, {
      closeWeekday: normalizedCloseWeekday,
      anchorMode,
    }),
    sampleSize: hourlyReturns.length,
    deseasonalize: returnAdjustment !== RETURN_ADJUSTMENT.RAW,
    returnAdjustment,
    closeHour: normalizedCloseHour,
    closeWeekday: normalizedCloseWeekday,
    anchorHour: normalizedCloseHour,
    anchorWeekday: normalizedCloseWeekday,
    anchorMode,
    maxHours: varianceRatios.at(-1)?.horizon || 0,
  };
}
