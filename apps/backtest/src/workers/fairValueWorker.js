import { runFairValueMonteCarlo } from "../lib/fairValueMonteCarlo.js";
import { loadIvRvHistory } from "../lib/ivRv.js";

let historyPromise;

const getHistory = () => {
  if (!historyPromise) historyPromise = loadIvRvHistory();
  return historyPromise;
};

self.addEventListener("message", async ({ data }) => {
  try {
    const historyRows = await getHistory();
    const result = await runFairValueMonteCarlo({
      ...data.options,
      cycles: data.cycles,
      historyRows,
      onProgress: ({ completed, total, result: partialResult }) => self.postMessage({
        type: "progress",
        requestId: data.requestId,
        completed,
        total,
        result: partialResult,
      }),
    });
    self.postMessage({ type: "complete", requestId: data.requestId, result });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error?.message || "Fair-value Monte Carlo failed",
    });
  }
});
