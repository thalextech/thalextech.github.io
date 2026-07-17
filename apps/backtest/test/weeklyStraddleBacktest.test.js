import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleDetail,
  computeMaxDrawdown,
  nextWeeklyExitTs,
  normalizeBacktestConfig,
  prepareBacktestData,
  prepareCycleDetailData,
  requiredQuoteDteDays,
  runWeeklyStraddleBacktest,
  runWeeklyStraddleBacktestBatch,
} from "../src/lib/weeklyStraddleBacktest.js";
import { PRECOMPUTED_DELTA_SCALE } from "../src/lib/optionRisk.js";

const DAY_SECONDS = 86_400;

const buildParityFixture = () => {
  const entryDayTs = Date.UTC(2025, 5, 6, 0) / 1000;
  const expirationTs = Date.UTC(2025, 5, 13, 8) / 1000;
  const instruments = [
    {
      instrumentId: 0,
      name: "BTC-13JUN25-100000-C",
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 1,
      name: "BTC-13JUN25-100000-P",
      expirationTs,
      strike: 100_000,
      optionType: "P",
    },
  ];
  const indexRows = [];
  const quoteSnapshots = [];
  for (let day = 0; day <= 7; day += 1) {
    for (const hour of [8, 9]) {
      const ts = entryDayTs + day * DAY_SECONDS + hour * 3_600;
      const indexPrice = 100_000 + day * 500 + hour;
      indexRows.push({ ts, indexPrice });
      if (ts >= expirationTs) continue;
      const entries = [];
      for (const instrument of instruments) {
        const delta = instrument.optionType === "C" ? 0.55 : -0.45;
        entries.push([
          instrument.instrumentId,
          4_000 - day * 250 + instrument.instrumentId * 50,
          0.55,
          delta * PRECOMPUTED_DELTA_SCALE,
        ]);
      }
      quoteSnapshots.push([ts, entries]);
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
  return { indexRows, quoteSnapshots, instruments, config };
};

const buildMultiExpiryEntryHourFixture = () => {
  const startTs = Date.UTC(2025, 5, 6, 0) / 1000;
  const expirationTimestamps = [13, 20, 27, 4].map((day, index) =>
    Date.UTC(2025, index === 3 ? 6 : 5, day, 8) / 1000
  );
  const instruments = expirationTimestamps.flatMap((expirationTs, expirationIndex) => [
    {
      instrumentId: expirationIndex * 2,
      name: `BTC-W${expirationIndex + 1}-100000-C`,
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: expirationIndex * 2 + 1,
      name: `BTC-W${expirationIndex + 1}-100000-P`,
      expirationTs,
      strike: 100_000,
      optionType: "P",
    },
  ]);
  const endTs = expirationTimestamps.at(-1) + 3_600;
  const indexRows = [];
  const quoteSnapshots = [];
  for (let ts = startTs; ts <= endTs; ts += DAY_SECONDS) {
    for (const hour of [8, 9]) {
      const observationTs = ts + hour * 3_600;
      if (observationTs > endTs) continue;
      const elapsedDays = Math.floor((observationTs - startTs) / DAY_SECONDS);
      const indexPrice = 100_000 + elapsedDays * 230 + hour * 17;
      indexRows.push({ ts: observationTs, indexPrice });
      const entries = instruments
        .filter((instrument) => instrument.expirationTs > observationTs)
        .map((instrument) => {
          const dteDays = (instrument.expirationTs - observationTs) / DAY_SECONDS;
          const hourPremium = hour === 9 ? 180 : 0;
          const markPrice = 650 + dteDays * 320 + hourPremium + instrument.instrumentId * 11;
          const delta = instrument.optionType === "C" ? 0.55 : -0.45;
          return [
            instrument.instrumentId,
            markPrice,
            0.55,
            delta * PRECOMPUTED_DELTA_SCALE,
          ];
        });
      quoteSnapshots.push([observationTs, entries]);
    }
  }
  const config = normalizeBacktestConfig({
    start: new Date(startTs * 1000),
    end: new Date(endTs * 1000),
    entryWeekday: 5,
    entryHourUtc: 8,
    hourlyOffset: 8,
    exitMode: "after_days",
    exitHoldDays: 7,
    hedgeEnabled: false,
    targetDteDays: 7,
    minWeeklyDteDays: 4,
    maxWeeklyDteDays: 10,
  });
  return { indexRows, quoteSnapshots, instruments, config };
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
  assert.equal(requiredQuoteDteDays({ maxWeeklyDteDays: 28 }), 28);
  assert.equal(
    requiredQuoteDteDays({ maxWeeklyDteDays: 10, farTargetDteDays: 30 }),
    10,
  );
  assert.equal(
    requiredQuoteDteDays({
      structure: "calendar_spread",
      maxWeeklyDteDays: 10,
      farTargetDteDays: 30,
    }),
    30,
  );
});

test("weekly exit schedule chooses the next UTC occurrence after entry", () => {
  const friday20 = Date.UTC(2025, 5, 6, 20) / 1000;
  assert.equal(
    nextWeeklyExitTs(friday20, 0, 20),
    Date.UTC(2025, 5, 8, 20) / 1000,
  );
  assert.equal(
    nextWeeklyExitTs(friday20, 5, 20),
    Date.UTC(2025, 5, 13, 20) / 1000,
  );
});

test("weekly schedule exits before expiry and waits for the next entry slot", () => {
  const fixture = buildParityFixture();
  const result = runWeeklyStraddleBacktest({
    ...fixture,
    config: {
      ...fixture.config,
      exitMode: "weekly_schedule",
      exitWeekday: 0,
      exitHourUtc: 8,
    },
  });
  assert.equal(result.cycleSummary.length, 1);
  assert.equal(
    result.cycleSummary[0].exitTs,
    Date.UTC(2025, 5, 8, 8) / 1000,
  );
  assert.equal(result.cycleSummary[0].exitAtExpiry, false);
});

test("fixed-day roll waits for the next configured entry slot after close", () => {
  const fixture = buildMultiExpiryEntryHourFixture();
  const result = runWeeklyStraddleBacktest({
    ...fixture,
    config: {
      ...fixture.config,
      exitMode: "after_days",
      exitHoldDays: 2,
    },
  });
  assert.ok(result.cycleSummary.length > 1);
  assert.ok(result.cycleSummary.every((cycle) =>
    new Date(cycle.entryTs * 1000).getUTCDay() === fixture.config.entryWeekday
  ));
  for (let index = 1; index < result.cycleSummary.length; index += 1) {
    assert.ok(result.cycleSummary[index].entryTs >= result.cycleSummary[index - 1].exitTs);
  }
});

test("fixed-day entry-hour sweeps preserve the selected hour across expiries", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildMultiExpiryEntryHourFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const results = [8, 9].map((entryHourUtc) =>
    runWeeklyStraddleBacktest({
      preparedData,
      config: {
        ...config,
        entryHourUtc,
        hourlyOffset: entryHourUtc,
      },
    })
  );

  assert.ok(results.every((result) => result.counts.closedCycles >= 3));
  results.forEach((result, index) => {
    const expectedHour = index === 0 ? 8 : 9;
    assert.ok(result.cycleSummary.every((cycle) =>
      new Date(cycle.entryTs * 1000).getUTCHours() === expectedHour
    ));
  });
  assert.ok(Math.abs(results[0].summary.meanEntryDteDays - 7) < 1e-9);
  assert.ok(Math.abs(results[1].summary.meanEntryDteDays - (7 - 1 / 24)) < 1e-9);
  assert.notDeepEqual(
    results[0].cycleSummary.map((cycle) => cycle.entryTs),
    results[1].cycleSummary.map((cycle) => cycle.entryTs),
  );
  assert.notDeepEqual(
    results[0].cycleSummary.map((cycle) => cycle.cyclePnlUsd),
    results[1].cycleSummary.map((cycle) => cycle.cyclePnlUsd),
  );
});

