import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarWeekKey,
  orderSweepDistributionRows,
} from "../src/lib/sweepDistribution.js";

const rows = [
  { key: "h20", total: 30, sharpe: 0.5, weeks: [0, 4], config: { entryHourUtc: 20 } },
  { key: "h00", total: 10, sharpe: 1.2, weeks: [1, 2], config: { entryHourUtc: 0 } },
  { key: "h08", total: 20, sharpe: 0.8, weeks: [-4, 10], config: { entryHourUtc: 8 } },
];

test("sweep distributions separate clock order from ranked order", () => {
  const clock = orderSweepDistributionRows(rows, {
    view: "clock",
    sortBy: "total",
    dimension: "entry_hour",
  });
  assert.deepEqual(clock.map((row) => row.key), ["h00", "h08", "h20"]);
  assert.deepEqual(clock.map((row) => row.distributionRank), [3, 2, 1]);

  const rankedBySharpe = orderSweepDistributionRows(rows, {
    view: "ranked",
    sortBy: "sharpe",
    dimension: "entry_hour",
  });
  assert.deepEqual(rankedBySharpe.map((row) => row.key), ["h00", "h08", "h20"]);
  assert.deepEqual(rankedBySharpe.map((row) => row.distributionRank), [1, 2, 3]);
});

test("calendar week selection uses the same Monday key across entry weekdays", () => {
  assert.equal(
    calendarWeekKey("2026-07-13T08:00:00Z"),
    calendarWeekKey("2026-07-17T20:00:00Z"),
  );
  assert.notEqual(
    calendarWeekKey("2026-07-17T20:00:00Z"),
    calendarWeekKey("2026-07-20T08:00:00Z"),
  );
});
