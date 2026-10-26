#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prepareBacktestData, runWeeklyStraddleBacktest, requiredQuoteDteDays } from "../src/lib/weeklyStraddleBacktest.js";
import { BACKTEST_CONFIG_SCHEMA, BacktestInputError, parseBacktestConfig, hoursForConfig, buildBacktestReport } from "../src/lib/backtestContract.js";
import { loadDataForHours } from "./backtestData.mjs";

export { hoursForConfig, loadDataForHours, buildBacktestReport };

/** Existing JS envelope is preserved; data provenance and batch counts are additive. */
export async function runBacktest(overrides = {}) {
  return (await runBacktestBatch([overrides]))[0];
}

export async function runBacktestBatch(configList = []) {
  if (!Array.isArray(configList)) throw new BacktestInputError("Batch configs must be an array");
  const now = new Date();
  const configs = configList.map(config => parseBacktestConfig(config, now));
  const groups = new Map();
  configs.forEach((config, index) => {
    // Sharing an exact loading window avoids first-config truncation and keeps
    // sampled paths identical to standalone execution, including holding gaps.
    const key = JSON.stringify([config.underlying, config.start, config.end, hoursForConfig(config), requiredQuoteDteDays(config)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ config, index });
  });
  const outputs = new Array(configs.length);
  for (const group of groups.values()) {
    const reference = group[0].config;
    const loaded = await loadDataForHours(hoursForConfig(reference), reference.start, reference.end, requiredQuoteDteDays(reference), reference.underlying);
    const preparedData = prepareBacktestData({ ...loaded, config: reference });
    for (const { config, index } of group) {
      const result = runWeeklyStraddleBacktest({ preparedData, config });
      outputs[index] = { config, result, summary: result.summary, cycles: result.cycleSummary, counts: result.counts, data: loaded.data };
    }
  }
  return outputs;
}

const dashed = key => key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
const CONFIG_FLAGS = Object.fromEntries(Object.keys(BACKTEST_CONFIG_SCHEMA.properties).map(key => [dashed(key), key]));
const ALIASES = { "entry-hour": "entryHourUtc", "exit-hour": "exitHourUtc", weekday: "entryWeekday", long: "longOption", targetDteDays: "targetDteDays" };
const CLI_OPTIONS = {
  ...Object.fromEntries([...Object.keys(CONFIG_FLAGS), ...Object.keys(ALIASES), "hedge", "maturity", "config", "output", "sweep"].map(key => [key, { type: "string" }])),
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const SWEEPS = ["entry_hour", "entry_weekday", "hedge_frequency", "hedge_tolerance"];
const invalid = message => { throw new BacktestInputError(message); };

export function parseCliArgs(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false })); }
  catch (error) { invalid(error.message); }
  const overrides = {};
  const assign = (key, value) => {
    if (Object.hasOwn(overrides, key) && overrides[key] !== value) invalid(`Conflicting options for ${key}`);
    overrides[key] = value;
  };
  for (const [flag, raw] of Object.entries(values)) {
    const key = CONFIG_FLAGS[flag] ?? ALIASES[flag];
    if (!key) continue;
    const rule = BACKTEST_CONFIG_SCHEMA.properties[key];
    let value = raw;
    if (rule.type === "boolean") {
      if (!["true", "false"].includes(raw)) invalid(`--${flag} requires true or false`);
      value = raw === "true";
    } else if (["number", "integer"].includes(rule.type)) {
      if (!raw.trim()) invalid(`--${flag} requires a number`);
      value = Number(raw);
    }
    assign(key, value);
  }
  if (values.hedge != null) {
    if (!["false", "0"].includes(values.hedge) && !/^(?:[1-9]|1[0-9]|2[0-4])$/.test(values.hedge)) invalid("--hedge requires false, 0, or an integer from 1 to 24");
    const interval = Number(values.hedge);
    assign("hedgeEnabled", interval > 0);
    if (interval > 0) assign("hedgeIntervalHours", interval);
  }
  if (values.maturity != null) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(values.maturity);
    if (!match) invalid("--maturity requires days (30) or a calendar pair (7-30)");
    assign("targetDteDays", Number(match[1]));
    if (match[2]) assign("farTargetDteDays", Number(match[2]));
  }
  if (values.sweep && !SWEEPS.includes(values.sweep)) invalid(`Unsupported sweep: ${values.sweep}; choose ${SWEEPS.join(", ")}`);
  if (values.config === "" || values.output === "") invalid("File paths must not be empty");
  return { ...values, overrides };
}

