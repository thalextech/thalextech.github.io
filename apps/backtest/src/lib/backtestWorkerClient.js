let worker;
let nextRequestId = 1;
const pendingRequests = new Map();
const preparedDatasetKeys = new Set();

const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(
    new URL("../workers/backtestWorker.js", import.meta.url),
    { type: "module" },
  );
  worker.addEventListener("message", ({ data }) => {
    const request = pendingRequests.get(data.requestId);
    if (!request) return;
    if (data.type === "progress") {
      request.onProgress?.(data);
      return;
    }
    if (data.type === "result") {
      request.onResult?.(data);
      return;
    }
    pendingRequests.delete(data.requestId);
    if (data.type === "error") {
      request.reject(new Error(data.message || "Backtest worker failed"));
      return;
    }
    if (data.datasetKey) preparedDatasetKeys.add(data.datasetKey);
    request.resolve(data);
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Backtest worker crashed");
    for (const request of pendingRequests.values()) request.reject(error);
    pendingRequests.clear();
    preparedDatasetKeys.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
};

const requestWorker = (message, callbacks = {}) => {
  const requestId = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve,
      reject,
      onProgress: callbacks.onProgress,
      onResult: callbacks.onResult,
    });
    getWorker().postMessage({ ...message, requestId });
  });
};

export const hasWorkerDataset = (datasetKey) =>
  preparedDatasetKeys.has(datasetKey);

export const runSingleInWorker = ({
  datasetKey,
  loadRequest,
  config,
  onProgress,
}) => requestWorker(
  {
    type: "run-single",
    datasetKey,
    loadRequest,
    config,
  },
  { onProgress },
);

export const runSweepInWorker = ({
  datasetKey,
  loadRequest,
  configs,
  onProgress,
  onResult,
}) => requestWorker(
  {
    type: "run-sweep",
    datasetKey,
    loadRequest,
    configs,
  },
  { onProgress, onResult },
);
