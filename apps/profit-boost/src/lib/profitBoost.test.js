import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WEEKLY_PNL,
  MAX_WEEKLY_PNL,
  MIN_WEEKLY_PNL,
  START_BALANCE,
  WEEKLY_PNL_STEP,
  calculateProfitBoost,
  formatDollar,
  formatSignedDollar,
} from "./profitBoost.js";

test("default scenario reports profit as the primary outcome", () => {
  assert.deepEqual(calculateProfitBoost(DEFAULT_WEEKLY_PNL), {
    inputPnl: 2_600,
    profits: { base: 2_600, twoX: 5_200, threeX: 7_800 },
    endingBalances: { base: 5_000, twoX: 7_600, threeX: 10_200 },
  });
});

test("zero remains unchanged", () => {
  for (const weeklyPnl of [0, MIN_WEEKLY_PNL]) {
    const result = calculateProfitBoost(weeklyPnl);
    assert.deepEqual(result.profits, {
      base: weeklyPnl,
      twoX: weeklyPnl,
      threeX: weeklyPnl,
    });
    assert.deepEqual(result.endingBalances, {
      base: START_BALANCE + weeklyPnl,
      twoX: START_BALANCE + weeklyPnl,
      threeX: START_BALANCE + weeklyPnl,
    });
  }
});

test("maximum input applies the positive-profit multipliers", () => {
  const result = calculateProfitBoost(MAX_WEEKLY_PNL);
  assert.deepEqual(result.profits, {
    base: 5_000,
    twoX: 10_000,
    threeX: 15_000,
  });
  assert.deepEqual(result.endingBalances, {
    base: 7_400,
    twoX: 12_400,
    threeX: 17_400,
  });
});

test("all 51 slider states satisfy the formula and balance identities", () => {
  const inputs = [];
  for (
    let weeklyPnl = MIN_WEEKLY_PNL;
    weeklyPnl <= MAX_WEEKLY_PNL;
    weeklyPnl += WEEKLY_PNL_STEP
  ) {
    inputs.push(weeklyPnl);
    const result = calculateProfitBoost(weeklyPnl);
    const positive = weeklyPnl > 0;

    assert.equal(result.profits.base, weeklyPnl);
    assert.equal(result.profits.twoX, positive ? weeklyPnl * 2 : weeklyPnl);
    assert.equal(result.profits.threeX, positive ? weeklyPnl * 3 : weeklyPnl);
    assert.equal(
      result.endingBalances.base,
      START_BALANCE + result.profits.base,
    );
    assert.equal(
      result.endingBalances.twoX,
      START_BALANCE + result.profits.twoX,
    );
    assert.equal(
      result.endingBalances.threeX,
      START_BALANCE + result.profits.threeX,
    );
  }

  assert.equal(inputs.length, 51);
  assert.equal(inputs[0], MIN_WEEKLY_PNL);
  assert.equal(inputs.at(-1), MAX_WEEKLY_PNL);
});

test("currency formatting is signed only where requested", () => {
  assert.equal(formatSignedDollar(2_600), "+$2,600");
  assert.equal(formatSignedDollar(-2_400), "−$2,400");
  assert.equal(formatSignedDollar(0), "$0");
  assert.equal(formatDollar(10_200), "$10,200");
  assert.equal(formatDollar(-100), "−$100");
});

test("non-finite inputs are rejected", () => {
  assert.throws(() => calculateProfitBoost(Number.NaN), TypeError);
  assert.throws(() => calculateProfitBoost(Infinity), TypeError);
});
