export const createBacktestWorkerEngine = ({
  prepareBacktestData,
  runWeeklyStraddleBacktest,
  now = () => performance.now(),
}) => {
  const preparedDatasets = new Map();

  const ensurePreparedData = ({
    requestId,
    datasetKey,
    sourceData,
    config,
    emit,
  }) => {
    if (preparedDatasets.has(datasetKey)) {
      return {
        preparedData: preparedDatasets.get(datasetKey),
        prepareMs: 0,
        reusedPreparedData: true,
      };
    }
    if (!sourceData) {
      throw new Error(`Prepared dataset is unavailable: ${datasetKey}`);
    }
    emit({
      type: "progress",
      requestId,
      phase: "prepare",
      message: "Preparing shared quote universe",
    });
    const startedAt = now();
    const preparedData = prepareBacktestData({
      indexRows: sourceData.indexRows,
      quoteSnapshots: sourceData.quoteSnapshots,
      instruments: sourceData.instruments,
      config,
    });
    const prepareMs = now() - startedAt;
    preparedDatasets.set(datasetKey, preparedData);
    return { preparedData, prepareMs, reusedPreparedData: false };
  };

  const handleRequest = (data, emit) => {
    const {
      requestId,
      type,
      datasetKey,
      sourceData,
      config,
      configs = [],
    } = data;
    if (type === "run-single") {
      const preparation = ensurePreparedData({
        requestId,
        datasetKey,
        sourceData,
        config,
        emit,
      });
      emit({
        type: "progress",
        requestId,
        phase: "run",
        message: "Running strategy",
      });
      const runStartedAt = now();
      const result = runWeeklyStraddleBacktest({
        preparedData: preparation.preparedData,
        config,
      });
      emit({
        type: "complete",
        requestId,
        datasetKey,
        result,
        timing: {
          prepareMs: preparation.prepareMs,
          runMs: now() - runStartedAt,
          reusedPreparedData: preparation.reusedPreparedData,
        },
      });
      return;
    }

    if (type !== "run-sweep") throw new Error(`Unknown worker request: ${type}`);
    const preparation = ensurePreparedData({
      requestId,
      datasetKey,
      sourceData,
      config: configs[0],
      emit,
    });
    const runStartedAt = now();
    for (const [index, runConfig] of configs.entries()) {
      emit({
        type: "progress",
        requestId,
        phase: "run",
        current: index,
        total: configs.length,
        message: `Running configuration ${index + 1}/${configs.length}`,
      });
      emit({
        type: "result",
        requestId,
        index,
        result: runWeeklyStraddleBacktest({
          preparedData: preparation.preparedData,
          config: runConfig,
        }),
      });
    }
    emit({
      type: "complete",
      requestId,
      datasetKey,
      timing: {
        prepareMs: preparation.prepareMs,
        runMs: now() - runStartedAt,
        reusedPreparedData: preparation.reusedPreparedData,
      },
    });
  };

  return { handleRequest };
};
