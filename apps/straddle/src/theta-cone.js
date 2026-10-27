import { calcGreeks, calcOptionPrice } from "../../../lib/thalex.js";

const YEAR_SECONDS = 365.25 * 24 * 60 * 60;
const straddlePrice = (spot, strike, remaining, iv) =>
  spot === 0 ? strike :
    calcOptionPrice(spot, strike, remaining, iv, "call") +
    calcOptionPrice(spot, strike, remaining, iv, "put");

function fitStraddleIv({ spot, strike, premium, entryTs, expiryTs }) {
  if (![spot, strike, premium, entryTs, expiryTs].every(Number.isFinite) ||
      spot <= 0 || strike <= 0 || premium <= Math.abs(spot - strike) ||
      premium >= strike || expiryTs <= entryTs) return null;

  const duration = expiryTs - entryTs;
  let volLow = 0;
  let volHigh = 1;
  while (straddlePrice(spot, strike, duration, volHigh) < premium && volHigh < 64) {
    volHigh *= 2;
  }
  if (straddlePrice(spot, strike, duration, volHigh) < premium) return null;
  for (let i = 0; i < 64; i += 1) {
    const mid = (volLow + volHigh) / 2;
    if (straddlePrice(spot, strike, duration, mid) < premium) volLow = mid;
    else volHigh = mid;
  }
  return (volLow + volHigh) / 2;
}

// Solve the straddle plus a fixed hedge of -hedgeDelta underlying units.
// Its value is minimized where the straddle delta equals hedgeDelta, which
// corresponds to a constant Black–Scholes d1 throughout the holding period.
function sampleCone({ spot, strike, premium, entryTs, expiryTs, holdingPeriods = [] }, iv, hedgeDelta, minimumD1) {
  if (!Number.isFinite(hedgeDelta) || Math.abs(hedgeDelta) >= 1) return null;
  const duration = expiryTs - entryTs;
  const terminalLow = (strike - premium + hedgeDelta * spot) / (1 + hedgeDelta);
  const terminalHigh = (strike + premium - hedgeDelta * spot) / (1 - hedgeDelta);
  const points = [];
  // Include requested holding periods exactly, alongside denser samples near entry.
  const elapsedTimes = [...new Set([
    ...Array.from({ length: 81 }, (_, i) => duration * (i / 80) ** 2),
    ...holdingPeriods.filter(seconds => Number.isFinite(seconds) && seconds > 0 && seconds < duration),
  ])].sort((a, b) => a - b);
  for (const elapsed of elapsedTimes) {
    const remaining = duration - elapsed;
    const volTime = iv * Math.sqrt(remaining / YEAR_SECONDS);
    const minimumSpot = strike * Math.exp(minimumD1 * volTime - 0.5 * volTime * volTime);
    const pnl = value => straddlePrice(value, strike, remaining, iv) - premium
      - hedgeDelta * (value - spot);
    const root = (left, right, increasing) => {
      for (let j = 0; j < 64; j += 1) {
        const mid = (left + right) / 2;
        if ((pnl(mid) < 0) === increasing) left = mid;
        else right = mid;
      }
      return (left + right) / 2;
    };
    // At a delta-neutral entry the roots coincide. Set this double root exactly
    // to avoid floating-point cancellation creating a tiny artificial gap.
    const atNeutralEntry = elapsed === 0 && Math.abs(minimumSpot - spot) <= spot * 1e-12;
    points.push({
      date: new Date((entryTs + elapsed) * 1000),
      low: atNeutralEntry ? spot : elapsed === duration ? terminalLow : root(terminalLow, minimumSpot, false),
      high: atNeutralEntry ? spot : elapsed === duration ? terminalHigh : root(minimumSpot, terminalHigh, true),
    });
  }
  return { iv, hedgeDelta, points };
}

// Inputs are prices and seconds, keeping API row shapes out of the model.
export function buildThetaCone(inputs) {
  const iv = fitStraddleIv(inputs);
  return iv === null ? null : sampleCone(inputs, iv, 0, 0);
}

export function buildInitiallyHedgedThetaCone(inputs) {
  const iv = fitStraddleIv(inputs);
  if (iv === null) return null;
  const { spot, strike, entryTs, expiryTs } = inputs;
  const duration = expiryTs - entryTs;
  const hedgeDelta = calcGreeks(spot, strike, duration, iv, "call").delta
    + calcGreeks(spot, strike, duration, iv, "put").delta;
  const volTime = iv * Math.sqrt(duration / YEAR_SECONDS);
  const minimumD1 = (Math.log(spot / strike) + 0.5 * volTime * volTime) / volTime;
  return sampleCone(inputs, iv, hedgeDelta, minimumD1);
}
