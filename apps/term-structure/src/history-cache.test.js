import test from "node:test";
import assert from "node:assert/strict";
import { missingHourRanges, loadHistoryCache } from "./history-cache.js";
test("missing ranges identify prefix, internal gaps and suffix without refetching cached hours", () => {
  const ranges = missingHourRanges(
    0,
    6 * 3600 - 1,
    new Map([
      [3600, 1],
      [3 * 3600, 1],
      [4 * 3600, 1],
    ]),
  );
  assert.deepEqual(ranges, [
    { from: 0, to: 3599 },
    { from: 7200, to: 10799 },
    { from: 18000, to: 21599 },
  ]);
  assert.deepEqual(
    missingHourRanges(0, 7199, new Map([[0, 1]]), [{ from: 3600, to: 7199 }]),
    [],
  );
});
test("Parquet-derived cache normalizes close-IV shards without any timestamp shift", async (t) => {
  const expiry = 2000000000;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("manifest.json")
        ? {
            schema: "thalex-term-history",
            version: 1,
            asset: "ETH",
            resolution: 3600,
            timestampBasis: "bar-start",
            ivBasis: "close",
            index: "index-abc.json",
            expiries: { [expiry]: "expiry-abc.json" },
          }
        : url.includes("index-")
          ? { rows: [[3600, 100, 102, 98, 101]] }
          : {
              expiry,
              instruments: [
                {
                  name: "ETH-TEST-C",
                  strike: 100,
                  side: "C",
                  rows: [[3600, 0.5]],
                },
              ],
            },
  }));
  const cache = await loadHistoryCache("ETH", [expiry]);
  assert.equal(cache.warning, "");
  assert.equal(cache.index.get(3600)[4], 101);
  assert.equal(cache.marks.get("ETH-TEST-C").rows.get(3600), 0.5);
});
test("missing cache is disclosed and leaves an API-fillable archive", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  const cache = await loadHistoryCache("BTC", []);
  assert.match(cache.warning, /missing history will be fetched/);
  assert.equal(cache.index.size, 0);
});
