export const createBacktestWorkerEngine = ({
  loadThalexHistory,
  prepareBacktestData,
  runWeeklyStraddleBacktest,
  buildPortfolioAttributionTimeline,
  buildCycleAttributionRows,
  now = () => performance.now(),
}) => {
  const preparedDatasets = new Map();
  const preparationLoads = new Map();

  const loadAndPrepareData = async ({
    requestId,
    datasetKey,
    loadRequest,
    config,
    emit,
  }) => {
    if (!loadRequest) throw new Error(`Load request is unavailable: ${datasetKey}`);
    emit({
      type: "progress",
      requestId,
      phase: "load",
      message: "Loading quote history",
    });
    const loadStartedAt = now();
    const loaded = await loadThalexHistory({
      ...loadRequest,
      onProgress: ({ current, total, file }) => emit({
        type: "progress",
        requestId,
        phase: "load",
        current,
        total,
        file,
        message: `Loaded ${current}/${total}: ${file}`,
      }),
    });
    const loadMs = now() - loadStartedAt;
    emit({
      type: "progress",
      requestId,
      phase: "prepare",
      message: "Preparing shared quote universe",
    });
    const startedAt = now();
    const preparedData = prepareBacktestData({
      indexRows: loaded.indexRows,
      quoteSnapshots: loaded.quoteSnapshots,
      instruments: loaded.artifact.instruments,
      config,
    });
    const prepareMs = now() - startedAt;
    preparedDatasets.set(datasetKey, preparedData);
    return { preparedData, loadMs, prepareMs };
  };

  const ensurePreparedData = async ({
    requestId,
    datasetKey,
    loadRequest,
    config,
    emit,
  }) => {
    if (preparedDatasets.has(datasetKey)) {
      return {
        preparedData: preparedDatasets.get(datasetKey),
        loadMs: 0,
        prepareMs: 0,
        reusedPreparedData: true,
      };
    }
    if (preparationLoads.has(datasetKey)) {
      const { preparedData } = await preparationLoads.get(datasetKey);
      return {
        preparedData,
        loadMs: 0,
        prepareMs: 0,
        reusedPreparedData: true,
      };
    }
    const preparation = loadAndPrepareData({
      requestId,
      datasetKey,
      loadRequest,
      config,
      emit,
    });
    preparationLoads.set(datasetKey, preparation);
    try {
      return {
        ...await preparation,
        reusedPreparedData: false,
      };
    } finally {
      preparationLoads.delete(datasetKey);
    }
  };

  const handleRequest = async (data, emit) => {
    const {
      requestId,
      type,
      datasetKey,
      loadRequest,
      prepareConfig,
      config,
      configs = [],
    } = data;
    if (type === "run-single") {
      const preparation = await ensurePreparedData({
        requestId,
        datasetKey,
        loadRequest,
        config: prepareConfig || config,
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
          loadMs: preparation.loadMs,
          prepareMs: preparation.prepareMs,
          runMs: now() - runStartedAt,
          reusedPreparedData: preparation.reusedPreparedData,
        },
      });
      return;
    }

    if (type === "run-attribution") {
      const preparation = await ensurePreparedData({
        requestId,
        datasetKey,
        loadRequest,
        config,
        emit,
      });
      emit({
        type: "progress",
        requestId,
        phase: "run",
        message: "Calculating PnL attribution",
      });
      const runStartedAt = now();
      const result = runWeeklyStraddleBacktest({
        preparedData: preparation.preparedData,
        config: { ...config, includeGreekAttribution: true },
      });
      emit({
        type: "complete",
        requestId,
        datasetKey,
        result: {
          timeline: buildPortfolioAttributionTimeline(result.cycleSummary),
          cycles: buildCycleAttributionRows(result.cycleSummary),
        },
        timing: {
          loadMs: preparation.loadMs,
          prepareMs: preparation.prepareMs,
          runMs: now() - runStartedAt,
          reusedPreparedData: preparation.reusedPreparedData,
        },
      });
      return;
    }

    if (type !== "run-sweep") throw new Error(`Unknown worker request: ${type}`);
    const preparation = await ensurePreparedData({
      requestId,
      datasetKey,
      loadRequest,
      config: prepareConfig || configs[0],
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
        loadMs: preparation.loadMs,
        prepareMs: preparation.prepareMs,
        runMs: now() - runStartedAt,
        reusedPreparedData: preparation.reusedPreparedData,
      },
    });
  };

  return { handleRequest };
};
