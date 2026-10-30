<script setup>
import { createLiveTermStructureLoader } from "../../research/live-term-structure.js";
import TermStructureChart from "../../../../apps/term-structure/src/components/TermStructureChart.vue";
import { toForwardTermStructure } from "../../../../apps/term-structure/src/forward-volatility.js";

// Only bundled, named snapshots can be requested from an article.
const snapshots = import.meta.glob("../../research/term-structure/*.json", {
  eager: true,
  import: "default",
});
const props = defineProps({
  snapshot: { type: String, required: true },
  view: { type: String, default: "iv", validator: (value) => ["iv", "forward"].includes(value) },
  focusExpiry: { type: String, default: "" },
  mode: { type: String, default: "live", validator: (value) => ["live", "snapshot"].includes(value) },
});
const saved = computed(() => Object.values(snapshots).find((data) => data.id === props.snapshot));
const selectedView = ref(props.view);
const mode = ref(props.mode);
const asset = ref(saved.value?.asset || "BTC");
const live = shallowRef(null);
const liveLoading = ref(false);
const liveError = ref("");
const loadLive = createLiveTermStructureLoader();
let controller, refreshTimer;
const isLive = computed(() => mode.value === "live");
const liveReady = computed(() => isLive.value && live.value?.asset === asset.value);
const displayAsset = computed(() => isLive.value ? asset.value : saved.value?.asset);
const source = computed(() => isLive.value ? "Thalex live marks" : saved.value?.source);
async function refresh() {
  if (!isLive.value) return;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  liveLoading.value = true;
  liveError.value = "";
  try {
    const result = await loadLive(asset.value, { signal: request.signal });
    if (!request.signal.aborted) live.value = result;
  } catch (error) {
    if (!request.signal.aborted) liveError.value = error.message || "Live quotes could not be loaded.";
  } finally {
    if (controller === request) liveLoading.value = false;
  }
}
function updateSelection() {
  controller?.abort();
  liveLoading.value = false;
  liveError.value = "";
  selectedExpiry.value = null;
  if (isLive.value) void refresh();
}
onMounted(() => {
  if (isLive.value) void refresh();
  refreshTimer = setInterval(() => {
    if (isLive.value && !liveLoading.value && document.visibilityState === "visible") void refresh();
  }, 60_000);
});
watch([mode, asset], updateSelection);
onBeforeUnmount(() => { controller?.abort(); clearInterval(refreshTimer); });
const showRealized = ref(true);
const selectedExpiry = ref(null);
const chart = ref(null);
const exportError = ref("");
const fullAppUrl = import.meta.dev ? "https://thalextech.github.io/term-structure/" : "/term-structure/";
// Stable inputs prevent selection updates from redrawing (and unfocusing) SVG points.
const noHistory = Object.freeze([]);
const initialExpiry = computed(() => {
  const data = saved.value;
  if (!data) return null;
  const selected = data.points.find((point) => point.expiry.slice(0, 10) === props.focusExpiry) || data.points[0];
  return Date.parse(selected.expiry) / 1000;
});
const activeExpiry = computed(() => {
  const preferred = selectedExpiry.value ?? initialExpiry.value;
  return current.value.some((point) => point.expiry === preferred) ? preferred : current.value[0]?.expiry;
});
const asOf = computed(() => isLive.value ? liveReady.value ? live.value.asOf : NaN : Date.parse(saved.value?.valuationTime) / 1000);
const valuationLabel = computed(() => Number.isFinite(asOf.value) ? new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
}).format(new Date(asOf.value * 1000)) + " UTC" : "Awaiting fresh quotes");
const articleTerm = computed(() => ({
  current: (saved.value?.points || []).map((point) => ({
    expiry: Date.parse(point.expiry) / 1000,
    ts: asOf.value,
    iv: point.iv,
    count: 0,
    rank: null,
  })),
  history: noHistory,
}));
const term = computed(() => isLive.value ? liveReady.value ? live.value.term : { current: noHistory, history: noHistory } : articleTerm.value);
const expiries = computed(() => liveReady.value ? live.value.expiries : term.value.current.map((point) => point.expiry));
const chartSubtitle = computed(() => isLive.value ? `${valuationLabel.value} snapshot · Thalex live marks · Refreshes every 60 seconds` : `${valuationLabel.value} valuation reference · ${saved.value?.source} · Rounded inputs`);
const forward = computed(() => toForwardTermStructure(term.value, expiries.value, asOf.value));
const formatDate = (seconds) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "2-digit", timeZone: "UTC",
}).format(new Date(seconds * 1000));
const formatVol = (value) => `${(value * 100).toFixed(1)}%`;
const periodLabel = (point) => selectedView.value === "forward"
  ? `${point.startExpiry == null ? "Now" : formatDate(point.startExpiry)} → ${formatDate(point.expiry)}`
  : formatDate(point.expiry);