function sweepConfigs(dimension, base) {
  switch (dimension) {
    case "entry_hour": return Array.from({ length: 24 }, (_, hour) => ({ ...base, entryHourUtc: hour, hourlyOffset: hour }));
    case "entry_weekday": return Array.from({ length: 7 }, (_, entryWeekday) => ({ ...base, entryWeekday }));
    case "hedge_frequency": return [1, 2, 3, 4, 6, 8, 12, 24].map(hedgeIntervalHours => ({ ...base, hedgeEnabled: true, hedgeMode: "time", hedgeIntervalHours }));
    case "hedge_tolerance": return [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2].map(hedgeDeltaTolerance => ({ ...base, hedgeEnabled: true, hedgeMode: "tolerance", hedgeDeltaTolerance }));
  }
}

function printHelp() {
  console.log(`Thalex Backtest Runner

From apps/backtest:
  node scripts/run-backtest.mjs [options]
  node scripts/run-backtest.mjs --config config.json --json --output result.json

Machine output:
  --json                     JSON only on stdout; errors on stderr
  --config config.json       One config object; explicit flags override its fields
  --output result.json       Write the full versioned JSON report (also works without --json)

Strategy (all canonical config fields also have kebab-case flags):
  --underlying BTC           BTC | ETH
  --start 2025-06-01          UTC date or ISO UTC timestamp
  --end 2025-07-01            Inclusive; date-only means midnight, not end of day
  --entry-hour 8 --weekday 5  UTC; weekday -1 means every day, 0=Sun ... 6=Sat
  --structure straddle       See schema/backtest-config.schema.json for structures
  --maturity 7               UI presets: 1, 2, 7, 14, 30, 60, 90, 180
  --maturity 7-30            With --structure calendar_spread
  --target-delta 0.25 --wing-delta 0.1
  --hedge 24                 Hours, or 0/false to disable
  --hedge-mode time          time | tolerance; --hedge-delta-tolerance 0.05
  --exit-mode after_days     after_days | weekly_schedule | expiry
  --exit-hold-days 7         Or --exit-weekday 0 --exit-hour-utc 20
  --hold-to-expiry true      Alias for exit mode expiry
  --long false               Short options by default
  --sizing-mode notional     notional | btc (fixed underlying units, including ETH)
  --notional-usd 100000 --btc-quantity 1

Sweeps:
  --sweep ${SWEEPS.join(" | ")}

Booleans other than --json and --help require true/false values.
Defaults match the initial BTC UI strategy; end defaults to the current time.
Run npm run build:data first. See README.md and schema/ for the contract.`);
}

const format = value => Number.isFinite(value) ? value.toFixed(3) : "n/a";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function printText(report) {
  const config = report.config;
  console.log(`${config.underlying} ${config.longOption ? "long" : "short"} ${config.structure} ${config.targetDteDays}D | ${config.start} → ${config.end}`);
  console.log(`Entry: ${weekdays[config.entryWeekday] ?? "daily"} ${String(config.entryHourUtc).padStart(2, "0")}:00 UTC | Hedge: ${config.hedgeEnabled ? config.hedgeMode === "tolerance" ? `delta ±${config.hedgeDeltaTolerance}` : `${config.hedgeIntervalHours}h` : "off"} | Exit: ${config.exitMode}`);
  console.log(`Closed cycles: ${report.counts.closedCycles}`);
  for (const [label, key] of [["Final PnL (USD)", "finalEquityUsd"], ["Sharpe ratio", "sharpeRatio"], ["Max drawdown (USD)", "maxDrawdownUsd"], ["Option PnL (USD)", "cumulativeOptionPnlUsd"], ["Hedge PnL (USD)", "cumulativeHedgePnlUsd"], ["Mean entry IV (decimal)", "meanEntryImpliedVol"], ["Mean sampled RV (decimal)", "meanSampledRealizedVol"]]) {
    console.log(`${label}: ${format(report.summary[key])}`);
  }
  for (const warning of report.warnings) console.error(`Warning [${warning.code}]: ${warning.message}`);
}

