export const buildDecisionTimes = (plan, config) => {
  const times = new Set();
  const intervalMs =
    Math.max(1, Math.min(24, Math.round(config.hedgeIntervalHours))) *
    3_600_000;
  for (
    let hedgeMs = plan.entryTime.getTime();
    hedgeMs < plan.exitTime.getTime();
    hedgeMs += intervalMs
  ) {
    const hedgeTime = new Date(hedgeMs);
    if (hedgeTime < plan.exitTime) times.add(hedgeTime.getTime());
  }
  times.add(plan.exitTime.getTime());
  return [...times].sort((a, b) => a - b).map((ms) => new Date(ms));
};

export const advanceHedgePosition = ({
  quantity,
  previousPrice,
  pnlUsd,
  indexPrice,
  targetQuantity,
}) => {
  const nextPnlUsd =
    previousPrice != null && Number.isFinite(quantity) && Number.isFinite(indexPrice)
      ? pnlUsd + quantity * (indexPrice - previousPrice)
      : pnlUsd;
  const tradeQuantity = targetQuantity - quantity;
  return {
    quantity: targetQuantity,
    previousPrice: indexPrice,
    pnlUsd: nextPnlUsd,
    trade:
      Math.abs(tradeQuantity) > 1e-10
        ? {
            side: tradeQuantity > 0 ? "buy" : "sell",
            quantity: Math.abs(tradeQuantity),
            price: indexPrice,
          }
        : null,
  };
};
