const SCENARIOS = ["base", "skew_up", "skew_down"];
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const uniqueSorted = (values, tolerance = 1e-7) => values
  .filter(Number.isFinite)
  .sort((a, b) => a - b)
  .filter((value, index, rows) => index === 0 || Math.abs(value - rows[index - 1]) > tolerance * Math.max(1, value));

const interpolate = (nodes, x) => {
  if (!nodes.length) return Number.NaN;
  if (nodes.length === 1 || x <= nodes[0].x) return nodes[0].iv;
  if (x >= nodes[nodes.length - 1].x) return nodes[nodes.length - 1].iv;
  let hi = 1;
  while (nodes[hi].x < x) hi += 1;
  const lo = hi - 1;
  const weight = (x - nodes[lo].x) / (nodes[hi].x - nodes[lo].x);
  return nodes[lo].iv + weight * (nodes[hi].iv - nodes[lo].iv);
};

const buildExpirySmile = (quotes, entrySpot, skewVolPoints, scenario) => {
  const sorted = quotes
    .map((quote) => ({
      x: Math.log(quote.strike / entrySpot),
      iv: quote.impliedVol,
      delta: quote.delta,
    }))
    .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.iv))
    .sort((a, b) => a.x - b.x);
  const put25 = sorted.filter((node) => node.delta < 0)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.25) - Math.abs(Math.abs(b.delta) - 0.25))[0];
  const call25 = sorted.filter((node) => node.delta > 0)
    .sort((a, b) => Math.abs(nodeDeltaDistance(a)) - Math.abs(nodeDeltaDistance(b)))[0];
  const putX = Math.abs(put25?.x || Math.min(...sorted.map((node) => node.x), -0.1));
  const callX = Math.abs(call25?.x || Math.max(...sorted.map((node) => node.x), 0.1));
  const direction = scenario === "skew_up" ? 1 : scenario === "skew_down" ? -1 : 0;
  return sorted.map((node) => {
    const wingWeight = node.x < 0
      ? clamp(-node.x / Math.max(putX, 1e-6), 0, 1)
      : -clamp(node.x / Math.max(callX, 1e-6), 0, 1);
    // `skewVolPoints` is the total 25-delta put-minus-call risk-reversal shift.
    // Split it evenly across the two wings so ATM remains fixed.
    return { ...node, iv: Math.max(1e-4, node.iv + direction * skewVolPoints / 200 * wingWeight) };
  });
};

const nodeDeltaDistance = (node) => node.delta - 0.25;

export const buildEntrySurface = ({ plan, preparedData, skewVolPoints = 2.5 }) => {
  const entryQuotes = (preparedData.quotes || []).filter((quote) => quote.ts === plan.entryTs);
  const byExpiry = new Map();
  for (const quote of entryQuotes) {
    if (!byExpiry.has(quote.expirationTs)) byExpiry.set(quote.expirationTs, []);
    byExpiry.get(quote.expirationTs).push(quote);
  }
  const smiles = Object.fromEntries(SCENARIOS.map((scenario) => [
    scenario,
    new Map([...byExpiry].map(([expiryTs, quotes]) => [
      expiryTs,
      buildExpirySmile(quotes, plan.entryIndexPrice, skewVolPoints, scenario),
    ])),
  ]));
  const legEntryVols = new Map(plan.legs.map((leg) => {
    const quote = entryQuotes.find((row) => row.instrumentName === leg.instrumentName);
    return [leg.instrumentName, quote?.impliedVol];
  }));
  return { entrySpot: plan.entryIndexPrice, smiles, legEntryVols, skewVolPoints };
};

const volatilityFor = ({ leg, spot, surface, surfaceMode, scenario }) => {
  const nodes = surface.smiles[scenario]?.get(leg.expirationTs) || [];
  if (surfaceMode === "sticky_strike") {
    const baseVol = surface.legEntryVols.get(leg.instrumentName);
    if (!Number.isFinite(baseVol)) return Number.NaN;
    if (scenario === "base") return baseVol;
    const baseNodes = surface.smiles.base?.get(leg.expirationTs) || [];
    return baseVol + interpolate(nodes, Math.log(leg.strike / surface.entrySpot))
      - interpolate(baseNodes, Math.log(leg.strike / surface.entrySpot));
  }
  return interpolate(nodes, Math.log(leg.strike / spot));
};

