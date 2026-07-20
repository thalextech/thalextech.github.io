<script setup>
import * as d3 from "d3";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import {
  cancelFairValueRun,
  runFairValueInWorker,
} from "../lib/fairValueWorkerClient.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  hedgeEnabled: { type: Boolean, default: true },
});

const SCENARIO_OPTIONS = [250, 500, 1_000, 2_000, 5_000];
const chartRef = ref(null);
const result = ref(null);
const running = ref(false);
const progress = ref(0);
const error = ref("");
const viewMode = ref("time");
const scenarioCount = ref(1_000);
let resizeObserver;
let runSequence = 0;

const formatUsd = d3.format("$,.0f");
const formatOrdinal = (value) => {
  const rounded = Math.round(value);
  const lastTwo = rounded % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13
    ? "th"
    : rounded % 10 === 1
      ? "st"
      : rounded % 10 === 2
        ? "nd"
        : rounded % 10 === 3
          ? "rd"
          : "th";
  return `${rounded}${suffix}`;
};

const modeResult = computed(() => result.value);
const completedWeekCount = computed(() =>
  (modeResult.value?.cohorts || []).reduce((total, cohort) => total + cohort.weekCount, 0),
);
const displayedGroups = computed(() =>
  modeResult.value?.views?.[viewMode.value] || modeResult.value?.cohorts || []);
const viewTitle = computed(() => viewMode.value === "iv"
  ? "PnL distributions by entry IV z-score"
  : "PnL distributions by cohort");
const hedgeModeLabel = computed(() => {
  const mode = modeResult.value?.hedgeMode
    || modeResult.value?.defaultHedgeMode
    || (props.hedgeEnabled ? "dynamic" : "unhedged");
  return mode === "dynamic" ? "Dynamic hedge" : "Unhedged option PnL";
});
const scenarioStatus = computed(() => {
  const completed = Number(modeResult.value?.simulations) || 0;
  return `${completed.toLocaleString()} scenarios completed · Conditional GBM · equal drift mix −100% / 0% / +100% · ${hedgeModeLabel.value}`;
});


const redraw = async () => {
  await nextTick();
  draw();
};

const run = async () => {
  if (!props.rows.length) return;
  const requestedScenarios = scenarioCount.value;
  const sequence = ++runSequence;
  running.value = true;
  progress.value = 0;
  result.value = null;
  error.value = "";
  try {
    const nextResult = await runFairValueInWorker({
      cycles: JSON.parse(JSON.stringify(props.rows)),
      options: {
        simulations: requestedScenarios,
        // Every rerun draws a fresh scenario set. Reproducibility stays internal.
        seed: Math.floor(Math.random() * 4_294_967_296),
      },
      onProgress: (update) => {
        if (sequence !== runSequence) return;
        progress.value = update.completed / update.total;
        if (update.result) {
          result.value = update.result;
          void redraw();
        }
      },
    });
    if (sequence !== runSequence) return;
    result.value = nextResult;
    await redraw();
  } catch (runError) {
    if (sequence === runSequence && !/superseded/i.test(runError?.message || "")) {
      error.value = runError?.message || "Simulation failed";
    }
  } finally {
    if (sequence === runSequence) running.value = false;
  }
};

const styleAxis = (group) => {
  group.select(".domain").remove();
  group.selectAll("line").attr("stroke", "rgba(255,255,255,0.08)");
  group.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.44)")
    .attr("font-size", 11)
    .attr("font-family", '"Helvetica Neue", Helvetica, sans-serif');
};

