import {
  resolveVarianceAt,
  resolveVolatilityRegime,
} from "./batesCalibration.js";

const SECONDS_PER_YEAR = 365 * 86_400;
const EPSILON = 1e-12;

const poissonRandom = (intensity, uniformRandom) => {
  if (intensity <= 0) return 0;
  if (intensity < 0.1) return uniformRandom() < intensity ? 1 : 0;
  const limit = Math.exp(-intensity);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= uniformRandom();
  } while (product > limit);
  return count - 1;
};

export const createBatesProcess = ({
  calibration,
  budget,
  annualDrift = 0,
}) => {
  const varianceParameters = calibration.variance;
  const jumpParameters = calibration.jumps;
  const rho = varianceParameters.rho;
  return {
    annualDrift,
    varianceParameters,
    jumpParameters,
    initialVariance: budget.initialVariance,
    diffusiveVarianceScale: budget.diffusiveVarianceScale,
    effectiveJumpIntensity: budget.effectiveJumpIntensity,
    orthogonalWeight: Math.sqrt(Math.max(0, 1 - rho ** 2)),
  };
};

export const createBatesState = (spot, process) => ({
  logSpot: Math.log(spot),
  variance: process.initialVariance,
});

export const advanceBatesState = (
  state,
  process,
  dtYears,
  normalRandom,
  uniformRandom,
) => {
  const varianceParameters = process.varianceParameters;
  const jumpParameters = process.jumpParameters;
  const positiveVariance = Math.max(0, state.variance);
  const varianceShock = normalRandom();
  const priceShock = varianceParameters.rho * varianceShock
    + process.orthogonalWeight * normalRandom();
  const jumpCount = poissonRandom(
    process.effectiveJumpIntensity * dtYears,
    uniformRandom,
  );
  let jumpLogReturn = 0;
  for (let jump = 0; jump < jumpCount; jump += 1) {
    jumpLogReturn += jumpParameters.logMean
      + jumpParameters.logStdDev * normalRandom();
  }
  const scaledVariance = process.diffusiveVarianceScale * positiveVariance;
  state.logSpot += (
    process.annualDrift
      - process.effectiveJumpIntensity * jumpParameters.compensatorMean
      - 0.5 * scaledVariance
  ) * dtYears
    + Math.sqrt(Math.max(0, scaledVariance * dtYears)) * priceShock
    + jumpLogReturn;
  state.variance = Math.max(
    0,
    state.variance
      + varianceParameters.kappa
        * (varianceParameters.theta - positiveVariance) * dtYears
      + varianceParameters.sigma
        * Math.sqrt(positiveVariance * dtYears) * varianceShock,
  );
  return {
    spot: Math.exp(state.logSpot),
    variance: state.variance,
    jumpCount,
  };
};

export const expectedIntegratedVariance = ({ kappa, theta, initialVariance, years }) => {
  if (kappa <= EPSILON) return Math.max(EPSILON, initialVariance) * years;
  return theta * years
    + (initialVariance - theta) * (1 - Math.exp(-kappa * years)) / kappa;
};

