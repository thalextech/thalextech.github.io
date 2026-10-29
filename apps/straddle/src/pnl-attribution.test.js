import test from "node:test";
import assert from "node:assert/strict";
import { calcGreeks, calcOptionPrice } from "../../../lib/thalex.js";
import { attributePnlPath, exposureSentence, PNL_BUCKETS } from "./pnl-attribution.js";
import { buildStraddlePnlHistory, parseAtmIvHistory } from "./pnl-history.js";
import historicalPath from "./fixtures/btc-straddle-history.json" with { type: "json" };

const ts = 1793000000;
const expiry = ts + 30 * 86400;
const legs = ["call", "put"].map(type => ({ type, strike: 70000, expiry, quantity: 1 }));
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);
const sum = values => values.reduce((a, b) => a + b, 0);
const value = (spot, time, ivs, position = legs) => sum(position.map((leg, i) =>
  leg.quantity * calcOptionPrice(spot, leg.strike, leg.expiry - time, ivs[i], leg.type)));
const observation = (time, spot, ivs, atmIv, position = legs) => ({
  ts: time, spot, atmIv,
  marks: position.map((leg, i) => calcOptionPrice(spot, leg.strike, leg.expiry - time, ivs[i], leg.type)),
});
const checkSums = result => {
  for (const name of ["canonical", "reverse"]) {
    close(sum(PNL_BUCKETS.map(key => result.totals[name][key])), result.marked);
    close(result.reconciliation[name], 0);
    for (const step of result.steps) close(sum(PNL_BUCKETS.map(key => step[name][key])), step.marked);
  }
  for (const step of result.steps) close(sum(Object.values(step.cross)), 0);
};

test("joint jumps use full revaluation in both orders and expose cross redistribution", () => {
  const old = observation(ts, 70000, [0.6, 0.65]);
  const next = observation(ts + 86400, 79000, [0.38, 0.41]);
  const result = attributePnlPath({ legs, observations: [old, next] });
  const canonical = result.totals.canonical;
  const reverse = result.totals.reverse;
  close(canonical.time, value(old.spot, next.ts, [0.6, 0.65]) - sum(old.marks));
  close(canonical.vol, value(old.spot, next.ts, [0.38, 0.41]) - value(old.spot, next.ts, [0.6, 0.65]));
  close(reverse.vol, value(next.spot, old.ts, [0.38, 0.41]) - value(next.spot, old.ts, [0.6, 0.65]));
  close(reverse.time, sum(next.marks) - value(next.spot, old.ts, [0.38, 0.41]));
  assert.ok(result.totalCrossMagnitude > 100);
  assert.equal(result.steps[0].flagged, true);
  assert.equal(result.splitVol, false);
  assert.equal(result.unfittedMarks, 0);
  assert.ok(result.maxFitError < 1e-7);
  checkSums(result);
});

test("time alone produces no vol or spot P&L and no cross", () => {
  const result = attributePnlPath({ legs, observations: [
    observation(ts, 71000, [0.6, 0.65]), observation(ts + 86400, 71000, [0.6, 0.65]),
  ] });
  for (const order of Object.values(result.totals)) {
    assert.ok(order.time < 0);
    close(order.vol, 0); close(order.direction, 0); close(order.convexity, 0);
  }
  close(result.totalCrossMagnitude, 0);
  checkSums(result);
});

test("direction uses the selected entry delta at every step and every resolution", () => {
  const points = [
    observation(ts, 71000, [0.6, 0.65]),
    observation(ts + 3600, 74000, [0.7, 0.72]),
    observation(ts + 7200, 68000, [0.5, 0.55]),
    observation(ts + 10800, 78000, [0.4, 0.44]),
  ];
  const fine = attributePnlPath({ legs, observations: points });
  const coarse = attributePnlPath({ legs, observations: [points[0], points.at(-1)] });
  const expectedDelta = sum(legs.map((leg, i) => calcGreeks(71000, leg.strike, expiry - ts, [0.6, 0.65][i], leg.type).delta));
  close(fine.entryDelta, expectedDelta);
  for (const step of fine.steps) {
    const old = points.find(point => point.ts === step.from);
    const next = points.find(point => point.ts === step.ts);
    close(step.canonical.direction, expectedDelta * (next.spot - old.spot));
    close(step.reverse.direction, step.canonical.direction);
    close(step.canonical.direction + step.canonical.convexity, step.canonical.spot);
  }
  close(fine.totals.canonical.direction, coarse.totals.canonical.direction);
  const selection = attributePnlPath({ legs, observations: points.slice(1) });
  assert.ok(Math.abs(selection.entryDelta - fine.entryDelta) > 0.1);
  checkSums(fine); checkSums(coarse); checkSums(selection);
});

