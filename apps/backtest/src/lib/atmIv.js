const DAY_SECONDS = 86_400;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

function interpolateAtZero(nodes) {
  const sorted = nodes.slice().sort((a, b) => a.x - b.x);
  const below = sorted.filter((node) => node.x <= 0).at(-1);
  const above = sorted.find((node) => node.x >= 0);
  if (!below || !above) return null;
  if (below.x === above.x) {
    return {
      iv: below.iv,
      lowerStrike: below.strike,
      upperStrike: above.strike,
      quoteCount: below.quoteCount,
    };
  }
  const weight = (0 - below.x) / (above.x - below.x);
  return {
    iv: below.iv + weight * (above.iv - below.iv),
    lowerStrike: below.strike,
    upperStrike: above.strike,
    quoteCount: below.quoteCount + above.quoteCount,
  };
}

export function buildAtmIvTermStructure({ quotes = [], spot, ts } = {}) {
  if (![spot, ts].every(Number.isFinite) || spot <= 0) return [];
  const valuesByExpiryStrike = new Map();
  for (const quote of quotes || []) {
    const expirationTs = finite(quote?.expirationTs);
    const strike = finite(quote?.strike);
    const iv = finite(quote?.iv);
    if (!expirationTs || expirationTs <= ts || !strike || strike <= 0 || !iv || iv <= 0) continue;
    if (!valuesByExpiryStrike.has(expirationTs)) valuesByExpiryStrike.set(expirationTs, new Map());
    const valuesByStrike = valuesByExpiryStrike.get(expirationTs);
    if (!valuesByStrike.has(strike)) valuesByStrike.set(strike, []);
    valuesByStrike.get(strike).push(iv);
  }

  return [...valuesByExpiryStrike].map(([expirationTs, valuesByStrike]) => {
    const atm = interpolateAtZero([...valuesByStrike].map(([strike, values]) => ({
      x: Math.log(strike / spot),
      strike,
      iv: values.reduce((sum, value) => sum + value, 0) / values.length,
      quoteCount: values.length,
    })));
    return atm ? { expirationTs, ...atm } : null;
  }).filter((row) => Number.isFinite(row?.iv))
    .sort((a, b) => a.expirationTs - b.expirationTs);
}

export function interpolateAtmIvWithDiagnostics({
  quotes = [],
  termStructure = null,
  spot,
  ts,
  targetDays = 7,
} = {}) {
  if (![spot, ts, targetDays].every(Number.isFinite) || spot <= 0 || targetDays <= 0) return null;
  const targetTs = ts + targetDays * DAY_SECONDS;
  const expiries = Array.isArray(termStructure)
    ? termStructure
    : buildAtmIvTermStructure({ quotes, spot, ts });
  const below = expiries.filter((row) => row.expirationTs <= targetTs).at(-1);
  const above = expiries.find((row) => row.expirationTs >= targetTs);
  if (!below || !above) return null;
  if (below.expirationTs === above.expirationTs) {
    return {
      iv: below.iv,
      lowerExpiryTs: below.expirationTs,
      upperExpiryTs: above.expirationTs,
      weight: 0,
      lowerIv: below.iv,
      upperIv: above.iv,
      lowerQuoteCount: below.quoteCount,
      upperQuoteCount: above.quoteCount,
    };
  }

  const belowDuration = below.expirationTs - ts;
  const aboveDuration = above.expirationTs - ts;
  const targetDuration = targetTs - ts;
  const belowVariance = below.iv ** 2 * belowDuration;
  const aboveVariance = above.iv ** 2 * aboveDuration;
  const weight = (targetDuration - belowDuration) / (aboveDuration - belowDuration);
  const targetVariance = belowVariance + weight * (aboveVariance - belowVariance);
  return targetVariance >= 0 ? {
    iv: Math.sqrt(targetVariance / targetDuration),
    lowerExpiryTs: below.expirationTs,
    upperExpiryTs: above.expirationTs,
    weight,
    lowerIv: below.iv,
    upperIv: above.iv,
    lowerQuoteCount: below.quoteCount,
    upperQuoteCount: above.quoteCount,
  } : null;
}

export function interpolateAtmIv(args = {}) {
  return interpolateAtmIvWithDiagnostics(args)?.iv ?? null;
}
