import { fetchOptionChain, fetchLiveQuotes } from "../../../apps/term-structure/src/market-data.js";
import { buildTermStructure } from "../../../apps/term-structure/src/volatility.js";

// Reuse the app's provider boundary and rate limits; the embed receives chart data.
export function createLiveTermStructureLoader({ fetchChain = fetchOptionChain, fetchQuotes = fetchLiveQuotes, now = () => Date.now() / 1000 } = {}) {
  return async function load(asset, { signal } = {}) {
    const chain = await fetchChain(asset, signal);
    signal?.throwIfAborted();
    if (!chain.length) throw new Error(`No listed ${asset} options returned.`);
    const asOf = now();
    const result = await fetchQuotes(chain, { signal });
    signal?.throwIfAborted();
    const expiries = [...new Set(chain.map((point) => point.expiry))].sort((a, b) => a - b);
    const term = buildTermStructure({ live: result.quotes, history: [], expiries, slice: "atm" });
    if (!term.current.length) throw new Error(`No fresh ${asset} ATM quotes returned. Try Refresh again.`);
    return {
      asset, asOf, expiries, term,
      quoteTime: Math.min(...result.quotes.map((quote) => quote.ts)),
      refreshedAt: now(),
      warning: [result.rateLimitWarning, result.failures.length ? `${result.failures.length} option quotes unavailable; curve uses available marks.` : ""].filter(Boolean).join(" "),
    };
  };
}
