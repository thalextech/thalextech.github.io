import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMaxDrawdown,
  normalizeBacktestConfig,
  prepareBacktestData,
} from "../src/lib/weeklyStraddleBacktest.js";

test("normalizeBacktestConfig applies defaults and coerces external input once", () => {
  const config = normalizeBacktestConfig({
    entryHourUtc: "12",
    entryWeekday: "2",
    hedgeIntervalHours: "99",
    exitHoldDays: "14.4",
    targetDelta: "-0.35",
    sizingMode: "unsupported",
  });

  assert.equal(config.entryHourUtc, 12);
  assert.equal(config.hourlyOffset, 12);
  assert.equal(config.entryWeekday, 2);
  assert.equal(config.hedgeIntervalHours, 24);
  assert.equal(config.exitHoldDays, 14);
  assert.equal(config.targetDelta, 0.35);
  assert.equal(config.sizingMode, "notional");
});

test("computeMaxDrawdown returns the largest peak-to-trough loss", () => {
  const rows = [100, 80, 120, 70].map((endingEquityUsd) => ({
    endingEquityUsd,
  }));

  assert.equal(computeMaxDrawdown(rows), -50);
  assert.equal(computeMaxDrawdown(), 0);
});

test("prepareBacktestData retains the index lookup used during preparation", () => {
  const indexRow = {
    ts: 1,
    dateTime: new Date("2026-01-01T00:00:00Z"),
    indexPrice: 100,
  };
  const prepared = prepareBacktestData({
    indexRows: [indexRow],
    markRows: [],
    config: { end: new Date("2026-01-02T00:00:00Z") },
  });

  assert.equal(prepared.indexes.indexByTs.get(1), indexRow);
});
