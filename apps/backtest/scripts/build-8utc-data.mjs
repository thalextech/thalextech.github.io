import fs from "node:fs/promises";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import {
  blackScholesDelta,
  OPTION_PRICING_DAYS_PER_YEAR,
  PRECOMPUTED_DELTA_SCALE,
} from "../src/lib/optionRisk.js";
import { interpolateAtmIv } from "../src/lib/atmIv.js";

const ARTIFACT_VERSION = 2;
const ARTIFACT_SCHEMA = "thalex-option-backtest";
const SOURCE_DATA_DIR = path.resolve("data/thalex");
const RUNTIME_DATA_DIR = path.resolve("public/data/thalex");
const MANIFEST_FILENAME = "prepared_manifest.json";
const IV_RV_FILENAME = "prepared_iv_rv_1h.json";
const IV_RV_TENORS = [7, 14, 30];
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const preparedFilename = (hour) =>
  `prepared_1h_h${String(hour).padStart(2, "0")}utc.json`;

const MONTHS = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

const asNumber = (value) => {
  if (typeof value === "bigint") return Number(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

const parseInstrument = (name) => {
  const match = /^([^-]+)-(\d{2}[A-Z]{3}\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(name);
  if (!match) return null;
  const [, underlying, expiryToken, strikeRaw, optionType] = match;
  const day = Number(expiryToken.slice(0, 2));
  const month = MONTHS[expiryToken.slice(2, 5)];
  const year = 2000 + Number(expiryToken.slice(5));
  const strike = Number(strikeRaw);
  if (
    underlying !== "BTC" ||
    !Number.isInteger(day) ||
    month == null ||
    !Number.isInteger(year) ||
    !Number.isFinite(strike)
  ) {
    return null;
  }
  return {
    name,
    expirationTs: Date.UTC(year, month, day, 8, 0, 0) / 1000,
    strike,
    optionType,
  };
};

const readParquet = async (filename, columns) => {
  const file = await asyncBufferFromFile(path.join(SOURCE_DATA_DIR, filename));
  return parquetReadObjects({ file, columns });
};

const filenames = (await fs.readdir(SOURCE_DATA_DIR)).filter((name) =>
  name.endsWith(".parquet"),
);
const indexFiles = filenames
  .filter((name) => /^BTCUSD_index_1h_\d{6}\.parquet$/.test(name))
  .sort();
const markFiles = filenames
  .filter((name) => /^OBTCUSD_marks_1h_\d{6}\.parquet$/.test(name))
  .sort();

if (!indexFiles.length || !markFiles.length) {
  throw new Error(`No source Parquet history found in ${SOURCE_DATA_DIR}`);
}

await fs.mkdir(RUNTIME_DATA_DIR, { recursive: true });

const indexByHour = new Map(hours.map((hour) => [hour, []]));
const indexOhlcByTs = new Map();
for (const filename of indexFiles) {
  console.log(`[index] ${filename}`);
  const rows = await readParquet(filename, [
    "ts",
    "index_price_open",
    "index_price_high",
    "index_price_low",
    "index_price_close",
  ]);
  for (const row of rows) {
    const ts = asNumber(row.ts);
    const open = asNumber(row.index_price_open);
    const high = asNumber(row.index_price_high);
    const low = asNumber(row.index_price_low);
    const close = asNumber(row.index_price_close);
    if ([ts, open, high, low, close].every(Number.isFinite)) {
      indexByHour.get(new Date(ts * 1000).getUTCHours())?.push([ts, open]);
      indexOhlcByTs.set(ts, { ts, open, high, low, close });
    }
  }
}

const indexPriceByTs = new Map();
for (const hour of hours) {
  const index = indexByHour.get(hour);
  index.sort((a, b) => a[0] - b[0]);
  for (let rowIndex = 0; rowIndex < index.length; rowIndex += 1) {
    const current = index[rowIndex];
    if (rowIndex > 0 && index[rowIndex - 1][0] === current[0]) {
      throw new Error(`Duplicate index row at ${current[0]} in hour ${hour}`);
    }
    indexPriceByTs.set(current[0], current[1]);
  }
}

const instrumentByName = new Map();
const quoteRowsByHour = new Map(hours.map((hour) => [hour, []]));
let skippedInvalidQuotes = 0;
for (const filename of markFiles) {
  console.log(`[marks] ${filename}`);
  const rows = await readParquet(filename, [
    "ts",
    "instrument_name",
    "mark_price_open",
    "iv_open",
    "iv_close",
  ]);
  for (const row of rows) {
    const ts = asNumber(row.ts);
    const instrumentName = String(row.instrument_name || "");
    const markPrice = asNumber(row.mark_price_open);
    const iv = asNumber(row.iv_open);
    const ivClose = asNumber(row.iv_close);
    if (
      !Number.isFinite(ts) ||
      !instrumentName ||
      !Number.isFinite(markPrice) ||
      !Number.isFinite(iv)
    ) {
      skippedInvalidQuotes += 1;
      continue;
    }

    const instrument = instrumentByName.get(instrumentName) || parseInstrument(instrumentName);
    const indexPrice = indexPriceByTs.get(ts);
    if (!instrument || !Number.isFinite(indexPrice) || instrument.expirationTs <= ts) {
      skippedInvalidQuotes += 1;
      continue;
    }
    const delta = blackScholesDelta({
      spot: indexPrice,
      strike: instrument.strike,
      yearsToExpiry:
        (instrument.expirationTs - ts) /
        (OPTION_PRICING_DAYS_PER_YEAR * 86_400),
      impliedVol: iv,
      optionType: instrument.optionType,
    });
    if (!Number.isFinite(delta)) {
      skippedInvalidQuotes += 1;
      continue;
    }

    instrumentByName.set(instrumentName, instrument);
    const deltaScaled = Math.round(delta * PRECOMPUTED_DELTA_SCALE);
    quoteRowsByHour
      .get(new Date(ts * 1000).getUTCHours())
      ?.push([ts, instrumentName, markPrice, iv, deltaScaled, ivClose]);
  }
}

const instruments = [...instrumentByName.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
const instrumentIdByName = new Map(
  instruments.map((instrument, instrumentId) => [instrument.name, instrumentId]),
);

const interpolatedAtmIv = (quotes, spot, ts, targetDays) => {
  const surfaceQuotes = [];
  for (const [, instrumentName, , ivOpen, , ivClose] of quotes || []) {
    const instrument = instrumentByName.get(instrumentName);
    if (!instrument || instrument.expirationTs <= ts) continue;
    surfaceQuotes.push({
      expirationTs: instrument.expirationTs,
      strike: instrument.strike,
      iv: Number.isFinite(ivClose) ? ivClose : ivOpen,
    });
  }
  return interpolateAtmIv({ quotes: surfaceQuotes, spot, ts, targetDays });
};

const quotesByTs = new Map();
for (const hourlyRows of quoteRowsByHour.values()) {
  for (const quote of hourlyRows) {
    const ts = quote[0];
    if (!quotesByTs.has(ts)) quotesByTs.set(ts, []);
    quotesByTs.get(ts).push(quote);
  }
}
const ivRvRows = [...indexOhlcByTs.values()]
  .sort((a, b) => a.ts - b.ts)
  .map((row) => [
    row.ts,
    row.open,
    row.high,
    row.low,
    row.close,
    ...IV_RV_TENORS.map((tenor) => interpolatedAtmIv(quotesByTs.get(row.ts), row.open, row.ts, tenor)),
  ]);
await fs.writeFile(
  path.join(RUNTIME_DATA_DIR, IV_RV_FILENAME),
  JSON.stringify({
    schema: "thalex-iv-rv",
    version: 1,
    resolutionSeconds: 3_600,
    tenors: IV_RV_TENORS,
    ivInterpolation: {
      strike: "linear-log-moneyness",
      maturity: "linear-total-variance",
      requiresBracketingNodes: true,
    },
    fields: ["ts", "open", "high", "low", "close", ...IV_RV_TENORS.map((tenor) => `iv${tenor}`)],
    rows: ivRvRows,
  }),
);
console.log(`wrote ${ivRvRows.length.toLocaleString()} hourly IV/RV source rows`);

const manifest = {
  schema: ARTIFACT_SCHEMA,
  version: ARTIFACT_VERSION,
  underlying: "BTC",
  resolutionSeconds: 3_600,
  pricing: {
    model: "black-scholes-zero-rate",
    daysPerYear: OPTION_PRICING_DAYS_PER_YEAR,
    deltaScale: PRECOMPUTED_DELTA_SCALE,
  },
  instrumentFields: ["name", "expirationTs", "strike", "optionTypeCode"],
  instruments: instruments.map((instrument) => [
    instrument.name,
    instrument.expirationTs,
    instrument.strike,
    instrument.optionType === "C" ? 1 : -1,
  ]),
};
await fs.writeFile(
  path.join(RUNTIME_DATA_DIR, MANIFEST_FILENAME),
  JSON.stringify(manifest),
);

for (const hour of hours) {
  const index = indexByHour.get(hour);
  const flatQuotes = quoteRowsByHour.get(hour).map(
    ([ts, instrumentName, markPrice, iv, deltaScaled]) => [
      ts,
      instrumentIdByName.get(instrumentName),
      markPrice,
      iv,
      deltaScaled,
    ],
  );
  flatQuotes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let rowIndex = 0; rowIndex < flatQuotes.length; rowIndex += 1) {
    const current = flatQuotes[rowIndex];
    if (!Number.isInteger(current[1]) || !Number.isFinite(current[4])) {
      throw new Error(`Invalid compact quote in hour ${hour}`);
    }
    if (
      rowIndex > 0 &&
      flatQuotes[rowIndex - 1][0] === current[0] &&
      flatQuotes[rowIndex - 1][1] === current[1]
    ) {
      const instrumentName = instruments[current[1]]?.name || current[1];
      throw new Error(
        `Duplicate quote for ${instrumentName} at ${current[0]} in hour ${hour}`,
      );
    }
  }
  const quotes = [];
  for (const [ts, instrumentId, markPrice, iv, deltaScaled] of flatQuotes) {
    let snapshot = quotes.at(-1);
    if (!snapshot || snapshot[0] !== ts) {
      snapshot = [ts, []];
      quotes.push(snapshot);
    }
    snapshot[1].push([instrumentId, markPrice, iv, deltaScaled]);
  }

  const payload = {
    schema: ARTIFACT_SCHEMA,
    version: ARTIFACT_VERSION,
    hourlyOffset: hour,
    indexFields: ["ts", "indexPrice"],
    quoteFields: ["ts", "entries"],
    quoteEntryFields: ["instrumentId", "markPrice", "iv", "deltaScaled"],
    index,
    quotes,
  };
  const outPath = path.join(RUNTIME_DATA_DIR, preparedFilename(hour));
  await fs.writeFile(outPath, JSON.stringify(payload));
  console.log(
    `wrote ${outPath}: ${index.length.toLocaleString()} index rows, ${flatQuotes.length.toLocaleString()} quote rows`,
  );
}

console.log(
  `wrote ${instruments.length.toLocaleString()} instruments; skipped ${skippedInvalidQuotes.toLocaleString()} invalid quotes`,
);
