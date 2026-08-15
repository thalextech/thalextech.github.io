import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PATH_MODEL,
  stochasticVarianceParameters,
} from "../src/lib/pathModel.ts";

test("stochastic variance uses RV without a mean-reversion target", () => {
  const variance = stochasticVarianceParameters(0.5, {
    ...DEFAULT_PATH_MODEL,
    volOfVol: 0.35,
    correlation: -0.6,
  });

  assert.deepEqual(variance, {
    kappa: 0,
    theta: 0.25,
    sigma: 0.35,
    rho: -0.6,
    initialVariance: 0.25,
  });
});
