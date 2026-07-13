import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeInstrumentDictionary,
  decodePreparedShard,
  THALEX_ARTIFACT_VERSION,
} from "../src/lib/thalexParquet.js";
import { PRECOMPUTED_DELTA_SCALE } from "../src/lib/optionRisk.js";

const manifest = {
  schema: "thalex-option-backtest",
  version: THALEX_ARTIFACT_VERSION,
  pricing: {
    daysPerYear: 365,
    deltaScale: PRECOMPUTED_DELTA_SCALE,
  },
  instruments: [
    ["BTC-13JUN25-100000-C", 1_749_808_800, 100_000, 1],
    ["BTC-13JUN25-100000-P", 1_749_808_800, 100_000, -1],
  ],
};

test("schema-v2 dictionary decodes numeric metadata once", () => {
  const instruments = decodeInstrumentDictionary(manifest);

  assert.deepEqual(instruments[0], {
    instrumentId: 0,
    name: "BTC-13JUN25-100000-C",
    expirationTs: 1_749_808_800,
    strike: 100_000,
    optionType: "C",
  });
  assert.equal(instruments[1].optionType, "P");
});

test("compact quote snapshots are filtered without per-quote expansion", () => {
  const payload = {
    schema: "thalex-option-backtest",
    version: THALEX_ARTIFACT_VERSION,
    hourlyOffset: 8,
    index: [[100, 99_000], [200, 100_000]],
    quotes: [
      [100, [[0, 4_000, 0.55, 0.51 * PRECOMPUTED_DELTA_SCALE]]],
      [200, [[1, 3_900, 0.56, -0.48 * PRECOMPUTED_DELTA_SCALE]]],
    ],
  };
  const decoded = decodePreparedShard({
    payload,
    startTs: 150,
    endTs: 250,
  });

  assert.deepEqual(decoded.indexRows, [{ ts: 200, indexPrice: 100_000 }]);
  assert.deepEqual(decoded.quoteSnapshots, [payload.quotes[1]]);
});

test("runtime rejects stale artifact versions", () => {
  assert.throws(
    () => decodeInstrumentDictionary({ ...manifest, version: 1 }),
    /rebuild data with schema version 2/,
  );
});
