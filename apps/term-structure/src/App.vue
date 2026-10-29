<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import TermStructureChart from "./components/TermStructureChart.vue";
import StyledSelectMenu from "../../../lib/components/StyledSelectMenu.vue";
import ChartSettings from "./components/ChartSettings.vue";
import {
  realizedByExpiry,
  realizedForwardByExpiry,
  RV_MIN_COVERAGE,
} from "./realized-volatility.js";
import {
  fetchOptionChain,
  fetchLiveQuotes,
  fetchHistoricalQuotes,
  HISTORY_LIMIT,
} from "./market-data.js";
import { buildTermStructure, selectLiveQuotes, SLICES } from "./volatility.js";
import {
  toForwardTermStructure,
  VOLATILITY_VIEWS,
} from "./forward-volatility.js";

const asset = ref("BTC"),
  slice = ref("atm");
const source = ref("mark");
const volatilityView = ref("iv");
const detailLabel = computed(() =>
  volatilityView.value === "forward"
    ? "Forward interval detail"
    : "Expiry detail",
);
const expiries = ref([]),
  referenceTime = ref(null);
const showRealized = ref(true);
const indexBars = shallowRef([]),
  coverage = ref(null);
const live = shallowRef([]),
  history = shallowRef([]);
const loading = ref(false),
  historyLoading = ref(false),
  historyWarnings = ref([]),
  phase = ref(""),
  progress = ref(0),
  error = ref(""),
  warnings = ref([]);
const chart = ref(null),
  historyReady = ref(false);
let controller, historyController;
let currentChain = [];
const selectedLive = computed(() => selectLiveQuotes(live.value, source.value));
const bookFallbackCount = computed(
  () =>
    live.value.filter((q) => !(q.bookIv > 0 && Number.isFinite(q.bookIv)))
      .length,
);
const sourceLabel = computed(() =>
  source.value === "book" ? "Book mid / mark fallback" : "Live marks",
);
const expirySeries = computed(() =>
  buildTermStructure({
    live: selectedLive.value,
    history: history.value,
    slice: slice.value,
    limit: HISTORY_LIMIT,
    expiries: expiries.value,
  }),
);
const series = computed(() =>
  volatilityView.value === "forward"
    ? toForwardTermStructure(
        expirySeries.value,
        expiries.value,
        referenceTime.value,
      )
    : expirySeries.value,
);
const sliceLabel = computed(
  () => SLICES.find((s) => s.value === slice.value).label,
);
const snapshotTime = computed(() =>
  live.value.length ? Math.min(...live.value.map((q) => q.ts)) : null,
);
const snapshotEnd = computed(() =>
  live.value.length ? Math.max(...live.value.map((q) => q.ts)) : null,
);
const total = computed(() => series.value.history.length);
const realized = computed(() =>
  (volatilityView.value === "forward"
    ? realizedForwardByExpiry
    : realizedByExpiry)(expiries.value, indexBars.value, referenceTime.value),
);
const realizedByMaturity = computed(
  () => new Map(realized.value.map((p) => [p.expiry, p])),
);
const fmt = (ts) =>
  new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const expiryLabel = (ts) =>
  new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

const rowLabel = (point) =>
  volatilityView.value === "forward"
    ? `${point.startExpiry == null ? "Now" : expiryLabel(point.startExpiry)} → ${expiryLabel(point.expiry)}`
    : expiryLabel(point.expiry);

async function loadHistory(chain, nextAsset, asOf, onProgress = () => {}) {
  historyController?.abort();
  const current = new AbortController();
  historyController = current;
  const parentSignal = controller?.signal;
  const cancel = () => current.abort();
  parentSignal?.addEventListener("abort", cancel, { once: true });
  if (parentSignal?.aborted) current.abort();
  const { signal } = current;
  const active = () => !signal.aborted;
  historyLoading.value = true;
  historyWarnings.value = [];
  try {
    const past = await fetchHistoricalQuotes(chain, nextAsset, {
      signal,
      asOf,
      slice: slice.value,
      onProgress,
      onUpdate: (data) => {
        if (!active()) return;
        history.value = data.quotes;
        indexBars.value = data.indexBars;
        if (data.quotes.length) historyReady.value = true;
      },
    });
    if (!active()) return;
    history.value = past.quotes;
    indexBars.value = past.indexBars;
    coverage.value = past.coverage;
    historyReady.value = true;
    if (past.rateLimitWarning)
      historyWarnings.value.push(past.rateLimitWarning);
    if (past.warning) historyWarnings.value.push(past.warning);
    if (past.failures.length)
      historyWarnings.value.push(
        `${past.failures.length} option histories failed. Available cached history is still shown; refresh to retry.`,
      );
    if (!past.quotes.length)
      historyWarnings.value.push("No historical IV observations returned.");
  } catch (error) {
    if (active())
      historyWarnings.value.push(
        `History update failed: ${error.message || error}. Any history already loaded remains visible.`,
      );
  } finally {
    parentSignal?.removeEventListener("abort", cancel);
    if (historyController === current) historyLoading.value = false;
  }
}

