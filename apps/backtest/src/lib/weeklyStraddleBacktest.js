import {
  blackScholesGreeks,
  normalizeVol,
  OPTION_PRICING_DAYS_PER_YEAR,
  PRECOMPUTED_DELTA_SCALE,
} from "./optionRisk.js";
import { mean, sampleStdDev } from "./statistics.js";

export const DEFAULT_BACKTEST_CONFIG = {
  start: new Date("2025-06-01T00:00:00Z"),
  end: new Date(),
  hourlyOffset: 8,
  entryHourUtc: 8,
  entryWeekday: 5,
  hedgeEnabled: true,
  hedgeIntervalHours: 24,
  holdToExpiry: false,
  exitHoldDays: 7,
  longOption: false,
  targetDteDays: 7,
  farTargetDteDays: 14,
  minWeeklyDteDays: 4,
  maxWeeklyDteDays: 10,
  notionalUsd: 100_000,
  sizingMode: "notional",
  btcQuantity: 1,
  structure: "straddle",
  targetDelta: 0.25,
};

export const normalizeBacktestConfig = (input = {}) => {
  const config = { ...DEFAULT_BACKTEST_CONFIG, ...input };
  const entryHour = Number(config.entryHourUtc);
  const hourlyOffset = Number(config.hourlyOffset);
  config.entryHourUtc = Number.isFinite(entryHour)
    ? entryHour
    : Number.isFinite(hourlyOffset)
      ? hourlyOffset
      : DEFAULT_BACKTEST_CONFIG.entryHourUtc;
  config.hourlyOffset = config.entryHourUtc;

  const entryWeekday = Number(config.entryWeekday);
  config.entryWeekday =
    Number.isInteger(entryWeekday) && entryWeekday >= 0 && entryWeekday <= 6
      ? entryWeekday
      : DEFAULT_BACKTEST_CONFIG.entryWeekday;
  config.hedgeEnabled = config.hedgeEnabled !== false;
  config.hedgeIntervalHours = Math.max(
    1,
    Math.min(24, Math.round(Number(config.hedgeIntervalHours) || 24)),
  );
  config.holdToExpiry = config.holdToExpiry !== false;
  config.exitHoldDays = Math.max(
    1,
    Math.round(Number(config.exitHoldDays) || DEFAULT_BACKTEST_CONFIG.exitHoldDays),
  );
  config.longOption = Boolean(config.longOption);
  config.sizingMode = config.sizingMode === "btc" ? "btc" : "notional";
  config.btcQuantity = Math.max(
    0,
    Number(config.btcQuantity) || DEFAULT_BACKTEST_CONFIG.btcQuantity,
  );
  config.targetDelta = Math.abs(
    Number(config.targetDelta) || DEFAULT_BACKTEST_CONFIG.targetDelta,
  );
  return config;
};

