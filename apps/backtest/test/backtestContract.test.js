import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BACKTEST_CONFIG_SCHEMA, parseBacktestConfig, hoursForConfig, buildBacktestReport } from "../src/lib/backtestContract.js";
import { MATURITY_OPTIONS, CALENDAR_MATURITY_OPTIONS, maturityConfigOverrides } from "../src/lib/backtestMaturities.js";

const fixedNow = new Date("2026-10-25T12:00:00Z");
test("external config dates round-trip and default end is resolved per call", () => {
  const config = parseBacktestConfig({ start: "2025-06-01", end: "2025-07-01T08:30:00.12Z", hourlyOffset: 12 });
  assert.equal(config.start.toISOString(), "2025-06-01T00:00:00.000Z");
  assert.equal(config.end.toISOString(), "2025-07-01T08:30:00.120Z");
  assert.equal(config.entryHourUtc, 12);
  assert.deepEqual(parseBacktestConfig(JSON.parse(JSON.stringify(config))), config);
  assert.equal(parseBacktestConfig({}, fixedNow).end.toISOString(), fixedNow.toISOString());
});

test("CLI presets use the same maturity windows as the UI", () => {
  for (const preset of [...MATURITY_OPTIONS, ...CALENDAR_MATURITY_OPTIONS]) {
    const expected = maturityConfigOverrides(preset);
    const config = parseBacktestConfig({
      structure: preset.farDays ? "calendar_spread" : "straddle",
      targetDteDays: expected.targetDteDays,
      ...(preset.farDays ? { farTargetDteDays: preset.farDays } : {}),
    });
    assert.equal(config.minWeeklyDteDays, expected.minWeeklyDteDays);
    assert.equal(config.maxWeeklyDteDays, expected.maxWeeklyDteDays);
  }
  const custom = parseBacktestConfig({ targetDteDays: 21, minWeeklyDteDays: 15, maxWeeklyDteDays: 25 });
  assert.equal(custom.targetDteDays, 21);
});

test("invalid external input is rejected instead of silently normalized", () => {
  for (const input of [null, [], { typo: 7 }, { toString: 1 }, { start: "2025-02-30" }, { end: "2025-01-01T24:00:00Z" },
    { start: "2025-01-01T08:00:00" }, { start: "2025-06-01", end: "2025-05-01" },
    { entryHourUtc: 24 }, { entryHourUtc: 8.5 }, { hedgeIntervalHours: 0 }, { hedgeDeltaTolerance: NaN },
    { longOption: "false" }, { hedgeEnabled: 0 }, { notionalUsd: -1 }, { underlying: "DOGE" },
    { structure: "unknown" }, { exitMode: "unknown" }, { sizingMode: "unknown" }, { targetDelta: 0.9 },
    { targetDteDays: 21 }, { targetDteDays: 7, minWeeklyDteDays: 10 },
    { structure: "calendar_spread", targetDteDays: 7, farTargetDteDays: 2, minWeeklyDteDays: 4, maxWeeklyDteDays: 10 },
    { entryHourUtc: 8, hourlyOffset: 9 }, { exitMode: "expiry", holdToExpiry: false },
    { structure: "call_spread", targetDelta: 0.1, wingDelta: 0.25 },
  ]) assert.throws(() => parseBacktestConfig(input), undefined, JSON.stringify(input));
});

test("effective config records fixed holding overrides and required quote hours", () => {
  const holding = parseBacktestConfig({ structure: "covered_call", longOption: true, btcQuantity: 5 });
  assert.equal(holding.btcQuantity, 1);
  assert.equal(holding.hedgeEnabled, false);
  assert.equal(holding.longOption, false);
  assert.equal(hoursForConfig(holding).length, 24);
  assert.deepEqual(hoursForConfig(parseBacktestConfig({ entryHourUtc: 9, hedgeIntervalHours: 8 })), [0, 1, 8, 9, 16, 17]);
  assert.equal(hoursForConfig(parseBacktestConfig({ hedgeMode: "tolerance" })).length, 24);
});

test("empty reports expose unavailable numbers as null and do not mutate engine data", () => {
  const result = { summary: { finalEquityUsd: NaN, sharpeRatio: Infinity }, cycleSummary: [], counts: { closedCycles: 0 } };
  const report = buildBacktestReport({ config: parseBacktestConfig({}, fixedNow), result, data: {} });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.finalEquityUsd, null);
  assert.equal(report.summary.sharpeRatio, null);
  assert.equal(report.summary.maxDrawdownUsd, null);
  assert.equal(report.warnings[0].code, "NO_CLOSED_CYCLES");
  assert.ok(Number.isNaN(result.summary.finalEquityUsd));
});

test("published config schema stays synchronized with runtime input validation", () => {
  const published = JSON.parse(fs.readFileSync(new URL("../schema/backtest-config.schema.json", import.meta.url)));
  assert.deepEqual(published, BACKTEST_CONFIG_SCHEMA);
});
