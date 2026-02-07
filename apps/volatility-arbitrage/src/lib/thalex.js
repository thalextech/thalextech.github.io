import { fetchInstruments } from "../../../../lib/thalex.js";

const API_BASE = "https://thalex.com/api/v2/public";

async function getJson(url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        json?.error?.message ||
        json?.message ||
        `Request failed (${res.status})`;
      throw new Error(message);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function makeUrl(path, params = {}) {
  const search = new URLSearchParams(params);
  return `${API_BASE}${path}?${search}`;
}

async function fetchTicker(instrument_name) {
  const url = makeUrl("/ticker", { instrument_name });
  const json = await getJson(url);
  const result = json?.result ?? json;
  return {
    mark_price:
      result?.mark_price ?? result?.mark ?? result?.price ?? result?.last_price,
    index_price:
      result?.index_price ?? result?.index ?? result?.underlying_price,
    underlying_price:
      result?.underlying_price ?? result?.index_price ?? result?.index,
    strike_price: result?.strike_price ?? result?.strike,
    bid: result?.bid,
    ask: result?.ask,
    best_bid: result?.best_bid,
    best_ask: result?.best_ask,
    iv: result?.iv, // IV as decimal (e.g., 0.68 = 68%)
  };
}

function parseExpirationDate(instrument) {
  if (instrument.expiration_timestamp) {
    return new Date(instrument.expiration_timestamp * 1000);
  }
  if (instrument.expiry_date) {
    const parsed = new Date(instrument.expiry_date);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (instrument.expiration) {
    if (typeof instrument.expiration === "number") {
      return new Date(instrument.expiration * 1000);
    }
    const parsed = new Date(instrument.expiration);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  const name = instrument.instrument_name || "";
  const match = name.match(/(\d{2}[A-Z]{3}\d{2})/);
  if (match) {
    const dateStr = match[1];
    const day = parseInt(dateStr.slice(0, 2), 10);
    const monthStr = dateStr.slice(2, 5);
    const year = 2000 + parseInt(dateStr.slice(5, 7), 10);
    const monthMap = {
      JAN: 0,
      FEB: 1,
      MAR: 2,
      APR: 3,
      MAY: 4,
      JUN: 5,
      JUL: 6,
      AUG: 7,
      SEP: 8,
      OCT: 9,
      NOV: 10,
      DEC: 11,
    };
    const month = monthMap[monthStr];
    if (month !== undefined) {
      return new Date(Date.UTC(year, month, day));
    }
  }
  return null;
}

function extractStrike(instrument) {
  if (instrument.strike_price !== undefined && instrument.strike_price !== null) {
    return Number(instrument.strike_price);
  }
  if (instrument.strike !== undefined && instrument.strike !== null) {
    return Number(instrument.strike);
  }
  const name = (instrument.instrument_name || "").toUpperCase();
  const strikeMatch = name.match(/-(\d+)-[CP]/);
  if (strikeMatch) {
    return parseFloat(strikeMatch[1]);
  }
  return null;
}

function isOptionInstrument(instrument, underlying) {
  if (!instrument) return false;
  const product = instrument.product || "";
  const instrumentType = instrument.type || instrument.instrument_type || "";
  const underlyingName = (underlying || "").toUpperCase();
  const isOptionProduct = product === "OBTCUSD" || product === "OETHUSD";
  const isOptionType = instrumentType === "option";
  if (isOptionProduct && isOptionType) {
    const instrumentUnderlying = (instrument.underlying || "").toUpperCase();
    if (instrumentUnderlying === underlyingName) {
      return true;
    }
  }
  return false;
}

export async function fetchOptionsData(indexName) {
  try {
    const allInstruments = await fetchInstruments();
    const optionInstruments = allInstruments.filter((inst) =>
      isOptionInstrument(inst, indexName),
    );

    if (optionInstruments.length === 0) {
      return [];
    }

    let indexPrice = null;
    try {
      const perpetualName = `${indexName}-PERPETUAL`;
      const indexTicker = await fetchTicker(perpetualName);
      indexPrice = indexTicker.index_price || indexTicker.mark_price;
    } catch (e) {
      // Ignore - try alternative methods
    }

    if (!indexPrice) {
      try {
        const indexTicker = await fetchTicker(indexName);
        indexPrice = indexTicker.index_price || indexTicker.mark_price;
      } catch (e) {
        // Ignore
      }
    }

    const byExpiration = new Map();
    for (const inst of optionInstruments) {
      const expirationDate = parseExpirationDate(inst);
      if (!expirationDate) continue;

      const daysToExpiry = Math.ceil(
        (expirationDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      );
      if (daysToExpiry <= 0) continue;

      const key = expirationDate.getTime();
      if (!byExpiration.has(key)) {
        byExpiration.set(key, {
          expirationDate,
          daysToExpiry,
          calls: [],
          puts: [],
        });
      }

      const group = byExpiration.get(key);
      const optionType = (inst.option_type || "").toLowerCase();
      const isCall =
        optionType === "call" ||
        (inst.instrument_name || "").toUpperCase().includes("-C-") ||
        inst.type === "call";

      if (isCall) {
        group.calls.push(inst);
      } else {
        group.puts.push(inst);
      }
    }

    const results = [];
    for (const [, group] of byExpiration) {
      let currentIndexPrice = indexPrice;

      if (!currentIndexPrice || currentIndexPrice <= 0) {
        const firstOption = [...group.calls, ...group.puts][0];
        if (firstOption) {
          try {
            const optionTicker = await fetchTicker(firstOption.instrument_name);
            currentIndexPrice =
              optionTicker.underlying_price || optionTicker.index_price;
          } catch (e) {
            // Ignore
          }
        }
      }

      if (!currentIndexPrice || currentIndexPrice <= 0) {
        continue;
      }

      const allStrikes = new Set();
      [...group.calls, ...group.puts].forEach((inst) => {
        const strike = extractStrike(inst);
        if (strike) allStrikes.add(strike);
      });

      const strikes = Array.from(allStrikes).sort((a, b) => a - b);
      if (strikes.length === 0) continue;

      const atmStrike = strikes.reduce((prev, curr) =>
        Math.abs(curr - currentIndexPrice) < Math.abs(prev - currentIndexPrice)
          ? curr
          : prev,
      );

      const atmCall = group.calls.find(
        (inst) => Math.abs(extractStrike(inst) - atmStrike) < 0.01,
      );
      const atmPut = group.puts.find(
        (inst) => Math.abs(extractStrike(inst) - atmStrike) < 0.01,
      );

      if (!atmCall || !atmPut) continue;

      try {
        const [callTicker, putTicker] = await Promise.all([
          fetchTicker(atmCall.instrument_name),
          fetchTicker(atmPut.instrument_name),
        ]);

        const callPrice =
          callTicker.mark_price ||
          (callTicker.best_bid && callTicker.best_ask
            ? (callTicker.best_bid + callTicker.best_ask) / 2
            : null);
        const putPrice =
          putTicker.mark_price ||
          (putTicker.best_bid && putTicker.best_ask
            ? (putTicker.best_bid + putTicker.best_ask) / 2
            : null);

        if (!callPrice || !putPrice) continue;

        const straddleCost = callPrice + putPrice;

        // Use API-provided IV (returned as decimal, convert to percentage)
        const callIV = Number.isFinite(callTicker.iv) ? callTicker.iv * 100 : null;
        const putIV = Number.isFinite(putTicker.iv) ? putTicker.iv * 100 : null;
        const avgIV = callIV && putIV ? (callIV + putIV) / 2 : callIV || putIV;

        let impliedVariance = null;
        if (avgIV !== null && Number.isFinite(avgIV)) {
          impliedVariance = Math.pow(avgIV / 100, 2);
        }

        results.push({
          expirationDate: group.expirationDate,
          daysToExpiry: group.daysToExpiry,
          strike: atmStrike,
          indexPrice: currentIndexPrice,
          callPrice,
          putPrice,
          straddleCost,
          iv: avgIV,
          impliedVariance,
        });
      } catch (e) {
        // Skip this expiration on error
      }
    }

    return results.sort((a, b) => a.expirationDate - b.expirationDate);
  } catch (e) {
    return [];
  }
}
