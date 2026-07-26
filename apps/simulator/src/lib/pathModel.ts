export type PathModelParams = {
  kind: "gbm" | "bates";
  meanReversion: number;
  longRunVol: number;
  volOfVol: number;
  correlation: number;
  jumpsEnabled: boolean;
  jumpIntensity: number;
  maxJumpVarianceShare: number;
  jumpMean: number;
  jumpVol: number;
};

export const DEFAULT_PATH_MODEL: PathModelParams = {
  kind: "bates",
  meanReversion: 8.86,
  longRunVol: 0.367,
  volOfVol: 0.1,
  correlation: -0.3,
  jumpsEnabled: false,
  jumpIntensity: 220.6,
  maxJumpVarianceShare: 0.35,
  jumpMean: -0.00163,
  jumpVol: 0.01878,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const sanitizePathModel = (
  value: PathModelParams,
): PathModelParams => ({
  kind: value?.kind === "gbm" ? "gbm" : "bates",
  meanReversion: clamp(
    finiteOr(value?.meanReversion, DEFAULT_PATH_MODEL.meanReversion),
    0.1,
    30,
  ),
  longRunVol: clamp(
    finiteOr(value?.longRunVol, DEFAULT_PATH_MODEL.longRunVol),
    0.05,
    2,
  ),
  volOfVol: clamp(
    finiteOr(value?.volOfVol, DEFAULT_PATH_MODEL.volOfVol),
    0,
    3,
  ),
  correlation: clamp(
    finiteOr(value?.correlation, DEFAULT_PATH_MODEL.correlation),
    -0.99,
    0.99,
  ),
  jumpsEnabled:
    typeof value?.jumpsEnabled === "boolean"
      ? value.jumpsEnabled
      : DEFAULT_PATH_MODEL.jumpsEnabled,
  jumpIntensity: clamp(
    finiteOr(value?.jumpIntensity, DEFAULT_PATH_MODEL.jumpIntensity),
    0,
    500,
  ),
  maxJumpVarianceShare: clamp(
    finiteOr(
      value?.maxJumpVarianceShare,
      DEFAULT_PATH_MODEL.maxJumpVarianceShare,
    ),
    0,
    0.9,
  ),
  jumpMean: clamp(
    finiteOr(value?.jumpMean, DEFAULT_PATH_MODEL.jumpMean),
    -0.2,
    0.2,
  ),
  jumpVol: clamp(
    finiteOr(value?.jumpVol, DEFAULT_PATH_MODEL.jumpVol),
    0,
    0.2,
  ),
});
