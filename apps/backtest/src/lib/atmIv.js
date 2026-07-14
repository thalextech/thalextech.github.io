const DAY_SECONDS = 86_400;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

function interpolateAtZero(nodes) {
  const sorted = nodes.slice().sort((a, b) => a.x - b.x);
  const below = sorted.filter((node) => node.x <= 0).at(-1);
  const above = sorted.find((node) => node.x >= 0);
  if (!below || !above) return null;
  if (below.x === above.x) return below.iv;
  const weight = (0 - below.x) / (above.x - below.x);
  return below.iv + weight * (above.iv - below.iv);
}

function atmIvByExpiry(quotes, spot, ts) {
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

  return [...valuesByExpiryStrike].map(([expirationTs, valuesByStrike]) => ({
    expirationTs,
    iv: interpolateAtZero([...valuesByStrike].map(([strike, values]) => ({
      x: Math.log(strike / spot),
      iv: values.reduce((sum, value) => sum + value, 0) / values.length,
    }))),
  })).filter((row) => Number.isFinite(row.iv)).sort((a, b) => a.expirationTs - b.expirationTs);
}

export function interpolateAtmIv({ quotes = [], spot, ts, targetDays = 7 } = {}) {
  if (![spot, ts, targetDays].every(Number.isFinite) || spot <= 0 || targetDays <= 0) return null;
  const targetTs = ts + targetDays * DAY_SECONDS;
  const expiries = atmIvByExpiry(quotes, spot, ts);
  const below = expiries.filter((row) => row.expirationTs <= targetTs).at(-1);
  const above = expiries.find((row) => row.expirationTs >= targetTs);
  if (!below || !above) return null;
  if (below.expirationTs === above.expirationTs) return below.iv;

  const belowDuration = below.expirationTs - ts;
  const aboveDuration = above.expirationTs - ts;
  const targetDuration = targetTs - ts;
  const belowVariance = below.iv ** 2 * belowDuration;
  const aboveVariance = above.iv ** 2 * aboveDuration;
  const weight = (targetDuration - belowDuration) / (aboveDuration - belowDuration);
  const targetVariance = belowVariance + weight * (aboveVariance - belowVariance);
  return targetVariance >= 0 ? Math.sqrt(targetVariance / targetDuration) : null;
}
