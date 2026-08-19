import assert from "node:assert/strict";
import test from "node:test";
import {
  getUnderlying,
  UNDERLYING_OPTIONS,
} from "../src/lib/underlyings.js";

test("backtest underlyings isolate their runtime data roots", () => {
  assert.deepEqual(
    UNDERLYING_OPTIONS.map(({ value, dataRoot }) => ({ value, dataRoot })),
    [
      { value: "BTC", dataRoot: "data/thalex" },
      { value: "ETH", dataRoot: "data/thalex/eth" },
    ],
  );
  assert.equal(getUnderlying("ETH").label, "ETH");
  assert.equal(getUnderlying("UNKNOWN").value, "BTC");
});
