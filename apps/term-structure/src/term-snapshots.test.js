import test from "node:test";
import assert from "node:assert/strict";
import { buildTermSnapshots, SNAPSHOT_RESOLUTIONS } from "./term-snapshots.js";

const HOUR = 3600;
const end = 500000 * HOUR;
const expiries = [end + 86400, end + 864000, end + 2592000];
const point = (ts, expiry, iv = 0.5) => ({ ts, expiry, iv });

for (const { value, count, step } of SNAPSHOT_RESOLUTIONS) {
  test(`${value} selects ${count} simultaneous curves exactly ${step / HOUR} hours apart`, () => {
    const history = Array.from({ length: 24 * 29 }, (_, hour) =>
      expiries.map(expiry => point(end - hour * HOUR, expiry)),
    ).flat();
    const result = buildTermSnapshots(history, expiries, end + 1200, value);
    assert.equal(result.length, count);
    assert.equal(result.at(-1).ts, end, "latest completed hour anchors the schedule");
    assert.equal(result[0].ts, end - (count - 1) * step);
    result.forEach((snapshot, i) => {
      if (i) assert.equal(snapshot.ts - result[i - 1].ts, step);
      assert.deepEqual(snapshot.points.map(p => p.expiry), expiries);
      assert.ok(snapshot.points.every(p => p.ts === snapshot.ts));
    });
  });
}

test("missing hours and maturities stay explicit without borrowing another close", () => {
  const history = [
    point(end, expiries[0]),
    point(end, expiries[2]),
    point(end - HOUR, expiries[1]),
    point(end - 900, expiries[1]),
    point(end + HOUR, expiries[1]),
    point(end, end + 999999),
    point(end, expiries[1], NaN),
  ];
  const result = buildTermSnapshots(history, expiries, end, "daily");
  assert.equal(result.length, 2);
  assert.deepEqual(result.at(-1).points.map(p => p?.expiry ?? null), [expiries[0], null, expiries[2]]);
  assert.deepEqual(result[0].points.map(p => p?.expiry ?? null), [null, expiries[1], null]);
  assert.deepEqual(buildTermSnapshots(history, expiries, null), []);
});

test("snapshot selection retains valid zero forward vol and never mutates the source", () => {
  const original = Object.freeze(point(end, expiries[0], 0));
  const history = Object.freeze([original]);
  const result = buildTermSnapshots(history, expiries, end);
  assert.equal(result[0].points[0], original);
  assert.equal(result[0].points[0].iv, 0);
  assert.throws(() => buildTermSnapshots(history, expiries, end, "invalid"), /Unknown snapshot resolution/);
});
