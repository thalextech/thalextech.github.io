import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackProbabilityHistory } from './trackSelection.js';

const day = 86400;
const start = 1700000000;
const date = offset => new Date((start + offset) * 1000);

test('probability history uses each observed IV and same-time forward, omitting missing IV and projections', () => {
  const track = { optionType: 'call', strike: 100, referenceIv: 0.9, points: [
    { date: date(0), iv: 0.2 }, { date: date(day), iv: 0.8 },
    { date: date(2 * day), iv: null }, { date: date(3 * day), iv: 0.9 },
  ] };
  const index = [0, day, 2 * day].map(offset => ({ date: date(offset), value: 100 }));
  const rows = buildTrackProbabilityHistory(track, index, start + 365.25 * day, index);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].indexPrice, 100);
  assert.ok(rows[0].probability > rows[1].probability, 'historical IV changes must affect probability');
  const puts = buildTrackProbabilityHistory({ ...track, optionType: 'put' }, index, start + 365.25 * day, index);
  rows.forEach((row, i) => assert.ok(Math.abs(row.probability + puts[i].probability - 1) < 1e-12));
  assert.deepEqual(buildTrackProbabilityHistory(null, index, start + day), []);
});

test('history follows the same-time parity forward, preserving the actual index price', () => {
  const track = { optionType: 'call', strike: 100, points: [
    { date: date(0), iv: 0.5 }, { date: date(day), iv: 0.5 },
  ] };
  const index = [
    { date: date(0), value: 100 }, { date: date(day), value: 100 },
  ];
  const rows = buildTrackProbabilityHistory(track, index, start + 30 * day, [
    { date: date(0), value: 80 }, { date: date(day), value: 120 },
  ]);
  assert.ok(rows[0].probability < 0.1);
  assert.ok(rows[1].probability > 0.8);
  assert.ok(rows.every(row => row.indexPrice === 100));
  assert.deepEqual(buildTrackProbabilityHistory(track, index, start + 30 * day), []);
  assert.equal(buildTrackProbabilityHistory(track, index, start + 30 * day, [
    { date: date(day), value: 120 },
  ]).length, 1, 'missing historical forwards are omitted, not filled with spot');
});

test('maturity changes match the same strike and option type without picking a substitute', async () => {
  const { findSameStrikeInstrument } = await import('./trackSelection.js');
  const selected = { strike: 90000, option_type_normalized: 'call' };
  const put = { instrument_name: 'new-put', strike: 90000, option_type_normalized: 'put' };
  const otherStrike = { instrument_name: 'other-call', strike: 95000, option_type_normalized: 'call' };
  const call = { instrument_name: 'new-call', strike: 90000, option_type_normalized: 'call' };
  assert.equal(findSameStrikeInstrument(selected, [put, otherStrike, call]), call);
  assert.equal(findSameStrikeInstrument(selected, [put, otherStrike]), null);
  assert.equal(findSameStrikeInstrument(null, [call]), null);
});
