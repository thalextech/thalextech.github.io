import fs from "node:fs/promises";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

const SOURCE_DATA_DIR = path.resolve("data/thalex");
const RUNTIME_DATA_DIR = path.resolve("public/data/thalex");
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const preparedFilename = (hour) =>
  `prepared_1h_h${String(hour).padStart(2, "0")}utc.json`;

const asNumber = (value) => {
  if (typeof value === "bigint") return Number(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
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
for (const filename of indexFiles) {
  console.log(`[index] ${filename}`);
  const rows = await readParquet(filename, ["ts", "index_price_open"]);
  for (const row of rows) {
    const ts = asNumber(row.ts);
    const price = asNumber(row.index_price_open);
    if (Number.isFinite(ts) && Number.isFinite(price)) {
      indexByHour.get(new Date(ts * 1000).getUTCHours())?.push([ts, price]);
    }
  }
}

const marksByHour = new Map(hours.map((hour) => [hour, []]));
for (const filename of markFiles) {
  console.log(`[marks] ${filename}`);
  const rows = await readParquet(filename, [
    "ts",
    "instrument_name",
    "mark_price_open",
    "iv_open",
  ]);
  for (const row of rows) {
    const ts = asNumber(row.ts);
    const instrument = String(row.instrument_name || "");
    const mark = asNumber(row.mark_price_open);
    const iv = asNumber(row.iv_open);
    if (
      Number.isFinite(ts) &&
      instrument &&
      Number.isFinite(mark) &&
      Number.isFinite(iv)
    ) {
      marksByHour
        .get(new Date(ts * 1000).getUTCHours())
        ?.push([ts, instrument, mark, iv]);
    }
  }
}

for (const hour of hours) {
  const index = indexByHour.get(hour);
  const marks = marksByHour.get(hour);
  index.sort((a, b) => a[0] - b[0]);
  marks.sort((a, b) =>
    a[1] === b[1] ? a[0] - b[0] : a[1].localeCompare(b[1]),
  );
  for (let index = 1; index < marks.length; index += 1) {
    const previous = marks[index - 1];
    const current = marks[index];
    if (previous[0] === current[0] && previous[1] === current[1]) {
      throw new Error(
        `Duplicate mark for ${current[1]} at ${current[0]} in hour ${hour}`,
      );
    }
  }

  const payload = {
    underlying: "BTC",
    resolution: "1h",
    hourlyOffset: hour,
    index,
    marks,
  };
  const outPath = path.join(RUNTIME_DATA_DIR, preparedFilename(hour));
  await fs.writeFile(outPath, JSON.stringify(payload));
  console.log(
    `wrote ${outPath}: ${index.length.toLocaleString()} index rows, ${marks.length.toLocaleString()} mark rows`,
  );
}
