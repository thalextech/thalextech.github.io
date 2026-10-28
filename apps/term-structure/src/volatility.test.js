import test from "node:test";
import assert from "node:assert/strict";
import {
  bookMidIv,
  buildTermStructure,
  interpolateSlice,
  spotDelta,
  selectLiveQuotes,
} from "./volatility.js";
const base = { expiry: 2000000000, ts: 1999000000, spot: 100, side: "C" };
const q = (strike, iv, extra = {}) => ({ ...base, strike, iv, ...extra });
const close = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("marks are default and book mode falls back per quote without discarding strikes", () => {
  const quotes = [
    q(90, 0.4, { bookIv: 0.5 }),
    q(100, 0.6, { bookIv: null }),
    q(110, 0.7, { bookIv: NaN }),
    q(120, 0.8, { bookIv: Infinity }),
  ];
  assert.deepEqual(
    selectLiveQuotes(quotes).map((q) => q.iv),
    [0.4, 0.6, 0.7, 0.8],
  );
  assert.deepEqual(
    selectLiveQuotes(quotes, "book").map((q) => q.iv),
    [0.5, 0.6, 0.7, 0.8],
  );
  assert.equal(quotes[0].iv, 0.4);
});

test("cached history is visible for listed expiries before live quotes arrive", () => {
  const result = buildTermStructure({
    live: [],
    history: [q(100, 0.4)],
    expiries: [base.expiry],
  });
  assert.equal(result.current.length, 0);
  assert.equal(result.history.length, 1);
});

test("ATM averages C/P variances before strike interpolation, matching the notebook", () => {
  const result = interpolateSlice([
    q(90, 0.2),
    q(90, 0.4, { side: "P" }),
    q(110, 0.6),
    q(110, 0.8, { side: "P" }),
  ]);
  close(result.iv, Math.sqrt((0.2 ** 2 + 0.4 ** 2 + 0.6 ** 2 + 0.8 ** 2) / 4));
  assert.equal(result.clamped, false);
});
test("ATM exact strike uses that strike and off-chain spot uses nearest strike", () => {
  close(interpolateSlice([q(100, 0.3), q(110, 0.5)]).iv, 0.3);
  assert.deepEqual(interpolateSlice([q(110, 0.5), q(120, 0.6)]), {
    iv: 0.5,
    clamped: true,
  });
});
test("invalid IVs, expired observations and empty chains are omitted", () => {
  assert.equal(
    interpolateSlice([
      q(100, NaN),
      q(100, 0),
      q(100, 0.5, { ts: base.expiry }),
    ]),
    null,
  );
  assert.equal(interpolateSlice([]), null);
});
test("delta wings interpolate variance between same-side deltas and do not extrapolate", () => {
  const rows = [q(100, 0.5), q(120, 0.5), q(100, 2, { side: "P" })];
  close(interpolateSlice(rows, "25c").iv, 0.5);
  const putRows = [q(80, 0.5, { side: "P" }), q(100, 0.5, { side: "P" })];
  close(interpolateSlice(putRows, "25p").iv, 0.5);
  assert.equal(interpolateSlice([q(100, 0.5)], "10c"), null);
  close(spotDelta(q(100, 0.5)) - spotDelta(q(100, 0.5, { side: "P" })), 1);
});
test("book midpoint solver recovers known call/put IV and rejects unusable books", () => {
  // At F=K=100, T=1, sigma=.4, call and put price = 100 * (2 Phi(.2) - 1).
  const args = {
    bid: 15.8,
    ask: 15.9038837756412,
    forward: 100,
    strike: 100,
    ts: 0,
    expiry: 365.25 * 86400,
  };
  close(bookMidIv({ ...args, side: "C" }), 0.4, 1e-6);
  close(bookMidIv({ ...args, side: "P" }), 0.4, 1e-6);
  for (const patch of [
    { bid: null },
    { ask: 0 },
    { bid: 20, ask: 10 },
    { expiry: 0 },
    { forward: NaN },
    { bid: 110, ask: 120 },
  ])
    assert.equal(bookMidIv({ ...args, side: "C", ...patch }), null);
});
test("history stays at its own timestamp/spot, retains only live expiries and caps newest points", () => {
  const live = [q(90, 0.4), q(110, 0.4)];
  const history = [
    q(90, 0.1, { ts: base.ts - 300, spot: 90 }),
    q(110, 0.8, { ts: base.ts - 300, spot: 90 }),
    q(90, 0.3, { ts: base.ts - 200 }),
    q(110, 0.3, { ts: base.ts - 200 }),
    q(90, 0.5, { ts: base.ts - 100 }),
    q(110, 0.5, { ts: base.ts - 100 }),
    q(100, 0.9, { ts: base.ts - 100, expiry: base.expiry + 100 }),
  ];
  const all = buildTermStructure({ live, history });
  close(all.history[0].iv, 0.1);
  const result = buildTermStructure({ live, history, limit: 2 });
  assert.deepEqual(
    result.history.map((p) => p.ts),
    [base.ts - 200, base.ts - 100],
  );
  assert.equal(result.current[0].rank, 50);
  assert.equal(result.current[0].count, 2);
});
test("no history yields no percentile and ties use midrank", () => {
  const live = [q(100, 0.4)];
  assert.equal(buildTermStructure({ live, history: [] }).current[0].rank, null);
  assert.equal(
    buildTermStructure({ live, history: [q(100, 0.4, { ts: base.ts - 1 })] })
      .current[0].rank,
    50,
  );
});
