import { calcOptionNd2 } from './breakEvenSnapshot.js';

export function findSameStrikeInstrument(selected, candidates) {
  if (!selected) return null;
  return candidates.find(instrument =>
    instrument.strike === selected.strike &&
    instrument.option_type_normalized === selected.option_type_normalized,
  ) ?? null;
}

// Use the proxy pair's historical forward with the option IV and index at the
// same timestamp. Today's inferred forward must not leak into past observations.
export function buildTrackProbabilityHistory(track, indexPoints, expiryTs, forwardPoints = []) {
  if (!track || !Number.isFinite(expiryTs)) return [];
  const marks = new Map(track.points.map(point => [+point.date, point]));
  const forwards = new Map(forwardPoints.map(point => [+point.date, point.value]));
  return indexPoints.flatMap(point => {
    const mark = marks.get(+point.date);
    const ts = +point.date / 1000;
    if (!mark || !Number.isFinite(ts) || ts > expiryTs) return [];
    const probability = calcOptionNd2({
      optionType: track.optionType, spot: forwards.get(+point.date), strike: track.strike,
      iv: mark.iv, tauSeconds: expiryTs - ts,
    });
    return Number.isFinite(probability) ? [{ date: point.date, indexPrice: point.value, probability }] : [];
  });
}
