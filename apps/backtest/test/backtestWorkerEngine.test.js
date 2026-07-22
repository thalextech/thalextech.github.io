import assert from "node:assert/strict";
import test from "node:test";
import { createBacktestWorkerEngine } from "../src/lib/backtestWorkerEngine.js";

test("worker engine loads and prepares once, then streams sweep results", async () => {
  let loadCalls = 0;
  let prepareCalls = 0;
  let runCalls = 0;
  let clock = 0;
  const engine = createBacktestWorkerEngine({
    loadThalexHistory: async ({ hourlyOffsets, onProgress }) => {
      loadCalls += 1;
      onProgress({ current: 1, total: 1, file: "h08 · 0-10D" });
      return {
        indexRows: [hourlyOffsets[0]],
        quoteSnapshots: [],
        artifact: { instruments: [] },
      };
    },
    prepareBacktestData: ({ indexRows }) => {
      prepareCalls += 1;
      return { marker: indexRows[0] };
    },
    runWeeklyStraddleBacktest: ({ preparedData, config }) => {
      runCalls += 1;
      return { marker: preparedData.marker, config };
    },
    now: () => {
      clock += 1;
      return clock;
    },
  });
  const firstMessages = [];
  await engine.handleRequest({
    requestId: 1,
    type: "run-sweep",
    datasetKey: "hours|dte:10",
    loadRequest: { hourlyOffsets: [8] },
    configs: [{ id: "a" }, { id: "b" }],
  }, (message) => firstMessages.push(message));

  assert.equal(loadCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(runCalls, 2);
  assert.deepEqual(
    firstMessages.filter(({ type }) => type === "result").map(({ index }) => index),
    [0, 1],
  );
  assert.equal(firstMessages.at(-1).timing.reusedPreparedData, false);

  const secondMessages = [];
  await engine.handleRequest({
    requestId: 2,
    type: "run-single",
    datasetKey: "hours|dte:10",
    config: { id: "c" },
  }, (message) => secondMessages.push(message));

  assert.equal(loadCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(runCalls, 3);
  assert.equal(secondMessages.at(-1).timing.reusedPreparedData, true);
  assert.equal(secondMessages.at(-1).result.marker, 8);
});

test("attribution reuses prepared data and is only calculated on its own request", async () => {
  let loadCalls = 0;
  const runConfigs = [];
  const engine = createBacktestWorkerEngine({
    loadThalexHistory: async () => {
      loadCalls += 1;
      return {
        indexRows: [{ ts: 1 }],
        quoteSnapshots: [],
        artifact: { instruments: [] },
      };
    },
    prepareBacktestData: () => ({ prepared: true }),
    runWeeklyStraddleBacktest: ({ config }) => {
      runConfigs.push(config);
      return { cycleSummary: [{ id: config.id }] };
    },
    buildPortfolioAttributionTimeline: (cycles) => [{ cycleId: cycles[0].id }],
    buildCycleAttributionRows: (cycles) => [{ summaryCycleId: cycles[0].id }],
  });

  const singleMessages = [];
  await engine.handleRequest({
    requestId: 1,
    type: "run-single",
    datasetKey: "shared",
    loadRequest: { hourlyOffsets: [8] },
    config: { id: "single", includeGreekAttribution: false },
  }, (message) => singleMessages.push(message));

  assert.equal(loadCalls, 1);
  assert.equal(runConfigs.length, 1);
  assert.equal(runConfigs[0].includeGreekAttribution, false);

  const attributionMessages = [];
  await engine.handleRequest({
    requestId: 2,
    type: "run-attribution",
    datasetKey: "shared",
    config: { id: "attribution", includeGreekAttribution: false },
  }, (message) => attributionMessages.push(message));

  assert.equal(loadCalls, 1);
  assert.equal(runConfigs.length, 2);
  assert.equal(runConfigs[1].includeGreekAttribution, true);
  assert.deepEqual(attributionMessages.at(-1).result.timeline, [
    { cycleId: "attribution" },
  ]);
  assert.deepEqual(attributionMessages.at(-1).result.cycles, [
    { summaryCycleId: "attribution" },
  ]);
  assert.equal(attributionMessages.at(-1).timing.reusedPreparedData, true);
});
