import { HOUR_SECONDS } from "./ivRv.js";

const HOURS_PER_DAY = 24;

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

export function buildHourlyLogReturns(rows = [], { deseasonalize = true } = {}) {
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
  if (!deseasonalize) {
    return hourlyReturns.map((row) => ({ ...row, value: row.rawReturn }));
  }

  const valuesByBucket = new Map();
  for (const row of hourlyReturns) {
    const key = `${row.weekday}-${row.hour}`;
    if (!valuesByBucket.has(key)) valuesByBucket.set(key, []);
    valuesByBucket.get(key).push(row.rawReturn);
  }
  const meansByBucket = new Map(
    [...valuesByBucket].map(([key, values]) => [key, mean(values)]),
  );
  return hourlyReturns.map((row) => ({
    ...row,
    value: row.rawReturn - meansByBucket.get(`${row.weekday}-${row.hour}`),
  }));
}

export function buildComplete24HourWindows(
  hourlyReturns = [],
  closeHour = 0,
  closeWeekday = null,
) {
  const normalizedCloseHour = Math.max(0, Math.min(23, Math.trunc(Number(closeHour) || 0)));
  const normalizedCloseWeekday = normalizeOptionalWeekday(closeWeekday);
  const returnByTimestamp = new Map(hourlyReturns.map((row) => [row.ts, row]));
  const windows = [];
  for (const end of hourlyReturns) {
    if (
      end.hour !== normalizedCloseHour
      || (normalizedCloseWeekday !== null && end.weekday !== normalizedCloseWeekday)
    ) continue;
    const values = [];
    for (let hoursBack = HOURS_PER_DAY - 1; hoursBack >= 0; hoursBack -= 1) {
      const row = returnByTimestamp.get(end.ts - hoursBack * HOUR_SECONDS);
      if (!row) {
        values.length = 0;
        break;
      }
      values.push(row.value);
    }
    if (values.length !== HOURS_PER_DAY) continue;
    windows.push({
      startTs: end.ts - (HOURS_PER_DAY - 1) * HOUR_SECONDS,
      endTs: end.ts,
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
  replications = 400,
  confidence = 0.95,
  seed = 94721,
} = {}) {
  const windows = buildComplete24HourWindows(hourlyReturns, closeHour, closeWeekday);
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

export function buildCloseHourVr24Range(hourlyReturns = [], { closeWeekday = null } = {}) {
  const rows = Array.from({ length: HOURS_PER_DAY }, (_, closeHour) => {
    const windows = buildComplete24HourWindows(hourlyReturns, closeHour, closeWeekday);
    const hourlyValues = windows.flatMap((window) => window.values);
    const dailyValues = windows.map((window) =>
      window.values.reduce((sum, value) => sum + value, 0),
    );
    const oneHourVariance = sampleVariance(hourlyValues);
    const dailyVariance = sampleVariance(dailyValues);
    return {
      closeHour,
      windowCount: windows.length,
      ratio: Number.isFinite(dailyVariance) && oneHourVariance > 0
        ? dailyVariance / (HOURS_PER_DAY * oneHourVariance)
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

export function calculateVarianceRatioDashboard(rows = [], {
  deseasonalize = true,
  closeHour = 0,
  closeWeekday = null,
  bootstrapReplications = 400,
} = {}) {
  const normalizedCloseHour = Math.max(0, Math.min(23, Math.trunc(Number(closeHour) || 0)));
  const normalizedCloseWeekday = normalizeOptionalWeekday(closeWeekday);
  const hourlyReturns = buildHourlyLogReturns(rows, { deseasonalize });
  const dayBootstrapRows = buildDayBootstrapVarianceRatios(hourlyReturns, {
    closeHour: normalizedCloseHour,
    closeWeekday: normalizedCloseWeekday,
    replications: bootstrapReplications,
  });
  const varianceRatios = dayBootstrapRows.map((row) => ({
    ...row,
    estimator: "close_hour_anchored",
  }));
  const baseHeadline = varianceRatios[HOURS_PER_DAY - 1] || null;
  const annualizedHourlyVolatility = Number.isFinite(baseHeadline?.oneHourVariance)
    ? Math.sqrt(365 * HOURS_PER_DAY * baseHeadline.oneHourVariance)
    : null;
  const annualizedDailyVolatility = Number.isFinite(baseHeadline?.variance)
    ? Math.sqrt(365 * baseHeadline.variance)
    : null;
  const headline = baseHeadline ? {
    ...baseHeadline,
    estimator: "anchored_daily",
    varianceDifference: 1 - baseHeadline.ratio,
    annualizedHourlyVolatility,
    annualizedDailyVolatility,
    volatilityDifferencePoints:
      (annualizedHourlyVolatility - annualizedDailyVolatility) * 100,
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
    }),
    sampleSize: hourlyReturns.length,
    deseasonalize,
    closeHour: normalizedCloseHour,
    closeWeekday: normalizedCloseWeekday,
    maxHours: varianceRatios.at(-1)?.horizon || 0,
  };
}
