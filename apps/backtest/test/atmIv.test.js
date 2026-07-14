import assert from "node:assert/strict";
import test from "node:test";
import { interpolateAtmIv } from "../src/lib/atmIv.js";

const DAY = 86_400;

test("ATM IV interpolates across log strike and total variance maturity", () => {
  const ts = 1_700_000_000;
  const quotes = [
    { expirationTs: ts + 5 * DAY, strike: 90, iv: 0.4 },
    { expirationTs: ts + 5 * DAY, strike: 110, iv: 0.6 },
    { expirationTs: ts + 9 * DAY, strike: 90, iv: 0.6 },
    { expirationTs: ts + 9 * DAY, strike: 110, iv: 0.8 },
  ];
  const strikeWeight = -Math.log(0.9) / (Math.log(1.1) - Math.log(0.9));
  const iv5 = 0.4 + strikeWeight * 0.2;
  const iv9 = 0.6 + strikeWeight * 0.2;
  const expectedVariance = iv5 ** 2 * 5 + 0.5 * (iv9 ** 2 * 9 - iv5 ** 2 * 5);
  const result = interpolateAtmIv({ quotes, spot: 100, ts, targetDays: 7 });
  assert.ok(Math.abs(result - Math.sqrt(expectedVariance / 7)) < 1e-12);
});

test("ATM IV requires strikes and maturities bracketing the target", () => {
  const ts = 1_700_000_000;
  assert.equal(interpolateAtmIv({
    quotes: [
      { expirationTs: ts + 5 * DAY, strike: 110, iv: 0.5 },
      { expirationTs: ts + 9 * DAY, strike: 110, iv: 0.6 },
    ],
    spot: 100,
    ts,
    targetDays: 7,
  }), null);
});
