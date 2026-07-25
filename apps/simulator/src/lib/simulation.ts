export type SimulationStats = {
  meanPayoff: number;
  medianPayoff: number;
  payoffMin: number;
  payoffMax: number;
  p05Payoff: number;
  p95Payoff: number;
  winRate: number;
  maxLossRate: number;
  /** Expected price opportunity cost from stopped paths that later recovered. */
  opportunityCost: number;
};
