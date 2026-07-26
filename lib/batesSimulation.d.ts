export type BatesVarianceParameters = {
  kappa: number;
  theta: number;
  sigma: number;
  rho: number;
  initialVariance: number;
};

export type BatesJumpParameters = {
  logMean: number;
  logStdDev: number;
  logSecondMoment: number;
  compensatorMean: number;
  byRegime: Record<string, { intensity: number }>;
};

export type BatesCalibration = {
  variance: BatesVarianceParameters;
  jumps: BatesJumpParameters;
  regimeCutoffs: {
    lowToMedium: number;
    mediumToHigh: number;
  };
  diagnostics?: {
    varianceSeries?: Array<{ ts: number; variance: number }>;
  };
};

export type BatesBudget = {
  initialVariance: number;
  diffusiveVarianceScale: number;
  effectiveJumpIntensity: number;
  expectedJumpQv?: number;
  expectedDiffusiveQv?: number;
  targetQv?: number;
  expectedTotalQv?: number;
  calibratedJumpIntensity?: number;
  jumpIntensityCapped?: boolean;
  maxJumpVarianceShare?: number;
  jumpVarianceShare?: number;
};

export type BatesProcess = {
  annualDrift: number;
  varianceParameters: BatesVarianceParameters;
  jumpParameters: BatesJumpParameters;
  initialVariance: number;
  diffusiveVarianceScale: number;
  effectiveJumpIntensity: number;
  orthogonalWeight: number;
};

export type BatesState = {
  logSpot: number;
  variance: number;
};

export function createBatesProcess(args: {
  calibration: BatesCalibration;
  budget: BatesBudget;
  annualDrift?: number;
}): BatesProcess;

export function createBatesState(
  spot: number,
  process: BatesProcess,
): BatesState;

export function advanceBatesState(
  state: BatesState,
  process: BatesProcess,
  dtYears: number,
  normalRandom: () => number,
  uniformRandom: () => number,
): {
  spot: number;
  variance: number;
  jumpCount: number;
};

export function buildQuadraticVariationBudget(args: {
  cycle: {
    entryTs: number;
    exitTs: number;
    sigma: number;
  };
  calibration: BatesCalibration;
  maxJumpVarianceShare?: number;
}): BatesBudget;