const draw = () => {
  const element = chartRef.value;
  const cohorts = displayedGroups.value;
  if (!element || !cohorts.length) return;
  element.innerHTML = "";
  const bounds = element.getBoundingClientRect();
  const width = Math.max(980, bounds.width || 1180);
  const height = Math.max(760, window.innerHeight - bounds.top - 82);
  const outer = { left: 64, right: 38, top: 36, bottom: 24 };
  const columnGap = 104;
  const rowGap = 48;
  const panelWidth = (width - outer.left - outer.right - columnGap) / 2;
  const panelHeight = (height - outer.top - outer.bottom - rowGap) / 2;
  const svg = d3.select(element).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%").attr("height", height)
    .attr("font-family", '"Helvetica Neue", Helvetica, sans-serif')
    .attr("role", "img")
    .attr("aria-label", `${viewMode.value === "iv" ? "Four entry IV regime" : "Four consecutive cohort"} PnL distributions`);

  const pnlCohorts = modeResult.value?.views?.[viewMode.value] || cohorts;
  const globalMaxAbsPnl = d3.max(pnlCohorts.flatMap((cohort) => [
    ...(cohort.terminalReturnOnPremium || []).map(Math.abs),
    Math.abs(cohort.returnSummary?.actualPnl || 0),
  ])) || 1;
  const pnlColor = d3.scaleDiverging(d3.interpolateRdBu)
    .domain([-globalMaxAbsPnl, 0, globalMaxAbsPnl]);

  const pooledPnlReturns = pnlCohorts
    .filter((cohort) => cohort.weekCount)
    .flatMap((cohort) => cohort.terminalReturnOnPremium || [])
    .sort((first, second) => first - second);
  let sharedPnlLow = d3.quantileSorted(pooledPnlReturns, 0.005);
  let sharedPnlHigh = d3.quantileSorted(pooledPnlReturns, 0.995);
  const historicalPnlReturns = pnlCohorts
    .filter((cohort) => cohort.weekCount)
    .map((cohort) => cohort.returnSummary.actualPnl);
  sharedPnlLow = Math.min(sharedPnlLow, ...historicalPnlReturns);
  sharedPnlHigh = Math.max(sharedPnlHigh, ...historicalPnlReturns);
  const sharedPnlSpan = Math.max(1e-6, sharedPnlHigh - sharedPnlLow);
  sharedPnlLow -= sharedPnlSpan * 0.04;
  sharedPnlHigh += sharedPnlSpan * 0.04;

  const legendX = width - outer.right - 236;
  [
    { x: legendX, fill: "rgba(255,255,255,.14)", label: "5–95%" },
    { x: legendX + 82, fill: "rgba(255,255,255,.07)", label: "1–99%" },
  ].forEach((item) => {
    svg.append("rect").attr("x", item.x).attr("y", 14).attr("width", 18).attr("height", 9)
      .attr("fill", item.fill);
    svg.append("text").attr("x", item.x + 24).attr("y", 22)
      .attr("fill", "rgba(255,255,255,.42)").attr("font-size", 9).text(item.label);
  });
  svg.append("line").attr("x1", legendX + 166).attr("x2", legendX + 166)
    .attr("y1", 12).attr("y2", 25).attr("stroke", "rgba(255,255,255,.7)").attr("stroke-width", 1.5);
  svg.append("text").attr("x", legendX + 175).attr("y", 22)
    .attr("fill", "rgba(255,255,255,.42)").attr("font-size", 9).text("Historical");

  const formatDate = d3.utcFormat("%b %Y");
  const formatPercent = d3.format(".1%");
  cohorts.forEach((cohort, cohortIndex) => {
    const column = cohortIndex % 2;
    const row = Math.floor(cohortIndex / 2);
    const panelX = outer.left + column * (panelWidth + columnGap);
    const panelY = outer.top + row * (panelHeight + rowGap);
    const plotTop = panelY + 78;
    const plotBottom = panelY + panelHeight - 27;
    const values = cohort.terminalReturnOnPremium;
    const stats = cohort.returnSummary;
    let domainLow = sharedPnlLow;
    let domainHigh = sharedPnlHigh;
    if (domainLow === domainHigh) {
      domainLow -= 1;
      domainHigh += 1;
    }
    const x = d3.scaleLinear().domain([domainLow, domainHigh]).nice(6)
      .range([panelX, panelX + panelWidth]);
    const [xLow, xHigh] = x.domain();
    const actualValue = stats.actualPnl;
    const actualRight = actualValue > xHigh;
    const actualLeft = actualValue < xLow;
    const actualX = actualRight ? panelX + panelWidth : actualLeft ? panelX : x(actualValue);
    const thresholds = Array.from({ length: 59 }, (_, index) =>
      xLow + (xHigh - xLow) * (index + 1) / 60);
    const bins = d3.bin().domain(x.domain()).thresholds(thresholds)(values);
    const y = d3.scaleLinear().domain([0, d3.max(bins, (bin) => bin.length) || 1]).nice()
      .range([plotBottom, plotTop]);

    const panelTitle = viewMode.value === "iv"
      ? `${cohort.label} · ${cohort.rangeLabel}`
      : `${cohort.label} · ${formatDate(cohort.startDate)} – ${formatDate(cohort.endDate)}`;
    const resultSummary = `historical ${formatUsd(cohort.summary.actualPnl)} · null mean ${formatPercent(stats.mean)} of entry option value · ${formatOrdinal(stats.actualPercentile)} percentile`;
    const panelSubtitle = viewMode.value === "iv"
      ? cohort.weekCount
        ? `${cohort.weekCount} weeks · avg entry IV ${formatPercent(cohort.meanEntryIv)} · ${resultSummary}`
        : "0 weeks"
      : `${cohort.weekCount} weeks · ${resultSummary}`;
    svg.append("text").attr("x", panelX).attr("y", panelY + 13)
      .attr("fill", "#dfe3e7").attr("font-size", 12).attr("font-weight", 600)
      .text(panelTitle);
    svg.append("text").attr("x", panelX).attr("y", panelY + 32)
      .attr("fill", "rgba(255,255,255,.36)").attr("font-size", 11)
      .text(panelSubtitle);
    if (cohort.bayesianEdge) {
      svg.append("text").attr("x", panelX).attr("y", panelY + 50)
        .attr("fill", "rgba(255,255,255,.36)").attr("font-size", 11)
        .text(`Bayesian bootstrap · P(observed mean edge > 0) ${formatPercent(cohort.bayesianEdge.probabilityEdgePositive)}`);
    }

    if (!cohort.weekCount) {
      svg.append("text").attr("x", panelX + panelWidth / 2).attr("y", (plotTop + plotBottom) / 2)
        .attr("text-anchor", "middle").attr("fill", "rgba(255,255,255,.3)").attr("font-size", 11)
        .text("No completed weeks in this IV regime");
      return;
    }

    svg.selectAll(`rect.bin-${cohortIndex}`).data(bins).join("rect")
      .attr("class", `bin bin-${cohortIndex}`)
      .attr("x", (bin) => x(bin.x0) + .6)
      .attr("y", (bin) => y(bin.length))
      .attr("width", (bin) => Math.max(.7, x(bin.x1) - x(bin.x0) - 1.2))
      .attr("height", (bin) => plotBottom - y(bin.length))
      .attr("fill", (bin) => pnlColor((bin.x0 + bin.x1) / 2)).attr("opacity", .82)
      .append("title")
      .text((bin) => `${formatPercent(bin.x0)} to ${formatPercent(bin.x1)} of entry option value · ${bin.length} scenarios`);

    const clampX = (value) => x(Math.max(xLow, Math.min(xHigh, value)));
    svg.append("rect")
      .attr("x", clampX(stats.p01)).attr("y", plotTop)
      .attr("width", Math.max(0, clampX(stats.p99) - clampX(stats.p01)))
      .attr("height", plotBottom - plotTop)
      .attr("fill", "rgba(255,255,255,.055)").attr("pointer-events", "none");
    svg.append("rect")
      .attr("x", clampX(stats.p05)).attr("y", plotTop)
      .attr("width", Math.max(0, clampX(stats.p95) - clampX(stats.p05)))
      .attr("height", plotBottom - plotTop)
      .attr("fill", "rgba(255,255,255,.10)").attr("pointer-events", "none");

    const meanX = clampX(stats.mean);
    svg.append("line").attr("x1", meanX).attr("x2", meanX)
      .attr("y1", plotTop).attr("y2", plotBottom)
      .attr("stroke", "rgba(226,232,240,.8)").attr("stroke-width", 1)
      .attr("stroke-dasharray", "3 3");

    const actualColor = d3.color(pnlColor(actualValue)).brighter(.45).formatHex();
    svg.append("line").attr("x1", actualX).attr("x2", actualX)
      .attr("y1", plotTop).attr("y2", plotBottom)
      .attr("stroke", actualColor).attr("stroke-width", 1.5);
    const anchorActualLabelRight = actualRight || actualX > panelX + panelWidth - 100;
    svg.append("text")
      .attr("x", actualX)
      .attr("y", plotTop - 6)
      .attr("text-anchor", anchorActualLabelRight ? "end" : actualLeft ? "start" : "middle")
      .attr("fill", actualColor).attr("font-size", 11).attr("font-weight", 600)
      .text(`Actual ${formatPercent(actualValue)} of entry option value${actualRight || actualLeft ? " · off scale" : ""}`);

    const axis = svg.append("g").attr("transform", `translate(0,${plotBottom})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(7));
    styleAxis(axis);
  });
};

watch(() => props.rows, () => {
  if (props.rows.length) void run();
});
watch(viewMode, () => void redraw());

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    draw();
  });
  if (chartRef.value) resizeObserver.observe(chartRef.value);
  void run();
});
onUnmounted(() => {
  runSequence += 1;
  resizeObserver?.disconnect();
  cancelFairValueRun();
});

function exportPng({
  filename = "fair-value-distribution.png",
  scale = 4,
  padding = 24,
  title = "Weekly fair-value scenarios",
  subtitle = "Historical result versus 1,000 simulated histories",
  source = "",
} = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({ svgEl, filename, scale, padding, title, subtitle, source, background: "#0a0b0e" });
}

defineExpose({ exportPng });
</script>

<template>
  <div class="distributionPanel">
    <div v-if="running" class="progressTrack"><span :style="{ width: `${progress * 100}%` }"></span></div>
    <div v-if="error" class="state error">{{ error }}</div>
    <div v-else-if="!result" class="state">Building the first scenarios…</div>
    <template v-else>
      <div class="distributionContent">
        <div class="distributionIntro">
          <div class="titleBlock">
            <div class="titleRow">
              <div class="titleWithMethodology">
                <h2>
                  <button type="button" aria-describedby="distribution-methodology-tooltip">{{ viewTitle }}</button>
                </h2>
                <div id="distribution-methodology-tooltip" class="methodologyTooltip" role="tooltip">
                  <p>
                    <strong>Paths, volatility, and drift.</strong>
                    Every completed week keeps its actual entry spot, option structure, holding period, and entry IV. We then
                    draw an independent GBM path on that strategy's hedge grid using constant volatility equal to entry IV.
                    Realized volatility is not forced back to IV: it varies naturally from path to path through finite-sample
                    diffusion noise. Scenarios are allocated as evenly as possible between −100%, 0%, and +100% annual drift.
                    Zero drift is the fair-value null; the two drift variants cheaply include the strategy's residual beta risk.
                  </p>
                  <p>
                    <strong>Hedging.</strong>
                    <template v-if="props.hedgeEnabled">
                      The option is repriced at constant entry IV and delta is recalculated at every configured hedge time on
                      the GBM path. The hedge follows the strategy's schedule and tolerance, includes configured execution
                      costs, and closes at the historical exit time. This matches the dynamic hedge settings from the run.
                    </template>
                    <template v-else>
                      No underlying hedge is opened or simulated because the strategy run is unhedged. Each scenario contains
                      only the fairly valued option position's PnL from entry to exit. The historical comparison likewise
                      excludes hedge PnL, keeping the observed and simulated results directly comparable.
                    </template>
                  </p>
                  <p>
                    <strong>Reading the charts.</strong>
                    <template v-if="viewMode === 'time'">
                      The {{ completedWeekCount }} completed weeks are split into four consecutive periods.
                    </template>
                    <template v-else>
                      Entry IV is standardized into Low, Medium, High, and Extreme regimes across the
                      {{ completedWeekCount }} completed weeks.
                    </template>
                    Bars show simulated PnL divided by the total option value paid or received when the trades in that
                    panel were opened. This makes differently sized cohorts comparable; it is not return on the strategy's
                    $100k notional. The brighter inner band is the empirical 5th–95th percentile range; the fainter outer
                    band is the empirical 1st–99th percentile range. The Bayesian number is calculated separately from
                    observed weekly PnLs using a Dirichlet bootstrap; it is not fed back into the GBM simulator.
                  </p>
                </div>
              </div>
              <p class="titleMeta">{{ scenarioStatus }}</p>
            </div>
          </div>
          <div class="distributionControls">
            <div class="controlRow">
              <span>Panels</span>
              <div class="groupingToggle" role="group" aria-label="Group distributions by">
                <button type="button" :aria-pressed="viewMode === 'time'" @click="viewMode = 'time'">Time</button>
                <button type="button" :aria-pressed="viewMode === 'iv'" @click="viewMode = 'iv'">Entry IV</button>
              </div>
            </div>
            <div class="controlRow">
              <div class="scenarioRunner">
                <details :class="['scenarioSelect', { disabled: running }]" @click.capture="running && $event.preventDefault()">
                  <summary aria-label="Number of Monte Carlo scenarios" :aria-disabled="running">
                    {{ scenarioCount.toLocaleString() }} sims
                    <span aria-hidden="true">⌄</span>
                  </summary>
                  <div class="scenarioMenu" role="listbox" aria-label="Number of Monte Carlo scenarios">
                    <button
                      v-for="count in SCENARIO_OPTIONS"
                      :key="count"
                      type="button"
                      role="option"
                      :aria-selected="scenarioCount === count"
                      @click="scenarioCount = count; $event.currentTarget.closest('details').removeAttribute('open')"
                    >{{ count.toLocaleString() }} sims</button>
                  </div>
                </details>
                <button type="button" :disabled="running || !rows.length" @click="run">
                  {{ running ? `Running · ${Math.round(progress * 100)}%` : 'Run again' }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div ref="chartRef" class="distributionChart"></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.distributionPanel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 14px 18px;
  scrollbar-color: rgba(255,255,255,.14) transparent;
}
.progressTrack { height: 3px; margin: 2px 11px 0; background: rgba(255,255,255,.05); }
.progressTrack span { display: block; height: 100%; background: #38bdf8; transition: width .12s linear; }
.state { display: grid; min-height: 420px; place-items: center; color: #69717a; font-size: 12px; }
.state.error { color: #fb7185; }
.distributionContent { min-width: 1100px; }
.distributionChart { margin-top: 12px; }
.distributionChart :deep(svg) { display: block; }
.distributionIntro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin: 20px 28px 0 54px;
}
.distributionIntro h2 {
  margin: 0;
  color: #e8eaed;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
}
.titleRow {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px 14px;
  min-width: 0;
}
.titleWithMethodology {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
}
.titleWithMethodology h2 button {
  padding: 0 0 2px;
  border: 0;
  border-bottom: 1px dotted rgba(255,255,255,.24);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: help;
}
.titleMeta {
  margin: 0;
  min-width: 0;
  color: rgba(255,255,255,.42);
  font-size: 12px;
  line-height: 1.3;
}
.methodologyTooltip {
  position: absolute;
  z-index: 30;
  top: calc(100% + 9px);
  left: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 32px;
  width: min(940px, calc(100vw - 120px));
  box-sizing: border-box;
  padding: 16px 18px;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 14px 34px rgba(0,0,0,.42);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity .1s ease;
}
.titleWithMethodology:hover .methodologyTooltip,
.titleWithMethodology:focus-within .methodologyTooltip {
  opacity: 1;
  visibility: visible;
}
.distributionIntro .methodologyTooltip p {
  margin: 0;
  color: #7c838b;
  font-size: 11px;
  line-height: 1.5;
  text-align: left;
}
.methodologyTooltip strong {
  display: block;
  margin-bottom: 4px;
  color: #aeb4bb;
  font-weight: 600;
}
.distributionControls {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 16px;
  margin-top: -5px;
}
.controlRow {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
}
.controlRow > span {
  color: #6a727a;
  font-size: 11px;
}
.groupingToggle {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border-radius: 5px;
  background: rgba(255,255,255,.045);
}
.groupingToggle button {
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #69717a;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.groupingToggle button[aria-pressed="true"] {
  background: rgba(255,255,255,.10);
  color: #d6dade;
}
.scenarioRunner {
  display: inline-flex;
  flex: none;
  gap: 5px;
}
.scenarioSelect summary,
.scenarioRunner button {
  height: 28px;
  border: 1px solid rgba(255,255,255,.10);
  border-radius: 4px;
  background: transparent;
  color: #777e86;
  font: inherit;
  font-size: 11px;
}
.scenarioSelect {
  position: relative;
  width: 88px;
}
.scenarioSelect summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  padding: 0 8px;
  cursor: pointer;
  list-style: none;
}
.scenarioSelect summary::-webkit-details-marker { display: none; }
.scenarioSelect[open] summary {
  color: #c5c9ce;
  border-color: rgba(255,255,255,.20);
  background: rgba(255,255,255,.04);
}
.scenarioSelect.disabled { opacity: .6; }
.scenarioSelect.disabled summary { cursor: default; }
.scenarioMenu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  width: 100%;
  padding: 3px;
  box-sizing: border-box;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 10px 28px rgba(0,0,0,.38);
}
.scenarioMenu button {
  display: block;
  width: 100%;
  height: 25px;
  padding: 0 6px;
  border: 0;
  text-align: left;
}
.scenarioMenu button:hover,
.scenarioMenu button[aria-selected="true"] {
  background: rgba(255,255,255,.08);
  color: #d6dade;
}
.scenarioRunner button {
  padding: 0 9px;
  cursor: pointer;
}
.scenarioRunner button:hover:not(:disabled) {
  color: #c5c9ce;
  border-color: rgba(255,255,255,.20);
}
.scenarioRunner button:disabled {
  opacity: .6;
  cursor: default;
}
</style>
