import { calcGreeks, calcOptionPrice } from "../../../lib/thalex.js";

// All money is USD; IV is a decimal; timestamps and expiries are UTC seconds.
// Contracts and quantities are fixed for the entire path.
export const PNL_BUCKETS = ["time", "vol", "direction", "convexity", "discrepancy"];
const zero = () => Object.fromEntries(PNL_BUCKETS.map(key => [key, 0]));
const sum = values => values.reduce((a, b) => a + b, 0);
const price = (leg, spot, ts, iv) =>
  calcOptionPrice(spot, leg.strike, leg.expiry - ts, iv, leg.type);

function validate(legs, observations) {
  if (!legs.length) throw new Error("No position selected.");
  for (const leg of legs) {
    if (![leg.strike, leg.expiry, leg.quantity].every(Number.isFinite) ||
        leg.strike <= 0 || !["call", "put"].includes(leg.type)) {
      throw new Error("Each leg needs a positive strike, expiry, type and fixed quantity.");
    }
  }
  let previous = -Infinity;
  for (const point of observations) {
    if (!Number.isFinite(point.ts) || point.ts <= previous ||
        !Number.isFinite(point.spot) || point.spot <= 0 ||
        point.marks?.length !== legs.length ||
        !point.marks.every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("The path needs increasing timestamps, positive index prices and every leg's nonnegative mark at every timestamp.");
    }
    previous = point.ts;
  }
}

function fitLeg(leg, point, index) {
  const mark = point.marks[index];
  const intrinsic = price(leg, point.spot, point.ts, 0);
  const remaining = leg.expiry - point.ts;
  // Outside the model's attainable prices, project onto its boundary and
  // retain mark minus model explicitly. No fabricated IV or Greek residual.
  if (remaining <= 0 || mark <= intrinsic) {
    return { iv: 0, model: intrinsic, fitted: Math.abs(mark - intrinsic) <= 1e-7 };
  }
  const upper = leg.type === "put" ? leg.strike : point.spot;
  let high = 1;
  while (price(leg, point.spot, point.ts, high) < Math.min(mark, upper) && high < 1048576) high *= 2;
  let low = 0;
  for (let i = 0; i < 64; i += 1) {
    const mid = (low + high) / 2;
    if (price(leg, point.spot, point.ts, mid) < mark) low = mid;
    else high = mid;
  }
  const iv = (low + high) / 2;
  const model = price(leg, point.spot, point.ts, iv);
  return { iv, model, fitted: Math.abs(mark - model) <= 1e-7 };
}

function entryDelta(leg, point, iv) {
  if (point.ts < leg.expiry && iv > 0) {
    return calcGreeks(point.spot, leg.strike, leg.expiry - point.ts, iv, leg.type).delta;
  }
  // Symmetric derivative of the intrinsic value at its kink.
  const callDelta = point.spot > leg.strike ? 1 : point.spot < leg.strike ? 0 : 0.5;
  return leg.type === "put" ? callDelta - 1 : callDelta;
}

