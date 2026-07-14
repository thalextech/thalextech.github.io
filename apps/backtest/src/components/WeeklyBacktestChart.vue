<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});
const emit = defineEmits(["select"]);

const chartRef = ref(null);

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatDate = d3.utcFormat("%d %b %Y");

const entryDate = (row) => new Date(row.entryTime);

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

  const rows = [...(props.rows || [])].sort(
    (a, b) => entryDate(a).getTime() - entryDate(b).getTime(),
  );

  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360);
  const allocatedHeight = Math.max(300, bounds.height || 470);
  const height = allocatedHeight * 0.95;

  // Plot area: use most of the height for the chart, small bottom for x labels
  const plotTop = 20;
  const plotBottom = height - 30;   // slightly less vertical space for the plot

  const X0 = 55;
  const X1 = width - 40;

  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr("aria-label", "Per-cycle delta hedged straddle backtest chart");

  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 14)
      .text("No chart data");
    return;
  }

  // Normalize y to actual data range (include 0)
  const allValues = rows.flatMap(r => [
    r.cyclePnlUsd || 0,
    r.endingEquityUsd || 0,
    0
  ]);
  let [dataMin, dataMax] = d3.extent(allValues);
  if (dataMin > 0) dataMin = 0;
  if (dataMax < 0) dataMax = 0;

  const y = d3.scaleLinear()
    .domain([dataMin, dataMax])
    .range([plotBottom, plotTop])
    .nice(7);

  // Reserve half a bar-slot of padding at each edge so first/last bars stay
  // inside [X0, X1] instead of overflowing (only visible with wide bars, e.g. 30D).
  const slot = (X1 - X0) / Math.max(1, rows.length);
  const x = d3.scaleLinear()
    .domain([0, Math.max(1, rows.length - 1)])
    .range([X0 + slot / 2, X1 - slot / 2]);

  const zeroY = y(0);

  // Grid lines at nice values (aim for ~7, ensure 0 is included)
  const [yLo, yHi] = y.domain();
  let ticks = y.ticks(7);
  if (!ticks.includes(0) && yLo <= 0 && yHi >= 0) {
    ticks.push(0);
  }
  ticks = ticks.filter(v => v >= yLo && v <= yHi).sort((a, b) => a - b);
  ticks.forEach(v => {
    const gy = y(v);
    svg.append("line")
      .attr("x1", X0 - 8)
      .attr("x2", X1)
      .attr("y1", gy)
      .attr("y2", gy)
      .attr("stroke", "rgba(255,255,255,0.055)");
    svg.append("text")
      .attr("x", X0 - 12)
      .attr("y", gy + 3)
      .attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 11)
      .text(formatUsd(v));
  });

  const bw = Math.max(2, slot - 1);

  // Proper diverging red/blue color scale for weekly PnL bars
  const barValues = rows.map(r => r.cyclePnlUsd || 0);
  const [barMin, barMax] = d3.extent(barValues);
  const colorDomain = [Math.min(barMin, 0), 0, Math.max(barMax, 0)];
  const barColor = d3.scaleDiverging(d3.interpolateRdBu)
    .domain(colorDomain);

  // Bars from 0 baseline
  rows.forEach((row, i) => {
    const v = row.cyclePnlUsd || 0;
    const top = y(Math.max(0, v));
    const bottom = y(Math.min(0, v));
    const h = Math.max(1, bottom - top);
    const fill = barColor(v);

    svg.append("rect")
      .attr("x", x(i) - bw / 2)
      .attr("y", top)
      .attr("width", bw)
      .attr("height", h)
      .attr("fill", fill)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", `${formatDate(entryDate(row))}: ${formatUsd(v)}. Open hourly detail`)
      .style("cursor", "pointer")
      .on("click", () => emit("select", row))
      .on("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") emit("select", row);
      })
      .append("title")
      .text(`${formatDate(entryDate(row))} · ${formatUsd(v)} · Click for hourly detail`);
  });

  const cumulativeLine = d3.line()
    .x((_, index) => x(index))
    .y((row) => y(row.endingEquityUsd || 0))
    .curve(d3.curveStepBefore);

  svg.append("path")
    .datum(rows)
    .attr("d", cumulativeLine)
    .attr("fill", "none")
    .attr("stroke", "#e8eaed")
    .attr("stroke-width", 1.5);

  // X labels follow the result dates so extending the dataset cannot leave a
  // stale, hardcoded time range on the chart.
  const tickCount = Math.min(14, rows.length);
  const tickIndexes = [...new Set(Array.from(
    { length: tickCount },
    (_, index) => Math.round(index * (rows.length - 1) / Math.max(1, tickCount - 1)),
  ))];
  const formatAxisDate = d3.utcFormat("%b %y");
  tickIndexes.forEach((idx) => {
    const lx = x(idx);
    svg.append("text")
      .attr("x", lx)
      .attr("y", height - 6)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.28)")
      .attr("font-size", 10)
      .text(formatAxisDate(entryDate(rows[idx])));
  });
};

onMounted(() => {
  draw();
  window.addEventListener("resize", draw);
});

onUnmounted(() => {
  window.removeEventListener("resize", draw);
});

watch(() => props.rows, draw);

function exportPng({
  filename = "backtest.png",
  scale = 4,
  padding = 24,
  title = "",
  subtitle = "",
  source = "",
  metrics = [],
} = {}) {
  const container = chartRef.value;
  const svgEl = container ? container.querySelector("svg") : null;
  if (!svgEl) return;
  exportTitledChart({
    svgEl,
    title,
    subtitle,
    source,
    metrics,
    filename,
    scale,
    padding,
    background: "#0a0b0e",
  });
}

defineExpose({ exportPng });
</script>

<template>
  <div ref="chartRef" class="chart"></div>
</template>

<style scoped>
.chart {
  flex: 1;
  min-height: 0;
  background: #0a0b0e;
  display: flex;
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  height: 95%;
  margin-top: 2px;
}
</style>
