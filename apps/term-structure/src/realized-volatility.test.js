import test from "node:test";
import assert from "node:assert/strict";
import {
  hourlyVariance,
  realizedByExpiry,
  realizedForwardByExpiry,
} from "./realized-volatility.js";
const HOUR = 3600,
  end = 200000 * HOUR;
const bar = (ts) => ({ ts, open: 100, high: 102, low: 98, close: 101 });
test("Garman–Klass uses all OHLC fields and calendar-hour annualization", () => {
  const expected =
    0.5 * Math.log(102 / 98) ** 2 -
    (2 * Math.LN2 - 1) * Math.log(101 / 100) ** 2;
  assert.ok(Math.abs(hourlyVariance(bar(0)) - expected) < 1e-12);
  const rows = [bar(end - 2 * HOUR), bar(end - HOUR)];
  const [point] = realizedByExpiry([end + 2 * HOUR], rows, end);
  assert.ok(Math.abs(point.iv - Math.sqrt(expected * 365.25 * 24)) < 1e-12);
  assert.equal(point.hours, 2);
});
test("lookbacks match each forward horizon, round upward and exclude incomplete/future bars", () => {
  const asOf = end + HOUR / 2;
  const bars = Array.from({ length: 5 }, (_, i) => bar(end - (5 - i) * HOUR));
  bars.push({ ...bar(end), high: 1000 });
  const points = realizedByExpiry(
    [asOf + 1.2 * HOUR, asOf + 4 * HOUR],
    bars,
    asOf,
  );
  assert.deepEqual(
    points.map((p) => [p.start, p.end, p.hours]),
    [
      [end - 2 * HOUR, end, 2],
      [end - 4 * HOUR, end, 4],
    ],
  );
  assert.equal(points[0].iv, points[1].iv);
});
test("large gaps suppress RV rather than substituting a shorter window", () => {
  const [missing] = realizedByExpiry(
    [end + 3 * HOUR],
    [bar(end - 3 * HOUR), bar(end - HOUR)],
    end,
  );
  assert.equal(missing.iv, null);
  assert.equal(missing.count, 2);
  assert.equal(missing.hours, 3);
  assert.equal(missing.coverage, 2 / 3);
  assert.equal(hourlyVariance({ ...bar(0), low: 105 }), null);
  assert.equal(hourlyVariance({ ...bar(0), close: NaN }), null);
  assert.deepEqual(realizedByExpiry([end + HOUR], [], null), []);
});

test("one missing hour does not hide long-maturity RV or shorten its lookback", () => {
  const hours = 216;
  const full = Array.from({ length: hours }, (_, i) =>
    bar(end - (hours - i) * HOUR),
  );
  const withGap = full.filter((b) => b.ts !== end - 7 * 24 * HOUR);
  const [point] = realizedByExpiry([end + hours * HOUR], withGap, end);
  const [complete] = realizedByExpiry([end + hours * HOUR], full, end);
  assert.equal(point.start, end - hours * HOUR);
  assert.equal(point.end, end);
  assert.equal(point.count, hours - 1);
  assert.equal(point.partial, true);
  assert.equal(point.coverage, 215 / 216);
  assert.ok(point.iv > 0);
  assert.ok(
    Math.abs(point.iv - complete.iv) < 1e-12,
    "missing bars must not be counted as zero variance",
  );
});

test("99% coverage is accepted but materially shorter histories stay unavailable", () => {
  const hours = 100;
  const full = Array.from({ length: hours }, (_, i) =>
    bar(end - (hours - i) * HOUR),
  );
  assert.ok(
    realizedByExpiry([end + hours * HOUR], full.slice(1), end)[0].iv > 0,
  );
  assert.equal(
    realizedByExpiry([end + hours * HOUR], full.slice(2), end)[0].iv,
    null,
  );
  assert.equal(realizedByExpiry([end + hours * HOUR], [], end)[0].iv, null);
});
test("constant prices yield zero RV rather than unavailable", () => {
  const [point] = realizedByExpiry(
    [end + HOUR],
    [{ ts: end - HOUR, open: 100, high: 100, low: 100, close: 100 }],
    end,
  );
  assert.equal(point.iv, 0);
});

