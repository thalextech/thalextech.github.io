import { runFairValueMonteCarlo } from "../lib/fairValueMonteCarlo.js";

self.addEventListener("message", async ({ data }) => {
  try {
    const result = await runFairValueMonteCarlo({
      ...data.options,
      cycles: data.cycles,
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