/** Full revaluation of a fixed unhedged position, close to close. */
export function attributePnlPath({ legs, observations, intervalSeconds }) {
  validate(legs, observations);
  if (observations.length < 2) return null;
  let previousIvs = legs.map(() => 0);
  const path = observations.map(point => {
    const fits = legs.map((leg, i) => fitLeg(leg, point, i));
    // IV is unidentifiable at expiry. Retain the preceding fitted IV so the
    // endpoint does not invent an observed vol collapse to zero.
    fits.forEach((fit, i) => { if (point.ts >= legs[i].expiry) fit.iv = previousIvs[i]; });
    previousIvs = fits.map(fit => fit.iv);
    return {
      ...point,
      ivs: fits.map(fit => fit.iv),
      model: sum(fits.map((fit, i) => legs[i].quantity * fit.model)),
      mark: sum(point.marks.map((mark, i) => legs[i].quantity * mark)),
      unfitted: fits.filter(fit => !fit.fitted).length,
      maxFitError: Math.max(...fits.map((fit, i) => Math.abs(point.marks[i] - fit.model))),
    };
  });
  const first = path[0];
  const delta = sum(legs.map((leg, i) => leg.quantity * entryDelta(leg, first, first.ivs[i])));
  const value = (ts, spot, ivs) => sum(legs.map((leg, i) => leg.quantity * price(leg, spot, ts, ivs[i])));
  // An independent, observed same-expiry ATM series is necessary. Averaging
  // the position's own IVs would invent a parallel/shape attribution.
  const hasAtm = new Set(legs.map(leg => leg.expiry)).size === 1 &&
    path.every(point => Number.isFinite(point.atmIv) && point.atmIv >= 0);
  let splitVol = hasAtm;
  const cumulative = { canonical: { ...zero(), parallel: 0, shape: 0 }, reverse: { ...zero(), parallel: 0, shape: 0 } };
  const steps = [];
  const series = [{ ts: first.ts, marked: 0, crossMagnitude: 0,
    canonical: { ...cumulative.canonical }, reverse: { ...cumulative.reverse } }];
  let totalCrossMagnitude = 0;
  for (let i = 1; i < path.length; i += 1) {
    const old = path[i - 1];
    const next = path[i];
    const discrepancy = (next.mark - next.model) - (old.mark - old.model);
    const direction = delta * (next.spot - old.spot);
    const canonical = {
      time: value(next.ts, old.spot, old.ivs) - old.model,
      vol: value(next.ts, old.spot, next.ivs) - value(next.ts, old.spot, old.ivs),
      spot: next.model - value(next.ts, old.spot, next.ivs),
      direction, discrepancy,
    };
    const reverse = {
      spot: value(old.ts, next.spot, old.ivs) - old.model,
      vol: value(old.ts, next.spot, next.ivs) - value(old.ts, next.spot, old.ivs),
      time: next.model - value(old.ts, next.spot, next.ivs),
      direction, discrepancy,
    };
    // Reverse the parallel/shape substeps as well as the three main variables.
    if (hasAtm) {
      const shift = next.atmIv - old.atmIv;
      const parallelFirst = old.ivs.map(iv => iv + shift);
      const shapeFirst = next.ivs.map(iv => iv - shift);
      if ([...parallelFirst, ...shapeFirst].some(iv => iv < 0)) splitVol = false;
      else {
        canonical.parallel = value(next.ts, old.spot, parallelFirst) - value(next.ts, old.spot, old.ivs);
        canonical.shape = canonical.vol - canonical.parallel;
        reverse.shape = value(old.ts, next.spot, shapeFirst) - value(old.ts, next.spot, old.ivs);
        reverse.parallel = reverse.vol - reverse.shape;
      }
    }
    for (const order of [canonical, reverse]) order.convexity = order.spot - direction;
    const cross = Object.fromEntries(["time", "vol", "spot"].map(key => [key, canonical[key] - reverse[key]]));
    // Dollars reassigned between the three buckets, not extra P&L. The signed
    // differences sum to zero because each order already telescopes to P&L.
    const crossMagnitude = sum(Object.values(cross).map(Math.abs)) / 2;
    const marked = next.mark - old.mark;
    if (![marked, ...PNL_BUCKETS.map(key => canonical[key]), ...PNL_BUCKETS.map(key => reverse[key])].every(Number.isFinite)) {
      throw new Error("Revaluation produced a non-finite value; check the price path and quantities.");
    }
    const tolerance = Math.max(1e-7, Math.abs(old.mark) * 1e-10, Math.abs(next.mark) * 1e-10);
    const errors = [canonical, reverse].map(order => sum(PNL_BUCKETS.map(key => order[key])) - marked);
    if (errors.some(error => Math.abs(error) > tolerance)) throw new Error("Attribution failed to reconcile to marked P&L.");
    for (const [name, order] of Object.entries({ canonical, reverse })) {
      for (const key of [...PNL_BUCKETS, "parallel", "shape"]) cumulative[name][key] += order[key] ?? 0;
    }
    totalCrossMagnitude += crossMagnitude;
    steps.push({ from: old.ts, ts: next.ts, canonical, reverse, cross, crossMagnitude, marked, errors,
      gap: Number.isFinite(intervalSeconds) && next.ts - old.ts > intervalSeconds * 1.01 });
    series.push({ ts: next.ts, marked: next.mark - first.mark, crossMagnitude: totalCrossMagnitude,
      canonical: { ...cumulative.canonical }, reverse: { ...cumulative.reverse } });
  }
  const marked = path.at(-1).mark - first.mark;
  const reconciliation = Object.fromEntries(Object.entries(cumulative).map(([name, buckets]) =>
    [name, sum(PNL_BUCKETS.map(key => buckets[key])) - marked]));
  if (Object.values(reconciliation).some(error => Math.abs(error) > Math.max(1e-6, Math.abs(first.mark) * 1e-9))) {
    throw new Error("Cumulative attribution failed to reconcile to marked P&L.");
  }
  const threshold = Math.max(1e-6, totalCrossMagnitude * 0.1);
  for (const step of steps) step.flagged = step.crossMagnitude >= threshold;
  return { legs, path, steps, series, totals: cumulative, marked, entryDelta: delta,
    splitVol, volSplitReason: !hasAtm ? "An independent same-expiry ATM IV history is not supplied; parallel and shape are unavailable."
      : !splitVol ? "The ATM shift produces a negative intermediate leg IV; parallel and shape are unavailable without changing the specified revaluation." : "",
    totalCrossMagnitude, crossThreshold: threshold, reconciliation,
    maxFitError: Math.max(...path.map(point => point.maxFitError)),
    unfittedMarks: sum(path.map(point => point.unfitted)), gaps: steps.filter(step => step.gap).length };
}

export function exposureSentence(result, money) {
  const outcomes = Object.values(result.totals).map(buckets => ({
    spot: buckets.direction + buckets.convexity, carry: buckets.time + buckets.vol,
  }));
  const [canonical, reverse] = outcomes;
  const paid = outcome => outcome.spot > 0 && outcome.carry < 0 && outcome.spot + outcome.carry >= 0;
  if (paid(canonical) !== paid(reverse)) {
    return `Whether spot paid for time and vol depends on the revaluation order: spot ${money(canonical.spot)} against time + vol ${money(canonical.carry)} in the canonical order; ${money(reverse.spot)} against ${money(reverse.carry)} in reverse.`;
  }
  if (canonical.carry >= 0 && reverse.carry >= 0) {
    return `Time and vol contributed ${money(canonical.carry)} / ${money(reverse.carry)} rather than a net cost; spot contributed ${money(canonical.spot)} / ${money(reverse.spot)} (canonical / reverse).`;
  }
  if ((canonical.carry >= 0) !== (reverse.carry >= 0)) {
    return `Time and vol switch between a contribution and a cost across orders: ${money(canonical.carry)} / ${money(reverse.carry)}, against spot ${money(canonical.spot)} / ${money(reverse.spot)} (canonical / reverse).`;
  }
  return `Spot ${paid(canonical) ? "paid" : "did not pay"} for time and vol in either order: ${money(canonical.spot)} against ${money(canonical.carry)} in the canonical order; ${money(reverse.spot)} against ${money(reverse.carry)} in reverse.`;
}
