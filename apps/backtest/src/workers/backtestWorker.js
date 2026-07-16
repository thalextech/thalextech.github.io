import {
  prepareBacktestData,
  runWeeklyStraddleBacktest,
} from "../lib/weeklyStraddleBacktest.js";
import { createBacktestWorkerEngine } from "../lib/backtestWorkerEngine.js";

const engine = createBacktestWorkerEngine({
  prepareBacktestData,
  runWeeklyStraddleBacktest,
});

self.addEventListener("message", ({ data }) => {
  try {
    engine.handleRequest(data, (message) => self.postMessage(message));
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error?.message || "Backtest worker failed",
    });
  }
});
