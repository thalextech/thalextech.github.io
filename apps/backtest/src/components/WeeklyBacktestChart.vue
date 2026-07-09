<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});

const chartRef = ref(null);

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
  const height = allocatedHeight * 0.85;  // slightly less than full to leave breathing room

  // Plot area: use most of the height for the chart, small bottom for x labels
  const plotTop = 45;   // a bit more padding from the top
  const plotBottom = height - 30;   // slightly less vertical space for the plot

  const X0 = 55;
  const X1 = width - 15;

  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("role", "img")
    .attr("aria-label", "Weekly delta hedged straddle backtest chart");

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
    r.deltaHedgedShortPnl || 0,
    r.cumulativeDeltaHedgedPnl || 0,
    0
  ]);
  let [dataMin, dataMax] = d3.extent(allValues);
  if (dataMin > 0) dataMin = 0;
  if (dataMax < 0) dataMax = 0;

  const y = d3.scaleLinear()
    .domain([dataMax, dataMin])
    .range([plotTop, plotBottom]);

  const x = d3.scaleLinear()
    .domain([0, rows.length - 1])
    .range([X0, X1]);

  const zeroY = y(0);

  // Grid lines at nice values (aim for ~7, ensure 0 is included)
  let ticks = y.ticks(7);
  if (!ticks.includes(0) && dataMin <= 0 && dataMax >= 0) {
    ticks.push(0);
  }
  ticks = ticks.filter(v => v >= dataMin && v <= dataMax).sort((a, b) => a - b);
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

  const bw = Math.max(2, (X1 - X0) / (rows.length - 1) - 1);

  // Proper diverging red/blue color scale for weekly PnL bars
  const barValues = rows.map(r => r.deltaHedgedShortPnl || 0);
  const [barMin, barMax] = d3.extent(barValues);
  const colorDomain = [Math.min(barMin, 0), 0, Math.max(barMax, 0)];
  const barColor = d3.scaleDiverging(d3.interpolateRdBu)
    .domain(colorDomain);

  // Bars from 0 baseline
  rows.forEach((row, i) => {
    const v = row.deltaHedgedShortPnl || 0;
    const top = y(Math.max(0, v));
    const bottom = y(Math.min(0, v));
    const h = Math.max(1, bottom - top);
    const fill = barColor(v);

    svg.append("rect")
      .attr("x", x(i) - bw / 2)
      .attr("y", top)
      .attr("width", bw)
      .attr("height", h)
      .attr("fill", fill);
  });

  // Cumulative step line
  let d = `M ${x(0)} ${y(rows[0].cumulativeDeltaHedgedPnl || 0)}`;
  for (let i = 1; i < rows.length; i++) {
    const prevY = y(rows[i-1].cumulativeDeltaHedgedPnl || 0);
    const currY = y(rows[i].cumulativeDeltaHedgedPnl || 0);
    d += ` L ${x(i)} ${prevY}`;
    d += ` L ${x(i)} ${currY}`;
  }

  svg.append("path")
    .attr("d", d)
    .attr("fill", "none")
    .attr("stroke", "#e8eaed")
    .attr("stroke-width", 1.5);

  // X labels at bottom
  const labels = ["Jun 25", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan 26", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
  const step = Math.max(1, Math.floor((rows.length - 1) / (labels.length - 1)));
  labels.forEach((lab, i) => {
    const idx = Math.min(i * step, rows.length - 1);
    const lx = x(idx);
    svg.append("text")
      .attr("x", lx)
      .attr("y", height - 6)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.28)")
      .attr("font-size", 10)
      .text(lab);
  });
};

onMounted(() => {
  draw();
  window.addEventListener("resize", draw);
});

onUnmounted(() => {
  window.removeEventListener("resize", draw);
});

watch(() => props.rows, draw, { deep: true });
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
  height: 85%;
  margin-top: 8px; /* a bit more padding from the top */
}
</style>
