import {
  prepareBacktestData,
  runWeeklyStraddleBacktest,
} from "../lib/weeklyStraddleBacktest.js";
import { createBacktestWorkerEngine } from "../lib/backtestWorkerEngine.js";
import { loadThalexHistory } from "../lib/thalexParquet.js";

const engine = createBacktestWorkerEngine({
  loadThalexHistory,
  prepareBacktestData,
  runWeeklyStraddleBacktest,
});

self.addEventListener("message", async ({ data }) => {
  try {
    await engine.handleRequest(data, (message) => self.postMessage(message));
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error?.message || "Backtest worker failed",
    });
  }
});
