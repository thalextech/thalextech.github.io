import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVolPnlBarRows,
  minimumEntryIv,
  pnlOnEntryPremium,
  VOLATILITY_METRICS,
} from "../src/lib/volPnlBar.js";

const cycle = {
  cyclePnlUsd: 2_000,
  entryOptionCashflowUsd: -5_000,
  trailingSevenDayRealizedVol: 0.45,
  legs: [
    { entryImpliedVol: 0.55 },
    { entryImpliedVol: 0.6 },
  ],
};

test("minimumEntryIv uses the lowest finite combination IV", () => {
  assert.equal(minimumEntryIv(cycle), 0.55);
});

test("pnlOnEntryPremium normalizes by absolute entry premium", () => {
  assert.equal(pnlOnEntryPremium(cycle), 0.4);
});

test("bar rows toggle between IV, RV, and IV minus RV", () => {
  assert.equal(
    buildVolPnlBarRows([cycle], VOLATILITY_METRICS.IV)[0].xValue,
    0.55,
  );
  assert.equal(
    buildVolPnlBarRows([cycle], VOLATILITY_METRICS.RV)[0].xValue,
    0.45,
  );
  assert.ok(Math.abs(
    buildVolPnlBarRows(
      [cycle],
      VOLATILITY_METRICS.IV_MINUS_RV,
    )[0].xValue - 0.1,
  ) < 1e-12);
});

test("bar rows expose both PnL measures and sort by the selected x metric", () => {
  const lowerRvCycle = {
    ...cycle,
    cyclePnlUsd: -1_000,
    trailingSevenDayRealizedVol: 0.35,
  };
  const rows = buildVolPnlBarRows(
    [cycle, lowerRvCycle],
    VOLATILITY_METRICS.RV,
  );

  assert.deepEqual(rows.map((row) => row.xValue), [0.35, 0.45]);
  assert.equal(rows[0].pnlUsd, -1_000);
  assert.equal(rows[0].pnlOnPremium, -0.2);
});

test("bar rows omit cycles missing data required by the selected metric", () => {
  const withoutRv = { ...cycle, trailingSevenDayRealizedVol: null };
  assert.equal(
    buildVolPnlBarRows([withoutRv], VOLATILITY_METRICS.IV).length,
    1,
  );
  assert.equal(
    buildVolPnlBarRows([withoutRv], VOLATILITY_METRICS.RV).length,
    0,
  );
  assert.equal(
    buildVolPnlBarRows([withoutRv], VOLATILITY_METRICS.IV_MINUS_RV).length,
    0,
  );
});
