import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { BACKTEST_CONFIG_SCHEMA, parseBacktestConfig } from "../src/lib/backtestContract.js";
import { loadThalexHistory } from "../src/lib/thalexParquet.js";
import { prepareBacktestData, runWeeklyStraddleBacktest, requiredQuoteDteDays } from "../src/lib/weeklyStraddleBacktest.js";

// Exercise the real filesystem adapter and CLI without generated market data,
// network access, or a data rebuild. Spaces also exercise executable URL handling.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backtest contract "));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
fs.mkdirSync(path.join(directory, "scripts"));
fs.mkdirSync(path.join(directory, "src"));
fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
fs.cpSync(new URL("../src/lib", import.meta.url), path.join(directory, "src/lib"), { recursive: true });
for (const name of ["run-backtest.mjs", "backtestData.mjs"]) fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(directory, "scripts", name));
const bucketBounds = [10, 28, 60];
const bucketKeys = ["000-010", "010-028", "028-plus"];
for (const underlying of ["BTC", "ETH"]) {
  const root = path.join(directory, "public/runtime-data/thalex", underlying === "ETH" ? "eth" : "");
  fs.mkdirSync(root, { recursive: true });
  const spot = underlying === "BTC" ? 100_000 : 2_000;
  const entries = [Date.UTC(2025, 5, 6, 8) / 1000, Date.UTC(2025, 7, 1, 8) / 1000];
  const expiries = entries.flatMap(ts => [ts + 7 * 86400, ts + 30 * 86400]);
  const manifest = {
    schema: "thalex-option-backtest", version: 4, underlying, resolutionSeconds: 3600,
    pricing: { model: "black-scholes-zero-rate", daysPerYear: 365, deltaScale: 100_000_000 },
    dteBuckets: bucketKeys.map((key, i) => ({ key, minExclusive: i ? bucketBounds[i - 1] : 0, maxInclusive: i === 2 ? null : bucketBounds[i] })),
    instruments: expiries.flatMap((expiry, i) => [1, -1].map(type => [`${underlying}-fixture-${i}-${type}`, expiry, spot, type])),
  };
  fs.writeFileSync(path.join(root, "prepared_manifest.json"), JSON.stringify(manifest));
  for (let hour = 0; hour < 24; hour++) {
    const index = [];
    const quotes = bucketKeys.map(() => []);
    for (const entry of entries) {
      for (let day = 0; day <= 31; day++) {
        const ts = entry - 8 * 3600 + day * 86400 + hour * 3600;
        const price = spot * (1 + day * 0.001);
        index.push([ts, price, price * 1.002, price * 0.998, price]);
        const byBucket = bucketKeys.map(() => []);
        manifest.instruments.forEach(([, expiry, , type], instrumentId) => {
          const dte = (expiry - ts) / 86400;
          if (dte <= 0) return;
          const bucket = bucketBounds.findIndex(bound => dte <= bound);
          if (bucket < 0) return;
          byBucket[bucket].push([instrumentId, spot * 0.0005 * dte, 0.6, type * 0.5 * 100_000_000]);
        });
        byBucket.forEach((rows, bucket) => { if (rows.length) quotes[bucket].push([ts, rows]); });
      }
    }
    bucketKeys.forEach((key, i) => fs.writeFileSync(path.join(root, `prepared_1h_h${String(hour).padStart(2, "0")}utc_dte${key}.json`), JSON.stringify({ schema: manifest.schema, version: 4, hourlyOffset: hour, index: i === 0 ? index : [], quotes: quotes[i] })));
  }
}
const runnerPath = path.join(directory, "scripts/run-backtest.mjs");
const runner = await import(pathToFileURL(runnerPath));
const run = args => spawnSync(process.execPath, [runnerPath, ...args], { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const june = { start: "2025-06-01", end: "2025-07-01" };
const august = { start: "2025-08-01", end: "2025-09-01" };

// Check the published schema's constraints against actual outputs. This helper
// implements only the keywords used here; it is not production input validation.
const resultSchema = JSON.parse(fs.readFileSync(new URL("../schema/backtest-result.schema.json", import.meta.url)));
function checkSchema(value, schema = resultSchema, root = resultSchema) {
  if (schema.$ref) return checkSchema(value, schema.$ref.split("/").slice(1).reduce((node, key) => node[key], root), root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => { try { checkSchema(value, option, root); return true; } catch { return false; } });
    assert.equal(matches.length, 1, `No unique schema for ${JSON.stringify(value).slice(0, 160)}`);
    return;
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.type) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok([schema.type].flat().some(t => t === type || (t === "integer" && Number.isInteger(value))), `Unexpected ${type}`);
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    if (schema.minimum != null) assert.ok(value >= schema.minimum);
    if (schema.maximum != null) assert.ok(value <= schema.maximum);
    if (schema.exclusiveMinimum != null) assert.ok(value > schema.exclusiveMinimum);
    if (schema.exclusiveMaximum != null) assert.ok(value < schema.exclusiveMaximum);
  }
  if (typeof value === "string") {
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
    if (schema.format === "date-time") assert.ok(Number.isFinite(Date.parse(value)));
  }
  if (schema.properties) {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `Missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `Undocumented ${key}`);
      if (schema.properties[key]) checkSchema(child, schema.properties[key], root);
    }
  }
  if (schema.items) value.forEach(child => checkSchema(child, schema.items, root));
  if (schema.uniqueItems) assert.equal(new Set(value).size, value.length);
}

test("standalone and mixed-date/mixed-underlying batch runs agree in either order", async () => {
  const configs = [june, august, { ...june, underlying: "ETH" }, { ...june, entryHourUtc: 9 }, { ...june, hedgeEnabled: false }];
  const singles = await Promise.all(configs.map(config => runner.runBacktest(config)));
  const batch = await runner.runBacktestBatch(configs);
  const reversed = await runner.runBacktestBatch([...configs].reverse());
  assert.ok(singles[1].counts.closedCycles > 0);
  assert.match(singles[2].cycles[0].legs[0].instrumentName, /^ETH-/);
  batch.forEach((output, i) => {
    assert.deepEqual(output, singles[i]);
    assert.deepEqual(reversed.at(-i - 1), singles[i]);
  });
});

test("browser and Node loaders produce the same backtest for identical effective configs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(directory, "public", url))) });
  try {
    for (const input of [june, { ...june, underlying: "ETH" }, { ...june, targetDteDays: 30, hedgeMode: "tolerance" }, { ...june, structure: "covered_call" }]) {
      const node = await runner.runBacktest(input);
      const config = parseBacktestConfig(input);
      const loaded = await loadThalexHistory({ start: config.start, end: config.end, hourlyOffsets: runner.hoursForConfig(config), maxDteDays: requiredQuoteDteDays(config), dataRoot: config.underlying === "ETH" ? "runtime-data/thalex/eth" : "runtime-data/thalex" });
      const preparedData = prepareBacktestData({ ...loaded, instruments: loaded.artifact.instruments, config });
      assert.deepEqual(runWeeklyStraddleBacktest({ preparedData, config }), node.result);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("CLI JSON and output file contain the same schema-valid report, with flags overriding config", () => {
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ ...june, underlying: "BTC", entryHourUtc: 9 }));
  const output = run(["--config", "config.json", "--underlying", "ETH", "--entry-hour", "8", "--json", "--output", "result.json"]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, "");
  assert.equal(output.stdout, fs.readFileSync(path.join(directory, "result.json"), "utf8"));
  const report = JSON.parse(output.stdout);
  checkSchema(report);
  assert.equal(report.config.entryHourUtc, 8);
  assert.equal(report.config.underlying, "ETH");
  assert.ok(report.counts.closedCycles > 0);
  assert.ok(report.summary.maxDrawdownUsd <= 0);
  assert.equal(report.result, undefined);
});

test("JSON sweeps use the same per-run contract and preserve input order", () => {
  const output = run(["--start", june.start, "--end", june.end, "--sweep", "entry_weekday", "--json"]);
  assert.equal(output.status, 0, output.stderr);
  const sweep = JSON.parse(output.stdout);
  checkSchema(sweep);
  assert.deepEqual(sweep.runs.map(report => report.config.entryWeekday), [0, 1, 2, 3, 4, 5, 6]);
});

test("custom maturity, calendar, holding, and tolerance reports match the published schema", async () => {
  for (const config of [
    { targetDteDays: 30 },
    { structure: "calendar_spread", farTargetDteDays: 30 },
    { structure: "covered_call", targetDelta: 0.5 },
    { hedgeMode: "tolerance", targetDteDays: 30 },
    { includeGreekAttribution: true },
  ]) {
    const output = await runner.runBacktest({ start: "2025-06-01", end: "2025-07-10", ...config });
    assert.ok(output.counts.closedCycles > 0, JSON.stringify(config));
    checkSchema(runner.buildBacktestReport(output));
  }
});

test("empty runs have null metrics and structured warnings; data hashes are reproducible", async () => {
  const config = { start: "2024-01-01", end: "2024-02-01" };
  const first = runner.buildBacktestReport(await runner.runBacktest(config));
  const second = runner.buildBacktestReport(await runner.runBacktest(config));
  checkSchema(first);
  assert.deepEqual(first, second);
  assert.equal(first.summary.finalEquityUsd, null);
  assert.equal(first.data.loadedEnd, null);
  assert.ok(first.warnings.some(w => w.code === "NO_CLOSED_CYCLES"));
});

test("bad CLI input gives a nonzero status, empty stdout, and structured stderr without replacing output", () => {
  fs.writeFileSync(path.join(directory, "keep.json"), "keep");
  fs.writeFileSync(path.join(directory, "array.json"), "[]");
  fs.writeFileSync(path.join(directory, "invalid.json"), "{");
  for (const args of [["--unknown", "1"], ["--start"], ["--long", "no"], ["--entry-hour", "24"], ["--entry-hour", "--weekday", "5"], ["--start", "2025-02-30"], ["--config", "array.json"], ["--config", "invalid.json"], ["--sweep", "maturity"]]) {
    const output = run([...args, "--json", "--output", "keep.json"]);
    assert.equal(output.status, 1, args.join(" "));
    assert.equal(output.stdout, "");
    const error = JSON.parse(output.stderr);
    checkSchema(error);
    assert.equal(error.error.code, "INVALID_INPUT");
    assert.equal(fs.readFileSync(path.join(directory, "keep.json"), "utf8"), "keep");
  }
});

test("help and imports work without runtime artifacts; runs report missing data", () => {
  const manifest = path.join(directory, "public/runtime-data/thalex/prepared_manifest.json");
  fs.renameSync(manifest, `${manifest}.saved`);
  try {
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(runnerPath).href)})`], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
    const failure = run(["--json"]);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.equal(JSON.parse(failure.stderr).error.code, "DATA_UNAVAILABLE");
  } finally { fs.renameSync(`${manifest}.saved`, manifest); }
});

test("--output alone writes JSON and keeps the text interface available", () => {
  const output = run(["--start", june.start, "--end", june.end, "--output", "text-result.json", "--hedge", "false", "--exit-hour", "20"]);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /Final PnL/);
  checkSchema(JSON.parse(fs.readFileSync(path.join(directory, "text-result.json"))));
});

test("effective config schema exposes the same fields as the input contract", () => {
  assert.deepEqual(Object.keys(resultSchema.$defs.config.properties).sort(), Object.keys(BACKTEST_CONFIG_SCHEMA.properties).sort());
});
