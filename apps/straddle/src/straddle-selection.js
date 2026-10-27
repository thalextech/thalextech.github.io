// A straddle exists only when both legs share the exact expiry and strike.
export function getAvailableStraddles(instruments, nowSeconds) {
  const pairs = new Map();
  for (const instrument of instruments) {
    const { expiration_ts: expiryTs, strike, option_type_normalized: type, instrument_name: name } = instrument;
    if (!Number.isFinite(expiryTs) || expiryTs <= nowSeconds ||
        !Number.isFinite(strike) || strike <= 0 || !name ||
        (type !== "call" && type !== "put")) continue;
    const key = `${expiryTs}:${strike}`;
    const pair = pairs.get(key) || { expiryTs, strike };
    pair[type === "call" ? "callInstrumentName" : "putInstrumentName"] = name;
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .filter(pair => pair.callInstrumentName && pair.putInstrumentName)
    .sort((a, b) => a.expiryTs - b.expiryTs || a.strike - b.strike);
}
