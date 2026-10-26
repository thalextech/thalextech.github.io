import { DEFAULT_BACKTEST_CONFIG, normalizeBacktestConfig, computeMaxDrawdown } from "./weeklyStraddleBacktest.js";
import { MATURITY_OPTIONS, CALENDAR_MATURITY_OPTIONS, maturityConfigOverrides } from "./backtestMaturities.js";
import { isUnderlyingHoldingStructure } from "./underlyingHolding.js";

const number = (exclusiveMinimum = 0) => ({ type: "number", exclusiveMinimum });
const integer = (minimum, maximum) => ({ type: "integer", minimum, ...(maximum == null ? {} : { maximum }) });
const choice = (...values) => ({ enum: values });
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z)?$" };

// This definition also generates schema/backtest-config.schema.json. Keep the
// external contract here; the engine's permissive normalizer serves UI callers.
export const BACKTEST_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Backtest config overrides (v1)",
  type: "object",
  additionalProperties: false,
  properties: {
    underlying: choice("BTC", "ETH"),
    start: date,
    end: date,
    entryHourUtc: integer(0, 23),
    hourlyOffset: integer(0, 23),
    entryWeekday: integer(-1, 6),
    hedgeEnabled: { type: "boolean" },
    hedgeIntervalHours: integer(1, 24),
    hedgeMode: choice("time", "tolerance"),
    hedgeDeltaTolerance: number(),
    exitMode: choice("after_days", "weekly_schedule", "expiry"),
    holdToExpiry: { type: "boolean" },
    exitHoldDays: integer(1),
    exitWeekday: integer(0, 6),
    exitHourUtc: integer(0, 23),
    longOption: { type: "boolean" },
    targetDteDays: number(),
    farTargetDteDays: number(),
    minWeeklyDteDays: number(),
    maxWeeklyDteDays: number(),
    notionalUsd: number(),
    sizingMode: choice("notional", "btc"),
    btcQuantity: number(),
    structure: choice("straddle", "strangle", "risk_reversal", "call", "put", "covered_call", "collar", "butterfly", "condor", "call_spread", "put_spread", "calendar_spread"),
    targetDelta: { ...number(), maximum: 0.5 },
    wingDelta: { ...number(), exclusiveMaximum: 0.5 },
    includeGreekAttribution: { type: "boolean" },
  },
};

export class BacktestInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "BacktestInputError";
    this.code = "INVALID_INPUT";
  }
}

const invalid = (message) => { throw new BacktestInputError(message); };

const parseDate = (value, key) => {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid(`${key} must be a valid date`);
    return new Date(value);
  }
  if (typeof value !== "string" || !new RegExp(date.pattern).test(value)) {
    invalid(`${key} must be YYYY-MM-DD or an ISO UTC timestamp ending in Z`);
  }
  const parsed = new Date(value);
  // Date.parse accepts dates such as February 30 by rolling into March.
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)
    || (value.length > 10 && parsed.toISOString().slice(11, 19) !== value.slice(11, 19))) {
    invalid(`${key} must be a valid date`);
  }
  return parsed;
};

