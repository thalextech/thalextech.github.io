import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPayoffDifferenceSummary,
  buildSharedTerminalCumulativeSeries,
  computePayoffBinValue,
  smoothSharedTerminalCumulativeSeries,
} from "../src/lib/payoffComparison.ts";

test("option-perp distribution keeps outcomes paired by simulation path", () => {
  const summary = buildPayoffDifferenceSummary(
    new Float64Array([10, -5, 0]),
    new Float64Array([4, -10, 2]),
  );

  assert.deepEqual(summary.sortedDifferences, [-2, 5, 6]);
  assert.equal(summary.optionWinRate, 2 / 3);
  assert.equal(summary.medianAdvantage, 5);
});

test("frequency weighted payoff is the bin contribution to total EV", () => {
  assert.equal(computePayoffBinValue(600, 3, 100, "payoff"), 200);
  assert.equal(computePayoffBinValue(600, 3, 100, "frequency"), 6);
});

test("cumulative series shares terminal-price order and ends at each EV", () => {
  const points = buildSharedTerminalCumulativeSeries(
    [70_000, 50_000, 60_000],
    [20, -10, 0],
    [8, -4, 2],
  );

  assert.deepEqual(
    points.map((point) => point.terminalPrice),
    [50_000, 60_000, 70_000],
  );
  assert.equal(points[0].primaryContribution, -10 / 3);
  assert.equal(points[1].primaryContribution, -10 / 3);
  assert.ok(Math.abs(points[2].primaryContribution - 10 / 3) < 1e-12);
  assert.equal(points[0].comparisonContribution, -4 / 3);
  assert.equal(points[2].comparisonContribution, 2);
});

test("cumulative smoothing preserves exact EV endpoints", () => {
  const points = [
    { terminalPrice: 1, primaryContribution: -1, comparisonContribution: -2 },
    { terminalPrice: 2, primaryContribution: 4, comparisonContribution: 3 },
    { terminalPrice: 3, primaryContribution: 0, comparisonContribution: -1 },
    { terminalPrice: 4, primaryContribution: 6, comparisonContribution: 5 },
    { terminalPrice: 5, primaryContribution: 3, comparisonContribution: 2 },
  ];
  const smoothed = smoothSharedTerminalCumulativeSeries(points, 2);

  assert.deepEqual(smoothed[0], points[0]);
  assert.deepEqual(smoothed[smoothed.length - 1], points[points.length - 1]);
  assert.equal(smoothed[2].terminalPrice, points[2].terminalPrice);
  assert.notEqual(smoothed[2].primaryContribution, points[2].primaryContribution);
});
