import test from "node:test";
import assert from "node:assert/strict";
import { getAvailableStraddles } from "./straddle-selection.js";

const now = 1000;
const instrument = (expiry, strike, type) => ({
  expiration_ts: expiry, strike, option_type_normalized: type,
  instrument_name: `${expiry}-${strike}-${type}`,
});
const pair = (expiry, strike) => [instrument(expiry, strike, "call"), instrument(expiry, strike, "put")];

test("a selected strike skips expiries without that exact call/put pair", () => {
  const available = getAvailableStraddles([
    ...pair(3000, 81000), ...pair(2000, 80000), ...pair(4000, 80000),
    ...pair(4000, 81000),
    instrument(5000, 80000, "call"), instrument(5000, 81000, "put"),
  ], now);
  const selected = available.filter(straddle => straddle.strike === 80000);
  assert.deepEqual(selected.map(straddle => straddle.expiryTs), [2000, 4000]);
  assert.ok(selected.every(straddle => straddle.strike === 80000));
  assert.deepEqual(selected[0], {
    expiryTs: 2000, strike: 80000,
    callInstrumentName: "2000-80000-call", putInstrumentName: "2000-80000-put",
  });
  assert.deepEqual([...new Set(available.map(straddle => straddle.strike))].sort(), [80000, 81000]);
});

test("legs from different expiries cannot create a strike option", () => {
  assert.deepEqual(getAvailableStraddles([
    instrument(2000, 80000, "call"), instrument(3000, 80000, "put"),
  ], now), []);
});

test("expired and malformed pairs are excluded", () => {
  assert.deepEqual(getAvailableStraddles([
    ...pair(999, 80000), ...pair(now, 80000), ...pair(3000, NaN),
    ...pair(3000, 0), ...pair(NaN, 80000),
    { ...instrument(3000, 80000, "call"), instrument_name: "" },
    instrument(3000, 80000, "put"),
  ], now), []);
});