async function load(nextAsset = asset.value) {
  const switchingAsset = nextAsset !== asset.value;
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  const { signal } = currentController;
  asset.value = nextAsset;
  loading.value = true;
  error.value = "";
  warnings.value = [];
  currentChain = [];
  if (switchingAsset) {
    live.value = [];
    history.value = [];
    indexBars.value = [];
    expiries.value = [];
    referenceTime.value = null;
    historyReady.value = false;
    coverage.value = null;
  }
  const active = () => !signal.aborted;
  try {
    phase.value = "Finding listed options";
    progress.value = 0;
    const chain = await fetchOptionChain(nextAsset, signal);
    signal.throwIfAborted();
    if (!chain.length)
      throw new Error(`No live ${nextAsset} option expiries returned`);
    currentChain = chain;
    expiries.value = [...new Set(chain.map((i) => i.expiry))].sort(
      (a, b) => a - b,
    );
    referenceTime.value = Date.now() / 1000;
    let liveTimer = null,
      pendingLive = [];
    const publishLive = (quotes) => {
      pendingLive = quotes;
      if (quotes.length === chain.length) {
        clearTimeout(liveTimer);
        liveTimer = null;
        if (active()) live.value = quotes;
      } else if (liveTimer == null)
        liveTimer = setTimeout(() => {
          liveTimer = null;
          if (active()) live.value = pendingLive;
        }, 50);
    };
    signal.addEventListener("abort", () => clearTimeout(liveTimer), {
      once: true,
    });
    const completed = { live: 0, history: 0 };
    const update = (kind, done) => {
      if (!active()) return;
      completed[kind] = done;
      phase.value = `Live quotes ${completed.live}/${chain.length} · History updates ${completed.history}/${chain.length}`;
      progress.value =
        (completed.live + completed.history) / (2 * chain.length);
    };
    update("live", 0);
    const [snapshot] = await Promise.allSettled([
      fetchLiveQuotes(chain, {
        signal,
        onProgress: (done) => update("live", done),
        onQuotes: publishLive,
      }),
      loadHistory(chain, nextAsset, referenceTime.value, (done) =>
        update("history", done),
      ),
    ]);
    signal.throwIfAborted();
    if (snapshot.status === "fulfilled") {
      live.value = snapshot.value.quotes;
      if (snapshot.value.rateLimitWarning)
        warnings.value.push(snapshot.value.rateLimitWarning);
      if (snapshot.value.failures.length)
        warnings.value.push(
          `${snapshot.value.failures.length} live option quotes unavailable. The curve uses the remaining quotes.`,
        );
      if (!snapshot.value.quotes.length)
        warnings.value.push(
          "No fresh live IVs returned. Historical observations remain visible; refresh to retry.",
        );
    } else error.value = snapshot.reason.message || String(snapshot.reason);
  } catch (e) {
    if (active()) error.value = e.message || String(e);
  } finally {
    if (active()) loading.value = false;
  }
}
onMounted(() => load());
watch(slice, () => {
  if (currentChain.length)
    void loadHistory(currentChain, asset.value, referenceTime.value);
});
onBeforeUnmount(() => {
  controller?.abort();
  historyController?.abort();
});
</script>

