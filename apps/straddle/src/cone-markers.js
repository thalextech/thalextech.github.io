const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MARKER_INTERVALS = [
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY,
  60 * DAY, 90 * DAY, 180 * DAY, 365 * DAY,
];

export function coneMarkerOffsets(durationSeconds) {
  const candidates = MARKER_INTERVALS.filter(seconds => seconds < durationSeconds * 0.9);
  if (!candidates.length) return [];
  return [...new Set([0.1, 0.35, 0.7].map(fraction => {
    const target = durationSeconds * fraction;
    return candidates.reduce((best, seconds) =>
      Math.abs(seconds - target) < Math.abs(best - target) ? seconds : best);
  }))].sort((a, b) => a - b);
}

export function coneMarkerLabel(seconds) {
  if (seconds >= DAY) return `+${seconds / DAY}d`;
  if (seconds >= HOUR) return `+${seconds / HOUR}h`;
  return `+${seconds / MINUTE}m`;
}

export function coneExpiryMarkerLabel(seconds) {
  const days = seconds / DAY;
  return `+${Number(days.toFixed(days < 0.1 ? 3 : 1))}d`;
}