export const buildQuadraticVariationBudget = ({
  cycle,
  calibration,
  maxJumpVarianceShare = 1,
}) => {
  const years = (cycle.exitTs - cycle.entryTs) / SECONDS_PER_YEAR;
  const initialVariance = resolveVarianceAt(calibration, cycle.entryTs);
  const entryRealizedVol = Math.sqrt(Math.max(EPSILON, initialVariance));
  const regime = resolveVolatilityRegime(calibration, entryRealizedVol);
  const jumpParameters = calibration.jumps;
  const calibratedIntensity = jumpParameters.byRegime[regime].intensity;
  const jumpSecondMoment = jumpParameters.logSecondMoment;
  const targetQv = cycle.sigma ** 2 * years;
  const calibratedJumpQv = calibratedIntensity * jumpSecondMoment * years;
  const requestedJumpVarianceShare = Number(maxJumpVarianceShare);
  const boundedJumpVarianceShare = Math.max(
    0,
    Math.min(
      1 - 1e-9,
      Number.isFinite(requestedJumpVarianceShare)
        ? requestedJumpVarianceShare
        : 1,
    ),
  );
  const maximumJumpQv = targetQv * boundedJumpVarianceShare;
  const jumpBudgetFeasible = calibratedJumpQv <= maximumJumpQv;
  const effectiveJumpIntensity = jumpBudgetFeasible || jumpSecondMoment <= EPSILON
    ? calibratedIntensity
    : maximumJumpQv / (jumpSecondMoment * years);
  const expectedJumpQv = effectiveJumpIntensity * jumpSecondMoment * years;
  const expectedBaseDiffusiveQv = expectedIntegratedVariance({
    ...calibration.variance,
    initialVariance,
    years,
  });
  const targetDiffusiveQv = Math.max(EPSILON, targetQv - expectedJumpQv);
  const diffusiveVarianceScale = targetDiffusiveQv
    / Math.max(EPSILON, expectedBaseDiffusiveQv);
  return {
    years,
    days: years * 365,
    regime,
    initialVariance,
    entryRealizedVol,
    targetQv,
    expectedJumpQv,
    expectedDiffusiveQv: diffusiveVarianceScale * expectedBaseDiffusiveQv,
    expectedTotalQv: expectedJumpQv
      + diffusiveVarianceScale * expectedBaseDiffusiveQv,
    calibratedJumpIntensity: calibratedIntensity,
    effectiveJumpIntensity,
    jumpIntensityCapped: effectiveJumpIntensity < calibratedIntensity,
    maxJumpVarianceShare: boundedJumpVarianceShare,
    jumpVarianceShare: expectedJumpQv / Math.max(EPSILON, targetQv),
    diffusiveVarianceScale,
  };
};

export const buildIntraWeekSimulationTimes = (cycle) => {
  const holdingSeconds = cycle.exitTs - cycle.entryTs;
  const times = new Set([holdingSeconds]);
  for (let elapsed = 3_600; elapsed < holdingSeconds; elapsed += 3_600) {
    times.add(elapsed);
  }
  return [...times].sort((first, second) => first - second);
};

export const generateBatesPath = ({
  cycle,
  calibration,
  normalRandom,
  uniformRandom,
  annualDrift = 0,
  budget = buildQuadraticVariationBudget({ cycle, calibration }),
}) => {
  const times = buildIntraWeekSimulationTimes(cycle);
  const process = createBatesProcess({ calibration, budget, annualDrift });
  const state = createBatesState(cycle.entrySpot, process);
  let previousElapsedSeconds = 0;
  return times.map((elapsedSeconds) => {
    const dtYears = (elapsedSeconds - previousElapsedSeconds) / SECONDS_PER_YEAR;
    const point = advanceBatesState(
      state,
      process,
      dtYears,
      normalRandom,
      uniformRandom,
    );
    previousElapsedSeconds = elapsedSeconds;
    return {
      ts: cycle.entryTs + elapsedSeconds,
      elapsedSeconds,
      ...point,
    };
  });
};

export const simulateBatesRealizedVol = ({
  cycle,
  calibration,
  normalRandom,
  uniformRandom,
  budget = buildQuadraticVariationBudget({ cycle, calibration }),
}) => {
  const times = buildIntraWeekSimulationTimes(cycle);
  const varianceParameters = calibration.variance;
  const jumpParameters = calibration.jumps;
  let previousElapsedSeconds = 0;
  let latentVariance = budget.initialVariance;
  let quadraticVariation = 0;
  for (const elapsedSeconds of times) {
    const dtYears = (elapsedSeconds - previousElapsedSeconds) / SECONDS_PER_YEAR;
    const positiveVariance = Math.max(0, latentVariance);
    quadraticVariation += budget.diffusiveVarianceScale * positiveVariance * dtYears;
    const jumpCount = poissonRandom(
      budget.effectiveJumpIntensity * dtYears,
      uniformRandom,
    );
    for (let jump = 0; jump < jumpCount; jump += 1) {
      const jumpLogReturn = jumpParameters.logMean
        + jumpParameters.logStdDev * normalRandom();
      quadraticVariation += jumpLogReturn ** 2;
    }
    latentVariance = Math.max(
      0,
      latentVariance
        + varianceParameters.kappa * (varianceParameters.theta - positiveVariance) * dtYears
        + varianceParameters.sigma * Math.sqrt(positiveVariance * dtYears) * normalRandom(),
    );
    previousElapsedSeconds = elapsedSeconds;
  }
  return Math.sqrt(quadraticVariation / Math.max(EPSILON, budget.years));
};
