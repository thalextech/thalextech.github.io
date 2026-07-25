import test from "node:test";
import assert from "node:assert/strict";
import {
  calibrateBatesModel,
  resolveVarianceAt,
} from "../src/lib/batesCalibration.js";
import {
  buildQuadraticVariationBudget,
  generateBatesPath,
} from "../src/lib/batesSimulation.js";
import {
  buildFairValueCycleState,
  createSeededRandom,
} from "../src/lib/fairValueMonteCarlo.js";

const startTs = Date.UTC(2025, 0, 1) / 1000;

const buildHistory = (days = 180) => {
  let close = 100_000;
  return Array.from({ length: days * 24 }, (_, index) => {
    const regimeScale = index < days * 8
      ? 0.003
      : index < days * 16
        ? 0.005
        : 0.008;
    const ordinaryReturn = regimeScale * (
      0.72 * Math.sin(index * 1.731)
      + 0.43 * Math.cos(index * 0.419)
    );
    const jumpReturn = index > 168 && index % 311 === 0
      ? (index % 622 === 0 ? -0.065 : 0.055)
      : 0;
    const open = close;
    close *= Math.exp(ordinaryReturn + jumpReturn);
    return {
      ts: startTs + index * 3_600,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
    };
  });
};

const buildCycle = () => {
  const entryTs = startTs + 120 * 86_400;
  const exitTs = entryTs + 7 * 86_400;
  return buildFairValueCycleState({
    cycle: 1,
    entryTime: new Date(entryTs * 1000),
    exitTime: new Date(exitTs * 1000),
    entryIndexPrice: 100_000,
    exitIndexPrice: 101_000,
    hedgeEnabled: true,
    hedgeIntervalHours: 24,
    cyclePnlUsd: 0,
    legs: [{
      optionType: "C",
      strike: 100_000,
      expirationTs: exitTs,
      quantity: -1,
      entryDelta: 0.5,
      entryImpliedVol: 0.8,
    }],
  });
};

test("Bates calibration isolates jumps and fits a finite variance process", () => {
  const calibration = calibrateBatesModel({ rows: buildHistory(), jumpThreshold: 4 });
  assert.equal(calibration.model, "Bates");
  assert.ok(calibration.jumps.count > 0);
  assert.ok(calibration.jumps.logStdDev > 0);
  assert.ok(["low", "medium", "high"].every((regime) =>
    Number.isFinite(calibration.jumps.byRegime[regime].intensity)));
  assert.ok(calibration.variance.kappa > 0);
  assert.ok(calibration.variance.theta > 0);
  assert.ok(calibration.variance.sigma > 0);
  assert.ok(calibration.variance.rho >= -0.99 && calibration.variance.rho <= 0.99);
  assert.ok(calibration.sensitivity.every((row, index, rows) =>
    index === 0 || row.jumps <= rows[index - 1].jumps));
  assert.ok(calibration.sensitivity.every((row) =>
    row.kappa > 0 && row.longRunVol > 0));
  assert.ok(resolveVarianceAt(calibration, startTs + 100 * 86_400) > 0);
});

test("Bates path budget matches ATM IV squared times T without double counting", () => {
  const calibration = calibrateBatesModel({ rows: buildHistory(), jumpThreshold: 4 });
  const cycle = buildCycle();
  const budget = buildQuadraticVariationBudget({ cycle, calibration });
  assert.ok(Math.abs(budget.expectedTotalQv - budget.targetQv) < 1e-12);
  assert.ok(budget.expectedJumpQv >= 0);
  assert.ok(budget.expectedDiffusiveQv > 0);
  assert.ok(budget.diffusiveVarianceScale > 0);

  const uniformRandom = createSeededRandom(42);
  let spare = null;
  const normalRandom = () => {
    if (spare != null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, uniformRandom())));
    const angle = 2 * Math.PI * uniformRandom();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  const path = generateBatesPath({
    cycle,
    calibration,
    budget,
    normalRandom,
    uniformRandom,
  });
  assert.equal(path.length, 7 * 24);
  assert.equal(path.at(-1).ts, cycle.exitTs);
  assert.ok(path.every((point) =>
    point.spot > 0 && point.variance >= 0 && Number.isInteger(point.jumpCount)));
});
