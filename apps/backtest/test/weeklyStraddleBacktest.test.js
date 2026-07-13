import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMaxDrawdown,
  normalizeBacktestConfig,
  prepareBacktestData,
  prepareCycleDetailData,
  runWeeklyStraddleBacktest,
  runWeeklyStraddleBacktestBatch,
} from "../src/lib/weeklyStraddleBacktest.js";

const DAY_SECONDS = 86_400;

const buildParityFixture = () => {
  const entryDayTs = Date.UTC(2025, 5, 6, 0) / 1000;
  const expirationTs = Date.UTC(2025, 5, 13, 8) / 1000;
  const instruments = [
    "BTC-13JUN25-100000-C",
    "BTC-13JUN25-100000-P",
  ];
  const indexRows = [];
  const markRows = [];
  for (let day = 0; day <= 7; day += 1) {
    for (const hour of [8, 9]) {
      const ts = entryDayTs + day * DAY_SECONDS + hour * 3_600;
      const indexPrice = 100_000 + day * 500 + hour;
      indexRows.push({ ts, indexPrice });
      if (ts >= expirationTs) continue;
      for (const [instrumentIndex, instrumentName] of instruments.entries()) {
        markRows.push({
          ts,
          instrumentName,
          markPrice: 4_000 - day * 250 + instrumentIndex * 50,
          iv: 0.55,
        });
      }
    }
  }
  const config = normalizeBacktestConfig({
    start: new Date(entryDayTs * 1000),
    end: new Date(expirationTs * 1000),
    entryWeekday: 5,
    entryHourUtc: 8,
    hourlyOffset: 8,
    hedgeEnabled: true,
    hedgeIntervalHours: 24,
    holdToExpiry: true,
    targetDteDays: 7,
    minWeeklyDteDays: 4,
    maxWeeklyDteDays: 10,
  });
  return { indexRows, markRows, config };
};

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
    indexPrice: 100,
  };
  const prepared = prepareBacktestData({
    indexRows: [indexRow],
    markRows: [],
    config: { end: new Date("2026-01-02T00:00:00Z") },
  });

  assert.equal(prepared.indexes.indexByTs.get(1), indexRow);
  assert.equal("markRows" in prepared, false);
  assert.equal("options" in prepared, false);
});

test("aggregate preparation omits detail Greeks while detail preparation retains them", () => {
  const ts = Date.UTC(2025, 5, 6, 8) / 1000;
  const indexRows = [{ ts, indexPrice: 100_000 }];
  const markRows = [{
    ts,
    instrumentName: "BTC-13JUN25-100000-C",
    markPrice: 4_000,
    iv: 0.55,
  }];
  const config = { end: new Date(Date.UTC(2025, 5, 13, 8)) };
  const aggregate = prepareBacktestData({ indexRows, markRows, config });
  const detail = prepareCycleDetailData({ indexRows, markRows, config });

  assert.equal(Number.isFinite(aggregate.quotes[0].delta), true);
  assert.equal("gamma" in aggregate.quotes[0], false);
  assert.equal(Number.isFinite(detail.quotes[0].gamma), true);
  assert.equal(Number.isFinite(detail.quotes[0].vega), true);
  assert.equal(Number.isFinite(detail.quotes[0].theta), true);
  assert.equal(detail.quotes[0].impliedVol, 0.55);
});

test("batch runs match independent runs across entry hours", () => {
  const { indexRows, markRows, config } = buildParityFixture();
  const preparedData = prepareBacktestData({ indexRows, markRows, config });
  const configs = [8, 9].map((hour) => ({
    ...config,
    entryHourUtc: hour,
    hourlyOffset: hour,
  }));
  const independent = configs.map((runConfig) =>
    runWeeklyStraddleBacktest({ preparedData, config: runConfig }),
  );
  const batch = runWeeklyStraddleBacktestBatch({
    preparedData,
    runs: configs.map((runConfig) => ({ config: runConfig })),
  });

  assert.deepEqual(batch, independent);
  assert.ok(batch.every((run) => run.counts.closedCycles === 1));
});
