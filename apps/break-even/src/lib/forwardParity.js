// Choose the strike from the listed instruments, before checking mark availability.
// A missing leg at this strike must not silently select a different proxy.
export function findForwardProxy(spot, instruments) {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const strikes = instruments
    .filter(instrument => instrument.option_type_normalized === 'call' || instrument.option_type_normalized === 'put')
    .map(instrument => instrument.strike)
    .filter(strike => Number.isFinite(strike) && strike > spot);
  if (!strikes.length) return null;
  const strike = Math.min(...strikes);
  const call = instruments.find(instrument => instrument.strike === strike && instrument.option_type_normalized === 'call');
  const put = instruments.find(instrument => instrument.strike === strike && instrument.option_type_normalized === 'put');
  if (!call || !put) return null;
  return { strike, callInstrumentName: call.instrument_name, putInstrumentName: put.instrument_name };
}

// Zero-rate put-call parity: F = K + C - P. Match candle timestamps so a
// recent call cannot be combined with an older put. No IV input is required.
export function buildParityForwardHistory(proxy, callRows = [], putRows = []) {
  if (!proxy || !Number.isFinite(proxy.strike) || proxy.strike <= 0) return [];
  const validMark = row => Number.isFinite(row?.ts) && Number.isFinite(row.mark_price_close) && row.mark_price_close >= 0;
  const puts = new Map(putRows.filter(validMark).map(row => [row.ts, row.mark_price_close]));
  const forwards = new Map();
  for (const call of callRows.filter(validMark)) {
    const put = puts.get(call.ts);
    if (put === undefined) continue;
    const value = proxy.strike + call.mark_price_close - put;
    if (Number.isFinite(value) && value > 0) {
      forwards.set(call.ts, { ts: call.ts, date: new Date(call.ts * 1000), value, strike: proxy.strike });
    }
  }
  return [...forwards.values()].sort((a, b) => a.ts - b.ts);
}