const brent = (fn, lower, upper, relativeTolerance = 1e-6, maxIterations = 80) => {
  let a = lower;
  let b = upper;
  let fa = fn(a);
  let fb = fn(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (!Number.isFinite(fa * fb) || fa * fb > 0) return Number.NaN;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const midpoint = 0.5 * (a + b);
    const secant = (a * fb - b * fa) / (fb - fa);
    const candidate = secant > Math.min(a, b) && secant < Math.max(a, b) ? secant : midpoint;
    const fc = fn(candidate);
    if (!Number.isFinite(fc)) return Number.NaN;
    if (Math.abs(fc) < 1e-10 || Math.abs(b - a) <= relativeTolerance * Math.max(1, Math.abs(candidate))) {
      return candidate;
    }
    if (fa * fc <= 0) {
      b = candidate;
      fb = fc;
    } else {
      a = candidate;
      fa = fc;
    }
  }
  return 0.5 * (a + b);
};

const classifyRegions = ({ fn, domain, roots, bands }) => {
  const boundaries = uniqueSorted([domain[0], domain[1], ...roots, ...bands.flat()]);
  const regions = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const range = [boundaries[index], boundaries[index + 1]];
    const midpoint = Math.sqrt(Math.max(range[0], 1e-12) * Math.max(range[1], 1e-12));
    const inBand = bands.some(([lo, hi]) => midpoint >= lo && midpoint <= hi);
    if (inBand || range[1] - range[0] <= 1e-8) continue;
    const value = fn(midpoint);
    if (Number.isFinite(value) && value !== 0) regions.push({ range, sign: value > 0 ? 1 : -1 });
  }
  return regions;
};

const solveTerminal = ({ legs, value0, domain }) => {
  const strikes = uniqueSorted(legs.map((leg) => leg.strike).filter((strike) => strike > domain[0] && strike < domain[1]));
  const boundaries = [domain[0], ...strikes, domain[1]];
  const payoff = (spot) => legs.reduce((value, leg) => value + leg.quantity * (
    leg.optionType === "C" ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0)
  ), 0) - value0;
  const roots = [];
  const bands = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const lo = boundaries[index];
    const hi = boundaries[index + 1];
    const flo = payoff(lo);
    const fhi = payoff(hi);
    const slope = (fhi - flo) / (hi - lo);
    if (Math.abs(slope) < 1e-12 && Math.abs(flo) < 1e-8) bands.push([lo, hi]);
    else if (flo === 0) roots.push(lo);
    else if (flo * fhi < 0 || fhi === 0) roots.push(lo - flo / slope);
  }
  const candidates = uniqueSorted(roots.filter((root) => !bands.some(([lo, hi]) => root >= lo && root <= hi)));
  const cleanRoots = [];
  const touches = [];
  candidates.forEach((root) => {
    const probe = Math.max(1e-6, root * 1e-7);
    const left = payoff(Math.max(domain[0], root - probe));
    const right = payoff(Math.min(domain[1], root + probe));
    if (left * right < 0) cleanRoots.push(root);
    else touches.push(root);
  });
  return { roots: cleanRoots, bands, touches, regions: classifyRegions({ fn: payoff, domain, roots: cleanRoots, bands }) };
};

const solveNumeric = ({ fn, domain, value0, contractMultiplier, gridPoints }) => {
  const [lo, hi] = domain;
  const ratio = (hi / lo) ** (1 / (gridPoints - 1));
  const spots = Array.from({ length: gridPoints }, (_, index) => lo * ratio ** index);
  const values = spots.map(fn);
  const epsFlat = Math.max(1e-4 * Math.abs(value0), 1e-2 * contractMultiplier);
  const flat = values.map((value) => Number.isFinite(value) && Math.abs(value) < epsFlat);
  const bands = [];
  for (let start = 0; start < flat.length;) {
    if (!flat[start]) { start += 1; continue; }
    let end = start;
    while (end + 1 < flat.length && flat[end + 1]) end += 1;
    if (end > start) bands.push([spots[start], spots[end]]);
    start = end + 1;
  }
  const inBand = (index) => bands.some(([bandLo, bandHi]) => spots[index] >= bandLo && spots[index] <= bandHi);
  const roots = [];
  const touches = [];
  for (let index = 0; index < spots.length - 1; index += 1) {
    if (inBand(index) || inBand(index + 1)) continue;
    const a = values[index];
    const b = values[index + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a * b < 0) roots.push(brent(fn, spots[index], spots[index + 1]));
  }
  for (let index = 1; index < spots.length - 1; index += 1) {
    if (inBand(index)) continue;
    const magnitude = Math.abs(values[index]);
    if (magnitude < epsFlat && magnitude <= Math.abs(values[index - 1]) && magnitude <= Math.abs(values[index + 1])) {
      touches.push(spots[index]);
    }
  }
  const cleanRoots = uniqueSorted(roots);
  const cleanTouches = uniqueSorted(touches.filter((touch) => !cleanRoots.some((root) => Math.abs(root - touch) < root * 1e-4)));
  return { roots: cleanRoots, bands, touches: cleanTouches, regions: classifyRegions({ fn, domain, roots: cleanRoots, bands }) };
};

