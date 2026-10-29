# Term structure

BTC / ETH volatility by live listed expiry. Explore historical dot clouds, compare against matched-window realized volatility, and export the chart as a high-resolution PNG.

```sh
npm ci
npm run dev
npm test
VITE_BASE_PATH=/term-structure/ npm run build
```

`dev` and `build` first run `build:data`, which reads the canonical Parquet files in `../backtest/source-data/thalex`. To regenerate the cache independently, run `npm run build:data`. The root app build discovers this app automatically; `index.yml` registers the home catalogue entry. No API keys or backend are needed. `VITE_THALEX_API_BASE` optionally overrides the public REST base. `VITE_THALEX_WS_URL` overrides the WebSocket endpoint; a custom non-Thalex REST base uses REST only unless an explicit WebSocket URL is supplied.

## Chart and settings

The compact top bar, typography, controls and shared `StyledSelectMenu` follow Straddle. The **Volatility** dropdown switches between **Expiry IV** (default) and **Forward vol** without making any new data requests. Both views show monochrome scatter clouds and support live marks/book fallback, delta slices, percentiles and PNG export. The round settings button in the chart opens a **Realized volatility** toggle. The current curve is solid white; RV is dashed with hollow markers. PNG exports contain only the chart SVG: title, both subtitles (snapshot timing, data source, history description and date range), axes, plotted values and RV overlay with a short legend. Coverage annotations, tooltips, controls, detail tables, methodology and request-status messages are excluded. Expiry details and methodology are collapsed below the chart, followed by small data-status footnotes.

## Data and interpolation

- **Live marks is the default.** Fresh quotes arrive through a single batched Thalex `public/subscribe` request for the chain’s `ticker.<instrument>.1000ms` channels. Each refresh collects a snapshot and closes the socket; this is not a continuously updating subscription. REST `ticker` requests fill only names missing from the bulk snapshot, or the whole chain if WebSocket is unavailable. Stale marks (>120 seconds) remain unavailable. **Book mid / mark fallback** solves IV from the best bid/ask midpoint using the ticker forward, an undiscounted Black model and a 365.25-day year, falling back to the same option’s mark IV when its book is empty, crossed or outside model bounds. A missing book never removes a valid mark quote. Snapshot timestamps disclose sequential collection.
- Historical IV uses closing mark IV and exact matching index closes for the latest 2,000 completed hours. Up to 2,000 interpolated observations are retained per currently live expiry; recently listed expiries and gaps in the bundled history can leave fewer observations. API backfill fills the gap between the actual Parquet coverage and the latest completed hour, within the existing lookback; there is no fixed 48-hour cap.
- ATM follows the notebook: average call/put squared IV per strike, interpolate variance between strikes around that observation’s spot, then take the square root. Spot outside available strikes uses a flagged nearest-strike fallback.
- 10Δ/25Δ put/call slices interpolate same-side variance in Black–Scholes spot delta, using zero rates/carry and the observation’s time to expiry. Unbracketed wings are omitted. This is an explicit approximation to exchange forward delta.
- Expiries are equally spaced. Scatter jitter changes x only. Percentiles use each expiry’s available sample, with half-weight for ties. Live book-mid percentiles compare to historical **mark** IV, not historical executable books.

## Forward volatility and its history

Forward mode shows fixed adjacent listed-expiry intervals: **Now → first expiry**, then **first → second**, **second → third**, and so on. Labels, tooltips, details and PNG filenames identify the selected view. The first interval equals the first expiry’s IV. Each subsequent interval uses:

`forwardVol = sqrt((IV_far² * (expiry_far - timestamp) - IV_near² * (expiry_near - timestamp)) / (expiry_far - expiry_near))`

The calculation differences **total variance**, not IV levels. Live inputs share the current snapshot reference time. Every historical observation is recomputed using its own remaining maturities and requires both legs at the **same UTC hour**. A missing intermediate maturity never causes the chart to bridge to a different interval. Historical percentiles and counts are recalculated from forward-vol observations, rather than reusing expiry-IV ranks. Exactly zero forward variance is valid; negative increments are omitted and disclosed rather than clamped to zero.

Forward values are derived from the selected ATM/delta IV slice. For delta wings in particular these are smile-slice forward estimates, not model-free forward variance or a fitted arbitrage-free surface. A nearest-strike flag propagates if either input IV used that fallback.

