const API_BASE = "https://thalex.com/api/v2/public";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "thalex-cache-vol";

function getLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

function isCacheFresh(timestamp) {
  return (
    typeof timestamp === "number" && Date.now() - timestamp <= CACHE_TTL_MS
  );
}

function readCache(key) {
  const storage = getLocalStorage();
  if (!storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!isCacheFresh(parsed.timestamp)) {
    storage.removeItem(key);
    return null;
  }
  if (!Array.isArray(parsed.rows)) {
    storage.removeItem(key);
    return null;
  }
  return {
    rows: parsed.rows,
    meta: parsed.meta,
  };
}

function writeCache(key, rows, meta) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const payload = {
      timestamp: Date.now(),
      rows,
      meta,
    };
    storage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to write cache", error);
  }
}

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

export async function fetchInstruments() {
  const url = makeUrl("/instruments", {});
  const json = await getJson(url);
  const result = json?.result;
  if (!Array.isArray(result)) return [];
  return result.map((instrument) => {
    if (!instrument || typeof instrument !== "object") return instrument;
    return {
      ...instrument,
      create_time_ms: instrument.create_time,
    };
  });
}

export async function fetchTicker(instrument_name) {
  const url = makeUrl("/ticker", { instrument_name });
  const json = await getJson(url);
  const result = json?.result ?? json;
  return {
    mark_price: result?.mark_price ?? result?.mark ?? result?.price ?? result?.last_price,
    index_price: result?.index_price ?? result?.index ?? result?.underlying_price,
    underlying_price: result?.underlying_price ?? result?.index_price ?? result?.index,
    strike_price: result?.strike_price ?? result?.strike,
    bid: result?.bid,
    ask: result?.ask,
    best_bid: result?.best_bid,
    best_ask: result?.best_ask,
  };
}

