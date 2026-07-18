import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComplete24HourWindows,
  buildDayBootstrapVarianceRatios,
  buildForwardVarianceRatioSeasonality,
  buildHourlyLogReturns,
  buildHourlySerialCorrelationSeasonality,
  buildVarianceRatioCurve,
  calculateVarianceRatioDashboard,
  RETURN_ADJUSTMENT,
} from "../src/lib/serialCorrelation.js";
import { HOUR_SECONDS } from "../src/lib/ivRv.js";

const START_TS = Date.UTC(2020, 0, 6) / 1000;

const rowsFromReturns = (returns) => returns.map((value, index) => ({
  ts: START_TS + index * HOUR_SECONDS,
  open: 100,
  close: 100 * Math.exp(value),
}));

const createNormalGenerator = (seed = 1) => {
  let state = seed >>> 0;
  const uniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
};

const simulateReturns = ({ count = 24_000, phi = 0, seed = 1 } = {}) => {
  const normal = createNormalGenerator(seed);
  const values = [];
  let previous = 0;
  for (let index = 0; index < count + 500; index += 1) {
    previous = phi * previous + normal() * 0.001;
    if (index >= 500) values.push(previous);
  }
  return values;
};

test("weekday-hour de-seasonalization leaves zero bucket means", () => {
  const returns = buildHourlyLogReturns(rowsFromReturns(
    Array.from({ length: 24 * 21 }, (_, index) => {
      const date = new Date((START_TS + index * HOUR_SECONDS) * 1000);
      return date.getUTCDay() * 0.0001 + date.getUTCHours() * 0.00001;
    }),
  ));
  const buckets = new Map();
  returns.forEach((row) => {
    const key = `${row.weekday}-${row.hour}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row.value);
  });
  buckets.forEach((values) => {
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0)) < 1e-14);
  });
});

test("variance standardization flattens a smooth weekly second-moment profile", () => {
  const normal = createNormalGenerator(71);
  const rows = rowsFromReturns(Array.from({ length: 168 * 120 }, (_, index) => {
    const weeklyHour = index % 168;
    const logSigma = 0.75 * Math.cos(2 * Math.PI * weeklyHour / 168)
      + 0.3 * Math.sin(2 * Math.PI * 7 * weeklyHour / 168);
    return normal() * 0.006 * Math.exp(logSigma);
  }));
  const bucketVarianceCv = (returns) => {
    const buckets = new Map();
    returns.forEach((row) => {
      const key = `${row.weekday}-${row.hour}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row.value);
    });
    const variances = [...buckets.values()].map((values) => {
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.reduce((sum, value) => sum + (value - average) ** 2, 0)
        / (values.length - 1);
    });
    const averageVariance = variances.reduce((sum, value) => sum + value, 0)
      / variances.length;
    const varianceOfVariances = variances.reduce(
      (sum, value) => sum + (value - averageVariance) ** 2,
      0,
    ) / (variances.length - 1);
    return Math.sqrt(varianceOfVariances) / averageVariance;
  };
  const meanAdjusted = buildHourlyLogReturns(rows, {
    adjustment: RETURN_ADJUSTMENT.MEAN,
  });
  const standardized = buildHourlyLogReturns(rows, {
    adjustment: RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED,
  });

  assert.ok(bucketVarianceCv(meanAdjusted) > 0.8);
  assert.ok(bucketVarianceCv(standardized) < 0.25);
  const standardizedAnalysis = calculateVarianceRatioDashboard(rows, {
    adjustment: RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED,
    bootstrapReplications: 0,
  });
  assert.equal(standardizedAnalysis.headline.annualizedHourlyVolatility, null);
  assert.equal(standardizedAnalysis.headline.volatilityDifferencePoints, null);
});

test("per-cell VR denominator is neutral under independent heteroskedastic hours", () => {
  const normal = createNormalGenerator(81);
  const rows = rowsFromReturns(Array.from({ length: 168 * 240 }, (_, index) => {
    const date = new Date((START_TS + index * HOUR_SECONDS) * 1000);
    const weekend = [0, 6].includes(date.getUTCDay());
    const sigma = weekend ? 0.003 : 0.009;
    return normal() * sigma;
  }));
  const cells = buildForwardVarianceRatioSeasonality(rows, {
    adjustment: RETURN_ADJUSTMENT.MEAN,
  });
  const averageRatio = cells.reduce((sum, cell) => sum + cell.ratio, 0) / cells.length;

  assert.ok(Math.abs(averageRatio - 1) < 0.08);
  assert.ok(Math.min(...cells.map((cell) => cell.ratio)) > 0.8);
});

