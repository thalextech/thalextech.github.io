import assert from "node:assert/strict";
import test from "node:test";
import { computeOptionOmega } from "../src/lib/blackScholes.ts";

test("option omega is the absolute delta elasticity", () => {
  assert.equal(computeOptionOmega(0.5, 60_000, 3_000), 10);
  assert.equal(computeOptionOmega(-0.4, 60_000, 2_000), 12);
});

test("option omega requires a positive option price", () => {
  assert.equal(computeOptionOmega(0.5, 60_000, 0), null);
});
