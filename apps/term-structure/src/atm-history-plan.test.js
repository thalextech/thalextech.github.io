import test from "node:test";
import assert from "node:assert/strict";
import { planAtmHistory } from "./atm-history-plan.js";
import { emptyArchive } from "./history-cache.js";

const chain = [80, 90, 100, 110, 120, 130].flatMap((strike) =>
  ["C", "P"].map((side) => ({
    name: `${strike}-${side}`,
    expiry: 1000000,
    strike,
    side,
  })),
);
const summarize = (plan) =>
  Object.fromEntries(
    plan.map(({ instrument, hours }) => [instrument.name, [...hours]]),
  );

test("ATM chooses both sides of each hour's spot bracket and combines hours per instrument", () => {
  const cache = emptyArchive();
  assert.deepEqual(
    summarize(
      planAtmHistory(
        chain,
        cache,
        new Map([
          [0, 95],
          [3600, 105],
          [7200, 95],
        ]),
        0,
        10799,
      ),
    ),
    {
      "90-C": [0, 7200],
      "90-P": [0, 7200],
      "100-C": [0, 3600, 7200],
      "100-P": [0, 3600, 7200],
      "110-C": [3600],
      "110-P": [3600],
    },
  );
});

test("exact spot needs one strike; a cached call still requires checking its put", () => {
  const cache = emptyArchive();
  cache.marks.set("100-C", {
    ...chain.find((i) => i.name === "100-C"),
    rows: new Map([[0, 0.4]]),
  });
  assert.deepEqual(
    summarize(planAtmHistory(chain, cache, new Map([[0, 100]]), 0, 3599)),
    {
      "100-P": [0],
    },
  );
});

test("confirmed empty brackets widen; failed or expired checks remain unresolved", () => {
  const cache = emptyArchive(),
    spots = new Map([[0, 95]]);
  for (const name of ["90-C", "90-P", "100-C", "100-P"])
    cache.checked.set(name, [{ from: 0, to: 3599, expires: 200 }]);
  assert.deepEqual(
    Object.keys(summarize(planAtmHistory(chain, cache, spots, 0, 3599, 100))),
    ["80-C", "80-P", "110-C", "110-P"],
  );
  assert.deepEqual(
    Object.keys(summarize(planAtmHistory(chain, cache, spots, 0, 3599, 300))),
    ["90-C", "90-P", "100-C", "100-P"],
  );
});

test("planning respects listing times, request bounds and expiry isolation", () => {
  const cache = emptyArchive();
  cache.marks.set("other-expiry", {
    expiry: 9999999,
    strike: 95,
    side: "C",
    rows: new Map([[0, 0.4]]),
  });
  const listed = chain.map((i) =>
    i.strike === 90 ? { ...i, listedAt: 3600 } : i,
  );
  assert.deepEqual(
    Object.keys(
      summarize(
        planAtmHistory(
          listed,
          cache,
          new Map([
            [-3600, 95],
            [0, 95],
            [3600, 105],
          ]),
          0,
          3599,
        ),
      ),
    ),
    ["80-C", "80-P", "100-C", "100-P"],
  );
});
