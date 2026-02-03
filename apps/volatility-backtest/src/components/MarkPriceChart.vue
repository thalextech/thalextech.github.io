<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";

const props = defineProps({
  series: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  showCumulativePnl: { type: Boolean, default: false },
});

const chartRef = ref(null);

const margin = { top: 24, right: 58, bottom: 40, left: 56 };
const width = 900;
const height = 360;
const pnlColor = "#5cb85c";

function render() {
  const el = chartRef.value;
  if (!el || !props.series.length) return;

  d3.select(el).selectAll("*").remove();

  const data = props.series.map((d) => ({
    date: d.date instanceof Date ? d.date : new Date(d.ts * 1000),
    // Plot option PnL (cumulative) instead of raw mark price.
    value: d.cumulativeOptionPnl ?? d.cumulativePnl ?? null,
    cumulativeTotalPnl: d.cumulativeTotalPnl,
    cumulativeHedgePnl: d.cumulativeHedgePnl,
  }));

  const xExtent = d3.extent(data, (d) => d.date);
  const yExtent = d3.extent(data, (d) => d.value);
  const yPadding = Math.max((yExtent[1] - yExtent[0]) * 0.05, 1) || 1;
  const yMin = yExtent[0] - yPadding;
  const yMax = yExtent[1] + yPadding;

  const xScale = d3.scaleUtc().domain(xExtent).range([margin.left, width - margin.right]);
  const yScale = d3.scaleLinear().domain([yMin, yMax]).range([height - margin.bottom, margin.top]);

  const hasTotalPnl = data.some((d) => d.cumulativeTotalPnl != null && Number.isFinite(d.cumulativeTotalPnl));
  const hasHedgePnl = data.some((d) => d.cumulativeHedgePnl != null && Number.isFinite(d.cumulativeHedgePnl));
  let yScaleRight = null;
  if (props.showCumulativePnl && (hasTotalPnl || hasHedgePnl)) {
    const totalExtent = hasTotalPnl ? d3.extent(data, (d) => d.cumulativeTotalPnl) : [0, 0];
    const hedgeExtent = hasHedgePnl ? d3.extent(data, (d) => d.cumulativeHedgePnl) : [0, 0];
    const lo = Math.min(totalExtent[0], hedgeExtent[0]);
    const hi = Math.max(totalExtent[1], hedgeExtent[1]);
    const pnlPad = Math.max(1, (hi - lo) * 0.1) || 1;
    yScaleRight = d3
      .scaleLinear()
      .domain([lo - pnlPad, hi + pnlPad])
      .range([height - margin.bottom, margin.top]);
  }

  const linePrice = d3
    .line()
    .x((d) => xScale(d.date))
    .y((d) => yScale(d.value))
    .defined((d) => d.value != null && Number.isFinite(d.value));

  const lineTotalPnl =
    yScaleRight &&
    d3
      .line()
      .x((d) => xScale(d.date))
      .y((d) => yScaleRight(d.cumulativeTotalPnl))
      .defined((d) => d.cumulativeTotalPnl != null && Number.isFinite(d.cumulativeTotalPnl));

  const lineHedgePnl =
    yScaleRight &&
    d3
      .line()
      .x((d) => xScale(d.date))
      .y((d) => yScaleRight(d.cumulativeHedgePnl))
      .defined((d) => d.cumulativeHedgePnl != null && Number.isFinite(d.cumulativeHedgePnl));

  const hedgePnlColor = "#e6a23c";

  const svg = d3
    .select(el)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "auto")
    .style("max-width", "100%");

  svg
    .append("path")
    .attr("fill", "none")
    .attr("stroke", "var(--accent, #7aa2ff)")
    .attr("stroke-width", 2)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
    .attr("d", linePrice(data));

  if (lineTotalPnl) {
    svg
      .append("path")
      .attr("fill", "none")
      .attr("stroke", pnlColor)
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("stroke-dasharray", "4,3")
      .attr("d", lineTotalPnl(data));
  }
  if (lineHedgePnl) {
    svg
      .append("path")
      .attr("fill", "none")
      .attr("stroke", hedgePnlColor)
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("d", lineHedgePnl(data));
  }

  const xAxis = d3.axisBottom(xScale).ticks(8).tickSizeOuter(0);
  const yAxis = d3.axisLeft(yScale).ticks(6).tickSizeOuter(0);

  const gX = svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).call(xAxis);
  const gY = svg.append("g").attr("transform", `translate(${margin.left},0)`).call(yAxis);

  gX.selectAll("text").attr("fill", "#a9abb6").style("font-size", "11px");
  gY.selectAll("text").attr("fill", "#a9abb6").style("font-size", "11px");
  gX.selectAll("line").attr("stroke", "#222532");
  gY.selectAll("line").attr("stroke", "#222532");

  if (yScaleRight) {
    const yAxisRight = d3.axisRight(yScaleRight).ticks(5).tickSizeOuter(0).tickFormat(d3.format("$.2f"));
    const gYRight = svg
      .append("g")
      .attr("transform", `translate(${width - margin.right},0)`)
      .call(yAxisRight);
    gYRight.selectAll("text").attr("fill", pnlColor).style("font-size", "11px");
    gYRight.selectAll("line").attr("stroke", "#222532");

    const legend = svg.append("g").attr("transform", `translate(${width - margin.right - 110},${margin.top})`);
    legend.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 0).attr("y2", 0).attr("stroke", "var(--accent,#7aa2ff)").attr("stroke-width", 2);
    legend.append("text").attr("x", 18).attr("y", 4).attr("fill", "#a9abb6").style("font-size", "11px").text("Option PnL");
    legend.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 16).attr("y2", 16).attr("stroke", pnlColor).attr("stroke-width", 2).attr("stroke-dasharray", "4,3");
    legend.append("text").attr("x", 18).attr("y", 20).attr("fill", "#a9abb6").style("font-size", "11px").text("Cum. total PnL");
    legend.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 32).attr("y2", 32).attr("stroke", hedgePnlColor).attr("stroke-width", 2);
    legend.append("text").attr("x", 18).attr("y", 36).attr("fill", "#a9abb6").style("font-size", "11px").text("Delta hedge PnL");
  }
}

watch(
  () => [props.series, props.loading],
  () => {
    if (props.series?.length && !props.loading) render();
  },
  { deep: true }
);

onMounted(() => {
  if (props.series?.length) render();
});
</script>

<template>
  <div class="chart-wrap">
    <h2>Option PnL</h2>
    <div v-if="loading" class="chart-loading">Loading…</div>
    <div
      v-else-if="!series || series.length === 0"
      class="chart-empty"
    >
      No data
    </div>
    <div
      v-else
      ref="chartRef"
      class="chart-svg"
      role="img"
      :aria-label="`Option PnL chart, ${series.length} points`"
    />
  </div>
</template>

<style scoped>
.chart-wrap {
  margin-top: 24px;
}
.chart-wrap h2 {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 650;
  color: var(--text, #e8e8ea);
}
.chart-loading,
.chart-empty {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, #a9abb6);
  font-size: 14px;
  background: color-mix(in oklab, var(--panel, #0b0d13), #111 30%);
  border: 1px solid var(--border, #222532);
  border-radius: 10px;
}
.chart-svg {
  background: color-mix(in oklab, var(--panel, #0b0d13), #111 30%);
  border: 1px solid var(--border, #222532);
  border-radius: 10px;
  overflow: hidden;
}
</style>
