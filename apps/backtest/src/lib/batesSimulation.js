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

export const expectedIntegratedVariance = ({ kappa, theta, initialVariance, years }) => {
  if (kappa <= EPSILON) return Math.max(EPSILON, initialVariance) * years;
  return theta * years
    + (initialVariance - theta) * (1 - Math.exp(-kappa * years)) / kappa;
};

export const buildQuadraticVariationBudget = ({ cycle, calibration }) => {
  const years = (cycle.exitTs - cycle.entryTs) / SECONDS_PER_YEAR;
  const initialVariance = resolveVarianceAt(calibration, cycle.entryTs);
  const entryRealizedVol = Math.sqrt(Math.max(EPSILON, initialVariance));
  const regime = resolveVolatilityRegime(calibration, entryRealizedVol);
  const jumpParameters = calibration.jumps;
  const calibratedIntensity = jumpParameters.byRegime[regime].intensity;
  const jumpSecondMoment = jumpParameters.logSecondMoment;
  const targetQv = cycle.sigma ** 2 * years;
  const calibratedJumpQv = calibratedIntensity * jumpSecondMoment * years;
  const feasible = calibratedJumpQv < targetQv;
  const effectiveJumpIntensity = feasible || jumpSecondMoment <= EPSILON
    ? calibratedIntensity
    : targetQv * (1 - 1e-9) / (jumpSecondMoment * years);
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
  const varianceParameters = calibration.variance;
  const jumpParameters = calibration.jumps;
  const jumpCompensator = jumpParameters.compensatorMean;
  const rho = varianceParameters.rho;
  const orthogonalWeight = Math.sqrt(Math.max(0, 1 - rho ** 2));
  let previousElapsedSeconds = 0;
  let logSpot = Math.log(cycle.entrySpot);
  let latentVariance = budget.initialVariance;
  return times.map((elapsedSeconds) => {
    const dtYears = (elapsedSeconds - previousElapsedSeconds) / SECONDS_PER_YEAR;
    const positiveVariance = Math.max(0, latentVariance);
    const varianceShock = normalRandom();
    const priceShock = rho * varianceShock + orthogonalWeight * normalRandom();
    const jumpCount = poissonRandom(
      budget.effectiveJumpIntensity * dtYears,
      uniformRandom,
    );
    let jumpLogReturn = 0;
    for (let jump = 0; jump < jumpCount; jump += 1) {
      jumpLogReturn += jumpParameters.logMean + jumpParameters.logStdDev * normalRandom();
    }
    const scaledVariance = budget.diffusiveVarianceScale * positiveVariance;
    logSpot += (
      annualDrift
        - budget.effectiveJumpIntensity * jumpCompensator
        - 0.5 * scaledVariance
    ) * dtYears
      + Math.sqrt(Math.max(0, scaledVariance * dtYears)) * priceShock
      + jumpLogReturn;
    latentVariance = Math.max(
      0,
      latentVariance
        + varianceParameters.kappa * (varianceParameters.theta - positiveVariance) * dtYears
        + varianceParameters.sigma * Math.sqrt(positiveVariance * dtYears) * varianceShock,
    );
    previousElapsedSeconds = elapsedSeconds;
    return {
      ts: cycle.entryTs + elapsedSeconds,
      elapsedSeconds,
      spot: Math.exp(logSpot),
      variance: latentVariance,
      jumpCount,
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
