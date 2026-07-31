export const VOLATILITY_METRICS = {
  IV: "iv",
  RV: "rv",
  IV_MINUS_RV: "iv-minus-rv",
};

export function minimumEntryIv(cycle) {
  const entryIvs = (cycle?.legs || [])
    .map((leg) => leg?.entryImpliedVol)
    .filter(Number.isFinite);
  return entryIvs.length ? Math.min(...entryIvs) : Number.NaN;
}

export function pnlOnEntryPremium(cycle) {
  const pnl = cycle?.cyclePnlUsd;
  const rawEntryPremium = cycle?.entryOptionCashflowUsd;
  const entryPremium = Number.isFinite(rawEntryPremium)
    ? Math.abs(rawEntryPremium)
    : Number.NaN;
  if (!Number.isFinite(pnl) || !Number.isFinite(entryPremium) || entryPremium <= 0) {
    return Number.NaN;
  }
  return pnl / entryPremium;
}

function volatilityValue(cycle, metric) {
  const entryIv = minimumEntryIv(cycle);
  const realizedVol = Number.isFinite(cycle?.trailingSevenDayRealizedVol)
    ? cycle.trailingSevenDayRealizedVol
    : Number.NaN;
  if (metric === VOLATILITY_METRICS.IV) return entryIv;
  if (metric === VOLATILITY_METRICS.IV_MINUS_RV) return entryIv - realizedVol;
  return realizedVol;
}

export function buildVolPnlBarRows(
  cycles = [],
  metric = VOLATILITY_METRICS.RV,
) {
  return cycles
    .map((cycle) => ({
      cycle,
      xValue: volatilityValue(cycle, metric),
      pnlUsd: Number.isFinite(cycle?.cyclePnlUsd)
        ? cycle.cyclePnlUsd
        : Number.NaN,
      pnlOnPremium: pnlOnEntryPremium(cycle),
    }))
    .filter((row) =>
      Number.isFinite(row.xValue)
      && Number.isFinite(row.pnlUsd)
      && Number.isFinite(row.pnlOnPremium))
    .sort((first, second) => first.xValue - second.xValue);
}