test("fixed-day entry-weekday sweeps preserve the selected weekday across every cycle", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildMultiExpiryEntryHourFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const weekdays = [1, 3, 5];
  const results = weekdays.map((entryWeekday) =>
    runWeeklyStraddleBacktest({
      preparedData,
      config: {
        ...config,
        entryWeekday,
        exitHoldDays: 2,
      },
    })
  );

  assert.ok(results.every((result) => result.counts.closedCycles >= 2));
  results.forEach((result, index) => {
    assert.ok(result.cycleSummary.every((cycle) =>
      new Date(cycle.entryTs * 1000).getUTCDay() === weekdays[index]
    ));
  });
  assert.equal(
    new Set(results.map((result) => JSON.stringify(
      result.cycleSummary.map((cycle) => cycle.entryTs),
    ))).size,
    weekdays.length,
  );
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
    quoteSnapshots: [],
    instruments: [],
    config: { end: new Date("2026-01-02T00:00:00Z") },
  });

  assert.equal(prepared.indexes.indexByTs.get(1), indexRow);
  assert.equal("quoteSnapshots" in prepared, false);
  assert.equal("options" in prepared, false);
});

test("aggregate preparation keeps delta-only risk while detail preparation filters full Greeks by plan expiry", () => {
  const ts = Date.UTC(2025, 5, 6, 8) / 1000;
  const expirationTs = Date.UTC(2025, 5, 13, 8) / 1000;
  const otherExpirationTs = Date.UTC(2025, 5, 20, 8) / 1000;
  const indexRows = [{ ts, indexPrice: 100_000 }];
  const instruments = [
    {
      instrumentId: 0,
      name: "BTC-13JUN25-100000-C",
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 1,
      name: "BTC-20JUN25-100000-C",
      expirationTs: otherExpirationTs,
      strike: 100_000,
      optionType: "C",
    },
  ];
  const quoteSnapshots = [[
    ts,
    [
      [0, 4_000, 0.55, 0.55 * PRECOMPUTED_DELTA_SCALE],
      [1, 5_000, 0.6, 0.58 * PRECOMPUTED_DELTA_SCALE],
    ],
  ]];
  const config = { end: new Date(Date.UTC(2025, 5, 13, 8)) };
  const args = { indexRows, quoteSnapshots, instruments, config };
  const aggregate = prepareBacktestData(args);
  const detail = prepareCycleDetailData({
    ...args,
    plan: { legs: [{ expirationTs }] },
  });

  assert.equal(aggregate.quotes.length, 2);
  assert.equal(aggregate.quotes[0].delta, 0.55);
  assert.equal(aggregate.quotes[0].impliedVol, 0.55);
  assert.equal("instrumentName" in aggregate.quotes[0], false);
  assert.equal(
    aggregate.indexes.quoteByTsInstrumentId.get(ts).get(0),
    aggregate.quotes[0],
  );
  assert.equal("gamma" in aggregate.quotes[0], false);
  assert.equal("vega" in aggregate.quotes[0], false);
  assert.equal("theta" in aggregate.quotes[0], false);
  assert.equal(detail.quotes.length, 1);
  assert.equal(detail.quotes[0].expirationTs, expirationTs);
  assert.equal("instrumentName" in detail.quotes[0], false);
  assert.equal(Number.isFinite(detail.quotes[0].gamma), true);
  assert.equal(Number.isFinite(detail.quotes[0].vega), true);
  assert.equal(Number.isFinite(detail.quotes[0].theta), true);
  assert.equal(detail.quotes[0].impliedVol, 0.55);
});

