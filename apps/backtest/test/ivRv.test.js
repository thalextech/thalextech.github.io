import assert from "node:assert/strict";
import test from "node:test";
import {
  addTrailingParkinsonRv,
  buildHourlyIvHeatmap,
  buildHourlyIvRows,
  buildHourlyIvWeekdayGroups,
  buildHourlyParkinsonRows,
  buildHourlyRvHeatmap,
  buildHourlyRvWeekdayGroups,
  buildIvRvChartRows,
  decodeIvRvArtifact,
  HOUR_SECONDS,
  summarizeIvRvRows,
} from "../src/lib/ivRv.js";

test("decodes the compact IV/RV artifact by tenor", () => {
  const rows = decodeIvRvArtifact({
    schema: "thalex-iv-rv",
    version: 2,
    tenors: [7, 14],
    rows: [[
      100,
      90,
      110,
      80,
      100,
      [
        [0.5, 100 + 5 * 86_400, 100 + 9 * 86_400, 0.5, 0.45, 0.55, 4, 6],
        [0.6, 100 + 12 * 86_400, 100 + 19 * 86_400, 2 / 7, 0.57, 0.65, 5, 5],
      ],
    ]],
  });
  assert.deepEqual(rows[0].ivByTenor, { 7: 0.5, 14: 0.6 });
  assert.equal(rows[0].high, 110);
  assert.equal(rows[0].constantMaturityByTenor[7].weight, 0.5);
});

test("keeps missing artifact values out of the chart instead of coercing them to zero", () => {
  const rows = decodeIvRvArtifact({
    schema: "thalex-iv-rv",
    version: 2,
    tenors: [7],
    rows: [[100, 90, 110, 80, 100, [null]]],
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
  assert.equal(forwardNow.ivDate.getTime(), 0);
  assert.equal(forwardNow.rvDate.getTime(), 24 * HOUR_SECONDS * 1000);
});

test("aggregate IV/RV statistics use paired observations", () => {
  const summary = summarizeIvRvRows([
    { iv: 0.5, rv: 0.4 },
    { iv: 0.7, rv: 0.5 },
    { iv: 1.2, rv: null },
  ]);
  assert.deepEqual(summary, {
    averageIv: 0.6,
    averageRv: 0.45,
    difference: 0.14999999999999997,
    count: 2,
  });
});

test("weekday RV groups use annualized single-hour observations", () => {
  const startTs = Date.UTC(2026, 0, 5, 8) / 1000; // Monday
  const source = Array.from({ length: 8 * 24 }, (_, index) => ({
    ts: startTs + index * HOUR_SECONDS,
    high: 101 + index / 100,
    low: 99,
  }));
  const rows = buildHourlyParkinsonRows(source);
  const groups = buildHourlyRvWeekdayGroups(rows);
  assert.equal(groups[0].label, "Mon");
  assert.equal(groups[0].values.length, 40);
  assert.ok(groups.every((group) => group.values.every(Number.isFinite)));
  const heatmap = buildHourlyRvHeatmap(rows);
  assert.equal(heatmap.length, 7 * 24);
  assert.equal(heatmap.find((cell) => cell.weekdayLabel === "Mon" && cell.hour === 8).values.length, 2);
});

test("weekday-hour IV heatmap uses the selected hourly ATM tenor", () => {
  const startTs = Date.UTC(2026, 0, 5, 8) / 1000; // Monday
  const source = Array.from({ length: 8 * 24 }, (_, index) => ({
    ts: startTs + index * HOUR_SECONDS,
    ivByTenor: {
      7: 0.4 + index / 10_000,
      14: 0.6 + index / 10_000,
    },
  }));
  source[0].ivByTenor[14] = null;

  const rows = buildHourlyIvRows(source, 14);
  const heatmap = buildHourlyIvHeatmap(rows);
  const groups = buildHourlyIvWeekdayGroups(rows);
  const mondayAtEight = heatmap.find(
    (cell) => cell.weekdayLabel === "Mon" && cell.hour === 8,
  );

  assert.equal(rows.length, source.length - 1);
  assert.equal(heatmap.length, 7 * 24);
  assert.equal(groups[0].label, "Mon");
  assert.equal(groups.reduce((count, group) => count + group.values.length, 0), rows.length);
  assert.equal(mondayAtEight.values.length, 1);
  assert.ok(mondayAtEight.values.every((value) => value >= 0.6));
});

test("IV and RV heatmaps can display the cell median instead of its mean", () => {
  const date = new Date(Date.UTC(2026, 0, 5, 8));
  const ivRows = [0.4, 0.5, 1.5].map((iv) => ({ date, iv }));
  const rvRows = [0.3, 0.4, 1.4].map((rv) => ({ date, rv }));
  const ivAverage = buildHourlyIvHeatmap(ivRows).find((cell) => cell.values.length);
  const ivMedian = buildHourlyIvHeatmap(ivRows, { metric: "median" })
    .find((cell) => cell.values.length);
  const rvAverage = buildHourlyRvHeatmap(rvRows).find((cell) => cell.values.length);
  const rvMedian = buildHourlyRvHeatmap(rvRows, { metric: "median" })
    .find((cell) => cell.values.length);

  assert.ok(Math.abs(ivAverage.average - 0.8) < 1e-12);
  assert.equal(ivMedian.average, 0.5);
  assert.ok(Math.abs(ivMedian.mean - 0.8) < 1e-12);
  assert.equal(ivMedian.median, 0.5);
  assert.ok(Math.abs(rvAverage.average - 0.7) < 1e-12);
  assert.equal(rvMedian.average, 0.4);
});

test("RV heatmap can winsorize period-wide outliers before averaging cells", () => {
  const date = new Date(Date.UTC(2026, 0, 5, 8));
  const rows = [
    ...Array.from({ length: 99 }, () => ({ date, rv: 0.5 })),
    { date, rv: 10 },
  ];
  const raw = buildHourlyRvHeatmap(rows).find((cell) => cell.weekdayLabel === "Mon" && cell.hour === 8);
  const corrected = buildHourlyRvHeatmap(rows, { winsorizeOutliers: true })
    .find((cell) => cell.weekdayLabel === "Mon" && cell.hour === 8);
  assert.equal(raw.average, 0.595);
  assert.ok(corrected.average < raw.average);
  assert.ok(corrected.values.at(-1) < 1);
});
