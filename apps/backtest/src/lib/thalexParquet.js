import {
  OPTION_PRICING_DAYS_PER_YEAR,
  PRECOMPUTED_DELTA_SCALE,
} from "./optionRisk.js";

export const THALEX_ARTIFACT_VERSION = 2;

const ARTIFACT_SCHEMA = "thalex-option-backtest";
const DEFAULT_DATA_ROOT = "data/thalex";
const MANIFEST_FILENAME = "prepared_manifest.json";
export const DEFAULT_SHARD_LOAD_CONCURRENCY = 4;
const preparedFilename = (hour) =>
  `prepared_1h_h${String(hour).padStart(2, "0")}utc.json`;
const manifestCache = new Map();

const asNumber = (value) => {
  if (typeof value === "bigint") return Number(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

const assertArtifactContract = (payload, filename) => {
  if (
    payload?.schema !== ARTIFACT_SCHEMA ||
    payload?.version !== THALEX_ARTIFACT_VERSION
  ) {
    throw new Error(
      `Unsupported Thalex artifact ${filename}; rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`,
    );
  }
};

const assertPricingContract = (manifest) => {
  if (
    Number(manifest.pricing?.daysPerYear) !== OPTION_PRICING_DAYS_PER_YEAR ||
    Number(manifest.pricing?.deltaScale) !== PRECOMPUTED_DELTA_SCALE
  ) {
    throw new Error(
      `Unsupported Thalex pricing metadata; rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`,
    );
  }
};

export const decodeInstrumentDictionary = (manifest) => {
  assertArtifactContract(manifest, MANIFEST_FILENAME);
  assertPricingContract(manifest);
  return (manifest.instruments || []).map(
    ([name, expirationTs, strike, optionTypeCode], instrumentId) => {
      const instrument = {
        instrumentId,
        name: String(name || ""),
        expirationTs: asNumber(expirationTs),
        strike: asNumber(strike),
        optionType: Number(optionTypeCode) === 1 ? "C" : "P",
      };
      if (
        !instrument.name ||
        !Number.isFinite(instrument.expirationTs) ||
        !Number.isFinite(instrument.strike) ||
        ![1, -1].includes(Number(optionTypeCode))
      ) {
        throw new Error(
          `Invalid instrument metadata at dictionary index ${instrumentId}`,
        );
      }
      return instrument;
    },
  );
};

export const decodePreparedShard = ({
  payload,
  startTs = Number.NEGATIVE_INFINITY,
  endTs = Number.POSITIVE_INFINITY,
}) => {
  assertArtifactContract(payload, `hour ${payload?.hourlyOffset ?? "?"}`);
  const indexRows = [];
  const quoteSnapshots = [];
  for (const [ts, price] of payload.index || []) {
    const timestamp = asNumber(ts);
    if (timestamp >= startTs && timestamp <= endTs) {
      indexRows.push({ ts: timestamp, indexPrice: asNumber(price) });
    }
  }
  for (const [ts, entries] of payload.quotes || []) {
    const timestamp = asNumber(ts);
    if (timestamp < startTs || timestamp > endTs) continue;
    quoteSnapshots.push([timestamp, entries]);
  }
  return { indexRows, quoteSnapshots };
};

const dataUrl = (dataRoot, filename) => {
  const baseUrl = import.meta.env?.BASE_URL || "/";
  return `${baseUrl}${dataRoot}/${filename}`;
};

const fetchJson = async (url, missingMessage) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(missingMessage);
  return response.json();
};

const loadManifest = (dataRoot) => {
  if (!manifestCache.has(dataRoot)) {
    manifestCache.set(
      dataRoot,
      fetchJson(
        dataUrl(dataRoot, MANIFEST_FILENAME),
        "Missing prepared data manifest",
      ).then((manifest) => ({
        manifest,
        instruments: decodeInstrumentDictionary(manifest),
      })),
    );
  }
  return manifestCache.get(dataRoot);
};

const mapWithConcurrency = async (items, requestedConcurrency, mapper) => {
  if (!items.length) return [];
  const concurrency = Math.max(
    1,
    Math.min(items.length, Math.floor(Number(requestedConcurrency)) || 1),
  );
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
};

export async function loadThalexHistory({
  start,
  end,
  hourlyOffset = 8,
  hourlyOffsets,
  dataRoot = DEFAULT_DATA_ROOT,
  onProgress,
  maxConcurrentShardLoads = DEFAULT_SHARD_LOAD_CONCURRENCY,
}) {
  const hours = [...new Set((hourlyOffsets || [hourlyOffset]).map(Number))]
    .sort((a, b) => a - b);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  const indexRows = [];
  const quoteSnapshots = [];
  const { manifest, instruments } = await loadManifest(dataRoot);

  let completedShards = 0;
  const decodedShards = await mapWithConcurrency(
    hours,
    maxConcurrentShardLoads,
    async (hour) => {
      const filename = preparedFilename(hour);
      const payload = await fetchJson(
        dataUrl(dataRoot, filename),
        `Missing prepared data for hour ${hour}`,
      );
      const decoded = decodePreparedShard({
        payload,
        startTs,
        endTs,
      });
      completedShards += 1;
      onProgress?.({
        phase: "prepared",
        current: completedShards,
        total: hours.length,
        file: `h${hour}`,
      });
      return decoded;
    },
  );

  for (const decoded of decodedShards) {
    indexRows.push(...decoded.indexRows);
    quoteSnapshots.push(...decoded.quoteSnapshots);
  }
  return {
    indexRows,
    quoteSnapshots,
    artifact: {
      version: manifest.version,
      pricing: manifest.pricing,
      instruments,
    },
  };
}
