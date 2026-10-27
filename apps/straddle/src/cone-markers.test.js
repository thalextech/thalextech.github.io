import test from "node:test";
import assert from "node:assert/strict";
import { coneExpiryMarkerLabel, coneMarkerLabel, coneMarkerOffsets } from "./cone-markers.js";
import { buildInitiallyHedgedThetaCone, buildThetaCone } from "./theta-cone.js";
import { calcOptionPrice } from "../../../lib/thalex.js";

const DAY = 86400;

test("ten-day cones show one, three and seven days, and long expiries use readable spacing", () => {
  assert.deepEqual(coneMarkerOffsets(10 * DAY), [DAY, 3 * DAY, 7 * DAY]);
  assert.deepEqual(coneMarkerOffsets(241 * DAY), [30 * DAY, 90 * DAY, 180 * DAY]);
  assert.equal(coneMarkerLabel(DAY), "+1d");
  assert.equal(coneMarkerLabel(6 * 3600), "+6h");
  assert.equal(coneMarkerLabel(15 * 60), "+15m");
  assert.equal(coneExpiryMarkerLabel(2.875 * DAY), "+2.9d");
  assert.equal(coneExpiryMarkerLabel(10 * DAY), "+10d");
  assert.equal(coneExpiryMarkerLabel(12 * 3600), "+0.5d");
  assert.equal(coneExpiryMarkerLabel(3600), "+0.042d");
});

test("short cones have distinct markers before expiry", () => {
  for (const duration of [60, 3600, 1.5 * DAY, 10 * DAY]) {
    const offsets = coneMarkerOffsets(duration);
    assert.equal(new Set(offsets).size, offsets.length);
    assert.ok(offsets.every(offset => offset > 0 && offset < duration));
    assert.ok(offsets.length <= 3);
  }
  assert.deepEqual(coneMarkerOffsets(NaN), []);
});

for (const build of [buildThetaCone, buildInitiallyHedgedThetaCone]) {
  test(`${build.name}: holding-period markers are solved exactly, preserving the original cone samples`, () => {
    const entryTs = 1793000000;
    const inputs = { spot: 80000, strike: 80000, premium: 4000, entryTs, expiryTs: entryTs + 10 * DAY };
    const original = build(inputs);
    const marked = build({ ...inputs, holdingPeriods: [...coneMarkerOffsets(10 * DAY), NaN, -1, 20 * DAY] });
    for (const point of original.points) {
      assert.deepEqual(marked.points.find(candidate => candidate.date.getTime() === point.date.getTime()), point);
    }
    for (const seconds of coneMarkerOffsets(10 * DAY)) {
      const point = marked.points.find(candidate => candidate.date.getTime() === (entryTs + seconds) * 1000);
      assert.ok(point);
      for (const spot of [point.low, point.high]) {
        const remaining = 10 * DAY - seconds;
        const value = calcOptionPrice(spot, inputs.strike, remaining, marked.iv, "call")
          + calcOptionPrice(spot, inputs.strike, remaining, marked.iv, "put");
        const pnl = value - inputs.premium - marked.hedgeDelta * (spot - inputs.spot);
        assert.ok(Math.abs(pnl) < 1e-6);
      }
    }
    assert.equal(marked.points.at(-1).date.getTime(), inputs.expiryTs * 1000);
  });
}
