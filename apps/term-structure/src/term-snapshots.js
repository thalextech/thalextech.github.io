const HOUR = 3600;
export const SNAPSHOT_RESOLUTIONS = [
  { value: "daily", label: "Daily · 24 hourly", count: 24, step: HOUR },
  { value: "weekly", label: "Weekly · 7 daily", count: 7, step: 24 * HOUR },
  { value: "monthly", label: "Monthly · 4 weekly", count: 4, step: 7 * 24 * HOUR },
];

// Select exact hourly closes from the already interpolated history. Missing
// maturity slots stay explicit for hover details and forward-interval gaps.
export function buildTermSnapshots(history, expiries, asOf, resolution = "daily") {
  const spec = SNAPSHOT_RESOLUTIONS.find(item => item.value === resolution);
  if (!spec) throw new Error(`Unknown snapshot resolution: ${resolution}`);
  if (!Number.isFinite(asOf)) return [];
  const latestClose = Math.floor(asOf / HOUR) * HOUR;
  const scheduled = new Map(Array.from({ length: spec.count }, (_, ageIndex) => {
    const ts = latestClose - ageIndex * spec.step;
    return [ts, { ts, ageIndex, byExpiry: new Map() }];
  }));
  const listed = new Set(expiries);
  for (const point of history) {
    const snapshot = scheduled.get(point.ts);
    if (snapshot && listed.has(point.expiry) && Number.isFinite(point.iv) && point.iv >= 0)
      snapshot.byExpiry.set(point.expiry, point);
  }
  return [...scheduled.values()].reverse().flatMap(({ ts, ageIndex, byExpiry }) => {
    const points = expiries.map(expiry => byExpiry.get(expiry) ?? null);
    return points.some(Boolean) ? [{ ts, ageIndex, points }] : [];
  });
}
