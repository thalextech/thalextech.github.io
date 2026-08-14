import assert from "node:assert/strict";
import test from "node:test";
import type { AtmOptionExpiryQuote } from "../src/lib/atmOptionChain.ts";
import {
  closestExpirationTs,
  maturityOptionsForQuotes,
  selectableExpiryQuotes,
} from "../src/lib/stopLossMaturity.ts";

const DAY = 24 * 60 * 60;
const valuationTs = 1_700_000_000;

const quote = (
  days: number,
  putInstrumentName: string | null = `BTC-${days}D-P`,
): AtmOptionExpiryQuote => ({
  expirationTs: valuationTs + days * DAY,
  strike: 60_000,
  callInstrumentName: `BTC-${days}D-C`,
  putInstrumentName,
  callIv: 0.5,
  callMark: 1_000,
  putMark: 1_000,
  fetchedAt: valuationTs * 1_000,
});

test("maturity options represent distinct eligible listed expiries", () => {
  const quotes = [quote(7), quote(14), quote(21), quote(42)];
  const selectable = selectableExpiryQuotes(quotes, valuationTs, 14, "up");

  assert.deepEqual(maturityOptionsForQuotes(selectable, valuationTs), [
    { label: "14d", value: valuationTs + 14 * DAY },
    { label: "21d", value: valuationTs + 21 * DAY },
    { label: "42d", value: valuationTs + 42 * DAY },
  ]);
});

test("short maturity options exclude expiries without a matching put", () => {
  const quotes = [quote(21, null), quote(42)];

  assert.deepEqual(
    selectableExpiryQuotes(quotes, valuationTs, 14, "down").map(
      ({ expirationTs }) => expirationTs,
    ),
    [valuationTs + 42 * DAY],
  );
});

test("the initial selection keeps the listed expiry nearest the target", () => {
  const quotes = [quote(21), quote(42), quote(133)];

  assert.equal(
    closestExpirationTs(quotes, valuationTs + 60 * DAY),
    valuationTs + 42 * DAY,
  );
});
