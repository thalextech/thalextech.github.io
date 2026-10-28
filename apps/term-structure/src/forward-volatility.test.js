import test from "node:test";
import assert from "node:assert/strict";
import {
  forwardVolatility,
  toForwardTermStructure,
} from "./forward-volatility.js";
const DAY = 86400,
  asOf = 1800000000;
const e1 = asOf + DAY,
  e2 = asOf + 2 * DAY,
  e3 = asOf + 4 * DAY;
const point = (expiry, iv, ts = asOf) => ({
  expiry,
  iv,
  ts,
  clamped: false,
  count: 999,
  rank: 99,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("adjacent forward volatility is the time-weighted total-variance difference", () => {
  close(
    forwardVolatility(point(e1, 0.4), point(e2, 0.5), asOf),
    Math.sqrt(0.5 ** 2 * 2 - 0.4 ** 2),
  );
  assert.equal(forwardVolatility(null, point(e1, 0.4), asOf), 0.4);
});
test("negative forward variance is unavailable; an exactly zero forward variance is valid", () => {
  assert.equal(forwardVolatility(point(e1, 0.8), point(e2, 0.1), asOf), null);
  assert.equal(forwardVolatility(point(e1, 0.4), point(e3, 0.2), asOf), 0);
  assert.equal(forwardVolatility(point(e2, 0.4), point(e1, 0.5), asOf), null);
  assert.equal(forwardVolatility(null, point(asOf, 0.4), asOf), null);
  assert.equal(forwardVolatility(null, point(e1, NaN), asOf), null);
});
test("historical forwards use their own observation time and have freshly computed percentiles", () => {
  const result = toForwardTermStructure(
    {
      current: [point(e1, 0.4, asOf - 60), point(e2, 0.5, asOf - 120)],
      history: [point(e1, 0.4, asOf - DAY), point(e2, 0.5, asOf - DAY)],
    },
    [e1, e2],
    asOf,
  );
  const current = result.current.find((p) => p.expiry === e2),
    historical = result.history.find((p) => p.expiry === e2);
  close(current.iv, Math.sqrt(0.34));
  close(historical.iv, Math.sqrt(0.43));
  assert.equal(current.ts, asOf);
  assert.equal(current.startExpiry, e1);
  assert.equal(current.rank, 0);
  assert.equal(current.count, 1);
});
test("history requires both legs at the same timestamp; no time forward-fill is used", () => {
  const result = toForwardTermStructure(
    {
      current: [],
      history: [point(e1, 0.4, asOf - 3600), point(e2, 0.5, asOf - 7200)],
    },
    [e1, e2],
    asOf,
  );
  assert.equal(result.history.filter((p) => p.expiry === e2).length, 0);
  assert.equal(result.history.filter((p) => p.expiry === e1).length, 1);
});
test("a missing intermediate expiry leaves gaps instead of bridging to a different interval", () => {
  const points = [point(e1, 0.4), point(e3, 0.5)];
  const result = toForwardTermStructure(
    { current: points, history: points },
    [e3, e1, e2],
    asOf,
  );
  assert.deepEqual(
    result.current.map((p) => p.expiry),
    [e1],
  );
  assert.deepEqual(
    result.history.map((p) => p.expiry),
    [e1],
  );
  assert.deepEqual(
    result.unavailable.map((p) => [p.expiry, p.reason]),
    [
      [e2, "missing-leg"],
      [e3, "missing-leg"],
    ],
  );
});
test("flat term structures stay flat in current and historical forward space", () => {
  const points = [point(e1, 0.3), point(e2, 0.3), point(e3, 0.3)];
  const result = toForwardTermStructure(
    { current: points, history: points.map((p) => ({ ...p, ts: asOf - DAY })) },
    [e1, e2, e3],
    asOf,
  );
  [...result.current, ...result.history].forEach((p) => close(p.iv, 0.3));
});
test("negative historical variance increments are disclosed and omitted rather than clamped to zero", () => {
  const result = toForwardTermStructure(
    {
      current: [point(e1, 0.4), point(e2, 0.5)],
      history: [point(e1, 0.8, asOf - DAY), point(e2, 0.1, asOf - DAY)],
    },
    [e1, e2],
    asOf,
  );
  assert.equal(result.negativeHistoryCount, 1);
  assert.equal(result.history.length, 1);
  assert.equal(result.current.find((p) => p.expiry === e2).count, 0);
});
