import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPayoffDifferenceSummary,
  buildSharedTerminalCumulativeSeries,
  computePayoffBinValue,
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
