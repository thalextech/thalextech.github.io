import { rankCurrentCurve } from "./volatility.js";

export const VOLATILITY_VIEWS = [
  { value: "iv", label: "Expiry IV" },
  { value: "forward", label: "Forward vol" },
];

// All maturities use the same observation time. Seconds cancel in the ratio.
export function forwardVolatility(near, far, asOf) {
  if (
    !far ||
    ![far.iv, far.expiry, asOf].every(Number.isFinite) ||
    far.iv < 0 ||
    far.expiry <= asOf
  )
    return null;
  if (!near) return far.iv; // Now → first expiry is its ordinary implied vol.
  if (
    ![near.iv, near.expiry].every(Number.isFinite) ||
    near.iv < 0 ||
    near.expiry <= asOf ||
    far.expiry <= near.expiry
  )
    return null;
  const variance =
    (far.iv ** 2 * (far.expiry - asOf) - near.iv ** 2 * (near.expiry - asOf)) /
    (far.expiry - near.expiry);
  return variance >= 0 ? Math.sqrt(variance) : null;
}

export function toForwardTermStructure(term, expiries, asOf) {
  const ordered = [...new Set(expiries)].sort((a, b) => a - b);
  function curve(points, ts) {
    const byExpiry = new Map(points.map((p) => [p.expiry, p]));
    const values = [],
      unavailable = [];
    ordered.forEach((expiry, index) => {
      const startExpiry = index ? ordered[index - 1] : null;
      const far = byExpiry.get(expiry),
        near = startExpiry == null ? null : byExpiry.get(startExpiry);
      if (!far || (startExpiry != null && !near)) {
        unavailable.push({ expiry, startExpiry, reason: "missing-leg" });
        return;
      }
      const iv = forwardVolatility(near, far, ts);
      if (iv == null) {
        unavailable.push({ expiry, startExpiry, reason: "negative-variance" });
        return;
      }
      values.push({
        ...far,
        ts,
        startExpiry,
        iv,
        clamped: far.clamped || near?.clamped || false,
      });
    });
    return { values, unavailable };
  }
  const current = curve(term.current, asOf);
  const snapshots = new Map();
  for (const point of term.history) {
    if (!snapshots.has(point.ts)) snapshots.set(point.ts, []);
    snapshots.get(point.ts).push(point);
  }
  const history = [];
  let negativeHistoryCount = 0;
  for (const [ts, points] of snapshots) {
    const past = curve(points, ts);
    history.push(...past.values);
    negativeHistoryCount += past.unavailable.filter(
      (p) => p.reason === "negative-variance",
    ).length;
  }
  history.sort((a, b) => a.expiry - b.expiry || a.ts - b.ts);
  return {
    current: rankCurrentCurve(current.values, history),
    history,
    unavailable: current.unavailable,
    negativeHistoryCount,
  };
}
