import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyPnlRows } from "../src/lib/dailyPnl.js";

const ts = (iso) => Date.parse(iso) / 1_000;

test("hourly cumulative PnL becomes complete UTC daily bars", () => {
  const rows = buildDailyPnlRows({
    rows: [
      { ts: ts("2026-08-01T08:00:00Z"), cumulativeTotalPnlUsd: 100 },
      { ts: ts("2026-08-01T20:00:00Z"), cumulativeTotalPnlUsd: 70 },
      { ts: ts("2026-08-03T08:00:00Z"), cumulativeTotalPnlUsd: 120 },
    ],
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-03T23:59:59Z"),
  });

  assert.deepEqual(
    rows.map((row) => [row.dailyPnlUsd, row.endingEquityUsd]),
    [
      [70, 70],
      [0, 70],
      [50, 120],
    ],
  );
  assert.equal(rows[0].entryTime.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("daily PnL rejects an inverted requested range", () => {
  assert.deepEqual(
    buildDailyPnlRows({
      rows: [{ ts: ts("2026-08-01T08:00:00Z"), cumulativeTotalPnlUsd: 100 }],
      start: new Date("2026-08-02T00:00:00Z"),
      end: new Date("2026-08-01T00:00:00Z"),
    }),
    [],
  );
});
