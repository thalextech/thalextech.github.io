// Plan one expiry at a time. Choose historical ATM inputs using that hour's spot, never today's spot.
// The fetcher repeats this plan after empty responses to try the next strike.
export function planAtmHistory(
  chain,
  cache,
  spots,
  from,
  to,
  now = Date.now(),
) {
  if (!chain.length) return [];
  const expiry = chain[0].expiry;
  const instruments = new Map();
  for (const stored of cache.marks.values())
    if (stored.expiry === expiry) instruments.set(stored.name, stored);
  for (const instrument of chain)
    instruments.set(instrument.name, {
      ...cache.marks.get(instrument.name),
      ...instrument,
      fetchable: true,
    });
  const byStrike = new Map();
  for (const instrument of instruments.values()) {
    if (!byStrike.has(instrument.strike)) byStrike.set(instrument.strike, []);
    byStrike.get(instrument.strike).push(instrument);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  const plan = new Map();
  for (const [ts, spot] of spots) {
    if (ts < from || ts > to) continue;
    const inspect = (strike) => {
      let present = false,
        unresolved = false;
      for (const instrument of byStrike.get(strike)) {
        if (instrument.listedAt != null && ts < instrument.listedAt) continue;
        const iv = instrument.rows?.get(ts);
        if (iv > 0 && Number.isFinite(iv)) {
          present = true;
          continue;
        }
        const checked = cache.checked.get(instrument.name) || [];
        if (
          !instrument.fetchable ||
          checked.some(
            (r) =>
              ts >= r.from &&
              ts <= r.to &&
              (r.expires == null || r.expires > now),
          )
        )
          continue;
        if (!plan.has(instrument.name))
          plan.set(instrument.name, { instrument, hours: new Set() });
        plan.get(instrument.name).hours.add(ts);
        unresolved = true;
      }
      return present || unresolved;
    };
    // An exact spot strike needs no second strike if it has usable observations.
    if (byStrike.has(spot) && inspect(spot)) continue;
    for (const strike of strikes.filter((k) => k < spot).reverse())
      if (inspect(strike)) break;
    for (const strike of strikes.filter((k) => k > spot))
      if (inspect(strike)) break;
  }
  return [...plan.values()];
}
