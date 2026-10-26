import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getUnderlying } from "../src/lib/underlyings.js";
import { decodeInstrumentDictionary, decodePreparedShard, selectDteBuckets } from "../src/lib/thalexParquet.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const iso = (ts) => Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;

/** Node filesystem adapter. No artifacts are read merely by importing it. */
export async function loadDataForHours(hours, start = null, end = null, maxDteDays = Infinity, underlying = "BTC") {
  if (!["BTC", "ETH"].includes(underlying)) throw new Error(`Unsupported underlying: ${underlying}`);
  const directory = path.join(PUBLIC_DIR, getUnderlying(underlying).dataRoot);
  const digest = createHash("sha256");
  const readArtifact = (filename) => {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(directory, filename));
    } catch (cause) {
      throw Object.assign(new Error(`Unable to read ${underlying}/${filename}; run npm run build:data in apps/backtest`, { cause }), { code: "DATA_UNAVAILABLE" });
    }
    digest.update(filename).update("\0").update(bytes).update("\0");
    return JSON.parse(bytes);
  };
  const manifest = readArtifact("prepared_manifest.json");
  if (manifest.underlying !== underlying) throw new Error(`Artifact underlying does not match ${underlying}`);
  const instruments = decodeInstrumentDictionary(manifest);
  const buckets = selectDteBuckets(manifest.dteBuckets.map(bucket => ({
    ...bucket, maxInclusive: bucket.maxInclusive ?? Infinity,
  })), maxDteDays);
  const hoursUtc = [...new Set(hours)].sort((a, b) => a - b);
  const indexRows = [];
  const quoteSnapshots = [];
  let availableStart = Infinity;
  let availableEnd = -Infinity;
  const startTs = start ? start.getTime() / 1000 : -Infinity;
  const endTs = end ? end.getTime() / 1000 : Infinity;
  for (const hour of hoursUtc) {
    for (const bucket of buckets) {
      const filename = `prepared_1h_h${String(hour).padStart(2, "0")}utc_dte${bucket.key}.json`;
      const payload = readArtifact(filename);
      for (const [ts] of payload.index || []) {
        availableStart = Math.min(availableStart, ts);
        availableEnd = Math.max(availableEnd, ts);
      }
      const decoded = decodePreparedShard({ payload, startTs, endTs });
      indexRows.push(...decoded.indexRows);
      quoteSnapshots.push(...decoded.quoteSnapshots);
    }
  }
  indexRows.sort((a, b) => a.ts - b.ts);
  quoteSnapshots.sort((a, b) => a[0] - b[0]);
  return {
    indexRows, quoteSnapshots, instruments,
    data: {
      underlying,
      artifactSchema: manifest.schema,
      artifactVersion: manifest.version,
      resolutionSeconds: manifest.resolutionSeconds,
      pricing: manifest.pricing,
      sha256: digest.digest("hex"),
      availableStart: iso(availableStart),
      availableEnd: iso(availableEnd),
      loadedStart: iso(indexRows[0]?.ts),
      loadedEnd: iso(indexRows.at(-1)?.ts),
      hoursUtc,
      dteBuckets: buckets.map(bucket => bucket.key),
    },
  };
}
