const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export function mapMarkRow(row) {
  if (!Array.isArray(row)) return null;
  const [
    ts,
    mark_price_open,
    mark_price_high,
    mark_price_low,
    mark_price_close,
    sixth,
    seventh,
  ] = row;
  let funding = null;
  let tob = null;
  if (row.length >= 7) {
    funding = sixth;
    tob = seventh;
  } else {
    tob = sixth;
  }
  return {
    ts,
    mark_price_open,
    mark_price_high,
    mark_price_low,
    mark_price_close,
    funding,
    tob,
  };
}

export function computeFundingSeries({ mark, index, intervalSeconds }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const merged = [];
  for (const m of mark || []) {
    const i = indexByTs.get(m.ts);
    if (!i) continue;

    const annualizedFunding = Number.isFinite(m.funding)
      ? ((m.funding * -1) / i.index_price_close) *
        (SECONDS_PER_YEAR / intervalSeconds)
      : null;

    merged.push({
      ...m,
      ...i,
      date: new Date(m.ts * 1000),
      funding_rate_annualized: annualizedFunding,
    });
  }
  return merged;
}