function printSweep({ sweep, runs }) {
  const label = config => sweep === "entry_hour" ? `${String(config.entryHourUtc).padStart(2, "0")}:00`
    : sweep === "entry_weekday" ? weekdays[config.entryWeekday]
      : sweep === "hedge_tolerance" ? `±${config.hedgeDeltaTolerance}` : `hedge ${config.hedgeIntervalHours}h`;
  console.log(`Sweep: ${sweep}`);
  console.log("Label | PnL USD | Sharpe | Max DD USD | Closed cycles");
  for (const run of runs) console.log(`${label(run.config)} | ${format(run.summary.finalEquityUsd)} | ${format(run.summary.sharpeRatio)} | ${format(run.summary.maxDrawdownUsd)} | ${run.counts.closedCycles}`);
  for (const [title, key] of [["Best Sharpe", "sharpeRatio"], ["Best PnL", "finalEquityUsd"]]) {
    const best = runs.filter(run => Number.isFinite(run.summary[key])).reduce((best, run) => !best || run.summary[key] > best.summary[key] ? run : best, null);
    console.log(`${title}: ${best ? `${label(best.config)} (${format(best.summary[key])})` : "n/a"}`);
  }
  for (const run of runs) for (const warning of run.warnings) console.error(`Warning [${label(run.config)} / ${warning.code}]: ${warning.message}`);
}

function writeReport(filename, json) {
  const destination = path.resolve(filename);
  const temporary = `${destination}.${process.pid}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(temporary, json, { flag: "wx" });
    created = true;
    fs.renameSync(temporary, destination);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function main(argv) {
  const machineErrors = argv.includes("--json") || argv.some(arg => arg === "--output" || arg.startsWith("--output="));
  try {
    const args = parseCliArgs(argv);
    if (args.help) { printHelp(); return; }
    if (args.config && args.output && path.resolve(args.config) === path.resolve(args.output)) invalid("Config and output paths must differ");
    let fromFile = {};
    if (args.config) {
      try { fromFile = JSON.parse(fs.readFileSync(args.config, "utf8")); }
      catch (error) { invalid(`Unable to read config: ${error.message}`); }
      // Validate file keys/types before merging; arrays and typos must not disappear.
      parseBacktestConfig(fromFile);
    }
    const overrides = { ...fromFile, ...args.overrides };
    // Sync legacy aliases when a canonical flag overrides a full effective config.
    if (Object.hasOwn(args.overrides, "entryHourUtc") && !Object.hasOwn(args.overrides, "hourlyOffset")) overrides.hourlyOffset = args.overrides.entryHourUtc;
    if (Object.hasOwn(args.overrides, "hourlyOffset") && !Object.hasOwn(args.overrides, "entryHourUtc")) overrides.entryHourUtc = args.overrides.hourlyOffset;
    if (Object.hasOwn(args.overrides, "exitMode") && !Object.hasOwn(args.overrides, "holdToExpiry")) overrides.holdToExpiry = args.overrides.exitMode === "expiry";
    if (Object.hasOwn(args.overrides, "holdToExpiry") && !Object.hasOwn(args.overrides, "exitMode")) overrides.exitMode = args.overrides.holdToExpiry ? "expiry" : "after_days";
    const outputs = args.sweep ? await runBacktestBatch(sweepConfigs(args.sweep, overrides)) : [await runBacktest(overrides)];
    const reports = outputs.map(buildBacktestReport);
    const report = args.sweep ? { schemaVersion: 1, sweep: args.sweep, runs: reports } : reports[0];
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) writeReport(args.output, json);
    if (args.json) process.stdout.write(json);
    else if (args.sweep) printSweep(report);
    else printText(report);
  } catch (error) {
    const code = error.code === "INVALID_INPUT" || error instanceof RangeError ? "INVALID_INPUT" : error.code === "DATA_UNAVAILABLE" ? error.code : "BACKTEST_FAILED";
    if (machineErrors) console.error(JSON.stringify({ schemaVersion: 1, error: { code, message: error.message } }));
    else console.error(`Backtest failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
