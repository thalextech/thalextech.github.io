import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchHistoricalQuotes,
  fetchLiveQuotes,
  fetchOptionChain,
  HISTORY_LIMIT,
  HOUR,
} from "./market-data.js";
import { emptyArchive } from "./history-cache.js";
const chain = [
  {
    name: "BTC-TEST-C",
    expiry: Date.now() / 1000 + 86400,
    strike: 100,
    side: "C",
  },
];
const bar = (ts, iv) => [ts, 1, 1, 1, 1, iv, iv, iv, iv];
test("history pages backwards, joins exact index timestamps and labels completed bar closes", async (t) => {
  const to = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 1;
  const from = to + 1 - HISTORY_LIMIT * HOUR;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input),
      end = Number(url.searchParams.get("to"));
    calls.push(url);
    let result;
    if (url.pathname.endsWith("index_price_historical_data"))
      result =
        end === to
          ? { index: [[from + HOUR, 100, 100, 100, 101]] }
          : { index: [[from, 100, 100, 100, 100]] };
    else
      result = {
        mark: [
          bar(from, 0.4),
          bar(from + HOUR, 0.5),
          bar(from + 2 * HOUR, 0.7),
        ],
      };
    return { ok: true, json: async () => ({ result }) };
  });
  const { quotes, failures } = await fetchHistoricalQuotes(chain, "BTC", {
    archive: emptyArchive(),
  });
  assert.equal(failures.length, 0);
  assert.equal(quotes.length, 2);
  assert.deepEqual(
    quotes.map((q) => q.ts),
    [from + HOUR, from + 2 * HOUR],
  );
  assert.deepEqual(
    quotes.map((q) => q.spot),
    [100, 101],
  );
  assert.ok(calls.every((url) => url.searchParams.get("count") === "2000"));
});
test("explicit no_data is accepted; malformed history is reported as a partial failure", async (t) => {
  const ts = Math.floor(Date.now() / 1000 / HOUR) * HOUR - HOUR;
  let payload = { no_data: true };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    const result = url.pathname.endsWith("index_price_historical_data")
      ? Number(url.searchParams.get("to")) < ts
        ? { no_data: true }
        : { index: [[ts, 100, 100, 100, 100]] }
      : payload;
    return { ok: true, json: async () => ({ result }) };
  });
  assert.deepEqual(
    (await fetchHistoricalQuotes(chain, "BTC", { archive: emptyArchive() }))
      .quotes,
    [],
  );
  for (const missing of [{}, { instrument_type: "option" }]) {
    payload = missing;
    const result = await fetchHistoricalQuotes(chain, "BTC", {
      archive: emptyArchive(),
    });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.quotes, []);
  }
  payload = { mark: {} };
  assert.equal(
    (await fetchHistoricalQuotes(chain, "BTC", { archive: emptyArchive() }))
      .failures.length,
    1,
  );
});
test("chain filters assets/expired contracts; snapshots bypass cache and reject stale marks", async (t) => {
  const now = Date.now() / 1000;
  let ticker = false;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(options.cache, "no-store");
    const result = ticker
      ? { iv: 0.4, index: 100, mark_timestamp: now - 180 }
      : [
          {
            type: "option",
            underlying: "BTCUSD",
            expiration_timestamp: now + 1000,
            instrument_name: "test",
            option_type: "call",
            strike_price: 100,
          },
          {
            type: "option",
            underlying: "ETHUSD",
            expiration_timestamp: now + 1000,
          },
          {
            type: "option",
            underlying: "BTCUSD",
            expiration_timestamp: now - 1,
          },
        ];
    return { ok: true, json: async () => ({ result }) };
  });
  assert.equal((await fetchOptionChain("BTC")).length, 1);
  ticker = true;
  const live = await fetchLiveQuotes(chain);
  assert.equal(live.quotes.length, 0);
  assert.equal(live.failures.length, 1);
});
test("cancellation stops fetching", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchOptionChain("BTC", controller.signal), {
    name: "AbortError",
  });
});

