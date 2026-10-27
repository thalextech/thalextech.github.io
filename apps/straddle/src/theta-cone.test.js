import test from "node:test";
import assert from "node:assert/strict";
import { calcGreeks, calcOptionPrice } from "../../../lib/thalex.js";
import { buildInitiallyHedgedThetaCone, buildThetaCone } from "./theta-cone.js";

const entryTs = 1793000000;
const duration = 30 * 86400;
const price = (spot, strike, remaining, iv) =>
  calcOptionPrice(spot, strike, remaining, iv, "call") +
  calcOptionPrice(spot, strike, remaining, iv, "put");
const close = (actual, expected, tolerance = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

for (const [spot, strike, iv, seconds] of [
  [70000, 70000, 0.6, duration],
  [74000, 70000, 0.6, duration],
  [66000, 70000, 0.6, duration],
  [2500, 2500, 0.8, 3600],
]) {
  test(`holding-period roots reprice to entry cost: spot ${spot}, strike ${strike}, duration ${seconds}`, () => {
    const premium = price(spot, strike, seconds, iv);
    const cone = buildThetaCone({ spot, strike, premium, entryTs, expiryTs: entryTs + seconds });
    assert.ok(cone);
    close(cone.iv, iv);
    const first = cone.points[0];
    // A straddle with nonzero delta can have a second entry-time root.
    close(Math.min(Math.abs(first.low - spot), Math.abs(first.high - spot)), 0);
    let previous = first;
    for (const point of cone.points) {
      const remaining = entryTs + seconds - point.date.getTime() / 1000;
      assert.ok(point.low <= point.high);
      assert.ok(point.low <= previous.low + 1e-5);
      assert.ok(point.high >= previous.high - 1e-5);
      for (const value of [point.low, point.high]) {
        close(price(value, strike, remaining, cone.iv), premium, 0.001);
      }
      previous = point;
    }
    close(previous.low, strike - premium);
    close(previous.high, strike + premium);
    assert.equal(previous.date.getTime(), (entryTs + seconds) * 1000);
    assert.ok(first.high - first.low < previous.high - previous.low);
  });
}

test("ATM cone includes nonlinear time decay rather than linearly interpolating expiry bounds", () => {
  const strike = 70000;
  const premium = price(strike, strike, duration, 0.6);
  const { points } = buildThetaCone({ spot: strike, strike, premium, entryTs, expiryTs: entryTs + duration });
  const quarter = points[40]; // sample time = (40 / 80)^2
  close(quarter.date.getTime(), (entryTs + duration / 4) * 1000);
  const width = point => point.high - point.low;
  assert.ok(width(quarter) < width(points.at(-1)));
  assert.ok(Math.abs(width(quarter) - (width(points[0]) * 0.75 + width(points.at(-1)) * 0.25)) > 100);
});

test("unsupported and missing inputs do not produce a misleading cone", () => {
  const valid = { spot: 70000, strike: 70000, premium: 5000, entryTs, expiryTs: entryTs + duration };
  for (const overrides of [
    { spot: 0 }, { premium: NaN }, { premium: undefined }, { premium: -1 },
    { premium: 70000 }, { spot: 80000, premium: 9999 },
    { expiryTs: entryTs }, { expiryTs: entryTs - 1 }, { entryTs: NaN },
  ]) {
    assert.equal(buildThetaCone({ ...valid, ...overrides }), null);
    assert.equal(buildInitiallyHedgedThetaCone({ ...valid, ...overrides }), null);
  }
});

for (const [spot, strike, iv, seconds] of [
  [80000, 80000, 0.4, 241 * 86400],
  [74000, 70000, 0.6, duration],
  [66000, 70000, 0.6, duration],
  [2500, 2500, 0.8, 3600],
]) {
  test(`fixed initial hedge removes the entry gap and includes hedge P&L: spot ${spot}, strike ${strike}, duration ${seconds}`, () => {
    const premium = price(spot, strike, seconds, iv);
    const cone = buildInitiallyHedgedThetaCone({ spot, strike, premium, entryTs, expiryTs: entryTs + seconds });
    assert.ok(cone);
    close(cone.iv, iv);
    const delta = calcGreeks(spot, strike, seconds, iv, "call").delta
      + calcGreeks(spot, strike, seconds, iv, "put").delta;
    close(cone.hedgeDelta, delta);
    assert.equal(cone.points[0].low, spot);
    assert.equal(cone.points[0].high, spot);
    let previous = cone.points[0];
    for (const point of cone.points) {
      const remaining = entryTs + seconds - point.date.getTime() / 1000;
      assert.ok(point.low <= previous.low + 1e-5);
      assert.ok(point.high >= previous.high - 1e-5);
      for (const value of [point.low, point.high]) {
        // The same entry delta is held throughout; it is not recomputed here.
        close(price(value, strike, remaining, iv) - premium - delta * (value - spot), 0, 0.001);
      }
      previous = point;
    }
    close(previous.low, (strike - premium + delta * spot) / (1 + delta));
    close(previous.high, (strike + premium - delta * spot) / (1 - delta));
  });
}

test("June A/B comparison retains original unhedged bounds and gives hedged expiry bounds", () => {
  const inputs = { spot: 80000, strike: 80000, premium: 20900, entryTs, expiryTs: entryTs + 241 * 86400 };
  const unhedged = buildThetaCone(inputs);
  const hedged = buildInitiallyHedgedThetaCone(inputs);
  assert.ok(unhedged.points[0].low < 72000);
  close(unhedged.points.at(-1).low, 59100);
  close(unhedged.points.at(-1).high, 100900);
  close(hedged.points.at(-1).low, 61514.64897733554);
  close(hedged.points.at(-1).high, 104040.25880661394);
  assert.deepEqual(buildThetaCone(inputs), unhedged);
});