const current = computed(() => (selectedView.value === "forward" ? forward.value.current : term.value.current).map((point) => ({
  ...point,
  tooltip: `${periodLabel(point)} · ${selectedView.value === "forward" ? "Forward IV" : isLive.value ? "Live ATM IV" : "Article ATM IV"} ${formatVol(point.iv)}\n${source.value}; ${isLive.value ? "live snapshot" : "rounded inputs"}. Valuation reference: ${valuationLabel.value}.`,
})));
const realized = computed(() => (saved.value?.points || []).map((point) => ({
  expiry: Date.parse(point.expiry) / 1000,
  iv: point.rv,
  tooltip: `${formatDate(Date.parse(point.expiry) / 1000)} · Approximate historical RV ${formatVol(point.rv)}\nReference transcribed from the article; original OHLC bars were not supplied.`,
})));
const displayedRealized = computed(() => !isLive.value && selectedView.value === "iv" && showRealized.value ? realized.value : noHistory);
const inspected = computed(() => current.value.find((point) => point.expiry === activeExpiry.value));
const inspectedRv = computed(() => realized.value.find((point) => point.expiry === activeExpiry.value)?.iv);
const gapLabel = computed(() => {
  const gap = (inspected.value.iv - inspectedRv.value) * 100;
  return `${gap >= 0 ? "+" : ""}${gap.toFixed(1)} pts`;
});
function reset() {
  mode.value = props.mode;
  asset.value = saved.value?.asset || "BTC";
  selectedView.value = props.view;
  showRealized.value = true;
  selectedExpiry.value = null;
  exportError.value = "";
}
async function savePng() {
  exportError.value = "";
  try { await chart.value?.exportPng(); }
  catch { exportError.value = "The image could not be saved. Please try again."; }
}
</script>

<template>
  <figure v-if="saved" class="term-embed" aria-label="Interactive article term structure">
    <header class="embed-header">
      <div>
        <p class="embed-eyebrow">{{ isLive ? "Live market" : "Article snapshot" }} · {{ displayAsset }}</p>
        <p class="embed-title">Explore the term structure</p>
      </div>
      <a :href="fullAppUrl" target="_blank" rel="noopener">Open live app ↗</a>
    </header>
    <div class="embed-controls">
      <div class="embed-switch" role="group" aria-label="Data source">
        <button type="button" :aria-pressed="isLive" @click="mode = 'live'">Live market</button>
        <button type="button" :aria-pressed="!isLive" @click="mode = 'snapshot'">Article snapshot</button>
      </div>
      <div v-if="isLive" class="embed-switch" role="group" aria-label="Underlying">
        <button v-for="coin in ['BTC', 'ETH']" :key="coin" type="button" :aria-pressed="asset === coin" @click="asset = coin">{{ coin }}</button>
      </div>
      <div class="embed-switch" role="group" aria-label="Volatility view">
        <button type="button" :aria-pressed="selectedView === 'iv'" @click="selectedView = 'iv'">Expiry IV</button>
        <button type="button" :aria-pressed="selectedView === 'forward'" @click="selectedView = 'forward'">Forward vol</button>
      </div>
      <label v-if="!isLive && selectedView === 'iv'" class="rv-toggle">
        <input v-model="showRealized" type="checkbox" /> Historical RV reference
      </label>
      <div class="embed-actions">
        <button v-if="isLive" type="button" :disabled="liveLoading" @click="refresh">{{ liveLoading ? 'Refreshing…' : 'Refresh' }}</button>
        <button type="button" @click="reset">Reset</button>
        <button type="button" @click="savePng">Save PNG</button>
      </div>
    </div>
    <p v-if="isLive" class="live-status" role="status">
      {{ liveLoading ? 'Loading fresh Thalex quotes…' : liveReady ? `Last refreshed ${new Date(live.refreshedAt * 1000).toLocaleTimeString('en-GB', {timeZone: 'UTC'})} UTC · Auto-refresh every 60 seconds` : 'Live quotes not yet available.' }}
      <span v-if="liveError">{{ liveError }} {{ liveReady ? 'Showing the last successful snapshot.' : 'Use Refresh to retry, or select Article snapshot.' }}</span>
      <span v-else-if="liveReady && live.warning">{{ live.warning }}</span>
    </p>
    <ClientOnly>
      <TermStructureChart
        ref="chart"
        :current="current"
        :expiries="expiries"
        :history="noHistory"
        :asset="displayAsset"
        slice-label="ATM"
        :source-label="source"
        :view="selectedView"
        :snapshot-time="asOf"
        :subtitle="chartSubtitle"
        :loading="liveLoading"
        realized-label="Dashed: approximate historical RV reference"
        :realized="displayedRealized"
        :highlight-expiry="activeExpiry"
        fit-container
        @inspect="selectedExpiry = $event"
      />
      <template #fallback>
        <p class="embed-fallback">Interactive chart loading. The published values are in the table below.</p>
      </template>
    </ClientOnly>
    <div v-if="inspected" class="embed-inspector" aria-live="polite" aria-atomic="true">
      <div><span>{{ selectedView === 'iv' ? 'Selected expiry' : 'Selected interval' }}</span><strong>{{ periodLabel(inspected) }}</strong></div>
      <div><span>{{ selectedView === 'iv' ? 'ATM IV' : 'Forward IV' }}</span><strong>{{ formatVol(inspected.iv) }}</strong></div>
      <template v-if="!isLive && selectedView === 'iv' && showRealized">
        <div><span>Historical RV ≈</span><strong>{{ formatVol(inspectedRv) }}</strong></div>
        <div><span>IV − RV ≈</span><strong>{{ gapLabel }}</strong></div>
      </template>
    </div>
    <figcaption>
      <p>Hover over a curve marker, or focus it with Tab, to inspect a maturity. On narrow screens, scroll the chart horizontally.</p>
      <p v-if="isLive">Live Thalex data may differ from the dated figures discussed in this article. Refresh requests a new snapshot; visible live charts also refresh every 60 seconds. Historical dot clouds and RV are available in the full app.</p>
      <p v-else>{{ saved.note }}</p>
      <p v-if="!isLive && selectedView === 'forward'">Forward volatility uses adjacent-expiry total-variance differences. Duration-matched forward RV and historical dot clouds are unavailable from the supplied table.</p>
      <p v-if="selectedView === 'forward' && forward.unavailable.length">{{ forward.unavailable.length }} interval(s) omitted because a leg is missing or forward variance is negative.</p>
      <p v-if="exportError" role="alert">{{ exportError }}</p>
    </figcaption>
  </figure>
  <p v-else role="status">The term structure snapshot “{{ snapshot }}” is unavailable. The published values remain in the article table.</p>
