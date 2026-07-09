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
  const width = Math.max(900, bounds.width || 960);
  const height = 650;
  const margin = { top: 50, right: 76, bottom: 112, left: 76 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", "Weekly delta hedged straddle backtest chart");

  const root = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  if (!rows.length) {
    root
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", innerHeight / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#8a94a6")
      .text("No chart data");
    return;
  }

  const x = d3
    .scaleUtc()
    .domain(d3.extent(rows, entryDate))
    .range([0, innerWidth])
    .nice();
  const step = innerWidth / Math.max(1, rows.length);
  const barWidth = Math.max(3, step * 0.9);

  const pnlExtent = d3.extent(
    rows.flatMap((row) => [
      row.deltaHedgedShortPnl,
      row.cumulativeDeltaHedgedPnl,
      0,
    ]),
  );
  const y = d3
    .scaleLinear()
    .domain(pnlExtent)
    .nice()
    .range([innerHeight, 0]);

  const barMin = d3.min(rows, (row) => row.deltaHedgedShortPnl) ?? 0;
  const barMax = d3.max(rows, (row) => row.deltaHedgedShortPnl) ?? 0;
  const colorDomain = [Math.min(barMin, 0), 0, Math.max(barMax, 0)];
  const color = d3.scaleDiverging(d3.interpolateRdBu).domain(colorDomain);

  const zeroY = y(0);
  root
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", zeroY)
    .attr("y2", zeroY)
    .attr("stroke", "#444")
    .attr("stroke-width", 1);

  root
    .selectAll("rect")
    .data(rows)
    .join("rect")
    .attr("x", (row) => x(entryDate(row)) - barWidth / 2)
    .attr("y", (row) => Math.min(y(row.deltaHedgedShortPnl), zeroY))
    .attr("width", barWidth)
    .attr("height", (row) => Math.abs(y(row.deltaHedgedShortPnl) - zeroY))
    .attr("rx", 0)
    .attr("fill", (row) => color(row.deltaHedgedShortPnl));

  const line = d3
    .line()
    .x((row) => x(entryDate(row)))
    .y((row) => y(row.cumulativeDeltaHedgedPnl))
    .curve(d3.curveStepAfter);

  root
    .append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", "whitesmoke")
    .attr("stroke-width", 2)
    .attr("d", line);

  root
    .append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(Math.min(12, rows.length))
        .tickFormat(formatDate)
        .tickSize(0)
        .tickPadding(10),
    )
    .selectAll("text")
    .attr("transform", "rotate(-35)")
    .attr("text-anchor", "end")
    .attr("fill", "white")
    .attr("font-size", 10);

  root
    .append("g")
    .call(d3.axisLeft(y).ticks(8).tickFormat(formatUsd).tickSize(0))
    .selectAll(".tick text")
    .attr("fill", "white")
    .attr("font-size", 10);

  root.selectAll(".domain").attr("stroke", "none");
  root.selectAll(".tick line").attr("stroke", "none");

  root
    .append("text")
    .attr("x", 0)
    .attr("y", -14)
    .attr("fill", "white")
    .attr("font-size", 13)
    .attr("font-weight", 700)
    .text("Hedged PnL ($)");
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
  min-height: 650px;
  overflow-x: auto;
  background: black;
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  min-width: 900px;
  height: auto;
}
</style>