<template>
  <main class="app">
    <header class="topBar">
      <div class="wordmark">Term Structure</div>
      <div class="divider"></div>
      <div class="controls">
        <div class="underlyingToggle" role="group" aria-label="Underlying">
          <button
            v-for="coin in ['BTC', 'ETH']"
            :key="coin"
            type="button"
            class="underlyingButton"
            :class="{ underlyingButtonActive: asset === coin }"
            :aria-pressed="asset === coin"
            @click="asset !== coin && load(coin)"
          >
            {{ coin }}
          </button>
        </div>
        <div class="field">
          <label for="volatility-view">Volatility</label>
          <StyledSelectMenu
            id="volatility-view"
            v-model="volatilityView"
            label="Volatility"
            :options="VOLATILITY_VIEWS"
          />
        </div>
        <div class="field">
          <label for="slice">Slice</label>
          <StyledSelectMenu
            id="slice"
            v-model="slice"
            label="Slice"
            :options="SLICES"
          />
        </div>
        <div class="field">
          <label for="source">Current</label>
          <StyledSelectMenu
            id="source"
            v-model="source"
            label="Current curve"
            :options="[
              { value: 'mark', label: 'Live marks' },
              { value: 'book', label: 'Book mid / mark fallback' },
            ]"
          />
        </div>
        <button class="saveButton" type="button" @click="load()">
          {{ loading || historyLoading ? "Restart fetch" : "Refresh" }}
        </button>
        <button
          class="saveButton"
          type="button"
          :disabled="!series.current.length && !series.history.length"
          @click="chart?.exportPng()"
        >
          Save PNG
        </button>
      </div>
    </header>

    <section class="chartPanel" aria-label="Volatility term structure">
      <ChartSettings
        v-model:show-realized="showRealized"
        :forward="volatilityView === 'forward'"
      />
      <TermStructureChart
        ref="chart"
        :current="series.current"
        :expiries="expiries"
        :history="series.history"
        :asset="asset"
        :slice-label="sliceLabel"
        :source-label="sourceLabel"
        :view="volatilityView"
        :snapshot-time="snapshotTime"
        :loading="loading || historyLoading"
        :realized="showRealized ? realized : []"
      />
    </section>

    <details v-if="series.current.length" class="expiryDetails">
      <summary>
        {{ detailLabel }} · {{ series.current.length }}
        {{ volatilityView === "forward" ? "intervals" : "expiries" }} ·
        {{ total.toLocaleString() }} historical observations
      </summary>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                {{
                  volatilityView === "forward"
                    ? "INTERVAL (UTC)"
                    : "EXPIRY (UTC)"
                }}
              </th>
              <th>
                {{
                  volatilityView === "forward"
                    ? "INTERVAL DAYS"
                    : "DAYS TO EXPIRY"
                }}
              </th>
              <th>
                {{
                  volatilityView === "forward" ? "LIVE FORWARD VOL" : "LIVE IV"
                }}
              </th>
              <th v-if="showRealized">REALIZED VOL</th>
              <th v-if="showRealized">RV COVERAGE</th>
              <th v-if="showRealized">
                {{ volatilityView === "forward" ? "FORWARD − RV" : "IV − RV" }}
              </th>
              <th>HISTORICAL PERCENTILE</th>
              <th>HOURLY OBSERVATIONS</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in series.current" :key="p.expiry">
              <td>{{ rowLabel(p) }}</td>
              <td>
                {{
                  (
                    (p.expiry -
                      (volatilityView === "forward"
                        ? (p.startExpiry ?? p.ts)
                        : p.ts)) /
                    86400
                  ).toFixed(1)
                }}
              </td>
              <td
                class="iv-cell"
                :title="
                  p.clamped
                    ? 'Spot outside available strikes; nearest strike used in at least one IV input'
                    : undefined
                "
              >
                {{ (p.iv * 100).toFixed(2) }}%
              </td>
              <td
                v-if="showRealized"
                :title="
                  realizedByMaturity.get(p.expiry)?.count +
                  ' of ' +
                  realizedByMaturity.get(p.expiry)?.hours +
                  ' hourly bars'
                "
              >
                {{
                  realizedByMaturity.get(p.expiry)?.iv == null
                    ? "Unavailable"
                    : (realizedByMaturity.get(p.expiry).iv * 100).toFixed(2) +
                      "%"
                }}
              </td>
              <td v-if="showRealized">
                {{
                  realizedByMaturity.has(p.expiry)
                    ? (realizedByMaturity.get(p.expiry).coverage * 100).toFixed(
                        2,
                      ) + "%"
                    : "—"
                }}
              </td>
              <td v-if="showRealized">
                {{
                  realizedByMaturity.get(p.expiry)?.iv == null
                    ? "—"
                    : (
                        (p.iv - realizedByMaturity.get(p.expiry).iv) *
                        100
                      ).toFixed(2) + " pp"
                }}
              </td>
              <td>
                <div class="rank-cell">
                  <div class="rank-track">
                    <i :style="{ width: (p.rank ?? 0) + '%' }"></i>
                  </div>
                  <span>{{
                    p.rank == null ? "—" : p.rank.toFixed(0) + "th"
                  }}</span>
                </div>
              </td>
              <td>
                {{
                  historyReady
                    ? p.count.toLocaleString()
                    : loading
                      ? "Loading…"
                      : "Unavailable"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <details class="methodDetails">
      <summary>Method and data</summary>
      <p v-if="snapshotTime">
        Snapshot: {{ fmt(snapshotTime) }} UTC · marks collected over
        {{ Math.ceil(snapshotEnd - snapshotTime) }}s. Refresh for latest.
      </p>
      <p v-if="volatilityView === 'forward'">
        Forward volatility is derived from adjacent expiries: √((IV₂² T₂ − IV₁²
        T₁)/(T₂ − T₁)), with times to maturity measured at each observation. The
        first interval is Now → first expiry and equals its IV. History requires
        both legs at the same UTC hour; missing legs and negative variance
        increments are omitted. Percentiles are recalculated from each
        interval’s forward-vol history. Delta slices are estimates derived from
        that smile slice, not model-free forward variance.
        {{ series.negativeHistoryCount.toLocaleString() }} historical
        negative-variance observations omitted.
      </p>
      <p>
        Dashed line: backward-looking Garman–Klass realized volatility from
        hourly index OHLC, annualized with 365.25 days. Each lookback is the
        current time to that expiry, rounded up to whole hours, ending at the
        latest available completed UTC hour before the snapshot. In Forward vol
        mode, RV uses the most recent history matching each interval’s duration:
        T₁ → T₂ ahead uses the latest T₂ − T₁ hours, rounded up to whole hours,
        using direct OHLC observations. The lookbacks overlap and all end at the
        same latest completed hour. Missing or invalid bars are skipped. At
        least
        {{ RV_MIN_COVERAGE * 100 }}% of each window’s hours must be valid. RV is
        estimated from the available bars across the full requested window;
        missing hours are not counted as zero volatility. Coverage is shown in
        {{ detailLabel }}. Larger gaps make RV unavailable.
      </p>
      <p v-if="coverage">
        History reused: {{ coverage.cachedIndexRows.toLocaleString() }} cached
        OHLC bars and {{ coverage.cachedMarkRows.toLocaleString() }} cached IVs.
        Differential fetched: {{ coverage.apiIndexRows.toLocaleString() }} OHLC
        bars and {{ coverage.apiMarkRows.toLocaleString() }} IVs.
      </p>
      <p>
        ATM: mean call/put variance per strike, linearly interpolated at spot,
        then square root. Nearest strike if spot is outside the chain. Delta
        slices: variance interpolated at Black–Scholes spot delta, zero
        rates/carry, 365.25-day year; unavailable wings are omitted.
      </p>
      <p>
        Live marks (default): exchange mark IV. Book mid / mark fallback: IV
        solved from the fresh ticker’s best bid/ask midpoint using its expiry
        forward, zero discounting. Empty/crossed books and prices outside model
        bounds fall back to exchange mark IV. History always uses completed
        hourly mark IV and matching index closes, up to 2,000 hours per
        currently listed expiry (about 83 days); book-mid percentiles compare
        against mark history. API supplements use currently listed strikes;
        cached history also retains older strikes for live expiries; newer
        expiries have shorter coverage. Dots show hourly observations with
        horizontal jitter only. Live quotes refresh manually.
      </p>
      <p>
        Historical cache is generated from the backtest’s canonical Parquet
        closing IV and index OHLC. API backfill covers the gap from the latest
        available Parquet bars to the latest completed hour, within the chart’s
        lookback. Older Parquet gaps are left as supplied. ATM updates fetch the
        strikes around each hour’s spot, trying neighbours if quotes are
        unavailable. Delta updates fetch the selected option side. Changing
        slice updates missing history. Cache and differential responses are
        merged by instrument and UTC bar start; successful API additions are
        reused for this browser session.
      </p>
      <a
        href="https://thalex.com/historical-data"
        target="_blank"
        rel="noopener"
        >Thalex data reference</a
      >
    </details>
    <footer class="dataFootnotes" aria-label="Data status">
      <p v-if="loading" role="status">
        {{ phase }} · {{ Math.round(progress * 100) }}%
      </p>
      <p v-else-if="historyLoading" role="status">
        Updating selected slice history…
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-for="warning in [...warnings, ...historyWarnings]" :key="warning">
        {{ warning }}
      </p>
      <p v-if="source === 'book' && bookFallbackCount">
        {{ bookFallbackCount }} options have no usable two-sided book midpoint
        and use exchange mark IV instead.
      </p>
      <p
        v-if="
          volatilityView === 'forward' &&
          !loading &&
          !historyLoading &&
          series.unavailable.length
        "
      >
        {{ series.unavailable.length }} current forward intervals are
        unavailable because an adjacent expiry is missing or the total variance
        decreases. Gaps are left unfilled.
      </p>
      <p
        v-if="
          showRealized &&
          !historyLoading &&
          indexBars.length &&
          realized.some((p) => p.iv == null)
        "
      >
        {{ realized.filter((p) => p.iv == null).length }} realized-volatility
        windows are unavailable because valid hourly OHLC coverage is below
        {{ RV_MIN_COVERAGE * 100 }}%. See {{ detailLabel }} for coverage.
      </p>
    </footer>
  </main>
</template>