test("complete windows require every one of the selected day's 24 hours", () => {
  const complete = buildHourlyLogReturns(rowsFromReturns(Array(72).fill(0.001)), {
    deseasonalize: false,
  });
  const missing = complete.filter((_, index) => index !== 10);
  assert.equal(buildComplete24HourWindows(complete, 0).length, 2);
  assert.equal(buildComplete24HourWindows(complete, 0, 2).length, 1);
  assert.equal(buildComplete24HourWindows(complete, 0, 1).length, 0);
  assert.equal(buildComplete24HourWindows(missing, 0).length, 1);
});

test("forward windows begin at the selected weekday and hour", () => {
  const returns = buildHourlyLogReturns(
    rowsFromReturns(Array.from({ length: 72 }, (_, index) => (index + 1) / 10_000)),
    { deseasonalize: false },
  );
  const monday = buildComplete24HourWindows(returns, 0, 1, { anchorMode: "start" });
  const tuesday = buildComplete24HourWindows(returns, 0, 2, { anchorMode: "start" });
  const wednesday = buildComplete24HourWindows(returns, 0, 3, { anchorMode: "start" });
  const thursday = buildComplete24HourWindows(returns, 0, 4, { anchorMode: "start" });

  assert.equal(monday.length, 1);
  assert.equal(tuesday.length, 1);
  assert.equal(wednesday.length, 1);
  assert.equal(thursday.length, 0);
  assert.equal(monday[0].startTs, START_TS);
  assert.equal(monday[0].endTs, START_TS + 23 * HOUR_SECONDS);
  assert.deepEqual(monday[0].values, returns.slice(0, 24).map((row) => row.value));
});

test("2h robustness windows aggregate non-overlapping pairs across the same 24h block", () => {
  const returns = buildHourlyLogReturns(
    rowsFromReturns(Array.from({ length: 72 }, (_, index) => (index + 1) / 10_000)),
    { adjustment: RETURN_ADJUSTMENT.RAW, barHours: 2 },
  );
  const monday = buildComplete24HourWindows(returns, 0, 1, {
    anchorMode: "start",
    barHours: 2,
  });

  assert.equal(monday.length, 1);
  assert.equal(monday[0].values.length, 12);
  assert.ok(Math.abs(monday[0].values[0] - 3 / 10_000) < 1e-12);
  assert.ok(Math.abs(monday[0].values[1] - 7 / 10_000) < 1e-12);
  assert.equal(monday[0].endTs, START_TS + 23 * HOUR_SECONDS);
});

test("forward seasonality screens every weekday and entry hour", () => {
  const rows = rowsFromReturns(simulateReturns({ count: 24 * 28, phi: -0.2, seed: 8 }));
  const cells = buildForwardVarianceRatioSeasonality(rows, { deseasonalize: false });

  assert.equal(cells.length, 7 * 24);
  assert.ok(cells.every((cell) =>
    Number.isInteger(cell.weekday)
    && cell.weekday >= 0
    && cell.weekday <= 6
    && Number.isInteger(cell.hour)
    && cell.hour >= 0
    && cell.hour <= 23
    && Number.isFinite(cell.ratio),
  ));
  const twoHourCells = buildForwardVarianceRatioSeasonality(rows, {
    adjustment: RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED,
    barHours: 2,
  });
  assert.equal(twoHourCells.length, 7 * 24);
  assert.ok(twoHourCells.every((cell) => cell.barHours === 2));
});

test("hourly serial-correlation cells compare consecutive returns inside each forward 24h block", () => {
  const values = Array.from({ length: 168 * 40 }, () => 0);
  for (let week = 0; week < 40; week += 1) {
    const mondayStart = week * 168;
    const signal = (week % 2 === 0 ? 1 : -1) * (0.001 + week * 0.00001);
    for (let hour = 0; hour < 24; hour += 1) {
      values[mondayStart + hour] = signal * (hour % 2 === 0 ? 1 : -1);
    }
  }
  const cells = buildHourlySerialCorrelationSeasonality(rowsFromReturns(values));
  const mondayMidnight = cells.find((cell) => cell.weekday === 1 && cell.hour === 0);

  assert.equal(cells.length, 7 * 24);
  assert.equal(mondayMidnight.count, 40);
  assert.equal(mondayMidnight.pairCount, 40 * 23);
  assert.equal(mondayMidnight.values.length, 40);
  assert.ok(mondayMidnight.correlation < -0.99);
});

