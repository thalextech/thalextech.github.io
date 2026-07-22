import test from "node:test";
import assert from "node:assert/strict";
import { varianceContribution } from "../src/lib/statistics.js";

test("variance contributions reconcile to total PnL variance", () => {
  const gammaTheta = [1, 2, 4, 3];
  const delta = [0, 2, 1, -1];
  const total = gammaTheta.map((value, index) => value + delta[index]);

  const gammaThetaContribution = varianceContribution(gammaTheta, total);
  const deltaContribution = varianceContribution(delta, total);

  assert.ok(Math.abs(gammaThetaContribution + deltaContribution - 1) < 1e-12);
  assert.ok(Math.abs(varianceContribution(total, total) - 1) < 1e-12);
});

test("variance contribution is unavailable when total PnL has no variance", () => {
  assert.equal(
    Number.isNaN(varianceContribution([1, 2, 3], [4, 4, 4])),
    true,
  );
});
