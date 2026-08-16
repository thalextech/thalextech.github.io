import assert from "node:assert/strict";
import test from "node:test";
import {
  blackScholesGreeks,
  computeOptionOmega,
} from "../src/lib/blackScholes.ts";

test("matches canonical Black-Scholes call and put prices", () => {
  const call = blackScholesGreeks(100, 100, 1, 0.2, 0.05, "call");
  const put = blackScholesGreeks(100, 100, 1, 0.2, 0.05, "put");

  assert.ok(Math.abs(call.price - 10.4506) < 0.0001);
  assert.ok(Math.abs(put.price - 5.5735) < 0.0001);
});

test("option omega is the absolute delta elasticity", () => {
  assert.equal(computeOptionOmega(0.5, 60_000, 3_000), 10);
  assert.equal(computeOptionOmega(-0.4, 60_000, 2_000), 12);
});

test("option omega requires a positive option price", () => {
  assert.equal(computeOptionOmega(0.5, 60_000, 0), null);
});
