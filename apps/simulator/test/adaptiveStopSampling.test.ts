import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveStopSubsteps } from "../src/lib/adaptiveStopSampling.ts";

const HOUR_IN_YEARS = 1 / (365.25 * 24);

test("keeps one hourly step when spot is safely away from the stop", () => {
  assert.equal(
    adaptiveStopSubsteps(100, 0.3, HOUR_IN_YEARS, [90]),
    1,
  );
});

test("upsamples an hour to one-minute steps near an active stop", () => {
  assert.equal(
    adaptiveStopSubsteps(100, 0.3, HOUR_IN_YEARS, [99]),
    60,
  );
});

test("does not upsample when there is no active stop", () => {
  assert.equal(
    adaptiveStopSubsteps(100, 0.3, HOUR_IN_YEARS, []),
    1,
  );
});
