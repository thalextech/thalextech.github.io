import { normCdf } from "./statistics.js";

export const blackScholesPrice = ({ optionType, strike, expirationTs }, spot, ts, impliedVol) => {
  if (![spot, strike, expirationTs, ts, impliedVol].every(Number.isFinite) || spot <= 0 || strike <= 0) {
    return Number.NaN;
  }
  const intrinsic = optionType === "C"
    ? Math.max(spot - strike, 0)
    : Math.max(strike - spot, 0);
  const yearsToExpiry = (expirationTs - ts) / (365 * 24 * 60 * 60);
  if (yearsToExpiry <= 0) return intrinsic;
  const sigma = impliedVol > 3 ? impliedVol / 100 : impliedVol;
  if (!Number.isFinite(sigma) || sigma <= 0) return intrinsic;
  const rootT = Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma ** 2 * yearsToExpiry) / (sigma * rootT);
  const d2 = d1 - sigma * rootT;
  return optionType === "C"
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
};