</template>

<style scoped>
.term-embed { margin: 2rem 0; overflow: hidden; border: 1px solid #23232a; border-radius: .85rem; background: #0a0b0e; line-height: 1.5; }
.term-embed p { margin: 0; }
.embed-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.25rem; }
.embed-eyebrow { font-size: .65rem; color: #85a5ff; letter-spacing: .1em; text-transform: uppercase; }
.embed-title { margin-top: .4rem !important; color: #e8eaed; font-size: 1rem; font-weight: 600; }
.embed-header a { font-size: .75rem; text-decoration: none; }
.embed-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; padding: 0 1.25rem 1rem; border-bottom: 1px solid #23232a; font-size: .75rem; }
.embed-switch { display: flex; padding: .2rem; border-radius: .5rem; background: #171717; }
.term-embed button { padding: .4rem .6rem; border-radius: .3rem; cursor: pointer; color: #a3a3a3; }
.term-embed button:hover { color: white; }
.term-embed button[aria-pressed="true"] { color: white; background: #333; }
.term-embed button:focus-visible, .term-embed input:focus-visible { outline: 2px solid #85a5ff; outline-offset: 3px; }
.live-status { padding: .7rem 1.25rem; font-size: .7rem; color: #a3a3a3; border-bottom: 1px solid #23232a; }
.live-status span { display: block; margin-top: .4rem; color: #e0ad68; }
.term-embed button:disabled { opacity: .5; cursor: wait; }
.rv-toggle { display: flex; gap: .5rem; align-items: center; color: #a3a3a3; cursor: pointer; }
.rv-toggle input { accent-color: #85a5ff; }
.embed-actions { display: flex; margin-left: auto; gap: .25rem; }
.embed-fallback { min-height: 26rem; padding: 2rem; color: #a3a3a3; }
.term-embed :deep(.chart-scroll) { width: 100%; overflow-x: auto; }
.term-embed :deep(svg) { display: block; max-width: none; }
.term-embed :deep(svg [tabindex]:focus-visible) { outline: 2px solid #85a5ff; outline-offset: 4px; }
.embed-inspector { display: flex; flex-wrap: wrap; gap: 1rem 2rem; padding: 1rem 1.25rem; border-top: 1px solid #23232a; }
.embed-inspector span { display: block; font-size: .65rem; color: #a3a3a3; }
.embed-inspector strong { display: block; margin-top: .25rem; color: #e8eaed; font-size: .9rem; }
.term-embed figcaption { padding: 1rem 1.25rem; border-top: 1px solid #23232a; color: #858a92; font-size: .7rem; }
.term-embed figcaption p + p { margin-top: .6rem; }
</style>
