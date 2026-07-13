import { normCdf } from "./statistics.js";

export const OPTION_PRICING_DAYS_PER_YEAR = 365;
export const PRECOMPUTED_DELTA_SCALE = 100_000_000;

export const normalizeVol = (impliedVol) =>
  impliedVol > 3 ? impliedVol / 100 : impliedVol;

const normalPdf = (value) =>
  Math.exp(-0.5 * value ** 2) / Math.sqrt(2 * Math.PI);

const blackScholesInputs = ({
  spot,
  strike,
  yearsToExpiry,
  impliedVol,
}) => {
  const sigma = normalizeVol(impliedVol);
  if (
    spot <= 0 ||
    strike <= 0 ||
    sigma <= 0 ||
    yearsToExpiry <= 0 ||
    !Number.isFinite(spot + strike + sigma + yearsToExpiry)
  ) {
    return null;
  }
  const rootT = Math.sqrt(yearsToExpiry);
  const d1 =
    (Math.log(spot / strike) + 0.5 * sigma ** 2 * yearsToExpiry) /
    (sigma * rootT);
  return { sigma, rootT, d1 };
};

export const blackScholesDelta = (args) => {
  const inputs = blackScholesInputs(args);
  if (!inputs) return Number.NaN;
  const callDelta = normCdf(inputs.d1);
  return args.optionType === "C" ? callDelta : callDelta - 1;
};

export const blackScholesGreeks = (args) => {
  const inputs = blackScholesInputs(args);
  if (!inputs) {
    return {
      delta: Number.NaN,
      gamma: Number.NaN,
      vega: Number.NaN,
      theta: Number.NaN,
      impliedVol: normalizeVol(args.impliedVol),
    };
  }
  const { sigma, rootT, d1 } = inputs;
  const callDelta = normCdf(d1);
  const density = normalPdf(d1);
  return {
    delta: args.optionType === "C" ? callDelta : callDelta - 1,
    gamma: density / (args.spot * sigma * rootT),
    vega: args.spot * density * rootT,
    theta: -(args.spot * density * sigma) / (2 * rootT),
    impliedVol: sigma,
  };
};