test("publication lag uses the latest available completed hour while retaining the current forward horizon", () => {
  const asOf = end + 2 * HOUR;
  const rows = [bar(end - 2 * HOUR), bar(end - HOUR)];
  const [point] = realizedByExpiry([asOf + 2 * HOUR], rows, asOf);
  assert.equal(point.end, end);
  assert.equal(point.hours, 2);
  assert.equal(point.start, end - 2 * HOUR);
  assert.ok(point.iv > 0);
});

test("forward RV uses the most recent history matching each interval duration", () => {
  const bars = Array.from({ length: 9 }, (_, i) => bar(end - (9 - i) * HOUR));
  bars[7] = { ...bars[7], high: 150, low: 50 };
  bars[8] = { ...bars[8], high: 150, low: 50 };
  const points = realizedForwardByExpiry(
    [end + 2 * HOUR, end + 5 * HOUR, end + 9 * HOUR],
    bars,
    end,
  );
  assert.deepEqual(
    points.map((p) => [p.start, p.end, p.hours, p.count]),
    [
      [end - 2 * HOUR, end, 2, 2],
      [end - 3 * HOUR, end, 3, 3],
      [end - 4 * HOUR, end, 4, 4],
    ],
  );
  assert.ok(points[0].iv > points[1].iv);
  assert.ok(points[1].iv > points[2].iv);
  const trailing = realizedByExpiry(
    [end + 2 * HOUR, end + 3 * HOUR, end + 4 * HOUR],
    bars,
    end,
  );
  assert.deepEqual(points.map((p) => p.iv), trailing.map((p) => p.iv));
  assert.equal(points[1].startExpiry, end + 2 * HOUR);
});
test("RV coverage is assessed separately inside each forward interval", () => {
  const expiries = [end + 100 * HOUR, end + 300 * HOUR];
  const bars = Array.from({ length: 200 }, (_, i) =>
    bar(end - (200 - i) * HOUR),
  );
  const oneGap = realizedForwardByExpiry(expiries, bars.slice(1), end);
  assert.equal(oneGap[0].coverage, 1);
  assert.equal(oneGap[1].coverage, 0.995);
  assert.ok(oneGap.every((p) => p.iv > 0));
  const twoGaps = realizedForwardByExpiry(expiries, bars.slice(2), end);
  assert.equal(twoGaps[1].coverage, 0.99);
  assert.ok(twoGaps.every((p) => p.iv > 0));
  const threeGaps = realizedForwardByExpiry(expiries, bars.slice(3), end);
  assert.ok(threeGaps[0].iv > 0);
  assert.equal(threeGaps[1].iv, null);
});
test("forward RV keeps long durations and rounds sub-hour durations up to one hour", () => {
  const bars = Array.from({ length: 2100 }, (_, i) =>
    bar(end - (2100 - i) * HOUR),
  );
  const points = realizedForwardByExpiry(
    [end + 100 * HOUR, end + 2100 * HOUR],
    bars,
    end,
  );
  assert.equal(points[1].count, 2000);
  assert.equal(points[1].hours, 2000);
  const short = realizedForwardByExpiry(
    [end + HOUR / 4, end + HOUR / 2],
    bars,
    end,
  );
  assert.equal(short[1].hours, 1);
  assert.ok(short[1].iv > 0);
});

test("forward RV and expiry RV share the first point and the same completed-hour anchor", () => {
  const asOf = end + HOUR / 2;
  const bars = Array.from({ length: 12 }, (_, i) => bar(end - (12 - i) * HOUR));
  bars.push({ ...bar(end), high: 1000 }); // Incomplete bar must not enter any window.
  const expiries = [asOf + 1.2 * HOUR, asOf + 5.4 * HOUR];
  const expiry = realizedByExpiry(expiries, bars, asOf);
  const forward = realizedForwardByExpiry(expiries, bars, asOf);
  assert.deepEqual(forward[0], expiry[0]);
  assert.equal(forward[1].end, end);
  assert.equal(forward[1].hours, 5);
  assert.equal(forward[1].start, end - 5 * HOUR);
});
