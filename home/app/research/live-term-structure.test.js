import test from "node:test";
import assert from "node:assert/strict";
import { createLiveTermStructureLoader } from "./live-term-structure.js";

const now = 1800000000;
const expiry = now + 86400 * 10;
const chain = [{ name: "call", expiry, strike: 100, side: "C" }, { name: "put", expiry, strike: 100, side: "P" }];
const quotes = (iv) => chain.map((instrument) => ({ ...instrument, spot: 100, iv, ts: now }));
const result = (iv) => ({ quotes: quotes(iv), failures: [], rateLimitWarning: null });

test("each refresh fetches new data instead of reusing the publication snapshot", async () => {
  let requests = 0;
  const load = createLiveTermStructureLoader({ fetchChain: async () => chain, fetchQuotes: async () => result(++requests === 1 ? 0.3 : 0.4), now: () => now + requests });
  const first = await load("BTC");
  const second = await load("BTC");
  assert.ok(Math.abs(first.term.current[0].iv - 0.3) < 1e-12);
  assert.ok(Math.abs(second.term.current[0].iv - 0.4) < 1e-12);
  assert.ok(second.refreshedAt > first.refreshedAt);
  assert.equal(second.asset, "BTC");
  assert.deepEqual(second.term.history, []);
});

test("a cancelled asset request cannot publish a late response", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const load = createLiveTermStructureLoader({ fetchChain: async () => chain, fetchQuotes: () => waiting, now: () => now });
  const controller = new AbortController();
  const pending = load("BTC", { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  release(result(0.3));
  await assert.rejects(pending, { name: "AbortError" });
});

test("an empty live response fails explicitly rather than masquerading as article data", async () => {
  const load = createLiveTermStructureLoader({ fetchChain: async () => chain, fetchQuotes: async () => ({ quotes: [], failures: [], rateLimitWarning: null }), now: () => now });
  await assert.rejects(load("ETH"), /No fresh ETH ATM quotes/);
});

test("partial quote failures remain disclosed with a usable curve", async () => {
  const load = createLiveTermStructureLoader({ fetchChain: async () => chain, fetchQuotes: async () => ({ ...result(0.3), failures: ["missing instrument"] }), now: () => now });
  assert.match((await load("BTC")).warning, /1 option quotes unavailable/);
});
