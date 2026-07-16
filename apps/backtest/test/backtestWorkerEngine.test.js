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