/** Strict external input; engine callers can continue using normalizeBacktestConfig. */
export function parseBacktestConfig(input = {}, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Config must be a JSON object");
  const overrides = { ...input };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(BACKTEST_CONFIG_SCHEMA.properties, key)) invalid(`Unknown config field: ${key}`);
    const rule = BACKTEST_CONFIG_SCHEMA.properties[key];
    if (key === "start" || key === "end") {
      overrides[key] = parseDate(value, key);
      continue;
    }
    if (rule.enum && !rule.enum.includes(value)) invalid(`${key} must be one of: ${rule.enum.join(", ")}`);
    if (rule.type === "boolean" && typeof value !== "boolean") invalid(`${key} must be a boolean`);
    if (["number", "integer"].includes(rule.type)) {
      if (typeof value !== "number" || !Number.isFinite(value)
        || (rule.type === "integer" && !Number.isInteger(value))
        || (rule.minimum != null && value < rule.minimum)
        || (rule.maximum != null && value > rule.maximum)
        || (rule.exclusiveMinimum != null && value <= rule.exclusiveMinimum)
        || (rule.exclusiveMaximum != null && value >= rule.exclusiveMaximum)) {
        invalid(`Invalid ${key}: ${value}`);
      }
    }
  }
  if (overrides.entryHourUtc != null && overrides.hourlyOffset != null
    && overrides.entryHourUtc !== overrides.hourlyOffset) invalid("entryHourUtc and hourlyOffset must agree");
  if (overrides.exitMode != null && overrides.holdToExpiry != null
    && overrides.holdToExpiry !== (overrides.exitMode === "expiry")) invalid("exitMode and holdToExpiry must agree");

  const target = overrides.targetDteDays ?? DEFAULT_BACKTEST_CONFIG.targetDteDays;
  const structure = overrides.structure ?? DEFAULT_BACKTEST_CONFIG.structure;
  const far = overrides.farTargetDteDays ?? DEFAULT_BACKTEST_CONFIG.farTargetDteDays;
  const preset = structure === "calendar_spread"
    ? CALENDAR_MATURITY_OPTIONS.find(option => option.nearDays === target && option.farDays === far)
    : MATURITY_OPTIONS.find(option => option.value === target);
  if (!preset && (overrides.minWeeklyDteDays == null || overrides.maxWeeklyDteDays == null)) {
    invalid("Custom maturity requires minWeeklyDteDays and maxWeeklyDteDays");
  }
  const presetConfig = preset ? maturityConfigOverrides(preset) : {};
  // Non-calendar presets have no farDays; do not overwrite the engine default.
  if (presetConfig.farTargetDteDays == null) delete presetConfig.farTargetDteDays;
  const config = normalizeBacktestConfig({
    ...presetConfig,
    ...overrides,
    entryHourUtc: overrides.entryHourUtc ?? overrides.hourlyOffset ?? DEFAULT_BACKTEST_CONFIG.entryHourUtc,
    end: overrides.end ?? new Date(now),
  });
  config.underlying = overrides.underlying ?? "BTC";
  config.start = new Date(config.start);
  if (config.start >= config.end) invalid("start must be before end");
  if (!(config.minWeeklyDteDays <= target && target <= config.maxWeeklyDteDays)) {
    invalid("Maturity must satisfy minWeeklyDteDays <= targetDteDays <= maxWeeklyDteDays");
  }
  if (structure === "calendar_spread" && far <= target) invalid("farTargetDteDays must exceed targetDteDays");
  return config;
}

/** Required quote sampling belongs to the strategy, independent of transport. */
export function hoursForConfig(config) {
  if (isUnderlyingHoldingStructure(config.structure)
    || (config.hedgeEnabled && config.hedgeMode === "tolerance")) {
    return Array.from({ length: 24 }, (_, hour) => hour);
  }
  const hours = new Set([config.entryHourUtc, 8]);
  if (config.exitMode === "weekly_schedule") hours.add(config.exitHourUtc);
  if (config.hedgeEnabled) {
    const addCycle = (start) => {
      let hour = start;
      do {
        hours.add(hour);
        hour = (hour + config.hedgeIntervalHours) % 24;
      } while (hour !== start);
    };
    addCycle(config.entryHourUtc);
    if (config.exitMode === "after_days") addCycle(8);
  }
  return [...hours].sort((a, b) => a - b);
}

/** JSON-safe public report, without duplicated copies of engine results. */
export function buildBacktestReport({ config, result, data }) {
  const warnings = [];
  if (!result.counts.closedCycles) warnings.push({ code: "NO_CLOSED_CYCLES", message: "No closed cycles in the requested range; unavailable metrics are null." });
  if (result.cycleSummary.some(cycle => !cycle.closed)) warnings.push({ code: "UNCLOSED_CYCLES", message: "Some cycle rows could not be valued at exit and are excluded from summary metrics." });
  if (data.availableEnd && config.end > new Date(data.availableEnd)) warnings.push({ code: "DATA_END_BEFORE_REQUESTED_END", message: "The requested end exceeds available observations at the loaded UTC hours." });
  if (result.cycleSummary.some(cycle => cycle.missingHedgeRangeBars || cycle.missingHedgeRiskBars || cycle.hedgeDataGapCount)) warnings.push({ code: "HEDGE_DATA_GAPS", message: "Some hedge observations are missing; inspect cycle diagnostics." });
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    config,
    data,
    summary: { ...result.summary, maxDrawdownUsd: result.counts.closedCycles ? computeMaxDrawdown(result.cycleSummary) : null },
    cycles: result.cycleSummary,
    counts: { ...result.counts, totalCycles: result.cycleSummary.length, unclosedCycles: result.cycleSummary.filter(cycle => !cycle.closed).length },
    warnings,
  }));
}
