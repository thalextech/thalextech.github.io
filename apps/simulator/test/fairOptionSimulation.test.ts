import assert from "node:assert/strict";
import test from "node:test";
import { blackScholesGreeks } from "../src/lib/blackScholes.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import type { PositionLeg } from "../src/lib/position.ts";
import { simulate } from "../src/workers/sim.worker.ts";

const ROWS = 1_000_000;
const SPOT = 63_000;
const STRIKE = 63_000;
const VOL = 0.289;
const T = 30 / 365.25;
const VALUATION_TS = 1_700_000_000;
const EXPIRATION_TS = VALUATION_TS + T * 365.25 * 24 * 60 * 60;

function simulateFairStructure(upperStrike?: number) {
  const longPremium = blackScholesGreeks(
    SPOT,
    STRIKE,
    T,
    VOL,
    0,
    "call",
  ).price;
  const shortPremium = upperStrike
    ? blackScholesGreeks(SPOT, upperStrike, T, VOL, 0, "call").price
    : 0;
  const netPremium = longPremium - shortPremium;
  const quantity = 10_000 / netPremium;
  const legs: PositionLeg[] = [
    {
      id: "long-call",
      kind: "option",
      side: "buy",
      qty: quantity,
      optionType: "call",
      strike: STRIKE,
      premium: longPremium,
    },
  ];
  const optionPricingByLegId = {
    "long-call": {
      iv: VOL,
      mark: longPremium,
      expirationTs: EXPIRATION_TS,
    },
  };

  if (upperStrike) {
    legs.push({
      id: "short-call",
      kind: "option",
      side: "sell",
      qty: quantity,
      optionType: "call",
      strike: upperStrike,
      premium: shortPremium,
    });
    Object.assign(optionPricingByLegId, {
      "short-call": {
        iv: VOL,
        mark: shortPremium,
        expirationTs: EXPIRATION_TS,
      },
    });
  }

  const result = simulate({
    id: 1,
    seed: 0x5eed1234,
    params: {
      s0: SPOT,
      mu: 0,
      vol: VOL,
      T,
      // One exact GBM step is sufficient for the terminal distribution.
      dt: T,
      rows: ROWS,
    },
    pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" },
    legs,
    optionPricingByLegId,
    valuationTs: VALUATION_TS,
    horizonSeconds: T * 365.25 * 24 * 60 * 60,
    histBins: 100,
    histBinsMultiplier: 1,
    samplePathLimit: 100,
    returnSamplePaths: false,
  });

  const payoffs = new Float64Array(result.terminalPayoffsBuffer);
  let squaredErrorSum = 0;
  for (const payoff of payoffs) {
    squaredErrorSum += (payoff - result.meanPayoff) ** 2;
  }
  const standardError = Math.sqrt(
    squaredErrorSum / (ROWS - 1) / ROWS,
  );

  return { mean: result.meanPayoff, standardError };
}

function assertZeroEv(mean: number, standardError: number) {
  assert.ok(
    Math.abs(mean) <= 4 * standardError,
    `mean ${mean} is more than four standard errors (${standardError}) from zero`,
  );
  assert.ok(
    Math.abs(mean) < 50,
    `mean ${mean} is not economically close to zero`,
  );
}

test("a model-fair call converges to zero EV over one million paths", () => {
  const { mean, standardError } = simulateFairStructure();
  assertZeroEv(mean, standardError);
});

test("a model-fair call spread converges to zero EV over one million paths", () => {
  const { mean, standardError } = simulateFairStructure(69_300);
  assertZeroEv(mean, standardError);
});