export const buildContourPolylines = (contours, scenario = "base") => {
  const rows = contours.filter((row) => row.scenario === scenario).sort((a, b) => a.t - b.t);
  const segments = [];
  let active = [];
  let previousCount = null;
  for (const row of rows) {
    if (row.roots.length !== previousCount) {
      segments.push(...active.filter((segment) => segment.length > 1));
      active = row.roots.map(() => []);
    }
    row.roots.forEach((spot, index) => active[index].push({ t: row.t, spot }));
    previousCount = row.roots.length;
  }
  segments.push(...active.filter((segment) => segment.length > 1));
  return segments;
};

export const computeZeroMtmContours = ({
  plan,
  preparedData,
  timestamps,
  price,
  surfaceMode = "sticky_strike",
  skewVolPoints = 2.5,
  contractMultiplier = 1,
  gridPoints = 201,
}) => {
  if (!plan || typeof price !== "function") throw new Error("A plan and option pricer are required");
  if (!["sticky_strike", "sticky_delta"].includes(surfaceMode)) throw new Error(`Unknown surface mode: ${surfaceMode}`);
  const surface = buildEntrySurface({ plan, preparedData, skewVolPoints });
  const value0 = plan.legs.reduce((value, leg) => value + leg.quantity * leg.entryPrice, 0);
  const frontExpiryTs = Math.min(...plan.legs.map((leg) => leg.expirationTs));
  const endTs = Math.min(frontExpiryTs, plan.exitTs ?? frontExpiryTs);
  const grid = uniqueSorted((timestamps || []).filter((ts) => ts >= plan.entryTs && ts <= endTs));
  const barSeconds = grid.length > 1 ? Math.min(...grid.slice(1).map((ts, index) => ts - grid[index]).filter((dt) => dt > 0)) : 3600;
  const domain = [0.5 * plan.entryIndexPrice, 2 * plan.entryIndexPrice];
  const contours = [];
  for (const scenario of SCENARIOS) {
    for (const t of grid) {
      const activeLegs = plan.legs.filter((leg) => t <= leg.expirationTs);
      const fn = (spot) => activeLegs.reduce((value, leg) => {
        const impliedVol = volatilityFor({ leg, spot, surface, surfaceMode, scenario });
        const legValue = price(leg, spot, t, impliedVol);
        return Number.isFinite(legValue) ? value + leg.quantity * legValue : value;
      }, 0) - value0;
      let solved;
      if (frontExpiryTs - t <= barSeconds && activeLegs.every((leg) => leg.expirationTs === frontExpiryTs)) {
        solved = solveTerminal({ legs: activeLegs, value0, domain });
      } else {
        solved = solveNumeric({ fn, domain, value0, contractMultiplier, gridPoints });
      }
      contours.push({ t, ...solved, scenario });
    }
  }
  return {
    metadata: {
      V0: value0,
      surface_mode: surfaceMode,
      entry_ts: plan.entryTs,
      expiry_ts: frontExpiryTs,
      lifecycle_end_ts: endTs,
      skew_vol_points: skewVolPoints,
      skew_convention: "25d put-minus-call risk reversal; ATM fixed; shift split evenly across wings",
      spot_domain: domain,
      legs: plan.legs.map(({ instrumentName, optionType, strike, expirationTs, quantity, entryPrice }) => ({
        instrument: instrumentName, optionType, strike, expirationTs, quantity, entry_price: entryPrice,
      })),
    },
    contours,
  };
};