test("parallel and shape use independent ATM observations and reverse substep order", () => {
  const old = observation(ts, 70000, [0.6, 0.64], 0.61);
  const next = observation(ts + 3600, 75000, [0.7, 0.8], 0.68);
  const result = attributePnlPath({ legs, observations: [old, next] });
  assert.equal(result.splitVol, true);
  close(result.totals.canonical.parallel, value(old.spot, next.ts, [0.67, 0.71]) - value(old.spot, next.ts, [0.6, 0.64]));
  close(result.totals.reverse.shape, value(next.spot, old.ts, [0.63, 0.73]) - value(next.spot, old.ts, [0.6, 0.64]));
  for (const order of Object.values(result.totals)) close(order.parallel + order.shape, order.vol);
  checkSums(result);
});

test("equal leg shifts matching ATM have zero shape in both orders", () => {
  const result = attributePnlPath({ legs, observations: [
    observation(ts, 70000, [0.6, 0.64], 0.61), observation(ts + 3600, 74000, [0.67, 0.71], 0.68),
  ] });
  assert.equal(result.splitVol, true);
  close(result.totals.canonical.shape, 0); close(result.totals.reverse.shape, 0);
  checkSums(result);
});

test("missing ATM or negative intermediate IV never fabricates a shape split", () => {
  for (const points of [
    [observation(ts, 70000, [0.6, 0.64], 0.61), observation(ts + 3600, 74000, [0.67, 0.71])],
    [observation(ts, 70000, [0.6, 0.64], 0.61), observation(ts + 3600, 74000, [0.67, 0.71], 1.61)],
  ]) {
    const result = attributePnlPath({ legs, observations: points });
    assert.equal(result.splitVol, false);
    assert.ok(result.volSplitReason);
    checkSums(result);
  }
});

test("unattainable marks retain quantity-weighted model-versus-mark P&L", () => {
  const position = [{ ...legs[0], quantity: -2 }, { ...legs[1], quantity: 3 }];
  const first = { ts, spot: 80000, marks: [9000, 1000] }; // call below intrinsic by 1000
  const next = { ts: ts + 3600, spot: 81000, marks: [9000, 1100] }; // below by 2000
  const result = attributePnlPath({ legs: position, observations: [first, next] });
  assert.equal(result.unfittedMarks, 2);
  close(result.totals.canonical.discrepancy, 2000);
  close(result.totals.reverse.discrepancy, 2000);
  close(result.maxFitError, 2000);
  checkSums(result);
});

test("marks above the finite model upper bound are reconciled separately", () => {
  const position = [legs[0]];
  const result = attributePnlPath({ legs: position, observations: [
    { ts, spot: 70000, marks: [71000] }, { ts: ts + 3600, spot: 72000, marks: [74000] },
  ] });
  close(result.totals.canonical.discrepancy, 1000);
  assert.equal(result.unfittedMarks, 2);
  checkSums(result);
});

test("expiry does not manufacture a fitted IV collapse", () => {
  const position = legs.map(leg => ({ ...leg, expiry: ts + 3600 }));
  const result = attributePnlPath({ legs: position, observations: [
    observation(ts, 70000, [0.6, 0.64], undefined, position),
    observation(ts + 3600, 71000, [0.6, 0.64], undefined, position),
  ] });
  close(result.path[0].ivs[0], result.path[1].ivs[0]);
  close(result.totals.canonical.vol, 0); close(result.totals.reverse.vol, 0);
  checkSums(result);
});

