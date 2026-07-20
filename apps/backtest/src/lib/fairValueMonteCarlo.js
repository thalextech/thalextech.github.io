import { blackScholesPrice } from "./optionPricing.js";
import { blackScholesDelta, normalizeVol } from "./optionRisk.js";
import { mean } from "./statistics.js";

const SECONDS_PER_YEAR = 365 * 86_400;
const EPSILON = 1e-12;
export const HEDGE_MODES = ["unhedged", "dynamic"];
export const ANNUAL_DRIFT_VARIANTS = [0, 1, -1];

const quantile = (values, probability) => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * weight;
};

const populationStdDev = (values) => {
  if (!values.length) return Number.NaN;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const IV_REGIMES = [
  { label: "Low IV", rangeLabel: "z < −0.5", accepts: (zScore) => zScore < -0.5 },
  { label: "Medium IV", rangeLabel: "−0.5 ≤ z < +0.5", accepts: (zScore) => zScore >= -0.5 && zScore < 0.5 },
  { label: "High IV", rangeLabel: "+0.5 ≤ z < +1.5", accepts: (zScore) => zScore >= 0.5 && zScore < 1.5 },
  { label: "Extreme IV", rangeLabel: "z ≥ +1.5", accepts: (zScore) => zScore >= 1.5 },
];

export const createSeededRandom = (seed = 1) => {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const createNormalRandom = (uniform) => {
  let spare = null;
  return () => {
    if (spare != null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(EPSILON, uniform())));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
};

// Keep the volatility choice isolated so a surface-based model can replace it later.
export const resolveCycleEntryVol = (cycle) => {
  const legs = (cycle?.legs || []).filter((leg) =>
    Number.isFinite(Number(leg.entryImpliedVol)),
  );
  if (!legs.length) return Number.NaN;
  const closestDistance = Math.min(...legs.map((leg) =>
    Math.abs(Number(leg.strike) - Number(cycle.entryIndexPrice)),
  ));
  const atmLegs = legs.filter((leg) =>
    Math.abs(Number(leg.strike) - Number(cycle.entryIndexPrice)) === closestDistance,
  );
  return mean(atmLegs.map((leg) => normalizeVol(Number(leg.entryImpliedVol))));
};

const modelLeg = (leg, spot, ts, sigma) => {
  if (ts >= leg.expirationTs) {
    return leg.optionType === "C"
      ? Math.max(spot - leg.strike, 0)
      : Math.max(leg.strike - spot, 0);
  }
  return blackScholesPrice(leg, spot, ts, sigma);
};

const modelLegDelta = (leg, spot, ts, sigma) => {
  if (ts >= leg.expirationTs) return 0;
  return blackScholesDelta({
    spot,
    strike: leg.strike,
    yearsToExpiry: Math.max(0, (leg.expirationTs - ts) / SECONDS_PER_YEAR),
    impliedVol: sigma,
    optionType: leg.optionType,
  });
};

export const buildFairValueCycleState = (cycle) => {
  const entryTs = new Date(cycle.entryTime).getTime() / 1000;
  const exitTs = new Date(cycle.exitTime).getTime() / 1000;
  const entrySpot = Number(cycle.entryIndexPrice);
  const exitSpot = Number(cycle.exitIndexPrice);
  const sigma = resolveCycleEntryVol(cycle);
  if (![entryTs, exitTs, entrySpot, exitSpot, sigma].every(Number.isFinite)
    || entrySpot <= 0 || exitSpot <= 0 || exitTs <= entryTs) {
    throw new Error(`Cycle ${cycle.cycle ?? "?"} has an invalid simulation price state`);
  }
  const legs = (cycle.legs || []).map((leg) => ({
    optionType: leg.optionType,
    strike: Number(leg.strike),
    expirationTs: Number(leg.expirationTs),
    quantity: Number(leg.quantity),
    entryDelta: Number(leg.entryDelta),
  }));
  if (!legs.length || legs.some((leg) =>
    ![leg.strike, leg.expirationTs, leg.quantity].every(Number.isFinite),
  )) {
    throw new Error(`Cycle ${cycle.cycle ?? "?"} has invalid option legs`);
  }

  const fairEntryOptionValue = legs.reduce((total, leg) =>
    total + leg.quantity * modelLeg(leg, entrySpot, entryTs, sigma),
  0);
  const entryPortfolioDelta = legs.reduce((total, leg) => {
    const delta = Number.isFinite(leg.entryDelta)
      ? leg.entryDelta
      : blackScholesDelta({
          spot: entrySpot,
          strike: leg.strike,
          yearsToExpiry: (leg.expirationTs - entryTs) / SECONDS_PER_YEAR,
          impliedVol: sigma,
          optionType: leg.optionType,
        });
    return total + leg.quantity * delta;
  }, 0);

  const actualDynamicPnl = Number(cycle.cyclePnlUsd) || 0;
  const actualUnhedgedPnl = Number.isFinite(Number(cycle.shortOptionPnlUsd))
    ? Number(cycle.shortOptionPnlUsd)
    : actualDynamicPnl - (Number(cycle.hedgePnlUsd) || 0);
  const state = {
    cycle: Number(cycle.cycle),
    entryTs,
    exitTs,
    entrySpot,
    exitSpot,
    sigma,
    legs,
    fairEntryCashflow: -fairEntryOptionValue,
    premiumBasisUsd: Math.max(EPSILON, Math.abs(fairEntryOptionValue)),
    hedgeEnabled: cycle.hedgeEnabled !== false,
    hedgeIntervalHours: Math.max(1, Number(cycle.hedgeIntervalHours) || 24),
    hedgeDeltaTolerance: Math.max(0, Number(cycle.hedgeDeltaTolerance) || 0),
    hedgeCostBps: Math.max(0, Number(cycle.hedgeCostBps) || 0),
    entryPortfolioDelta,
    actualPnlByMode: {
      unhedged: actualUnhedgedPnl,
      dynamic: actualDynamicPnl,
    },
  };
  state.simulationTimes = buildSimulationTimes(state);
  return state;
};

const optionPnlAt = (cycle, spot, ts) => cycle.fairEntryCashflow
  + cycle.legs.reduce((total, leg) =>
    total + leg.quantity * modelLeg(leg, spot, ts, cycle.sigma), 0);

const portfolioDeltaAt = (cycle, spot, ts) => cycle.legs.reduce((total, leg) =>
  total + leg.quantity * modelLegDelta(leg, spot, ts, cycle.sigma), 0);

const buildSimulationTimes = (cycle) => {
  const holdingSeconds = cycle.exitTs - cycle.entryTs;
  const intervalSeconds = cycle.hedgeIntervalHours * 3_600;
  const times = new Set([holdingSeconds]);
  for (let elapsed = intervalSeconds; elapsed < holdingSeconds; elapsed += intervalSeconds) {
    times.add(elapsed);
  }
  return [...times].sort((a, b) => a - b);
};

export const generateGbmPath = ({
  cycle,
  normalRandom,
  annualDrift = 0,
}) => {
  const times = cycle.simulationTimes || buildSimulationTimes(cycle);
  let previousElapsedSeconds = 0;
  let logSpot = Math.log(cycle.entrySpot);
  return times.map((elapsedSeconds) => {
    const dtYears = (elapsedSeconds - previousElapsedSeconds) / SECONDS_PER_YEAR;
    logSpot += (annualDrift - 0.5 * cycle.sigma ** 2) * dtYears
      + cycle.sigma * Math.sqrt(dtYears) * normalRandom();
    previousElapsedSeconds = elapsedSeconds;
    return {
      ts: cycle.entryTs + elapsedSeconds,
      elapsedSeconds,
      spot: Math.exp(logSpot),
    };
  });
};

const dynamicHedgePnl = ({ cycle, path }) => {
  const intervalSeconds = cycle.hedgeIntervalHours * 3_600;
  let hedgeQuantity = -cycle.entryPortfolioDelta;
  let previousSpot = cycle.entrySpot;
  let hedgePnl = 0;
  let costs = Math.abs(hedgeQuantity) * cycle.entrySpot * cycle.hedgeCostBps / 10_000;
  for (const point of path) {
    hedgePnl += hedgeQuantity * (point.spot - previousSpot);
    previousSpot = point.spot;
    const isExit = Math.abs(point.ts - cycle.exitTs) < 1e-7;
    const isScheduled = !isExit
      && Math.abs(point.elapsedSeconds / intervalSeconds - Math.round(point.elapsedSeconds / intervalSeconds)) < 1e-7;
    if (!isExit && !isScheduled) continue;
    const targetQuantity = isExit ? 0 : -portfolioDeltaAt(cycle, point.spot, point.ts);
    const tradeQuantity = targetQuantity - hedgeQuantity;
    if (!isExit && Math.abs(tradeQuantity) < cycle.hedgeDeltaTolerance) continue;
    costs += Math.abs(tradeQuantity) * point.spot * cycle.hedgeCostBps / 10_000;
    hedgeQuantity = targetQuantity;
  }
  return hedgePnl - costs;
};

export const simulateWeeklyCycleModes = (
  cycle,
  normalRandom,
  annualDrift = 0,
) => {
  const path = generateGbmPath({ cycle, normalRandom, annualDrift });
  const terminalSpot = path.at(-1).spot;
  const unhedged = optionPnlAt(cycle, terminalSpot, cycle.exitTs);
  return {
    unhedged,
    dynamic: unhedged + dynamicHedgePnl({ cycle, path }),
  };
};


const summarizeDistribution = (values, actualPnl) => {
  const count = values.length;
  const belowOrEqual = values.filter((value) => value <= actualPnl).length;
  return {
    actualPnl,
    mean: mean(values),
    standardDeviation: populationStdDev(values),
    median: quantile(values, 0.5),
    p01: quantile(values, 0.01),
    p05: quantile(values, 0.05),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    actualPercentile: count ? 100 * belowOrEqual / count : Number.NaN,
    probabilityExceedsActual: count
      ? values.filter((value) => value > actualPnl).length / count
      : Number.NaN,
  };
};

export const summarizeBayesianEdge = ({
  cycles,
  hedgeMode,
  seed = 1,
  draws = 5_000,
}) => {
  const observations = cycles.map((cycle) =>
    cycle.actualPnlByMode[hedgeMode] / Math.max(EPSILON, cycle.premiumBasisUsd));
  if (!observations.length) {
    return {
      draws: 0,
      probabilityEdgePositive: Number.NaN,
      observedMean: Number.NaN,
      posteriorMedian: Number.NaN,
      p05: Number.NaN,
      p95: Number.NaN,
    };
  }
  const uniformRandom = createSeededRandom(seed);
  const posteriorMeans = Array.from({ length: draws }, () => {
    let weightedTotal = 0;
    let totalWeight = 0;
    observations.forEach((observation) => {
      const weight = -Math.log(Math.max(EPSILON, uniformRandom()));
      weightedTotal += weight * observation;
      totalWeight += weight;
    });
    return weightedTotal / totalWeight;
  });
  return {
    draws,
    probabilityEdgePositive: posteriorMeans.filter((value) => value > 0).length / draws,
    observedMean: mean(observations),
    posteriorMedian: quantile(posteriorMeans, 0.5),
    p05: quantile(posteriorMeans, 0.05),
    p95: quantile(posteriorMeans, 0.95),
  };
};

const summarizeGroups = (
  groups,
  samples,
  hedgeMode,
  bayesianGroups = [],
) => groups.map((group, index) => {
  const actualPnl = group.cycles.reduce(
    (sum, cycle) => sum + cycle.actualPnlByMode[hedgeMode],
    0,
  );
  const premiumBasisUsd = Math.max(EPSILON, group.cycles.reduce(
    (sum, cycle) => sum + cycle.premiumBasisUsd,
    0,
  ));
  const terminalReturnOnPremium = samples[index].map((value) => value / premiumBasisUsd);
  return {
    index,
    label: group.label,
    rangeLabel: group.rangeLabel,
    startDate: group.cycles.length ? new Date(group.cycles[0].entryTs * 1000) : null,
    endDate: group.cycles.length ? new Date(group.cycles.at(-1).exitTs * 1000) : null,
    weekCount: group.cycles.length,
    meanEntryIv: group.cycles.length ? mean(group.cycles.map((cycle) => cycle.sigma)) : Number.NaN,
    premiumBasisUsd,
    terminalPnl: [...samples[index]],
    terminalReturnOnPremium,
    summary: summarizeDistribution(samples[index], actualPnl),
    returnSummary: summarizeDistribution(
      terminalReturnOnPremium,
      actualPnl / premiumBasisUsd,
    ),
    bayesianEdge: bayesianGroups[index] || null,
  };
});

const summarizeHitRateGroups = (groups, cycles, weeklySamples, hedgeMode) => {
  const cycleIndex = new Map(cycles.map((cycle, index) => [cycle, index]));
  const simulationCount = weeklySamples[0]?.length || 0;
  return groups.map((group, index) => {
    const indexes = group.cycles.map((cycle) => cycleIndex.get(cycle));
    const hitCounts = Array.from({ length: simulationCount }, (_, simulationIndex) =>
      indexes.filter((cycleIndexValue) => weeklySamples[cycleIndexValue][simulationIndex] > 0).length);
    const hitRates = hitCounts.map((hits) => hits / Math.max(1, group.cycles.length));
    const actualHits = group.cycles.filter((cycle) => cycle.actualPnlByMode[hedgeMode] > 0).length;
    const actualHitRate = group.cycles.length ? actualHits / group.cycles.length : Number.NaN;
    const distribution = summarizeDistribution(hitRates, actualHitRate);
    const scenariosAtOrAboveActual = hitCounts.filter((hits) => hits >= actualHits).length;
    return {
      index,
      label: group.label,
      rangeLabel: group.rangeLabel,
      startDate: group.cycles.length ? new Date(group.cycles[0].entryTs * 1000) : null,
      endDate: group.cycles.length ? new Date(group.cycles.at(-1).exitTs * 1000) : null,
      weekCount: group.cycles.length,
      meanEntryIv: group.cycles.length ? mean(group.cycles.map((cycle) => cycle.sigma)) : Number.NaN,
      hitCounts,
      hitRates,
      summary: {
        ...distribution,
        actualHits,
        actualHitRate,
        expectedHitRate: distribution.mean,
        scenariosAtOrAboveActual,
        probabilityAtOrAboveActual: simulationCount
          ? scenariosAtOrAboveActual / simulationCount
          : Number.NaN,
      },
    };
  });
};

// Retained as part of the simulation result contract even though the UI now
// uses the cumulative hit-rate view instead of the weekly percentile strip.
const summarizeWeeklyNullRanks = (cycles, samples, hedgeMode) => cycles.map((cycle, index) => {
  const values = samples[index];
  const actualPnl = cycle.actualPnlByMode[hedgeMode];
  const lessThanActual = values.filter((value) => value < actualPnl).length;
  const equalToActual = values.filter((value) => value === actualPnl).length;
  return {
    cycle: cycle.cycle,
    entryDate: new Date(cycle.entryTs * 1000),
    exitDate: new Date(cycle.exitTs * 1000),
    actualPnl,
    actualReturn: cycle.exitSpot / cycle.entrySpot - 1,
    percentile: values.length
      ? 100 * (lessThanActual + 0.5 * equalToActual) / values.length
      : Number.NaN,
    simulations: values.length,
  };
});

const summarizeMode = ({
  hedgeMode,
  samples,
  requestedSimulations,
  cycles,
  timeGroups,
  ivGroups,
  bayesianEdge,
}) => {
  const terminalPnl = samples.terminalPnl;
  const actualTerminalPnl = timeGroups.flatMap((group) => group.cycles)
    .reduce((sum, cycle) => sum + cycle.actualPnlByMode[hedgeMode], 0);
  const combinedGroups = [{ label: "Combined", cycles }];
  const combined = summarizeGroups(
    combinedGroups,
    [terminalPnl],
    hedgeMode,
    [bayesianEdge.combined],
  )[0];
  const timeCohorts = summarizeGroups(
    timeGroups,
    samples.time,
    hedgeMode,
    bayesianEdge.time,
  );
  const ivRegimes = summarizeGroups(
    ivGroups,
    samples.iv,
    hedgeMode,
    bayesianEdge.iv,
  );
  const combinedHitRate = summarizeHitRateGroups(
    combinedGroups,
    cycles,
    samples.weekly,
    hedgeMode,
  )[0];
  const timeHitRates = summarizeHitRateGroups(timeGroups, cycles, samples.weekly, hedgeMode);
  const ivHitRates = summarizeHitRateGroups(ivGroups, cycles, samples.weekly, hedgeMode);
  return {
    hedgeMode,
    modelLabel: hedgeMode === "dynamic"
      ? "Dynamic hedge under conditional GBM"
      : "Unhedged option PnL under conditional GBM",
    simulations: terminalPnl.length,
    requestedSimulations,
    terminalPnl: [...terminalPnl],
    summary: {
      actualTerminalPnl,
      simulatedMedian: quantile(terminalPnl, 0.5),
      p05: quantile(terminalPnl, 0.05),
      p95: quantile(terminalPnl, 0.95),
      ...summarizeDistribution(terminalPnl, actualTerminalPnl),
    },
    cohorts: timeCohorts,
    combined,
    combinedHitRate,
    bayesianEdge: bayesianEdge.combined,
    weeklyNullRanks: summarizeWeeklyNullRanks(cycles, samples.weekly, hedgeMode),
    views: {
      time: timeCohorts,
      iv: ivRegimes,
    },
    hitRateViews: {
      time: timeHitRates,
      iv: ivHitRates,
    },
  };
};

const summarize = ({
  modeSamples,
  defaultHedgeMode,
  requestedSimulations,
  cycles,
  timeGroups,
  ivGroups,
  ivMean,
  ivStandardDeviation,
  path,
  returnNull,
  hedgeModes,
  bayesianByMode,
}) => {
  const modes = Object.fromEntries(hedgeModes.map((hedgeMode) => [
    hedgeMode,
    summarizeMode({
      hedgeMode,
      samples: modeSamples[hedgeMode],
      requestedSimulations,
      cycles,
      timeGroups,
      ivGroups,
      bayesianEdge: bayesianByMode[hedgeMode],
    }),
  ]));
  return {
    ...modes[defaultHedgeMode],
    defaultHedgeMode,
    modes,
    ivZScore: {
      mean: ivMean,
      standardDeviation: ivStandardDeviation,
    },
    path,
    returnNull,
  };
};

export const runFairValueMonteCarlo = async ({
  cycles = [],
  simulations = 1_000,
  seed = Date.now(),
  onProgress,
}) => {
  const states = cycles
    .filter((cycle) => cycle.closed !== false)
    .map(buildFairValueCycleState);
  const count = Math.max(1, Math.round(Number(simulations) || 1_000));
  if (!states.length) throw new Error("No completed cycles are available for simulation");

  const uniformRandom = createSeededRandom(seed);
  const normalRandom = createNormalRandom(uniformRandom);
  const defaultHedgeMode = states.some((cycle) => cycle.hedgeEnabled) ? "dynamic" : "unhedged";
  const hedgeModes = defaultHedgeMode === "dynamic" ? HEDGE_MODES : ["unhedged"];
  const returnNull = {
    type: "conditional-gbm-drift-mixture",
    conditionalCycles: states.length,
    volatility: "each cycle's entry IV",
    pathGrid: "scheduled hedge times and exit",
    realizedVariance: "unconstrained finite-sample GBM realization",
    annualDriftVariants: [...ANNUAL_DRIFT_VARIANTS],
    driftScenarioCounts: Object.fromEntries(ANNUAL_DRIFT_VARIANTS.map((drift, variantIndex) => [
      `${drift}`,
      Math.max(0, Math.floor((count - 1 - variantIndex) / ANNUAL_DRIFT_VARIANTS.length) + 1),
    ])),
    allocation: "round-robin equal thirds",
    zeroDriftIsPrimaryNull: true,
    pnlCenteredToFairValue: false,
  };
  const cohortCount = Math.min(4, states.length);
  const baseCohortSize = Math.floor(states.length / cohortCount);
  const remainder = states.length % cohortCount;
  const timeGroups = [];
  let cohortStart = 0;
  for (let index = 0; index < cohortCount; index += 1) {
    const size = baseCohortSize + (index < remainder ? 1 : 0);
    timeGroups.push({
      label: `Cohort ${index + 1}`,
      cycles: states.slice(cohortStart, cohortStart + size),
    });
    cohortStart += size;
  }
  const ivMean = mean(states.map((cycle) => cycle.sigma));
  const ivStandardDeviation = populationStdDev(states.map((cycle) => cycle.sigma));
  const zScoreFor = (cycle) => ivStandardDeviation > EPSILON
    ? (cycle.sigma - ivMean) / ivStandardDeviation
    : 0;
  const ivGroups = IV_REGIMES.map((regime) => ({
    label: regime.label,
    rangeLabel: regime.rangeLabel,
    cycles: states.filter((cycle) => regime.accepts(zScoreFor(cycle))),
  }));
  const timeGroupByCycle = new Map();
  timeGroups.forEach((group, groupIndex) => {
    group.cycles.forEach((cycle) => timeGroupByCycle.set(cycle, groupIndex));
  });
  const ivGroupByCycle = new Map();
  ivGroups.forEach((group, groupIndex) => {
    group.cycles.forEach((cycle) => ivGroupByCycle.set(cycle, groupIndex));
  });
  const modeSamples = Object.fromEntries(hedgeModes.map((hedgeMode) => [hedgeMode, {
    terminalPnl: [],
    weekly: states.map(() => []),
    time: timeGroups.map(() => []),
    iv: ivGroups.map(() => []),
  }]));
  const bayesianByMode = Object.fromEntries(hedgeModes.map((hedgeMode, modeIndex) => {
    const baseSeed = (Number(seed) + 0x9e3779b9 + modeIndex * 10_000) >>> 0;
    const summarizeGroupsForBayes = (groups, offset) => groups.map((group, groupIndex) =>
      summarizeBayesianEdge({
        cycles: group.cycles,
        hedgeMode,
        seed: (baseSeed + offset + groupIndex) >>> 0,
      }));
    return [hedgeMode, {
      combined: summarizeBayesianEdge({ cycles: states, hedgeMode, seed: baseSeed }),
      time: summarizeGroupsForBayes(timeGroups, 1_000),
      iv: summarizeGroupsForBayes(ivGroups, 2_000),
    }];
  }));
  const path = {
    maxPathPoints: Math.max(...states.map((cycle) => cycle.simulationTimes.length)),
    usesScheduledHedgeTimes: true,
    pathSource: "conditional GBM with cycle entry IV",
    costsConfigured: states.some((cycle) => cycle.hedgeCostBps > 0),
    toleranceConfigured: states.some((cycle) => cycle.hedgeDeltaTolerance > 0),
  };
  const updateStride = Math.max(1, Math.floor(count / 20));

  for (let simulation = 0; simulation < count; simulation += 1) {
    const annualDrift = ANNUAL_DRIFT_VARIANTS[simulation % ANNUAL_DRIFT_VARIANTS.length];
    const terminalPnl = Object.fromEntries(hedgeModes.map((mode) => [mode, 0]));
    const timePnl = Object.fromEntries(hedgeModes.map((mode) => [mode, timeGroups.map(() => 0)]));
    const ivPnl = Object.fromEntries(hedgeModes.map((mode) => [mode, ivGroups.map(() => 0)]));
    for (const [cycleIndex, cycle] of states.entries()) {
      const outcomes = simulateWeeklyCycleModes(cycle, normalRandom, annualDrift);
      for (const hedgeMode of hedgeModes) {
        terminalPnl[hedgeMode] += outcomes[hedgeMode];
        modeSamples[hedgeMode].weekly[cycleIndex].push(outcomes[hedgeMode]);
        timePnl[hedgeMode][timeGroupByCycle.get(cycle)] += outcomes[hedgeMode];
        ivPnl[hedgeMode][ivGroupByCycle.get(cycle)] += outcomes[hedgeMode];
      }
    }
    for (const hedgeMode of hedgeModes) {
      modeSamples[hedgeMode].terminalPnl.push(terminalPnl[hedgeMode]);
      timePnl[hedgeMode].forEach((pnl, index) => modeSamples[hedgeMode].time[index].push(pnl));
      ivPnl[hedgeMode].forEach((pnl, index) => modeSamples[hedgeMode].iv[index].push(pnl));
    }
    const completed = simulation + 1;
    if (completed % updateStride === 0 || completed === count) {
      onProgress?.({
        completed,
        total: count,
        result: summarize({
          modeSamples,
          defaultHedgeMode,
          requestedSimulations: count,
          cycles: states,
          timeGroups,
          ivGroups,
          ivMean,
          ivStandardDeviation,
          path,
          returnNull,
          hedgeModes,
          bayesianByMode,
        }),
      });
      // Pace batches by one frame so the evolving distribution is visible and
      // controls remain responsive; the calculation itself is already sub-frame.
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  return summarize({
    modeSamples,
    defaultHedgeMode,
    requestedSimulations: count,
    cycles: states,
    timeGroups,
    ivGroups,
    ivMean,
    ivStandardDeviation,
    path,
    returnNull,
    hedgeModes,
    bayesianByMode,
  });
};