export const computeMaxDrawdown = (rows = []) => {
  let peak = 0;
  let drawdown = 0;
  for (const row of rows) {
    const equity = row.endingEquityUsd;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return drawdown;
};

const buildQuotes = ({ quoteSnapshots, instruments, indexByTs, config, calculateRisk }) => {
  const quotes = [];
  for (const [ts, entries] of quoteSnapshots) {
    const index = indexByTs.get(ts);
    if (!index) continue;
    for (const [instrumentId, markPrice, iv, deltaScaled] of entries) {
      const instrument = instruments[instrumentId];
      if (!instrument) continue;
      const dteDays = (instrument.expirationTs - ts) / 86_400;
      if (dteDays <= 0) continue;
      const risk = calculateRisk
        ? calculateRisk({
            spot: index.indexPrice,
            strike: instrument.strike,
            yearsToExpiry: dteDays / OPTION_PRICING_DAYS_PER_YEAR,
            impliedVol: iv,
            optionType: instrument.optionType,
          })
        : { delta: deltaScaled / PRECOMPUTED_DELTA_SCALE };
      if (!Number.isFinite(risk.delta)) continue;
      quotes.push({
        ts,
        instrumentId,
        instrumentName: instrument.name,
        markPrice,
        expirationTs: instrument.expirationTs,
        strike: instrument.strike,
        optionType: instrument.optionType,
        indexPrice: index.indexPrice,
        dteDays,
        impliedVol: normalizeVol(iv),
        ...risk,
      });
    }
  }
  return quotes;
};

const buildEntryExpirations = ({ entryCandidates, dataEnd, config }) => {
  const bestByEntryTs = new Map();
  const startTs = config.start.getTime() / 1000;
  const dataEndTs = dataEnd.getTime() / 1000;
  for (const quote of entryCandidates) {
    if (
      quote.ts < startTs ||
      quote.ts > dataEndTs ||
      quote.dteDays < config.minWeeklyDteDays ||
      quote.dteDays > config.maxWeeklyDteDays ||
      quote.expirationTs > dataEndTs
    ) {
      continue;
    }

    const dteDistance = Math.abs(quote.dteDays - config.targetDteDays);
    const current = bestByEntryTs.get(quote.ts);
    if (
      !current ||
      dteDistance < current.dteDistance ||
      (dteDistance === current.dteDistance && quote.expirationTs < current.expirationTs)
    ) {
      bestByEntryTs.set(quote.ts, {
        entryTs: quote.ts,
        expirationTs: quote.expirationTs,
        entryDteDays: quote.dteDays,
        dteDistance,
      });
    }
  }
  return [...bestByEntryTs.values()].sort((a, b) => a.entryTs - b.entryTs);
};

const closestByDelta = ({ rows, targetDelta, indexPrice }) => {
  let selected = null;
  for (const row of rows) {
    const deltaDistance = Math.abs(row.delta - targetDelta);
    const strikeDistance = Math.abs(row.strike - indexPrice);
    if (
      !selected ||
      deltaDistance < selected.deltaDistance ||
      (deltaDistance === selected.deltaDistance &&
        strikeDistance < selected.strikeDistance) ||
      (deltaDistance === selected.deltaDistance &&
        strikeDistance === selected.strikeDistance &&
        row.strike < selected.row.strike)
    ) {
      selected = { row, deltaDistance, strikeDistance };
    }
  }
  return selected?.row || null;
};

const quantityForStrike = (config, strike) =>
  config.sizingMode === "btc"
    ? Math.max(0, Number(config.btcQuantity) || 1)
    : config.notionalUsd / strike;

const selectLegs = ({ group, entryIndexPrice, config }) => {
  if (config.structure === "straddle") {
    let selected = null;
    for (const call of group.calls) {
      const put = group.putsByStrike.get(call.strike);
      if (!put) continue;
      const strikeDistance = Math.abs(call.strike - entryIndexPrice);
      if (
        !selected ||
        strikeDistance < selected.strikeDistance ||
        (strikeDistance === selected.strikeDistance && call.strike < selected.call.strike)
      ) {
        selected = { call, put, strikeDistance };
      }
    }
    if (!selected) return null;
    const qty = quantityForStrike(config, selected.call.strike);
    return {
      legs: [
        { quote: selected.call, quantity: -qty },
        { quote: selected.put, quantity: -qty },
      ],
      sizingStrike: selected.call.strike,
      selectionMetric: selected.strikeDistance,
    };
  }

  const targetDelta = Number.isFinite(Number(config.targetDelta))
    ? Math.abs(Number(config.targetDelta))
    : 0.25;
  const call = closestByDelta({
    rows: group.calls.filter((row) => row.strike >= entryIndexPrice),
    targetDelta,
    indexPrice: entryIndexPrice,
  }) || closestByDelta({
    rows: group.calls,
    targetDelta,
    indexPrice: entryIndexPrice,
  });
  const put = closestByDelta({
    rows: [...group.putsByStrike.values()].filter((row) => row.strike <= entryIndexPrice),
    targetDelta: -targetDelta,
    indexPrice: entryIndexPrice,
  }) || closestByDelta({
    rows: [...group.putsByStrike.values()],
    targetDelta: -targetDelta,
    indexPrice: entryIndexPrice,
  });

  if (config.structure === "call") {
    if (!call) return null;
    return {
      legs: [{ quote: call, quantity: -quantityForStrike(config, call.strike) }],
      sizingStrike: call.strike,
      selectionMetric: Math.abs(call.delta - targetDelta),
    };
  }
  if (config.structure === "put") {
    if (!put) return null;
    return {
      legs: [{ quote: put, quantity: -quantityForStrike(config, put.strike) }],
      sizingStrike: put.strike,
      selectionMetric: Math.abs(put.delta + targetDelta),
    };
  }
  if (!call || !put) return null;
  const callQty = -quantityForStrike(config, call.strike);
  const putAbsQty = quantityForStrike(config, put.strike);
  return {
    legs: [
      { quote: call, quantity: callQty },
      { quote: put, quantity: config.structure === "risk_reversal" ? putAbsQty : -putAbsQty },
    ],
    sizingStrike: entryIndexPrice,
    selectionMetric:
      Math.abs(call.delta - targetDelta) + Math.abs(put.delta + targetDelta),
  };
};

const selectCalendarLegs = ({ nearGroup, farGroup, entryIndexPrice, config }) => {
  let selected = null;
  for (const nearCall of nearGroup.calls) {
    const nearPut = nearGroup.putsByStrike.get(nearCall.strike);
    const farCall = farGroup.calls.find((quote) => quote.strike === nearCall.strike);
    const farPut = farGroup.putsByStrike.get(nearCall.strike);
    if (!nearPut || !farCall || !farPut) continue;
    const strikeDistance = Math.abs(nearCall.strike - entryIndexPrice);
    if (!selected || strikeDistance < selected.strikeDistance) {
      selected = { nearCall, nearPut, farCall, farPut, strikeDistance };
    }
  }
  if (!selected) return null;
  const quantity = quantityForStrike(config, selected.nearCall.strike);
  return {
    // Base orientation is the short calendar. The Side toggle reverses all legs.
    legs: [
      { quote: selected.nearCall, quantity },
      { quote: selected.nearPut, quantity },
      { quote: selected.farCall, quantity: -quantity },
      { quote: selected.farPut, quantity: -quantity },
    ],
    sizingStrike: selected.nearCall.strike,
    selectionMetric: selected.strikeDistance,
  };
};

const buildQuoteGroups = (quotes) => {
  const quotesByEntryExpiry = new Map();
  const expiryGroupsByEntry = new Map();
  for (const quote of quotes) {
    const key = `${quote.ts}|${quote.expirationTs}`;
    if (!quotesByEntryExpiry.has(key)) {
      const group = {
        calls: [],
        putsByStrike: new Map(),
        expirationTs: quote.expirationTs,
        dteDays: quote.dteDays,
      };
      quotesByEntryExpiry.set(key, group);
      if (!expiryGroupsByEntry.has(quote.ts)) expiryGroupsByEntry.set(quote.ts, []);
      expiryGroupsByEntry.get(quote.ts).push(group);
    }
    const group = quotesByEntryExpiry.get(key);
    if (quote.optionType === "C") {
      group.calls.push(quote);
    } else if (quote.optionType === "P") {
      group.putsByStrike.set(quote.strike, quote);
    }
  }
  const entryCandidates = [...quotesByEntryExpiry.values()].map((group) => {
    const quote = group.calls[0] || group.putsByStrike.values().next().value;
    return quote;
  }).filter(Boolean);
  const scheduleKeyByTs = new Map();
  const entryCandidatesBySchedule = new Map();
  for (const quote of entryCandidates) {
    let scheduleKey = scheduleKeyByTs.get(quote.ts);
    if (!scheduleKey) {
      const date = new Date(quote.ts * 1000);
      scheduleKey = `${date.getUTCDay()}|${date.getUTCHours()}`;
      scheduleKeyByTs.set(quote.ts, scheduleKey);
    }
    if (!entryCandidatesBySchedule.has(scheduleKey)) {
      entryCandidatesBySchedule.set(scheduleKey, []);
    }
    entryCandidatesBySchedule.get(scheduleKey).push(quote);
  }
  return {
    quotesByEntryExpiry,
    expiryGroupsByEntry,
    entryCandidatesBySchedule,
  };
};

const buildEntryPlan = ({ quotes, entryExpirations, config, quoteGroups }) => {
  const { quotesByEntryExpiry, expiryGroupsByEntry } = quoteGroups || buildQuoteGroups(quotes);

  // entryExpirations is ordered by entryTs; this loop preserves that order.
  const plans = [];
  let positionAvailableAtMs = Number.NEGATIVE_INFINITY;
  for (const entry of entryExpirations) {
    const entryTimeMs = entry.entryTs * 1000;
    const expirationMs = entry.expirationTs * 1000;
    // This is a single-position strategy. Skip candidate entries while the
    // previously accepted trade is still open. A same-timestamp close/reopen
    // is allowed.
    if (entryTimeMs < positionAvailableAtMs) continue;

    const group = quotesByEntryExpiry.get(`${entry.entryTs}|${entry.expirationTs}`);
    if (!group) continue;
    const entryIndexPrice =
      group.calls[0]?.indexPrice ?? [...group.putsByStrike.values()][0]?.indexPrice;
    let selected;
    if (config.structure === "calendar_spread") {
      const farGroup = (expiryGroupsByEntry.get(entry.entryTs) || [])
        .filter((candidate) => candidate.expirationTs > entry.expirationTs)
        .sort((a, b) =>
          Math.abs(a.dteDays - config.farTargetDteDays) -
          Math.abs(b.dteDays - config.farTargetDteDays)
        )[0];
      selected = farGroup
        ? selectCalendarLegs({ nearGroup: group, farGroup, entryIndexPrice, config })
        : null;
    } else {
      selected = selectLegs({ group, entryIndexPrice, config });
    }
    if (selected) {
      const legs = selected.legs.map(({ quote, quantity }) => ({
        instrumentName: quote.instrumentName,
        optionType: quote.optionType,
        strike: quote.strike,
        expiration: new Date(quote.expirationTs * 1000),
        expirationTs: quote.expirationTs,
        entryPrice: quote.markPrice,
        entryDelta: quote.delta,
        entryImpliedVol: quote.impliedVol,
        quantity: config.longOption ? -quantity : quantity,
      }));
      const entryOptionCashflowUsd = -legs.reduce(
        (cashflow, leg) => cashflow + leg.quantity * leg.entryPrice,
        0,
      );
      const requestedExitMs = config.holdToExpiry
        ? expirationMs
        : entryTimeMs +
          Math.max(1, Math.round(config.exitHoldDays)) * 86_400_000;
      const exitMs = Math.min(requestedExitMs, expirationMs);
      const entryTime = new Date(entryTimeMs);
      const expiration = new Date(expirationMs);
      const exitTime = new Date(exitMs);
      plans.push({
        hourlyOffset: config.hourlyOffset,
        entryHourUtc: config.entryHourUtc,
        entryWeekday: config.entryWeekday,
        hedgeEnabled: config.hedgeEnabled,
        hedgeIntervalHours: config.hedgeIntervalHours,
        holdToExpiry: config.holdToExpiry,
        exitHoldDays: config.exitHoldDays,
        structure: config.structure,
        targetDelta: config.targetDelta,
        entryTime,
        entryTs: entry.entryTs,
        expiration,
        expirationTs: entry.expirationTs,
        exitTime,
        exitTs: exitMs / 1000,
        exitAtExpiry: exitMs === expirationMs,
        dteDays: entry.entryDteDays,
        strike: selected.sizingStrike,
        legs,
        entryIndexPrice,
        notionalUsd: config.notionalUsd,
        sizingMode: config.sizingMode,
        btcQuantity: config.btcQuantity,
        investmentUsd: config.sizingMode === "btc"
          ? config.btcQuantity * entryIndexPrice
          : config.notionalUsd,
        optionQuantityBtc: Math.abs(legs[0]?.quantity || 0),
        entryOptionCashflowUsd,
        selectionMetric: selected.selectionMetric,
      });
      positionAvailableAtMs = exitMs;
    }
  }

  return plans.map((plan, index) => ({
    ...plan,
    cycle: index + 1,
    entryStraddleMark: plan.legs.reduce((total, leg) => total + leg.entryPrice, 0),
    premiumReceivedUsd: plan.entryOptionCashflowUsd,
  }));
};

const buildDecisionTimes = (plan, config) => {
  const times = new Set();
  const intervalMs =
    Math.max(1, Math.min(24, Math.round(config.hedgeIntervalHours))) *
    3_600_000;
  for (
    let hedgeMs = plan.entryTime.getTime();
    hedgeMs < plan.exitTime.getTime();
    hedgeMs += intervalMs
  ) {
    const hedgeTime = new Date(hedgeMs);
    if (hedgeTime < plan.exitTime) {
      times.add(hedgeTime.getTime());
    }
  }
  times.add(plan.exitTime.getTime());
  return [...times].sort((a, b) => a - b).map((ms) => new Date(ms));
};

const advanceHedgePosition = ({
  quantity,
  previousPrice,
  pnlUsd,
  indexPrice,
  targetQuantity,
}) => {
  const nextPnlUsd =
    previousPrice != null && Number.isFinite(quantity) && Number.isFinite(indexPrice)
      ? pnlUsd + quantity * (indexPrice - previousPrice)
      : pnlUsd;
  const tradeQuantity = targetQuantity - quantity;
  return {
    quantity: targetQuantity,
    previousPrice: indexPrice,
    pnlUsd: nextPnlUsd,
    trade:
      Math.abs(tradeQuantity) > 1e-10
        ? {
            side: tradeQuantity > 0 ? "buy" : "sell",
            quantity: Math.abs(tradeQuantity),
            price: indexPrice,
          }
        : null,
  };
};

export const buildCycleDetail = ({ plan, preparedData, config: inc = {} }) => {
  if (!plan || !preparedData) return [];
  const config = normalizeBacktestConfig(inc);
  const indexRows = (preparedData.indexRows || [])
    .filter((row) => row.ts >= plan.entryTs && row.ts <= plan.exitTs)
    .sort((a, b) => a.ts - b.ts);
  const quoteByTimeInstrument = new Map(
    (preparedData.quotes || []).map((quote) => [
      `${quote.ts}|${quote.instrumentName}`,
      quote,
    ]),
  );
  const decisionTimes = new Set(
    buildDecisionTimes(plan, config).map((date) => date.getTime() / 1000),
  );

  let hedgeQuantity = 0;
  let previousIndexPrice = null;
  let previousTs = null;
  let previousLegQuotes = null;
  let previousTotalPnlUsd = null;
  let hedgePnlUsd = 0;
  let cumulativeThetaPnlUsd = 0;
  let cumulativeGammaPnlUsd = 0;
  let cumulativeVegaPnlUsd = 0;
  let cumulativeNetDeltaMtmUsd = 0;
  let cumulativeResidualPnlUsd = 0;

  return indexRows.map((indexRow) => {
    const isExit = indexRow.ts === plan.exitTs;
    const legQuotes = plan.legs.map((leg) => ({
      leg,
      quote: quoteByTimeInstrument.get(`${indexRow.ts}|${leg.instrumentName}`),
    }));
    const intervalHedgeQuantity = hedgeQuantity;

    const optionDeltaBtc = isExit
      ? 0
      : legQuotes.every(({ quote }) => Number.isFinite(quote?.delta))
        ? legQuotes.reduce(
            (delta, { leg, quote }) => delta + leg.quantity * quote.delta,
            0,
          )
        : Number.NaN;
    let targetHedgeQuantity = hedgeQuantity;
    if (config.hedgeEnabled && decisionTimes.has(indexRow.ts)) {
      const hasDeltas = isExit || Number.isFinite(optionDeltaBtc);
      targetHedgeQuantity = hasDeltas
        ? (isExit ? 0 : -optionDeltaBtc)
        : hedgeQuantity;
    }
    const hedgeState = advanceHedgePosition({
      quantity: hedgeQuantity,
      previousPrice: previousIndexPrice,
      pnlUsd: hedgePnlUsd,
      indexPrice: indexRow.indexPrice,
      targetQuantity: targetHedgeQuantity,
    });
    hedgeQuantity = hedgeState.quantity;
    hedgePnlUsd = hedgeState.pnlUsd;
    const hedgeTrade = hedgeState.trade;

    const legMarks = legQuotes.map(({ leg, quote }) => {
      const expiresNow = indexRow.ts === leg.expirationTs;
      const mark = expiresNow
        ? (leg.optionType === "C"
            ? Math.max(indexRow.indexPrice - leg.strike, 0)
            : Math.max(leg.strike - indexRow.indexPrice, 0))
        : quote?.markPrice;
      return { leg, mark };
    });
    const hasMarks = legMarks.every(({ mark }) => Number.isFinite(mark));
    const optionPnlUsd = hasMarks
      ? plan.entryOptionCashflowUsd + legMarks.reduce(
          (value, { leg, mark }) => value + leg.quantity * mark,
          0,
        )
      : Number.NaN;

    const totalPnlUsd = Number.isFinite(optionPnlUsd) ? optionPnlUsd + hedgePnlUsd : Number.NaN;
    let thetaPnlIncrementUsd = 0;
    let gammaPnlIncrementUsd = 0;
    let vegaPnlIncrementUsd = 0;
    let deltaPnlIncrementUsd = 0;
    if (
      previousIndexPrice != null &&
      previousTs != null &&
      previousLegQuotes?.length === plan.legs.length
    ) {
      const dS = indexRow.indexPrice - previousIndexPrice;
      const dtYears =
        (indexRow.ts - previousTs) /
        (OPTION_PRICING_DAYS_PER_YEAR * 86_400);
      const hasPreviousDeltas = previousLegQuotes.every((quote) => Number.isFinite(quote?.delta));
      if (hasPreviousDeltas) {
        const previousOptionDeltaBtc = plan.legs.reduce(
          (delta, leg, index) => delta + leg.quantity * previousLegQuotes[index].delta,
          0,
        );
        deltaPnlIncrementUsd = (previousOptionDeltaBtc + intervalHedgeQuantity) * dS;
      }
      plan.legs.forEach((leg, index) => {
        const previousQuote = previousLegQuotes[index];
        const currentQuote = legQuotes[index]?.quote;
        if (Number.isFinite(previousQuote?.theta)) {
          thetaPnlIncrementUsd += leg.quantity * previousQuote.theta * dtYears;
        }
        if (Number.isFinite(previousQuote?.gamma)) {
          gammaPnlIncrementUsd += leg.quantity * 0.5 * previousQuote.gamma * dS ** 2;
        }
        const previousVol = previousQuote?.impliedVol;
        const currentVol = currentQuote?.impliedVol;
        if (Number.isFinite(previousQuote?.vega) && Number.isFinite(previousVol) && Number.isFinite(currentVol)) {
          vegaPnlIncrementUsd += leg.quantity * previousQuote.vega * (currentVol - previousVol);
        }
      });
      cumulativeThetaPnlUsd += thetaPnlIncrementUsd;
      cumulativeGammaPnlUsd += gammaPnlIncrementUsd;
      cumulativeVegaPnlUsd += vegaPnlIncrementUsd;
      cumulativeNetDeltaMtmUsd += deltaPnlIncrementUsd;
      if (Number.isFinite(previousTotalPnlUsd) && Number.isFinite(totalPnlUsd)) {
        cumulativeResidualPnlUsd +=
          totalPnlUsd - previousTotalPnlUsd -
          deltaPnlIncrementUsd - thetaPnlIncrementUsd -
          gammaPnlIncrementUsd - vegaPnlIncrementUsd;
      }
    }

    previousIndexPrice = indexRow.indexPrice;
    previousTs = indexRow.ts;
    previousLegQuotes = legQuotes.map(({ quote }) => quote);
    previousTotalPnlUsd = totalPnlUsd;
    return {
      ts: indexRow.ts,
      dateTime: new Date(indexRow.ts * 1000),
      indexPrice: indexRow.indexPrice,
      legMarks: legMarks.map(({ leg, mark }) => ({ instrumentName: leg.instrumentName, mark })),
      combinedMark: hasMarks ? legMarks.reduce((total, { mark }) => total + mark, 0) : Number.NaN,
      optionPnlUsd,
      hedgePnlUsd,
      totalPnlUsd,
      cumulativeThetaPnlUsd,
      cumulativeGammaPnlUsd,
      cumulativeVegaPnlUsd,
      cumulativeNetDeltaMtmUsd,
      cumulativeResidualPnlUsd,
      hedgeQuantity,
      hedgeTrade,
    };
  });
};

export function computeBreakEvens(plan) {
  if (!plan || !Array.isArray(plan.legs) || plan.legs.length === 0) return null;
  const cashflow = plan.entryOptionCashflowUsd;
  if (!Number.isFinite(cashflow)) return null;

  // We solve: sum(leg.quantity * intrinsic(S)) + cashflow === 0
  // i.e. payoff(S) === -cashflow
  const target = -cashflow;

  const legs = plan.legs.filter((l) => Number.isFinite(l.strike) && (l.optionType === "C" || l.optionType === "P"));

  const payoff = (S) => {
    let sum = 0;
    for (const leg of legs) {
      const intr = leg.optionType === "C"
        ? Math.max(0, S - leg.strike)
        : Math.max(0, leg.strike - S);
      sum += (Number(leg.quantity) || 0) * intr;
    }
    return sum;
  };

  const strikes = legs.map((l) => l.strike);
  const minK = Math.min(...strikes);
  const maxK = Math.max(...strikes);
  const center = Number.isFinite(plan.entryIndexPrice) ? plan.entryIndexPrice : (minK + maxK) / 2;

  // Wide search range
  const low = Math.min(minK * 0.3, center * 0.4, 1000);
  const high = Math.max(maxK * 2.5, center * 2.0, 300000);
  const steps = 600;

  let prevS = low;
  let prevVal = payoff(prevS) - target;

  const roots = [];

  for (let i = 1; i <= steps; i++) {
    const s = low + ((high - low) * i) / steps;
    const val = payoff(s) - target;
    if (prevVal * val < 0 || (prevVal === 0 && val !== 0)) {
      // linear interpolate root
      const root = prevS - (prevVal * (s - prevS)) / (val - prevVal || 1);
      if (Number.isFinite(root) && root > 0) roots.push(root);
    }
    prevS = s;
    prevVal = val;
  }

  if (roots.length === 0) {
    // No crossing found. Could be always in the money or out.
    // Return nulls; caller can decide.
    return { lower: null, upper: null };
  }

  roots.sort((a, b) => a - b);

  // Dedup close roots
  const unique = [];
  for (const r of roots) {
    if (!unique.length || Math.abs(r - unique[unique.length - 1]) > 1) unique.push(r);
  }

  let lower = unique[0] ?? null;
  let upper = unique[unique.length - 1] ?? null;

  // For single-root cases (directional), assign appropriately
  if (unique.length === 1) {
    // If payoff at very low S suggests we need higher S to break even
    const lowPay = payoff(low);
    if (lowPay < target) {
      lower = null;
      upper = unique[0];
    } else {
      lower = unique[0];
      upper = null;
    }
  }

  // Clamp obviously bad values
  const reasonableMin = Math.max(100, center * 0.1);
  const reasonableMax = center * 4;
  if (lower != null && (lower < reasonableMin || lower > reasonableMax)) lower = null;
  if (upper != null && (upper < reasonableMin || upper > reasonableMax)) upper = null;

  return { lower, upper };
}

const buildHedgePnlByCycle = ({ entryPlan, quotes, indexRows, config, indexByTs, quoteByTimeInstrument }) => {
  const hedgePnlByCycle = new Map(entryPlan.map(p => [p.cycle, 0]));
  if (!config.hedgeEnabled) return { hedgePnlByCycle };

  const indexMap = indexByTs || new Map(indexRows.map(r => [r.ts, r]));
  const qmap = quoteByTimeInstrument || new Map(quotes.map(q => [`${q.ts}|${q.instrumentName}`, q]));

  for (const plan of entryPlan) {
    const decisions = buildDecisionTimes(plan, config);
    let hedgeState = { quantity: 0, previousPrice: null, pnlUsd: 0 };
    for (const ht of decisions) {
      const ts = ht.getTime() / 1000;
      const isExit = ts === plan.exitTs;
      const idx = indexMap.get(ts);
      const legQuotes = plan.legs.map((leg) => ({
        leg,
        quote: qmap.get(`${ts}|${leg.instrumentName}`),
      }));
      const has = isExit || legQuotes.every(({ quote }) => Number.isFinite(quote?.delta));
      const od = has
        ? (isExit ? 0 : legQuotes.reduce(
            (delta, { leg, quote }) => delta + leg.quantity * quote.delta,
            0,
          ))
        : null;
      const targetQuantity = has ? -od : hedgeState.quantity;
      hedgeState = advanceHedgePosition({
        ...hedgeState,
        indexPrice: idx?.indexPrice,
        targetQuantity,
      });
    }
    hedgePnlByCycle.set(plan.cycle, hedgeState.pnlUsd);
  }
  return { hedgePnlByCycle };
};

const buildCycleSummary = ({ entryPlan, hedgePnlByCycle, indexRows, quotes, config, indexByTs, quoteByTimeInstrument }) => {
  const indexMap = indexByTs || new Map(indexRows.map((row) => [row.ts, row]));
  const quoteMap = quoteByTimeInstrument || new Map(
    quotes.map((quote) => [`${quote.ts}|${quote.instrumentName}`, quote]),
  );
  let endingEquityUsd = 0;
  return entryPlan.map((plan) => {
    const settlementIndexPrice = indexMap.get(plan.exitTs)?.indexPrice ?? Number.NaN;
    const legExitValues = plan.legs.map((leg) => {
      const expiresAtExit = leg.expirationTs === plan.exitTs;
      const payoff = leg.optionType === "C"
        ? Math.max(settlementIndexPrice - leg.strike, 0)
        : Math.max(leg.strike - settlementIndexPrice, 0);
      const quote = quoteMap.get(`${plan.exitTs}|${leg.instrumentName}`);
      return expiresAtExit ? payoff : quote?.markPrice ?? Number.NaN;
    });
    const optionSettlementValueUsd = plan.legs.reduce(
      (value, leg, index) => value + leg.quantity * legExitValues[index],
      0,
    );
    const shortOptionPnlUsd =
      plan.entryOptionCashflowUsd + optionSettlementValueUsd;
    const hedgePnlUsd = hedgePnlByCycle.get(plan.cycle) ?? 0;
    const cyclePnlUsd = shortOptionPnlUsd + hedgePnlUsd;
    endingEquityUsd += cyclePnlUsd;
    return {
      ...plan,
      shortOptionPnlUsd,
      hedgePnlUsd,
      cyclePnlUsd,
      cycleReturnOnNotional: cyclePnlUsd / plan.investmentUsd,
      endingEquityUsd,
      closed: Number.isFinite(settlementIndexPrice) && legExitValues.every(Number.isFinite),
    };
  });
};

export const buildBacktestIndexes = (preparedData, indexByTs) => {
  const indexRows = preparedData?.indexRows || [];
  const quotes = preparedData?.quotes || [];
  return {
    indexByTs: indexByTs || new Map(indexRows.map((row) => [row.ts, row])),
    quoteByTimeInstrument: new Map(
      quotes.map((quote) => [`${quote.ts}|${quote.instrumentName}`, quote]),
    ),
    quoteGroups: buildQuoteGroups(quotes),
  };
};

const prepareData = ({
  indexRows = [],
  quoteSnapshots = [],
  instruments = [],
  config: inc = {},
  calculateRisk,
}) => {
  const config = normalizeBacktestConfig(inc);
  let maxTs = 0;
  for (const row of indexRows) maxTs = Math.max(maxTs, row.ts || 0);
  for (const [ts] of quoteSnapshots) maxTs = Math.max(maxTs, ts || 0);
  const configuredEndTs = config.end.getTime() / 1000;
  const dataEnd = new Date(Math.min(configuredEndTs, maxTs || configuredEndTs) * 1000);
  const indexByTs = new Map(indexRows.map((row) => [row.ts, row]));
  const quotes = buildQuotes({
    quoteSnapshots,
    instruments,
    indexByTs,
    config,
    calculateRisk,
  });
  const preparedData = { indexRows, quotes, dataEnd };
  preparedData.indexes = buildBacktestIndexes(preparedData, indexByTs);
  return preparedData;
};

export const prepareBacktestData = (args) =>
  prepareData({ ...args, calculateRisk: null });

export const prepareCycleDetailData = (args) =>
  prepareData({ ...args, calculateRisk: blackScholesGreeks });

export const runWeeklyStraddleBacktest = ({
  indexRows,
  quoteSnapshots,
  instruments,
  preparedData,
  config: inc = {},
}) => {
  const config = normalizeBacktestConfig(inc);
  const c = config;
  const p = preparedData || prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const { indexRows: pi = [], quotes, dataEnd } = p;
  const indexes = p.indexes || buildBacktestIndexes(p);
  const entryScheduleKey = `${c.entryWeekday}|${c.entryHourUtc}`;

  const entryExpirations = buildEntryExpirations({
    entryCandidates:
      indexes.quoteGroups.entryCandidatesBySchedule.get(entryScheduleKey) || [],
    dataEnd,
    config: c,
  });
  const entryPlan = buildEntryPlan({
    quotes,
    entryExpirations,
    config: c,
    quoteGroups: indexes.quoteGroups,
  });
  const { hedgePnlByCycle } = buildHedgePnlByCycle({
    entryPlan,
    quotes,
    indexRows: pi,
    config: c,
    indexByTs: indexes.indexByTs,
    quoteByTimeInstrument: indexes.quoteByTimeInstrument,
  });
  const cycleSummary = buildCycleSummary({
    entryPlan,
    hedgePnlByCycle,
    indexRows: pi,
    quotes,
    config: c,
    indexByTs: indexes.indexByTs,
    quoteByTimeInstrument: indexes.quoteByTimeInstrument,
  });
  const closedCycles = cycleSummary.filter((row) => row.closed);
  let cumulativeOptionPnlUsd = 0;
  let cumulativeHedgePnlUsd = 0;
  const entryImpliedVols = [];
  for (const cycle of closedCycles) {
    if (Number.isFinite(cycle.shortOptionPnlUsd)) {
      cumulativeOptionPnlUsd += cycle.shortOptionPnlUsd;
    }
    if (Number.isFinite(cycle.hedgePnlUsd)) {
      cumulativeHedgePnlUsd += cycle.hedgePnlUsd;
    }
    for (const leg of cycle.legs) {
      if (Number.isFinite(leg.entryImpliedVol)) entryImpliedVols.push(leg.entryImpliedVol);
    }
  }
  const cycleReturns = closedCycles
    .map((row) => row.cycleReturnOnNotional)
    .filter(Number.isFinite);
  const entryDtes = cycleSummary
    .map((row) => row.dteDays)
    .filter(Number.isFinite);
  const cycleMeanReturn = mean(cycleReturns);
  const cycleReturnVol = sampleStdDev(cycleReturns);
  const firstEntryMs = closedCycles[0]?.entryTime?.getTime();
  const lastExitMs = closedCycles.at(-1)?.exitTime?.getTime();
  const observedYears =
    Number.isFinite(firstEntryMs) && Number.isFinite(lastExitMs) && lastExitMs > firstEntryMs
      ? (lastExitMs - firstEntryMs) / (365 * 86_400_000)
      : Number.NaN;
  const annualizedCyclesPerYear =
    Number.isFinite(observedYears) && observedYears > 0
      ? cycleReturns.length / observedYears
      : Number.NaN;
  const finalEquityUsd = cycleSummary.at(-1)?.endingEquityUsd ?? Number.NaN;

  return {
    dataEnd,
    counts: { closedCycles: closedCycles.length },
    cycleSummary,
    summary: {
      finalEquityUsd,
      cumulativeReturnOnNotional: finalEquityUsd / config.notionalUsd,
      sharpeRatio:
        cycleReturns.length > 1 &&
        cycleReturnVol > 0 &&
        Number.isFinite(annualizedCyclesPerYear)
          ? (cycleMeanReturn / cycleReturnVol) * Math.sqrt(annualizedCyclesPerYear)
          : Number.NaN,
      annualizedCyclesPerYear,
      meanEntryDteDays: mean(entryDtes),
      cumulativeOptionPnlUsd,
      cumulativeHedgePnlUsd,
      meanEntryImpliedVol: mean(entryImpliedVols),
      notionalUsdPerCycle: config.notionalUsd,
      sizingMode: config.sizingMode,
      btcQuantity: config.btcQuantity,
    },
  };
};

export const runWeeklyStraddleBacktestBatch = ({ preparedData, runs }) => {
  const indexes = preparedData.indexes || buildBacktestIndexes(preparedData);
  const sharedPreparedData = { ...preparedData, indexes };
  return runs.map(({ config }) => runWeeklyStraddleBacktest({
    preparedData: sharedPreparedData,
    config,
  }));
};