The RV overlay compares each forward bucket with the **most recent history of the same duration**. A forward bucket T₁ → T₂ ahead uses the latest T₂ − T₁ hours of OHLC, rounded up to whole hours. For example, day 7 → day 30 uses the most recent 23 days. All lookbacks end at the same latest available completed hour, so they overlap. The first bucket uses the same RV as the first expiry-IV point. RV is computed directly from bars in each lookback, rather than subtracting cumulative RV estimates. Each window independently requires 99% hourly coverage. No additional API data is required beyond the index history already loaded for the longest maturity.

Reference for total-variance differencing: [QuantLib Black forward-volatility implementation](https://github.com/lballabio/QuantLib/blob/master/ql/termstructures/volatility/equityfx/blackvoltermstructure.cpp).

## Realized volatility

For each expiry, calculate its time to maturity at the current snapshot and round **up** to a whole number of hours. Apply that same number of hours backwards, ending at the latest available completed hourly index bar before the snapshot. Publication lag therefore shifts the window end back to the most recent available close, which is shown in RV tooltips.

The Garman–Klass variance contribution of each OHLC bar is:

`v = 0.5 * ln(high / low)^2 - (2 * ln(2) - 1) * ln(close / open)^2`

Annualized RV is `sqrt(mean(v) * 24 * 365.25)`. No demeaning is applied. This OHLC estimator assumes a continuous, zero-drift process and does not capture unobserved jumps between bars. Missing, nonpositive or internally inconsistent OHLC bars are skipped. With at least **99% valid hourly coverage**, RV is estimated as the mean variance of the available bars across the full requested window; missing bars are not zero-filled and the lookback start/end are not shortened. Below 99% coverage, RV remains unavailable. The detail table shows RV, coverage, IV minus RV in percentage points, and exact valid/expected bar counts in the RV tooltip. Small gaps are disclosed through coverage and tooltips without markers on the chart. This assumes the available bars are representative of the small missing portion; material gaps are not estimated.

The canonical files contain a missing 09:00 UTC index bar on 21 October 2026; the public API also returns no data for that hour. That single gap no longer hides the longer-maturity RV points: their coverage is above 99%, with actual coverage shown in the detail table.

[Garman and Klass, original paper](https://www.cmegroup.com/trading/fx/files/a_estimation_of_security_price.pdf)

## Parquet reuse and incremental fetching

`build-history.mjs` reads all index OHLC and recent **closing** IVs from the canonical backtest Parquet files. It creates content-hashed index and per-expiry JSON shards in ignored `public/history-cache/`, plus small versioned manifests. This avoids reusing the backtest’s opening-IV artifacts or leaking their pricing conventions into this app. Building the app packages these static cache files automatically.

Live quotes and history load in parallel. The browser publishes cached index/history as shards arrive, before waiting for the API differential. Live quotes update as ticker messages arrive (UI changes are coalesced over 50 ms); historical corrections publish after each expiry finishes so a partly fetched strike ladder does not distort new hourly points. The expiry axis stays fixed while data fills in; cached history can render and export before any live quotes arrive.

The browser loads the asset’s index history and shards for its live expiries. It retains the full cached 2,000-hour scatter window and longer cached index history needed for RV. The build records separate **exclusive source-end timestamps** for index OHLC and option IV in the manifest, based on actual completed Parquet bars rather than build time. API backfill covers missing hours from each source boundary to the latest completed hour, even when the gap is longer than 48 hours. Gaps inside the older Parquet history remain as supplied. New expiries use the asset-wide IV boundary and their listing times, so an absent expiry shard cannot trigger unnecessary requests across the whole chart window. Cached data includes previously listed strikes for still-live expiries; fresh API supplementation uses currently listed instruments.

These source boundaries remain fixed while API additions accumulate in memory, so failed requests are still retried on refresh rather than skipped because a newer hour was fetched. Older manifests infer boundaries from the loaded bars. If a source cache is unavailable, the corresponding requested lookback bounds the API fallback (2,000 hours for scatter, or the longer required index window for RV).

For **ATM**, the request planner uses each historical hour’s index close to select the nearest strike below and above spot (one strike when spot matches exactly). It checks both call and put IVs so variance averaging is unchanged. Confirmed empty brackets widen to neighbouring strikes; request failures stop expansion for that expiry rather than being treated as proof of absent data. Required hours are combined into one request envelope within the backfill window per instrument per round, reusing extra returned hours. For **delta slices**, only the selected option side is supplemented across its strikes; narrowing delta strikes further would require assumptions about historical IV. Switching slice automatically backfills missing history using the existing chain and snapshot, without fetching live quotes again. The existing in-memory archive is shared across selections, so switching between put deltas reuses the same additions.

Known index gaps are skipped when selecting option hours because IV observations without matching index closes cannot be used. Index API pagination reaches its own Parquet boundary, independently of IV coverage. Longer RV lookbacks retain the existing coverage checks.

Successful additions are retained in memory per asset for the browser session. Content-hashed static shards use normal HTTP caching; manifests are revalidated on first load. Empty API windows are remembered for one minute, allowing later retry after publication lag. Missing/invalid static cache files trigger a disclosed API fallback bounded by the requested lookback. No IndexedDB or localStorage history persistence is used; reloading the page discards session additions. Live quotes are always fetched afresh. **Method and data** reports reused and fetched row counts. REST supplementation uses the shared rate-limit policy below; the batched WebSocket snapshot avoids one REST request per listed option. A stream that stops adding names settles after 500 ms; a stream with no usable data times out after eight seconds. Background historical corrections can still take time because their API remains per instrument, but the chart no longer waits for them.

## REST limits and local CORS handling

The request policy retains the supplied **100-request initial burst**, then spaces REST starts at least **125 ms apart (8/second)** to leave headroom below the supplied 10/second limit. Every REST request and retry consumes one token. After the initial allowance is spent, timer delays and idle periods do not create a catch-up burst. Refresh/reload does not reset the allowance. A separate concurrency bound permits at most four in-flight REST requests. Identical in-flight requests within the same cancellation scope are deduplicated before entering the queue.

The bucket survives HMR in memory and full reloads in localStorage. Web Locks coordinate reads and writes between this app’s tabs on the same origin when supported. If storage/locks are unavailable, coordination is best effort within the tab. Other origins, apps and machines sharing the same public IP are outside this browser’s budget; rate-limit responses therefore still trigger adaptive backoff.

A 429 pauses the entire shared queue for at least ten seconds, respects longer `Retry-After` values in seconds or HTTP-date form, adds jitter and drains remaining burst credit. It also halves the shared sustained rate, down to a minimum of one request/second. When the pause ends, requests resume at that slower pace without another burst. After a quiet minute, the rate recovers gradually by one request/second per minute, up to eight. Both the pacing deadline and reduced rate survive refresh/reload. Transient HTTP errors have up to three retries; opaque CORS/network errors get only one retry and trigger the same conservative cooldown and slowdown. Five shared rate-limit/network failures in 30 seconds stop further network work for at least 30 seconds. Cancelled queued jobs do not fetch or consume tokens. Refresh preserves the existing chart if the provider is still cooling down.

For local development, requests use the same-origin **`/thalex-api`** Vite proxy (prefixed by `VITE_BASE_PATH` when set). Local Vite preview uses it too. The proxy forwards only to `https://thalex.com/api/v2/public`, preserving upstream status and `Retry-After`; it does not retry, bypass the rate limit, disable TLS validation or add an open CORS policy. This allows the client to handle upstream 429s which otherwise lack CORS headers. Restart the dev server after updating the proxy configuration. Leave `VITE_THALEX_API_BASE` unset to use this automatic local route; an explicit override takes precedence.

Deployed static sites still rely on Thalex’s CORS headers; a local Vite proxy is not a production backend. When a blocked response is opaque, the client cannot inspect its status or headers and conservatively backs off rather than repeatedly retrying it. A hosted production relay would need its own shared server-side IP budget.

Validation includes deterministic token/refill/cooldown tests and a local mock proxy returning 429 without CORS headers; it deliberately does not flood the public API to test its limit.

## Boundaries

- `scripts/build-history.mjs`: canonical Parquet to browser-cache conversion.
- `history-cache.js`: static cache contract, session archive and missing-hour ranges.
- `live-quotes.js`: batched WebSocket ticker contract, snapshot lifecycle and shared ticker normalization.
- `thalex-rate-limit.js`: token accounting, persisted shared budget, cancellation and cooldown.
- `thalex-rest.js`: bounded/deduplicated REST requests, retry policy and endpoint selection.
- `atm-history-plan.js`: per-hour ATM strike selection and outward search after empty responses.
- `market-data.js`: Parquet-to-present backfill, selected-side fetching, differential merge and progressive publishing.
- `volatility.js`: IV interpolation and percentiles.
- `forward-volatility.js`: adjacent-expiry forward variance and contemporaneous historical pairs.
- `realized-volatility.js`: OHLC estimator and matched windows.
- `App.vue`: loading and control orchestration.
- Chart components: rendering, settings and exports through the shared PNG helper.

[Thalex historical data reference](https://thalex.com/historical-data)

[Thalex ticker and public subscription API](https://thalex.com/docs/)
