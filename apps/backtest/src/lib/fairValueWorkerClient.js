let worker;
let nextRequestId = 1;
let activeRequest = null;

const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/fairValueWorker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", ({ data }) => {
    if (!activeRequest || activeRequest.requestId !== data.requestId) return;
    if (data.type === "progress") {
      activeRequest.onProgress?.(data);
      return;
    }
    const request = activeRequest;
    activeRequest = null;
    if (data.type === "error") request.reject(new Error(data.message));
    else request.resolve(data.result);
  });
  return worker;
};

export const runFairValueInWorker = ({ cycles, options, onProgress }) => {
  if (activeRequest) {
    activeRequest.reject(new Error("Monte Carlo run superseded"));
    worker?.terminate();
    worker = null;
    activeRequest = null;
  }
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    activeRequest = { requestId, resolve, reject, onProgress };
    getWorker().postMessage({ requestId, cycles, options });
  });
};

export const cancelFairValueRun = () => {
  if (activeRequest) {
    activeRequest.reject(new Error("Monte Carlo run cancelled"));
    activeRequest = null;
  }
  worker?.terminate();
  worker = null;
};