test("missing data, duplicate timestamps and malformed contracts fail explicitly", () => {
  const first = observation(ts, 70000, [0.6, 0.64]);
  const next = observation(ts + 3600, 71000, [0.6, 0.64]);
  for (const observations of [[first, first], [next, first], [first, { ...next, marks: [100] }], [first, { ...next, spot: NaN }]]) {
    assert.throws(() => attributePnlPath({ legs, observations }));
  }
  assert.throws(() => attributePnlPath({ legs: [{ ...legs[0], type: "unknown" }], observations: [] }));
  assert.equal(attributePnlPath({ legs, observations: [first] }), null);
});

test("observed time gaps are reported, with no fabricated steps", () => {
  const result = attributePnlPath({ legs, intervalSeconds: 3600, observations: [
    observation(ts, 70000, [0.6, 0.64]), observation(ts + 7200, 71000, [0.6, 0.64]),
  ] });
  assert.equal(result.gaps, 1); assert.equal(result.steps.length, 1);
  checkSums(result);
});

test("venue history adapter keeps missing leg marks visible and quotes separate", () => {
  const history = buildStraddlePnlHistory({
    index: [{ ts, index_price_close: 70000 }, { ts: ts + 3600, index_price_close: 71000 }],
    callMark: [{ ts, mark_price_close: 1000, iv_close: 0.6 }],
    putMark: [{ ts, mark_price_close: 1000, iv_close: 0.65 }],
    callInstrument: { instrument_name: "C", strike_price: 70000, expiration_timestamp: expiry, option_type: "call" },
    putInstrument: { instrument_name: "P", strike_price: 70000, expiration_timestamp: expiry, option_type: "put" },
  });
  assert.deepEqual(history.observations[0].reportedIvs, [0.6, 0.65]);
  assert.deepEqual(history.observations[1].marks, [undefined, undefined]);
  assert.throws(() => attributePnlPath(history));
});

test("ATM CSV requires observed, unique timestamps and the exact selected expiry", () => {
  const parsed = parseAtmIvHistory(`timestamp,expiry,atm_iv\n${ts},${expiry},0.61`, expiry);
  close(parsed.get(ts), 0.61);
  const iso = new Date(ts * 1000).toISOString();
  assert.equal(parseAtmIvHistory(`timestamp,expiry,atm_iv\n${iso},${expiry},0.6`, expiry).size, 1);
  for (const csv of [
    `timestamp,expiry,atm_iv\n${ts},${expiry + 1},0.61`,
    `timestamp,expiry,atm_iv\n${ts},${expiry},`,
    `timestamp,expiry,atm_iv\n${ts},${expiry},-1`,
    `timestamp,expiry,atm_iv\n${ts},${expiry},0.6\n${ts},${expiry},0.7`,
    "timestamp,iv\n1,0.6",
  ]) assert.throws(() => parseAtmIvHistory(csv, expiry));
});

test("the exposure sentence distinguishes order-dependent payback", () => {
  const result = { totals: { canonical: { direction: 0, convexity: 120, time: -80, vol: -30 },
    reverse: { direction: 0, convexity: 80, time: -70, vol: -40 } } };
  assert.match(exposureSentence(result, String), /depends on the revaluation order/);
});

test("stored Thalex closes reconcile across 39 hourly steps, including impossible index-model marks", () => {
  const result = attributePnlPath(historicalPath);
  assert.equal(result.steps.length, 39);
  close(result.marked, -409.7108679803205);
  close(result.totals.canonical.time, -228.64003252153452);
  close(result.totals.canonical.vol, 53.649995865599976);
  close(result.totals.canonical.direction, -246.1886648088182);
  close(result.totals.canonical.convexity, 11.467833484430507);
  close(result.totals.reverse.vol, -32.00931394060672);
  close(result.totalCrossMagnitude, 179.12416795979152);
  assert.equal(result.unfittedMarks, 3);
  close(result.maxFitError, 49.494066421160824);
  assert.deepEqual(result.steps.filter(step => step.flagged).map(step => step.ts), [1790694000, 1790769600]);
  assert.equal(result.gaps, 0);
  checkSums(result);
});
