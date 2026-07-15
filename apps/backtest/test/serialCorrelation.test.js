import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComplete24HourWindows,
  buildDayBootstrapVarianceRatios,
  buildHourlyLogReturns,
  buildVarianceRatioCurve,
  calculateVarianceRatioDashboard,
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

test("complete windows require every one of the selected day's 24 hours", () => {
  const complete = buildHourlyLogReturns(rowsFromReturns(Array(72).fill(0.001)), {
    deseasonalize: false,
  });
  const missing = complete.filter((_, index) => index !== 10);
  assert.equal(buildComplete24HourWindows(complete, 0).length, 2);
  assert.equal(buildComplete24HourWindows(missing, 0).length, 1);
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

test("dashboard uses the anchored daily estimate at 24h and extends point estimates weekly", () => {
  const analysis = calculateVarianceRatioDashboard(
    rowsFromReturns(simulateReturns({ count: 12_000, phi: -0.35, seed: 50 })),
    { deseasonalize: false, bootstrapReplications: 100 },
  );
  assert.equal(analysis.varianceRatios.length, 168);
  assert.equal(analysis.headline.horizon, 24);
  assert.ok(Number.isFinite(analysis.headline.ciLower));
  assert.ok(Number.isFinite(analysis.headline.volatilityDifferencePoints));
  assert.ok(analysis.trough.horizon >= 2 && analysis.trough.horizon <= 24);
  assert.equal(analysis.closeHourRange.rows.length, 24);
  assert.ok(analysis.closeHourRange.minimum.ratio <= analysis.closeHourRange.maximum.ratio);
  assert.equal(analysis.varianceRatios[24].ciLower, null);
});
