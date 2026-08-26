export const START_BALANCE = 2_400;
export const MIN_WEEKLY_PNL = 0;
export const MAX_WEEKLY_PNL = 5_000;
export const WEEKLY_PNL_STEP = 100;
export const DEFAULT_WEEKLY_PNL = 2_600;

const USD_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function toFiniteNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError("Weekly realized P&L must be a finite number.");
  }
  return number;
}

export function calculateProfitBoost(weeklyPnl) {
  const inputPnl = toFiniteNumber(weeklyPnl);
  const base = inputPnl;
  const twoX = inputPnl > 0 ? inputPnl * 2 : inputPnl;
  const threeX = inputPnl > 0 ? inputPnl * 3 : inputPnl;

  return {
    inputPnl,
    profits: { base, twoX, threeX },
    endingBalances: {
      base: START_BALANCE + base,
      twoX: START_BALANCE + twoX,
      threeX: START_BALANCE + threeX,
    },
  };
}

export function formatDollar(value) {
  const number = toFiniteNumber(value);
  const normalized = Object.is(number, -0) ? 0 : number;
  const sign = normalized < 0 ? "−" : "";
  return `${sign}$${USD_INTEGER.format(Math.abs(normalized))}`;
}

export function formatSignedDollar(value) {
  const number = toFiniteNumber(value);
  const normalized = Object.is(number, -0) ? 0 : number;
  if (normalized === 0) return "$0";
  const sign = normalized > 0 ? "+" : "−";
  return `${sign}$${USD_INTEGER.format(Math.abs(normalized))}`;
}
