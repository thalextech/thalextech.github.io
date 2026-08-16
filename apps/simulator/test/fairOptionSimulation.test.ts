import assert from "node:assert/strict";
import test from "node:test";
import { blackScholesGreeks } from "../src/lib/blackScholes.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import { simulate } from "../src/workers/sim.worker.ts";

test("a model-fair option converges to zero EV over one million paths", () => {
  const rows = 1_000_000;
  const spot = 63_000;
  const strike = 63_000;
  const vol = 0.289;
  const T = 30 / 365.25;
  const valuationTs = 1_700_000_000;
  const expirationTs = valuationTs + T * 365.25 * 24 * 60 * 60;
  const premium = blackScholesGreeks(
    spot,
    strike,
    T,
    vol,
    0,
    "call",
  ).price;

  const result = simulate({
    id: 1,
    seed: 0x5eed1234,
    params: {
      s0: spot,
      mu: 0,
      vol,
      T,
      // One exact GBM step is sufficient for the terminal distribution.
      dt: T,
      rows,
    },
    pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" },
    legs: [
      {
        id: "fair-call",
        kind: "option",
        side: "buy",
        qty: 10_000 / premium,
        optionType: "call",
        strike,
        premium,
      },
    ],
    optionPricingByLegId: {
      "fair-call": { iv: vol, mark: premium, expirationTs },
    },
    valuationTs,
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
    squaredErrorSum / (rows - 1) / rows,
  );

  assert.ok(
    Math.abs(result.meanPayoff) <= 4 * standardError,
    `mean ${result.meanPayoff} is more than four standard errors (${standardError}) from zero`,
  );
  assert.ok(
    Math.abs(result.meanPayoff) < 50,
    `mean ${result.meanPayoff} is not economically close to zero`,
  );
});