test("variance-ratio curve distinguishes independent, reversing, and continuing returns", () => {
  const curveFor = (phi, seed) => buildVarianceRatioCurve(buildHourlyLogReturns(
    rowsFromReturns(simulateReturns({ phi, seed })),
    { deseasonalize: false },
  ), { maxHours: 168 });
  const independent = curveFor(0, 10);
  const reversing = curveFor(-0.55, 20);
  const continuing = curveFor(0.55, 30);
  assert.equal(independent.length, 168);
  assert.ok(Math.abs(independent[23].ratio - 1) < 0.1);
  assert.ok(reversing[23].ratio < 1);
  assert.ok(continuing[23].ratio > 1);
});

test("day bootstrap identifies statistically significant VR(24) reversal", () => {
  const hourlyReturns = buildHourlyLogReturns(
    rowsFromReturns(simulateReturns({ count: 24_000, phi: -0.6, seed: 40 })),
    { deseasonalize: false },
  );
  const vr24 = buildDayBootstrapVarianceRatios(hourlyReturns, {
    closeHour: 0,
    replications: 250,
    seed: 123,
  })[23];
  assert.equal(vr24.bootstrapReplications, 250);
  assert.ok(vr24.ratio < 1);
  assert.ok(vr24.ciLower < vr24.ciUpper);
  assert.ok(vr24.ciUpper < 1);
  assert.equal(vr24.significantBelowOne, true);
});

test("dashboard redraws one anchored curve and cloud when the close hour changes", () => {
  const sourceRows = rowsFromReturns(simulateReturns({ count: 12_000, phi: -0.35, seed: 50 }));
  const analysis = calculateVarianceRatioDashboard(
    sourceRows,
    { deseasonalize: false, bootstrapReplications: 100 },
  );
  assert.equal(analysis.varianceRatios.length, 24);
  assert.equal(analysis.headline.horizon, 24);
  assert.equal(analysis.headline.estimator, "anchored_daily");
  assert.ok(Number.isFinite(analysis.headline.ciLower));
  assert.ok(Number.isFinite(analysis.headline.volatilityDifferencePoints));
  assert.equal(analysis.termStructureVr24.estimator, "close_hour_anchored");
  assert.equal(analysis.termStructureVr24.ratio, analysis.headline.ratio);
  assert.ok(analysis.varianceRatios.every((row) =>
    Number.isFinite(row.ciLower) && Number.isFinite(row.ciUpper),
  ));
  assert.ok(analysis.trough.horizon >= 2 && analysis.trough.horizon <= 24);
  assert.equal(analysis.closeHourRange.rows.length, 24);
  assert.ok(analysis.closeHourRange.minimum.ratio <= analysis.closeHourRange.maximum.ratio);

  const alternateAnchor = calculateVarianceRatioDashboard(sourceRows, {
    deseasonalize: false,
    closeHour: 16,
    bootstrapReplications: 100,
  });
  assert.ok(
    alternateAnchor.varianceRatios.some((row, index) =>
      Math.abs(row.ratio - analysis.varianceRatios[index].ratio) > 1e-6,
    ),
  );

  const mondayOnly = calculateVarianceRatioDashboard(sourceRows, {
    deseasonalize: false,
    closeHour: 0,
    closeWeekday: 1,
    bootstrapReplications: 100,
  });
  assert.equal(mondayOnly.closeWeekday, 1);
  assert.ok(mondayOnly.headline.bootstrapWindows < analysis.headline.bootstrapWindows);
  assert.ok(mondayOnly.varianceRatios.some((row, index) =>
    Math.abs(row.ratio - analysis.varianceRatios[index].ratio) > 1e-6,
  ));

  const fridayForward = calculateVarianceRatioDashboard(sourceRows, {
    deseasonalize: false,
    closeHour: 16,
    closeWeekday: 5,
    anchorMode: "start",
    bootstrapReplications: 100,
  });
  assert.equal(fridayForward.anchorMode, "start");
  assert.equal(fridayForward.headline.estimator, "forward_daily");
  assert.equal(fridayForward.termStructureVr24.estimator, "entry_hour_forward");
  assert.equal(fridayForward.anchorWeekday, 5);
  assert.equal(fridayForward.anchorHour, 16);
  assert.equal(fridayForward.closeWeekday, 5);
  assert.equal(fridayForward.closeHour, 16);
  assert.ok(Number.isFinite(fridayForward.headline.ratio));
});
