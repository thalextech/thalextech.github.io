import { mean, normCdf, sampleStdDev } from "./statistics.js";

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

export const DEFAULT_BACKTEST_CONFIG = {
  underlying: "BTC",
  resolution: "1h",
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
  minWeeklyDteDays: 5,
  maxWeeklyDteDays: 10,
  maxHedgeDays: 12,
  daysPerYear: 365,
  notionalUsd: 100_000,
  structure: "straddle",
  targetDelta: 0.25,
};

const parseInstrumentName = (instrumentName) => {
  const match = /^([^-]+)-(\d{2}[A-Z]{3}\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(
    instrumentName,
  );
  if (!match) return null;

  const [, underlying, expiryToken, strikeRaw, optionType] = match;
  const day = Number(expiryToken.slice(0, 2));
  const month = MONTHS[expiryToken.slice(2, 5)];
  const year = 2000 + Number(expiryToken.slice(5));

  if (!Number.isFinite(day) || month == null || !Number.isFinite(year)) {
    return null;
  }

  return {
    underlying,
    expiration: new Date(Date.UTC(year, month, day, 8, 0, 0)),
    strike: Number(strikeRaw),
    optionType,
  };
};

const blackScholesDelta = ({
  spot,
  strike,
  yearsToExpiry,
  impliedVol,
  optionType,
}) => {
  const sigma = impliedVol > 3 ? impliedVol / 100 : impliedVol;
  if (
    spot <= 0 ||
    strike <= 0 ||
    sigma <= 0 ||
    yearsToExpiry <= 0 ||
    !Number.isFinite(spot + strike + sigma + yearsToExpiry)
  ) {
    return Number.NaN;
  }
  const d1 =
    (Math.log(spot / strike) + 0.5 * sigma ** 2 * yearsToExpiry) /
    (sigma * Math.sqrt(yearsToExpiry));
  const callDelta = normCdf(d1);
  return optionType === "C" ? callDelta : callDelta - 1;
};

const dedupeByKey = (rows, makeKey) => {
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(makeKey(row), row);
  }
  return [...byKey.values()];
};

const buildOptions = ({ markRows, indexRows, config }) => {
  const indexByTs = new Map(indexRows.map((row) => [row.ts, row]));
  return markRows
    .map((mark) => {
      const index = indexByTs.get(mark.ts);
      const parsed = parseInstrumentName(mark.instrumentName);
      if (!index || !parsed) return null;
      const dteDays = (parsed.expiration.getTime() - mark.dateTime.getTime()) / 86_400_000;
      const yearsToExpiry = dteDays / config.daysPerYear;
      const delta = blackScholesDelta({
        spot: index.indexPrice,
        strike: parsed.strike,
        yearsToExpiry,
        impliedVol: mark.iv,
        optionType: parsed.optionType,
      });
      if (!Number.isFinite(delta)) return null;
      return {
        ...mark,
        ...parsed,
        expirationTs: parsed.expiration.getTime() / 1000,
        indexPrice: index.indexPrice,
        dteDays,
        yearsToExpiry,
        delta,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.expirationTs !== b.expirationTs) return a.expirationTs - b.expirationTs;
      if (a.strike !== b.strike) return a.strike - b.strike;
      return a.optionType.localeCompare(b.optionType);
    });
};

const buildQuotes = ({ options, config }) =>
  dedupeByKey(
    options.filter(
      (row) => row.dteDays > 0,
    ),
    (row) => `${row.ts}|${row.instrumentName}`,
  ).sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.expirationTs !== b.expirationTs) return a.expirationTs - b.expirationTs;
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.optionType.localeCompare(b.optionType);
  });

