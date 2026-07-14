import assert from "node:assert/strict";
import test from "node:test";
import {
  addTrailingParkinsonRv,
  buildIvRvChartRows,
  decodeIvRvArtifact,
  HOUR_SECONDS,
} from "../src/lib/ivRv.js";

test("decodes the compact IV/RV artifact by tenor", () => {
  const rows = decodeIvRvArtifact({
    schema: "thalex-iv-rv",
    version: 1,
    tenors: [7, 14],
    rows: [[100, 90, 110, 80, 100, 0.5, 0.6]],
  });
  assert.deepEqual(rows[0].ivByTenor, { 7: 0.5, 14: 0.6 });
  assert.equal(rows[0].high, 110);
});

test("keeps missing artifact values out of the chart instead of coercing them to zero", () => {
  const rows = decodeIvRvArtifact({
    schema: "thalex-iv-rv",
    version: 1,
    tenors: [7],
    rows: [[100, 90, 110, 80, 100, null]],
  });
  assert.equal(rows[0].ivByTenor[7], null);
  assert.equal(buildIvRvChartRows({ rows, tenorDays: 7 }).length, 0);
});

test("Parkinson RV is null until its full trailing tenor is available", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ts: index * HOUR_SECONDS,
    high: 101,
    low: 99,
  }));
  const result = addTrailingParkinsonRv(rows, 1);
  assert.equal(result[22].rv, null);
  assert.ok(Number.isFinite(result[23].rv));
  assert.ok(Number.isFinite(result[24].rv));
});

test("chart rows dynamically sample the hourly observations", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    ts: index * HOUR_SECONDS,
    high: 101,
    low: 99,
    ivByTenor: { 1: 0.5 + index / 1000 },
  }));
  const sampled = buildIvRvChartRows({ rows, tenorDays: 1, resolutionHours: 4 });
  assert.deepEqual(sampled.map((row) => row.ts), [3, 7, 11, 15, 19, 23, 27, 29].map((hour) => hour * HOUR_SECONDS));
});

test("forward alignment compares IV with RV realized over the following tenor", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    ts: index * HOUR_SECONDS,
    high: 101 + index / 10,
    low: 99,
    ivByTenor: { 1: 0.5 },
  }));
  const trailing = buildIvRvChartRows({ rows, tenorDays: 1 });
  const forward = buildIvRvChartRows({ rows, tenorDays: 1, alignForwardRv: true });
  const trailingFuture = trailing.find((row) => row.ts === 24 * HOUR_SECONDS);
  const forwardNow = forward.find((row) => row.ts === 0);
  assert.equal(forwardNow.rv, trailingFuture.rv);
});