test("batch runs match independent runs across entry hours", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildParityFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
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
  assert.ok(batch.every((run) => run.summary.meanEntryImpliedVol === 0.55));
  assert.ok(batch.every((run) =>
    Math.abs(
      run.summary.cumulativeOptionPnlUsd +
      run.summary.cumulativeHedgePnlUsd -
      run.summary.finalEquityUsd
    ) < 1e-9
  ));

  const selectedPlan = batch[0].cycleSummary[0];
  assert.ok(selectedPlan.legs.every((leg) =>
    Number.isInteger(leg.instrumentId) && leg.instrumentName.startsWith("BTC-")
  ));
  const sampledPrices = Array.from({ length: 8 }, (_, day) => 100_008 + day * 500);
  const sampledVariance = sampledPrices.slice(1).reduce((variance, price, index) => {
    const sampledReturn = Math.log(price / sampledPrices[index]);
    return variance + sampledReturn ** 2;
  }, 0);
  const expectedSampledVol = Math.sqrt(sampledVariance / (7 / 365));
  const expectedEndpointVol = Math.abs(Math.log(sampledPrices.at(-1) / sampledPrices[0])) /
    Math.sqrt(7 / 365);
  assert.ok(Math.abs(selectedPlan.sampledRealizedVol - expectedSampledVol) < 1e-12);
  assert.ok(Math.abs(batch[0].summary.meanSampledRealizedVol - expectedSampledVol) < 1e-12);

  const unhedged = runWeeklyStraddleBacktest({
    preparedData,
    config: { ...configs[0], hedgeEnabled: false },
  });
  assert.ok(
    Math.abs(
      unhedged.cycleSummary[0].sampledRealizedVol -
      expectedEndpointVol,
    ) < 1e-12,
  );

  const detailPrepared = prepareCycleDetailData({
    indexRows,
    quoteSnapshots,
    instruments,
    config: configs[0],
    plan: selectedPlan,
  });
  const detailRows = buildCycleDetail({
    plan: selectedPlan,
    preparedData: detailPrepared,
    config: configs[0],
  });
  assert.ok(
    Math.abs(detailRows.at(-1).hedgePnlUsd - selectedPlan.hedgePnlUsd) < 1e-7,
  );
});