const buildEntryExpirations = ({ quotes, dataEnd, config }) => {
  const bestByEntryTs = new Map();
  for (const quote of quotes) {
    if (
      quote.dateTime < config.start ||
      quote.dateTime > dataEnd ||
      quote.dateTime.getUTCDay() !== config.entryWeekday ||
      quote.dateTime.getUTCHours() !== config.entryHourUtc ||
      quote.dteDays < config.minWeeklyDteDays ||
      quote.dteDays > config.maxWeeklyDteDays ||
      quote.expiration > dataEnd
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
        entryTime: quote.dateTime,
        expiration: quote.expiration,
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
    const qty = config.notionalUsd / selected.call.strike;
    return {
      call: selected.call,
      put: selected.put,
      callQty: -qty,
      putQty: -qty,
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

  if (!call || !put) return null;
  const callQty = -config.notionalUsd / call.strike;
  const putAbsQty = config.notionalUsd / put.strike;
  return {
    call,
    put,
    callQty,
    putQty: config.structure === "risk_reversal" ? putAbsQty : -putAbsQty,
    sizingStrike: entryIndexPrice,
    selectionMetric:
      Math.abs(call.delta - targetDelta) + Math.abs(put.delta + targetDelta),
  };
};

const buildEntryPlan = ({ quotes, entryExpirations, config }) => {
  const quotesByEntryExpiry = new Map();
  for (const quote of quotes) {
    const key = `${quote.ts}|${quote.expirationTs}`;
    if (!quotesByEntryExpiry.has(key)) {
      quotesByEntryExpiry.set(key, { calls: [], putsByStrike: new Map() });
    }
    const group = quotesByEntryExpiry.get(key);
    if (quote.optionType === "C") {
      group.calls.push(quote);
    } else if (quote.optionType === "P") {
      group.putsByStrike.set(quote.strike, quote);
    }
  }

  const plans = [];
  let positionAvailableAtMs = Number.NEGATIVE_INFINITY;
  for (const entry of entryExpirations) {
    // This is a single-position strategy. Skip candidate entries while the
    // previously accepted trade is still open. A same-timestamp close/reopen
    // is allowed.
    if (entry.entryTime.getTime() < positionAvailableAtMs) continue;

    const group = quotesByEntryExpiry.get(`${entry.entryTs}|${entry.expirationTs}`);
    if (!group) continue;
    const entryIndexPrice =
      group.calls[0]?.indexPrice ?? [...group.putsByStrike.values()][0]?.indexPrice;
    const selected = selectLegs({ group, entryIndexPrice, config });
    if (selected) {
      let callQty = selected.callQty;
      let putQty = selected.putQty;
      if (config.longOption) {
        callQty = -callQty;
        putQty = -putQty;
      }
      const entryOptionCashflowUsd = -(
        callQty * selected.call.markPrice +
        putQty * selected.put.markPrice
      );
      const requestedExitTime = config.holdToExpiry
        ? entry.expiration
        : new Date(
            entry.entryTime.getTime() +
              Math.max(1, Math.round(config.exitHoldDays)) * 86_400_000,
          );
      const exitTime =
        requestedExitTime.getTime() >= entry.expiration.getTime()
          ? entry.expiration
          : requestedExitTime;
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
        entryTime: entry.entryTime,
        entryTs: entry.entryTs,
        expiration: entry.expiration,
        expirationTs: entry.expirationTs,
        exitTime,
        exitTs: exitTime.getTime() / 1000,
        exitAtExpiry: exitTime.getTime() === entry.expiration.getTime(),
        dteDays: entry.entryDteDays,
        strike: selected.sizingStrike,
        callStrike: selected.call.strike,
        putStrike: selected.put.strike,
        entryIndexPrice,
        notionalUsd: config.notionalUsd,
        optionQuantityBtc: Math.abs(callQty),
        callQty,
        putQty,
        callInstrument: selected.call.instrumentName,
        putInstrument: selected.put.instrumentName,
        callEntryPrice: selected.call.markPrice,
        putEntryPrice: selected.put.markPrice,
        callEntryDelta: selected.call.delta,
        putEntryDelta: selected.put.delta,
        entryOptionCashflowUsd,
        selectionMetric: selected.selectionMetric,
      });
      positionAvailableAtMs = exitTime.getTime();
    }
  }

  return plans.map((plan, index) => ({
    ...plan,
    cycle: index + 1,
    entryStraddleMark: plan.callEntryPrice + plan.putEntryPrice,
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

const buildHedgePnlByCycle = ({ entryPlan, quotes, indexRows, config }) => {
  const hedgePnlByCycle = new Map(entryPlan.map(p => [p.cycle, 0]));
  if (!config.hedgeEnabled) return { hedgePnlByCycle };

  const indexByTs = new Map(indexRows.map(r => [r.ts, r]));
  const qmap = new Map(quotes.map(q => [`${q.ts}|${q.instrumentName}`, q]));

  for (const plan of entryPlan) {
    const decisions = buildDecisionTimes(plan, config);
    let prevQty = 0, prevPrice = null, cyclePnl = 0;
    for (const ht of decisions) {
      const ts = ht.getTime() / 1000;
      const isExit = ts === plan.exitTs;
      const idx = indexByTs.get(ts);
      const cq = qmap.get(`${ts}|${plan.callInstrument}`);
      const pq = qmap.get(`${ts}|${plan.putInstrument}`);
      const cd = isExit ? 0 : cq?.delta;
      const pd = isExit ? 0 : pq?.delta;
      const has = Number.isFinite(cd) && Number.isFinite(pd);
      const od = has ? plan.callQty * cd + plan.putQty * pd : null;
      const tq = has ? -od : prevQty;
      const price = idx?.indexPrice;
      if (prevPrice != null && Number.isFinite(prevQty) && Number.isFinite(price)) {
        cyclePnl += prevQty * (price - prevPrice);
      }
      prevQty = tq;
      prevPrice = price;
    }
    hedgePnlByCycle.set(plan.cycle, cyclePnl);
  }
  return { hedgePnlByCycle };
};

const buildCycleSummary = ({ entryPlan, hedgePnlByCycle, indexRows, quotes, config }) => {
  const indexByTs = new Map(indexRows.map((row) => [row.ts, row]));
  const quoteByTimeInstrument = new Map(
    quotes.map((quote) => [`${quote.ts}|${quote.instrumentName}`, quote]),
  );
  let endingEquityUsd = 0;
  return [...entryPlan].sort((a, b) => a.entryTs - b.entryTs).map((plan) => {
    const settlementIndexPrice = indexByTs.get(plan.exitTs)?.indexPrice ?? Number.NaN;
    const callPayoffUsd = Math.max(settlementIndexPrice - plan.callStrike, 0);
    const putPayoffUsd = Math.max(plan.putStrike - settlementIndexPrice, 0);
    const settlementStraddle = callPayoffUsd + putPayoffUsd;
    const callExitQuote = quoteByTimeInstrument.get(`${plan.exitTs}|${plan.callInstrument}`);
    const putExitQuote = quoteByTimeInstrument.get(`${plan.exitTs}|${plan.putInstrument}`);
    const callExitValue = plan.exitAtExpiry
      ? callPayoffUsd
      : callExitQuote?.markPrice ?? Number.NaN;
    const putExitValue = plan.exitAtExpiry
      ? putPayoffUsd
      : putExitQuote?.markPrice ?? Number.NaN;
    const optionSettlementValueUsd =
      plan.callQty * callExitValue + plan.putQty * putExitValue;
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
      cycleReturnOnNotional: cyclePnlUsd / config.notionalUsd,
      endingEquityUsd,
      closed: Number.isFinite(settlementIndexPrice),
    };
  });
};

export const prepareBacktestData = ({ indexRows, markRows, config: inc = {} }) => {
  const config = { ...DEFAULT_BACKTEST_CONFIG, ...inc };
  let maxT = 0;
  for (const r of indexRows) maxT = Math.max(maxT, r.dateTime?.getTime() || 0);
  for (const r of markRows) maxT = Math.max(maxT, r.dateTime?.getTime() || 0);
  const dataEnd = new Date(Math.min(config.end.getTime(), maxT || config.end.getTime()));
  const options = buildOptions({ markRows, indexRows, config });
  const quotes = buildQuotes({ options, config });
  return { indexRows, markRows, options, quotes, dataEnd };
};

export const runWeeklyStraddleBacktest = ({ indexRows, markRows, preparedData, config: inc = {} }) => {
  const c = { ...DEFAULT_BACKTEST_CONFIG, ...inc };
  c.entryHourUtc = Number(c.entryHourUtc) || Number(c.hourlyOffset) || 8;
  c.hourlyOffset = c.entryHourUtc;
  c.entryWeekday = Number(c.entryWeekday) || 5;
  c.hedgeEnabled = c.hedgeEnabled !== false;
  c.hedgeIntervalHours = Math.max(1, Math.min(24, Math.round(Number(c.hedgeIntervalHours) || 24)));
  c.holdToExpiry = c.holdToExpiry !== false;
  c.exitHoldDays = Math.max(1, Math.round(Number(c.exitHoldDays) || 7));
  c.longOption = !!c.longOption;
  c.targetDelta = Math.abs(Number(c.targetDelta) || 0.25);
  const config = c;
  const p = preparedData || prepareBacktestData({ indexRows, markRows, config });
  const { indexRows: pi = [], markRows: pm = [], options, quotes, dataEnd } = p;

  const entryExpirations = buildEntryExpirations({ quotes, dataEnd, config: c });
  const entryPlan = buildEntryPlan({ quotes, entryExpirations, config: c }).sort((a, b) => a.entryTs - b.entryTs);
  const { hedgePnlByCycle } = buildHedgePnlByCycle({ entryPlan, quotes, indexRows: pi, config: c });
  const cycleSummary = buildCycleSummary({ entryPlan, hedgePnlByCycle, indexRows: pi, quotes, config: c });
  const weeklyChartData = [...cycleSummary]
    .sort((a, b) => a.entryTs - b.entryTs)
    .map((row) => ({
      ...row,
      weekLabel: row.entryTime.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
      deltaHedgedShortPnl: row.cyclePnlUsd,
      cumulativeDeltaHedgedPnl: row.endingEquityUsd,
    }));

  const closedCycles = cycleSummary.filter((row) => row.closed);
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
    weeklyChartData,
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
      notionalUsdPerCycle: config.notionalUsd,
    },
  };
};
