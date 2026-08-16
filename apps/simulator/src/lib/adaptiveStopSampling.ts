const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const FINE_STEP_SECONDS = 60;
const PROXIMITY_VOL_TIMES = 4;

export const adaptiveStopSubsteps = (
  spot: number,
  annualVol: number,
  intervalYears: number,
  activeStopPrices: readonly number[],
): number => {
  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(annualVol) ||
    annualVol <= 0 ||
    !Number.isFinite(intervalYears) ||
    intervalYears <= 0 ||
    activeStopPrices.length === 0
  ) {
    return 1;
  }

  const intervalSeconds = intervalYears * SECONDS_PER_YEAR;
  if (intervalSeconds <= FINE_STEP_SECONDS) return 1;

  const proximity =
    PROXIMITY_VOL_TIMES * annualVol * Math.sqrt(intervalYears);
  const nearActiveStop = activeStopPrices.some((stopPrice) => {
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return false;
    return Math.abs(Math.log(spot / stopPrice)) <= proximity;
  });

  return nearActiveStop
    ? Math.max(1, Math.ceil(intervalSeconds / FINE_STEP_SECONDS))
    : 1;
};