export async function fetchIndexHistory({
  index_name,
  resolution,
  from,
  to,
} = {}) {
  const cacheKey = `${CACHE_PREFIX}:index:${index_name}:${resolution}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return (cached.rows || []).map((row) => ({
      ts: row[0],
      index_price_open: row[1],
      index_price_high: row[2],
      index_price_low: row[3],
      index_price_close: row[4],
    }));
  }

  const url = makeUrl("/index_price_historical_data", {
    index_name,
    resolution,
    from,
    to,
  });
  const json = await getJson(url);
  const rows = json?.result?.index;
  if (!Array.isArray(rows)) return [];

  writeCache(cacheKey, rows, { index_name, resolution });

  return rows.map((row) => ({
    ts: row[0],
    index_price_open: row[1],
    index_price_high: row[2],
    index_price_low: row[3],
    index_price_close: row[4],
  }));
}

/**
 * Calculate realized volatility from index price data
 * Realized volatility is the standard deviation of log returns, annualized
 */
export function computeVolatilitySeries({ index, resolution, windowSize = 20 }) {
  if (!index || index.length === 0) return [];

  // Calculate periods per year based on resolution
  const resolutionSeconds = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
  }[resolution] || 24 * 60 * 60;

  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
  const periodsPerYear = SECONDS_PER_YEAR / resolutionSeconds;
  const annualizationFactor = Math.sqrt(periodsPerYear);

  const result = [];
  
  // Calculate log returns
  const returns = [];
  for (let i = 1; i < index.length; i++) {
    const prev = index[i - 1].index_price_close;
    const curr = index[i].index_price_close;
    
    if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      const logReturn = Math.log(curr / prev);
      returns.push({
        ts: index[i].ts,
        date: new Date(index[i].ts * 1000),
        logReturn,
        index_price_close: curr,
        index_price_open: index[i].index_price_open,
        index_price_high: index[i].index_price_high,
        index_price_low: index[i].index_price_low,
      });
    }
  }

  // Calculate rolling realized volatility
  for (let i = windowSize - 1; i < returns.length; i++) {
    const window = returns.slice(i - windowSize + 1, i + 1);
    const logReturns = window.map(r => r.logReturn);
    
    // Calculate mean return
    const meanReturn = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
    
    // Calculate variance
    const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / logReturns.length;
    
    // Standard deviation (realized volatility)
    const stdDev = Math.sqrt(variance);
    
    // Annualize
    const realizedVol = stdDev * annualizationFactor * 100; // Convert to percentage
    
    const current = returns[i];
    result.push({
      ts: current.ts,
      date: current.date,
      index_price_close: current.index_price_close,
      index_price_open: current.index_price_open,
      index_price_high: current.index_price_high,
      index_price_low: current.index_price_low,
      realized_vol: Number.isFinite(realizedVol) ? realizedVol : null,
    });
  }

  return result;
}

function parseExpirationDate(instrument) {
  // Try expiration_timestamp first (Unix timestamp in seconds)
  if (instrument.expiration_timestamp) {
    return new Date(instrument.expiration_timestamp * 1000);
  }

  // Try expiry_date (format: "2026-06-26")
  if (instrument.expiry_date) {
    const parsed = new Date(instrument.expiry_date);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Try expiration field
  if (instrument.expiration) {
    if (typeof instrument.expiration === "number") {
      return new Date(instrument.expiration * 1000);
    }
    const parsed = new Date(instrument.expiration);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Fallback: try to parse from instrument name (e.g., BTC-26JUN26-70000-P)
  const name = instrument.instrument_name || "";
  const match = name.match(/(\d{2}[A-Z]{3}\d{2})/);
  if (match) {
    const dateStr = match[1];
    const day = parseInt(dateStr.slice(0, 2), 10);
    const monthStr = dateStr.slice(2, 5);
    const year = 2000 + parseInt(dateStr.slice(5, 7), 10);
    const monthMap = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const month = monthMap[monthStr];
    if (month !== undefined) {
      return new Date(Date.UTC(year, month, day));
    }
  }

  return null;
}

function extractStrike(instrument) {
  // First try strike_price field (most reliable)
  if (instrument.strike_price !== undefined && instrument.strike_price !== null) {
    return Number(instrument.strike_price);
  }
  
  // Fallback to strike field
  if (instrument.strike !== undefined && instrument.strike !== null) {
    return Number(instrument.strike);
  }
  
  // Last resort: try to extract from instrument name (e.g., BTC-26JUN26-70000-P)
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
  
  // Options are marked with product "OBTCUSD" or "OETHUSD" and type "option"
  // Check both product and type to be sure
  const isOptionProduct = product === "OBTCUSD" || product === "OETHUSD";
  const isOptionType = instrumentType === "option";
  
  if (isOptionProduct && isOptionType) {
    // Verify underlying matches
    const instrumentUnderlying = (instrument.underlying || "").toUpperCase();
    if (instrumentUnderlying === underlyingName) {
      return true;
    }
  }
  
  return false;
}

/**
 * Calculate implied volatility using Black-Scholes approximation
 * This is a simplified version - in production you'd use a proper IV solver
 */
function calculateIV(optionPrice, spotPrice, strike, timeToExpiry, isCall, riskFreeRate = 0) {
  if (!optionPrice || !spotPrice || !strike || !timeToExpiry || timeToExpiry <= 0) {
    return null;
  }

  // Simple approximation: IV ≈ price / (spot * sqrt(T)) * sqrt(2π)
  // This is a rough estimate - for accurate IV you'd need iterative solving
  const T = timeToExpiry / 365.0; // Convert days to years
  if (T <= 0) return null;

  // Rough IV approximation
  const moneyness = Math.abs(Math.log(spotPrice / strike));
  const intrinsicValue = isCall 
    ? Math.max(0, spotPrice - strike)
    : Math.max(0, strike - spotPrice);
  const timeValue = Math.max(0, optionPrice - intrinsicValue);
  
  if (timeValue <= 0 || T <= 0) return null;
  
  // Rough approximation: IV ≈ timeValue / (spot * sqrt(T)) * sqrt(2π)
  const ivApprox = (timeValue / spotPrice) * Math.sqrt(2 * Math.PI / T) * 100;
  
  return Number.isFinite(ivApprox) && ivApprox > 0 ? ivApprox : null;
}

export async function fetchOptionsData(indexName) {
  try {
    console.log("Fetching options data for index:", indexName);
    const allInstruments = await fetchInstruments();
    console.log("Total instruments fetched:", allInstruments.length);
    
    // Filter option instruments for the given index
    const optionInstruments = allInstruments.filter((inst) =>
      isOptionInstrument(inst, indexName)
    );
    console.log("Option instruments found:", optionInstruments.length);
    
    if (optionInstruments.length === 0) {
      // Check for instruments with OBTCUSD or OETHUSD product
      const optionProducts = allInstruments.filter(i => {
        const product = i.product || "";
        return product === "OBTCUSD" || product === "OETHUSD" || 
               product === "obtcusd" || product === "oethusd";
      });
      console.log("Instruments with option products (OBTCUSD/OETHUSD):", optionProducts.length);
      
      if (optionProducts.length > 0) {
        console.log("Sample option products:", optionProducts.slice(0, 3).map(i => ({
          name: i.instrument_name,
          product: i.product,
          type: i.type || i.instrument_type,
          underlying: i.underlying
        })));
      }
      
      console.warn("No option instruments found. Sample all instruments:", 
        allInstruments.slice(0, 10).map(i => ({ 
          name: i.instrument_name, 
          type: i.type || i.instrument_type,
          product: i.product,
          underlying: i.underlying 
        }))
      );
    }

    // Get current index price - try multiple methods
    let indexPrice = null;
    
    // Method 1: Try perpetual contract
    try {
      const perpetualName = `${indexName}-PERPETUAL`;
      console.log("Fetching index price for:", perpetualName);
      const indexTicker = await fetchTicker(perpetualName);
      indexPrice = indexTicker.index_price || indexTicker.mark_price;
      console.log("Index price (perpetual):", indexPrice);
    } catch (e) {
      console.warn("Failed to fetch index price from perpetual", e);
    }
    
    // Method 2: Try index name directly
    if (!indexPrice) {
      try {
        const indexTicker = await fetchTicker(indexName);
        indexPrice = indexTicker.index_price || indexTicker.mark_price;
        console.log("Index price (direct):", indexPrice);
      } catch (e2) {
        console.warn("Failed to fetch index price directly", e2);
      }
    }
    
    // Method 3: Get from first option's ticker (check strike_price field for underlying price)
    if (!indexPrice && optionInstruments.length > 0) {
      try {
        const firstOption = optionInstruments[0];
        const optionTicker = await fetchTicker(firstOption.instrument_name);
        // Check strike_price field first (as user indicated), then fallback to other fields
        indexPrice = optionTicker.strike_price || optionTicker.underlying_price || optionTicker.index_price;
        console.log("Index price (from option ticker strike_price):", indexPrice);
      } catch (e3) {
        console.warn("Failed to fetch index price from option ticker", e3);
      }
    }
    
    if (!indexPrice) {
      console.error("Could not fetch index price from any source. Options will be processed but ATM selection may be inaccurate.");
    }

    // Group by expiration date
    const byExpiration = new Map();
    let skippedNoExpiration = 0;
    
    for (const inst of optionInstruments) {
      const expirationDate = parseExpirationDate(inst);
      if (!expirationDate) {
        skippedNoExpiration++;
        continue;
      }
      
      const daysToExpiry = Math.ceil(
        (expirationDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      );
      
      if (daysToExpiry <= 0) continue; // Skip expired options
      
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
      // Check option_type field first (most reliable: "call" or "put")
      const optionType = (inst.option_type || "").toLowerCase();
      const isCall = optionType === "call" || 
                     (inst.instrument_name || "").toUpperCase().includes("-C-") ||
                     inst.type === "call";
      
      if (isCall) {
        group.calls.push(inst);
      } else {
        group.puts.push(inst);
      }
    }
    
    console.log(`Grouped ${byExpiration.size} expirations (skipped ${skippedNoExpiration} with no expiration date)`);

    // Process each expiration to find ATM straddles
    const results = [];
    let skippedNoStrikes = 0;
    let skippedNoATM = 0;
    let skippedNoPrices = 0;
    
    for (const [expiryTime, group] of byExpiration) {
      // If we don't have index price, try to get it from the first option's ticker
      let currentIndexPrice = indexPrice;
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:450',message:'Checking index price before processing expiration',data:{hasIndexPrice:!!indexPrice,indexPrice,expirationDate:group.expirationDate.toISOString(),callsCount:group.calls.length,putsCount:group.puts.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      
      if (!currentIndexPrice || currentIndexPrice <= 0) {
        // Try to get underlying price from one of the options in this expiration
        const firstOption = [...group.calls, ...group.puts][0];
        if (firstOption) {
          try {
            const optionTicker = await fetchTicker(firstOption.instrument_name);
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:460',message:'Option ticker response for underlying price',data:{optionTicker,firstOptionName:firstOption.instrument_name,strikePrice:optionTicker.strike_price,underlyingPrice:optionTicker.underlying_price,indexPriceField:optionTicker.index_price},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            
            // Check strike_price field first (as user indicated), then fallback to other fields
            currentIndexPrice = optionTicker.strike_price || optionTicker.underlying_price || optionTicker.index_price;
            if (currentIndexPrice) {
              console.log(`Using underlying price (from strike_price) from option ${firstOption.instrument_name}:`, currentIndexPrice);
            }
          } catch (e) {
            console.warn(`Failed to get underlying price from option ${firstOption.instrument_name}`, e);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:468',message:'Failed to fetch option ticker for underlying price',data:{error:e.message,firstOptionName:firstOption.instrument_name},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
            // #endregion
          }
        }
      }
      
      if (!currentIndexPrice || currentIndexPrice <= 0) {
        console.warn(`Skipping expiration ${group.expirationDate.toISOString()} - no index price available`);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:475',message:'Skipping expiration - no index price',data:{expirationDate:group.expirationDate.toISOString(),currentIndexPrice},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        continue;
      }
      
      // Find ATM strike (closest to current index price)
      const allStrikes = new Set();
      [...group.calls, ...group.puts].forEach((inst) => {
        const strike = extractStrike(inst);
        if (strike) allStrikes.add(strike);
      });
      
      const strikes = Array.from(allStrikes).sort((a, b) => a - b);
      if (strikes.length === 0) {
        skippedNoStrikes++;
        continue;
      }
      
      // Find closest strike to ATM
      const atmStrike = strikes.reduce((prev, curr) =>
        Math.abs(curr - currentIndexPrice) < Math.abs(prev - currentIndexPrice) ? curr : prev
      );
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:512',message:'ATM strike selection',data:{currentIndexPrice,strikes:strikes.slice(0,10),atmStrike,strikesCount:strikes.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Find call and put at ATM strike
      const atmCall = group.calls.find(
        (inst) => Math.abs(extractStrike(inst) - atmStrike) < 0.01
      );
      const atmPut = group.puts.find(
        (inst) => Math.abs(extractStrike(inst) - atmStrike) < 0.01
      );
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:522',message:'ATM call/put matching',data:{atmStrike,hasAtmCall:!!atmCall,hasAtmPut:!!atmPut,atmCallName:atmCall?.instrument_name,atmPutName:atmPut?.instrument_name,callsCount:group.calls.length,putsCount:group.puts.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      if (!atmCall || !atmPut) {
        skippedNoATM++;
        console.log(`No ATM pair found for expiration ${group.expirationDate.toISOString()}, strikes:`, strikes.slice(0, 5));
        continue;
      }
      
      try {
        // Fetch ticker data for both options
        const [callTicker, putTicker] = await Promise.all([
          fetchTicker(atmCall.instrument_name),
          fetchTicker(atmPut.instrument_name),
        ]);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:482',message:'Option ticker response structure',data:{callTicker,putTicker,atmCallName:atmCall.instrument_name,atmPutName:atmPut.instrument_name,currentIndexPrice},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        const callPrice = callTicker.mark_price || 
                        (callTicker.best_bid && callTicker.best_ask 
                          ? (callTicker.best_bid + callTicker.best_ask) / 2 
                          : null);
        const putPrice = putTicker.mark_price || 
                        (putTicker.best_bid && putTicker.best_ask 
                          ? (putTicker.best_bid + putTicker.best_ask) / 2 
                          : null);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/543bd467-bb78-464d-af39-a1e58724a314',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'thalex.js:495',message:'Extracted prices and checking availability',data:{callPrice,putPrice,hasCallPrice:!!callPrice,hasPutPrice:!!putPrice},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        if (!callPrice || !putPrice) continue;
        
        const straddleCost = callPrice + putPrice;
        
        // Calculate IV (use average of call and put IV)
        const callIV = calculateIV(
          callPrice,
          currentIndexPrice,
          atmStrike,
          group.daysToExpiry,
          true
        );
        const putIV = calculateIV(
          putPrice,
          currentIndexPrice,
          atmStrike,
          group.daysToExpiry,
          false
        );
        
        const avgIV = callIV && putIV 
          ? (callIV + putIV) / 2 
          : callIV || putIV;
        
        // Calculate implied variance: (IV/100)^2
        let impliedVariance = null;
        if (avgIV !== null && avgIV !== undefined && Number.isFinite(avgIV)) {
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
        console.warn(`Failed to fetch data for expiration ${group.expirationDate}`, e);
      }
    }
    
    // Sort by expiration date
    return results.sort((a, b) => a.expirationDate - b.expirationDate);
  } catch (e) {
    console.error("Failed to fetch options data", e);
    return [];
  }
}
