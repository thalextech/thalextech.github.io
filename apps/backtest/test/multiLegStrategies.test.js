import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleDetail, normalizeBacktestConfig, prepareBacktestData, prepareCycleDetailData,
  runWeeklyStraddleBacktest, runWeeklyStraddleBacktestBatch,
} from "../src/lib/weeklyStraddleBacktest.js";
import { PRECOMPUTED_DELTA_SCALE } from "../src/lib/optionRisk.js";
import { buildFairValueCycleState, simulateWeeklyCycleModes } from "../src/lib/fairValueMonteCarlo.js";

const DAY = 86_400;
const entryTs = Date.UTC(2025, 5, 6, 8) / 1000;
const expirationTs = entryTs + 7 * DAY;
const fixtureFor = (structure, exitSpot = 100_000, overrides = {}) => {
  const specs = [
    ['P', 85_000, -0.1, 400], ['P', 95_000, -0.25, 2_000],
    ['P', 100_000, -0.5, 4_000], ['C', 100_000, 0.5, 4_000],
    ['C', 105_000, 0.25, 2_000], ['C', 115_000, 0.1, 400],
  ];
  const instruments = specs.map(([optionType, strike], instrumentId) => ({
    instrumentId, name: `${optionType}-${strike}`, optionType, strike, expirationTs,
  }));
  return {
    instruments,
    indexRows: [
      { ts: entryTs, indexPrice: 100_000 },
      { ts: entryTs + 2 * DAY, indexPrice: 101_000 },
      { ts: expirationTs, indexPrice: exitSpot },
    ],
    quoteSnapshots: [0, 2].map(day => [entryTs + day * DAY,
      specs.map(([, , delta, premium], id) => [id, premium * (day ? 0.75 : 1), 0.55,
        delta * PRECOMPUTED_DELTA_SCALE])]),
    config: {
      structure, start: new Date(entryTs * 1000), end: new Date(expirationTs * 1000),
      entryWeekday: 5, entryHourUtc: 8, exitMode: 'expiry', hedgeEnabled: false,
      sizingMode: 'btc', btcQuantity: 2, targetDelta: 0.25, wingDelta: 0.1, ...overrides,
    },
  };
};

for (const structure of ['butterfly', 'condor', 'collar']) {
  test(`${structure} selects its legs and reconciles expiry P&L across the payoff regions`, () => {
    for (const spot of [70_000, 85_000, 90_000, 95_000, 100_000, 105_000, 110_000, 115_000, 130_000]) {
      const fixture = fixtureFor(structure, spot);
      const cycle = runWeeklyStraddleBacktest(fixture).cycleSummary[0];
      assert.ok(cycle.closed);
      const strikes = cycle.legs.map(leg => leg.strike);
      const quantities = cycle.legs.map(leg => leg.quantity);
      assert.deepEqual(strikes, structure === 'butterfly' ? [100_000, 100_000, 115_000, 85_000]
        : structure === 'condor' ? [105_000, 115_000, 95_000, 85_000] : [105_000, 95_000]);
      assert.deepEqual(quantities, structure === 'butterfly' ? [-2, -2, 2, 2]
        : structure === 'condor' ? [-2, 2, -2, 2] : [-1, 1]);
      assert.ok(cycle.legs.every(leg => leg.expirationTs === expirationTs));
      const optionPnl = cycle.legs.reduce((total, leg) => total + leg.quantity * (
        Math.max(leg.optionType === 'C' ? spot - leg.strike : leg.strike - spot, 0) - leg.entryPrice), 0);
      assert.equal(cycle.cyclePnlUsd, optionPnl + (structure === 'collar' ? spot - 100_000 : 0));
      const expected = structure === 'collar' ? Math.max(95_000, Math.min(spot, 105_000)) - 100_000
        : structure === 'butterfly' ? 14_400 - 2 * Math.min(Math.abs(spot - 100_000), 15_000)
          : 6_400 - 2 * Math.min(Math.max(95_000 - spot, spot - 105_000, 0), 10_000);
      assert.equal(cycle.cyclePnlUsd, expected);
      if (structure !== 'collar') {
        const long = runWeeklyStraddleBacktest({ ...fixture,
          config: { ...fixture.config, longOption: true } }).cycleSummary[0];
        assert.equal(long.cyclePnlUsd, -cycle.cyclePnlUsd);
      }
    }
  });

  test(`${structure} early exit agrees across detail, attribution, batch, and simulation`, () => {
    const fixture = fixtureFor(structure, 110_000, {
      exitMode: 'after_days', exitHoldDays: 2, sizingMode: 'notional', notionalUsd: 50_000,
      includeGreekAttribution: true,
    });
    const result = runWeeklyStraddleBacktest(fixture);
    const cycle = result.cycleSummary[0];
    assert.equal(Math.abs(cycle.legs[0].quantity), structure === 'collar' ? 1 : 0.5);
    const detailPrepared = prepareCycleDetailData({ ...fixture, plan: cycle });
    const detail = buildCycleDetail({ plan: cycle, preparedData: detailPrepared, config: fixture.config });
    assert.ok(Math.abs(detail.at(-1).totalPnlUsd - cycle.cyclePnlUsd) < 1e-8);
    assert.ok(Math.abs(Object.values(cycle.greekPnl).reduce((sum, pnl) => sum + pnl, 0)
      - cycle.cyclePnlUsd) < 1e-8);
    const preparedData = prepareBacktestData(fixture);
    const batch = runWeeklyStraddleBacktestBatch({ preparedData, runs: [{ config: fixture.config }] });
    assert.equal(batch[0].summary.finalEquityUsd, result.summary.finalEquityUsd);
    const state = buildFairValueCycleState(cycle);
    assert.ok(Number.isFinite(simulateWeeklyCycleModes(state, () => 0.2).unhedged));
    const activePnl = cycle.shortOptionPnlUsd + (cycle.underlyingQuantity || 0)
      * (cycle.exitIndexPrice - cycle.entryIndexPrice);
    assert.equal(state.actualPnlByMode.unhedged, activePnl);
  });
}

for (const structure of ['butterfly', 'condor']) {
  test(`${structure} skips missing wings and selects consistently from a sparse, reordered chain`, () => {
    const fixture = fixtureFor(structure, 100_000, { targetDelta: 0.2, wingDelta: 0.19 });
    const select = () => runWeeklyStraddleBacktest(fixture).cycleSummary[0].legs;
    const legs = select();
    fixture.quoteSnapshots = fixture.quoteSnapshots.map(([ts, rows]) => [ts, [...rows].reverse()]);
    assert.deepEqual(select(), legs);
    fixture.quoteSnapshots = fixture.quoteSnapshots.map(([ts, rows]) => [ts, rows.filter(row => row[0] !== 0 && row[0] !== 1)]);
    assert.equal(runWeeklyStraddleBacktest(fixture).cycleSummary.length, 0);
  });
}

test('wing delta validation covers butterfly and condor', () => {
  for (const wingDelta of [0, 0.5, NaN, Infinity]) {
    assert.throws(() => normalizeBacktestConfig({ structure: 'butterfly', wingDelta }), RangeError);
  }
  assert.throws(() => normalizeBacktestConfig({ structure: 'condor', targetDelta: 0.1, wingDelta: 0.25 }), RangeError);
});
