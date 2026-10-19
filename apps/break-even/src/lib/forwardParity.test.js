import test from 'node:test';
import assert from 'node:assert/strict';
import { calcOptionPrice } from '../../../../lib/thalex.js';
import { findForwardProxy, buildParityForwardHistory } from './forwardParity.js';

const instrument = (strike, type) => ({
  strike, option_type_normalized: type, instrument_name: `${strike}-${type}`,
});
const pair = strike => [instrument(strike, 'call'), instrument(strike, 'put')];
const row = (ts, mark) => ({ ts, mark_price_close: mark });

test('proxy is the first listed strike strictly above spot, regardless of input order', () => {
  const instruments = [...pair(85000), ...pair(82000), ...pair(83000)];
  const expected = { strike: 83000, callInstrumentName: '83000-call', putInstrumentName: '83000-put' };
  assert.deepEqual(findForwardProxy(82008, instruments), expected);
  assert.deepEqual(findForwardProxy(82000, instruments), expected, 'a strike equal to spot is skipped');
  assert.equal(findForwardProxy(85000, instruments), null);
  assert.equal(findForwardProxy(null, instruments), null);
  assert.equal(findForwardProxy(82008, []), null);
});

test('a missing leg at the first strike does not select a farther complete pair', () => {
  assert.equal(findForwardProxy(82008, [instrument(83000, 'call'), ...pair(84000)]), null);
  assert.equal(findForwardProxy(82008, [instrument(83000, 'put'), ...pair(84000)]), null);
});

test('parity recovers the pricing forward from a matching call and put without an IV input', () => {
  const forward = 82845;
  for (const strike of [83000, 84000]) {
    for (const iv of [0.2, 0.8]) {
      const call = calcOptionPrice(forward, strike, 11 * 86400, iv, 'call');
      const put = calcOptionPrice(forward, strike, 11 * 86400, iv, 'put');
      const result = buildParityForwardHistory({ strike }, [row(100, call)], [row(100, put)]);
      assert.equal(result.length, 1);
      assert.ok(Math.abs(result[0].value - forward) < 1e-9);
      assert.equal(result[0].strike, strike);
      assert.equal(+result[0].date, 100000);
    }
  }
});

test('parity matches observations by timestamp and returns ordered forwards', () => {
  const result = buildParityForwardHistory({ strike: 83000 },
    [row(300, 1800), row(100, 1666), row(400, 1900)],
    [row(300, 1900), row(200, 2000), row(100, 1820)]);
  assert.deepEqual(result.map(({ ts, value }) => ({ ts, value })), [
    { ts: 100, value: 82846 }, { ts: 300, value: 82900 },
  ]);
  assert.deepEqual(buildParityForwardHistory({ strike: 83000 }, [row(100, 1666)], [row(200, 1820)]), []);
});

test('missing or invalid marks never fall back to a different strike or spot', () => {
  const proxy = { strike: 100 };
  assert.deepEqual(buildParityForwardHistory(null), []);
  assert.deepEqual(buildParityForwardHistory(proxy), []);
  for (const mark of [null, NaN, Infinity, -1, '10']) {
    assert.deepEqual(buildParityForwardHistory(proxy, [row(100, mark)], [row(100, 10)]), []);
    assert.deepEqual(buildParityForwardHistory(proxy, [row(100, 10)], [row(100, mark)]), []);
  }
  assert.deepEqual(buildParityForwardHistory(proxy, [row(100, 0)], [row(100, 101)]), []);
  assert.equal(buildParityForwardHistory(proxy, [row(100, 0)], [row(100, 0)])[0].value, 100);
});
