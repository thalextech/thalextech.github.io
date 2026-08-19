import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWeeklyPnlCsv,
  buildWeeklyPnlExportRows,
  serializeCsv,
} from "../src/lib/weeklyPnlCsv.js";

const entryTs = Date.UTC(2025, 5, 7, 8) / 1_000;
const exitTs = Date.UTC(2025, 5, 9, 8) / 1_000;

const cycle = {
  cycle: 1,
  closed: true,
  structure: "straddle",
  longOption: true,
  entryTs,
  exitTs,
  expirationTs: Date.UTC(2025, 5, 13, 8) / 1_000,
  holdingPeriodDays: 2,
  dteDays: 6,
  exitAtExpiry: false,
  hedgeEnabled: false,
  sizingMode: "notional",
  notionalUsd: 100_000,
  btcQuantity: 1,
  investmentUsd: 100_000,
  optionQuantityBtc: 1,
  entryIndexPrice: 100_000,
  exitIndexPrice: 102_000,
  entryStraddleMark: 7_000,
  exitStructureMark: 7_800,
  entryOptionMarketValueUsd: 7_000,
  exitOptionMarketValueUsd: 7_800,
  entryOptionCashflowUsd: -7_000,
  shortOptionPnlUsd: 800,
  hedgePnlUsd: 0,
  cyclePnlUsd: 800,
  cycleReturnOnNotional: 0.008,
  endingEquityUsd: 800,
  sampledRealizedVol: 0.42,
  sampledRealizedVariance: 0.001,
  sampledReturnCount: 2,
  legs: [
    {
      instrumentName: "BTC, CALL",
      optionType: "C",
      strike: 100_000,
      expirationTs: Date.UTC(2025, 5, 13, 8) / 1_000,
      quantity: 1,
      entryPrice: 3_500,
      exitPrice: 4_200,
      entryImpliedVol: 0.5,
      exitImpliedVol: 0.54,
      entryDelta: 0.51,
      exitDelta: 0.61,
    },
    {
      instrumentName: "BTC PUT",
      optionType: "P",
      strike: 100_000,
      expirationTs: Date.UTC(2025, 5, 13, 8) / 1_000,
      quantity: 1,
      entryPrice: 3_500,
      exitPrice: 3_600,
      entryImpliedVol: 0.52,
      exitImpliedVol: 0.56,
      entryDelta: -0.49,
      exitDelta: -0.39,
    },
  ],
};

test("weekly PnL export flattens cycle, market, volatility, attribution, and leg data", () => {
  const [row] = buildWeeklyPnlExportRows([cycle], [{
    cycle: 1,
    netDeltaPnlUsd: 100,
    gammaPnlUsd: 350,
    thetaPnlUsd: -100,
    gammaThetaPnlUsd: 250,
    vegaPnlUsd: 400,
    vannaPnlUsd: 25,
    volgaPnlUsd: 10,
    residualPnlUsd: 15,
    attributionSteps: 48,
    meanAttributionIntervalHours: 1,
  }]);

  assert.equal(row.entry_weekday_utc, "Saturday");
  assert.equal(row.exit_weekday_utc, "Monday");
  assert.equal(row.index_move_usd, 2_000);
  assert.ok(Math.abs(row.index_return_pct - 2) < 1e-12);
  assert.equal(row.mean_entry_iv_decimal, 0.51);
  assert.equal(row.mean_exit_iv_decimal, 0.55);
  assert.ok(Math.abs(row.mean_iv_change_points - 4) < 1e-12);
  assert.equal(row.gamma_pnl_usd, 350);
  assert.equal(row.theta_pnl_usd, -100);
  assert.equal(row.gamma_theta_pnl_usd, 250);
  assert.equal(row.attribution_steps, 48);
  assert.equal(row.leg_2_exit_mark_usd_per_btc, 3_600);
});

test("CSV serialization escapes labels and keeps missing expiry IV blank", () => {
  const expiryCycle = {
    ...cycle,
    legs: [{
      ...cycle.legs[0],
      instrumentName: 'BTC "SPECIAL", CALL',
      exitImpliedVol: Number.NaN,
    }],
  };
  const csv = buildWeeklyPnlCsv([expiryCycle]);

  assert.match(csv, /"BTC ""SPECIAL"", CALL"/);
  assert.match(csv.split("\r\n")[0], /leg_1_exit_iv_decimal/);
  assert.equal(serializeCsv([]), "");
});

test("ETH exports name underlying-unit columns without BTC leakage", () => {
  const unitSizedCycle = { ...cycle, sizingMode: "btc" };
  const [row] = buildWeeklyPnlExportRows([unitSizedCycle], [], {
    underlying: "ETH",
  });

  assert.equal(row.configured_eth_quantity, cycle.btcQuantity);
  assert.equal(row.option_quantity_eth, cycle.optionQuantityBtc);
  assert.equal(row.leg_1_quantity_eth, cycle.legs[0].quantity);
  assert.equal(row.sizing_mode, "eth");
  assert.equal("configured_btc_quantity" in row, false);
});