test("cached history plus API tail merges once, retains cached strikes and is reused on refresh", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const archive = emptyArchive();
  for (let ts = from; ts < end - HOUR; ts += HOUR)
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
  archive.marks.set(chain[0].name, {
    ...chain[0],
    rows: new Map([[end - 2 * HOUR, 0.4]]),
  });
  archive.marks.set("delisted-strike", {
    ...chain[0],
    name: "delisted-strike",
    strike: 110,
    rows: new Map([[end - 2 * HOUR, 0.6]]),
  });
  const active = [{ ...chain[0], listedAt: end - 2 * HOUR }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(Number(url.searchParams.get("from")), end - HOUR);
    const result = url.pathname.endsWith("index_price_historical_data")
      ? { index: [[end - HOUR, 101, 103, 99, 102]] }
      : { mark: [bar(end - HOUR, 0.5)] };
    return { ok: true, json: async () => ({ result }) };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.quotes.length, 3);
  assert.equal(result.quotes.find((q) => q.ts === end).spot, 102);
  assert.deepEqual(result.coverage, {
    cachedIndexRows: 1999,
    cachedMarkRows: 2,
    apiIndexRows: 1,
    apiMarkRows: 1,
  });
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 2);
});

test("index pagination retains more than 2,000 hours when long-expiry RV requires it", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const requiredHours = 2100;
  const active = [
    { ...chain[0], expiry: end + requiredHours * HOUR, listedAt: end },
  ];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input),
      to = Number(url.searchParams.get("to"));
    const last = Math.floor(to / HOUR) * HOUR;
    const from = Math.max(end - requiredHours * HOUR, last - 1999 * HOUR);
    const index = [];
    for (let ts = from; ts <= last; ts += HOUR)
      index.push([ts, 100, 101, 99, 100]);
    return { ok: true, json: async () => ({ result: { index } }) };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive: emptyArchive(),
    asOf: end,
  });
  assert.equal(result.indexBars.length, requiredHours);
  assert.equal(result.indexBars[0].ts, end - requiredHours * HOUR);
});

test("cached history publishes before network requests, then updates after each expiry completes", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const active = [
    { ...chain[0], listedAt: end - 2 * HOUR },
    {
      ...chain[0],
      name: "BTC-NEXT-C",
      expiry: chain[0].expiry + 86400,
      listedAt: end - 2 * HOUR,
    },
  ];
  const archive = emptyArchive();
  for (let ts = from; ts < end; ts += HOUR)
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
  for (const instrument of active)
    archive.marks.set(instrument.name, {
      ...instrument,
      rows: new Map([[end - 2 * HOUR, 0.4]]),
    });
  const updates = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.ok(
      updates.length > 0,
      "cached data must be published before any API request",
    );
    assert.equal(new URL(input).searchParams.get("from"), String(end - HOUR));
    return {
      ok: true,
      json: async () => ({ result: { mark: [bar(end - HOUR, 0.5)] } }),
    };
  });
  await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
    onUpdate: (data) => updates.push(data.quotes),
  });
  assert.equal(updates[0].length, 2);
  assert.ok(updates.some((quotes) => quotes.length === 3));
  assert.equal(updates.at(-1).length, 4);
});

test("missing index hours do not trigger unusable per-option history requests", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const archive = emptyArchive(),
    rows = new Map(),
    missing = end - 3 * HOUR;
  for (let ts = from; ts < end; ts += HOUR) {
    if (ts === missing) continue;
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
    rows.set(ts, 0.4);
  }
  archive.marks.set(chain[0].name, { ...chain[0], rows });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.ok(url.pathname.endsWith("index_price_historical_data"));
    return { ok: true, json: async () => ({ result: {} }) };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.quotes.length, 1999);
  await fetchHistoricalQuotes(chain, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 1);
});
