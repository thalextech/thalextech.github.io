import test from "node:test";
import assert from "node:assert/strict";
import { blackScholesPrice } from "../src/lib/optionPricing.js";
import { buildContourPolylines, computeZeroMtmContours } from "../src/lib/zeroMtmContours.js";

const DAY = 86_400;
const entryTs = Date.UTC(2026, 0, 1, 8) / 1000;
const spot = 100;

const makeLeg = ({ strike, optionType, expiryDays = 30, quantity, entryPrice }) => ({
  instrumentName: `BTC-${expiryDays}D-${strike}-${optionType}`,
  strike,
  optionType,
  expirationTs: entryTs + expiryDays * DAY,
  quantity,
  entryPrice,
});

const quoteFor = (leg, iv = 0.6, delta = leg.optionType === "C" ? 0.25 : -0.25) => ({
  ts: entryTs,
  instrumentName: leg.instrumentName,
  strike: leg.strike,
  expirationTs: leg.expirationTs,
  impliedVol: iv,
  delta,
});

const makePlan = (legs, exitTs = Math.min(...legs.map((leg) => leg.expirationTs))) => ({
  entryTs,
  exitTs,
  entryIndexPrice: spot,
  legs,
});

const priceEntry = (leg, iv = 0.6) => blackScholesPrice(leg, spot, entryTs, iv);

const run = (plan, quotes, timestamps) => computeZeroMtmContours({
  plan,
  preparedData: { quotes },
  timestamps,
  price: blackScholesPrice,
});

test("ATM short straddle terminal roots equal strike plus/minus premium", () => {
  let call = makeLeg({ strike: 100, optionType: "C", quantity: -1, entryPrice: 0 });
  let put = makeLeg({ strike: 100, optionType: "P", quantity: -1, entryPrice: 0 });
  call = { ...call, entryPrice: priceEntry(call) };
  put = { ...put, entryPrice: priceEntry(put) };
  const plan = makePlan([call, put]);
  const result = run(plan, [quoteFor(call), quoteFor(put)], [entryTs, plan.exitTs]);
  const terminal = result.contours.find((row) => row.scenario === "base" && row.t === plan.exitTs);
  const premium = call.entryPrice + put.entryPrice;
  assert.equal(terminal.roots.length, 2);
  assert.ok(Math.abs(terminal.roots[0] - (100 - premium)) < 1e-6);
  assert.ok(Math.abs(terminal.roots[1] - (100 + premium)) < 1e-6);
});

test("zero-cost risk reversal emits its terminal inter-strike flat band", () => {
  const put = makeLeg({ strike: 90, optionType: "P", quantity: 1, entryPrice: 3 });
  const call = makeLeg({ strike: 110, optionType: "C", quantity: -1, entryPrice: 3 });
  const plan = makePlan([put, call]);
  const result = run(plan, [quoteFor(put), quoteFor(call)], [entryTs, plan.exitTs]);
  const terminal = result.contours.find((row) => row.scenario === "base" && row.t === plan.exitTs);
  assert.deepEqual(terminal.bands, [[90, 110]]);
  assert.equal(terminal.roots.length, 0);
});

test("long butterfly terminal regions alternate around the profit tent", () => {
  const legs = [
    makeLeg({ strike: 90, optionType: "C", quantity: 1, entryPrice: 2 }),
    makeLeg({ strike: 100, optionType: "C", quantity: -2, entryPrice: 1 }),
    makeLeg({ strike: 110, optionType: "C", quantity: 1, entryPrice: 2 }),
  ];
  const plan = makePlan(legs);
  const result = run(plan, legs.map((leg) => quoteFor(leg)), [entryTs, plan.exitTs]);
  const terminal = result.contours.find((row) => row.scenario === "base" && row.t === plan.exitTs);
  assert.ok(terminal.roots.length >= 2);
  assert.ok(terminal.regions.some((region) => region.sign > 0));
  assert.ok(terminal.regions.some((region) => region.sign < 0));
});

test("calendar terminates at front expiry and keeps the back leg finite", () => {
  let front = makeLeg({ strike: 100, optionType: "C", expiryDays: 7, quantity: -1, entryPrice: 0 });
  let back = makeLeg({ strike: 100, optionType: "C", expiryDays: 30, quantity: 1, entryPrice: 0 });
  front = { ...front, entryPrice: priceEntry(front) };
  back = { ...back, entryPrice: priceEntry(back) };
  const plan = makePlan([front, back], back.expirationTs);
  const timestamps = [entryTs, front.expirationTs, back.expirationTs];
  const result = run(plan, [quoteFor(front), quoteFor(back)], timestamps);
  assert.equal(result.metadata.lifecycle_end_ts, front.expirationTs);
  assert.ok(result.contours.every((row) => row.t <= front.expirationTs));
  assert.ok(result.contours.flatMap((row) => row.roots).every(Number.isFinite));
});

test("root-count changes break contour polylines", () => {
  const contours = [
    { t: 1, roots: [90, 110], scenario: "base" },
    { t: 2, roots: [91, 109], scenario: "base" },
    { t: 3, roots: [100], scenario: "base" },
    { t: 4, roots: [101], scenario: "base" },
  ];
  const lines = buildContourPolylines(contours);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => !(line.some((point) => point.t === 2) && line.some((point) => point.t === 3))));
});

test("skew scenarios are emitted separately and move an asymmetric structure", () => {
  const put = makeLeg({ strike: 90, optionType: "P", quantity: 1, entryPrice: 3 });
  const call = makeLeg({ strike: 110, optionType: "C", quantity: -1, entryPrice: 3 });
  const plan = makePlan([put, call]);
  const result = run(plan, [quoteFor(put), quoteFor(call)], [entryTs + DAY]);
  assert.deepEqual(new Set(result.contours.map((row) => row.scenario)), new Set(["base", "skew_up", "skew_down"]));
  const roots = Object.fromEntries(result.contours.map((row) => [row.scenario, row.roots]));
  assert.ok(roots.base.length && roots.skew_up.length && roots.skew_down.length);
  assert.notDeepEqual(roots.base, roots.skew_up);
});
