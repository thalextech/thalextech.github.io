<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});

const chartRef = ref(null);
let resizeObserver;

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.2f");
const formatEntryDate = d3.utcFormat("%d %b %y");
const valueFor = (row, key) => Number(row[key]) || 0;
const instrumentName = (row) =>
  (row.callInstrument || `Cycle ${row.cycle || ""}`).replace(/-[CP]$/, "-S");

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

  const rows = [...(props.rows || [])]
    .filter((row) => row.closed !== false)
    .sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360, rows.length * 22 + 110);
  const allocatedHeight = Math.max(300, bounds.height || 470);
  const height = Math.max(660, allocatedHeight * 0.95);
  const margin = { top: 18, right: 24, bottom: 58, left: 64 };
  const panelGap = 34;
  const panelHeight = (height - margin.top - margin.bottom - panelGap * 2) / 3;
  const plotWidth = width - margin.left - margin.right;

  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", height)
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr(
      "aria-label",
      "PnL decomposition over entry time comparing straddle, hedge, and total PnL",
    );

  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 14)
      .text("No hedge performance data");
    return;
  }

  const series = [
    { key: "shortOptionPnlUsd", label: "Straddle PnL" },
    { key: "hedgePnlUsd", label: "Hedge PnL" },
    { key: "cyclePnlUsd", label: "Total PnL" },
  ];
  const xBound = d3.max(rows, (row) =>
    d3.max(series, ({ key }) => Math.abs(valueFor(row, key))),
  ) || 1;
  const entryTimes = rows.map((row) => new Date(row.entryTime).getTime());
  const x = d3
    .scaleBand()
    .domain(entryTimes)
    .range([0, plotWidth])
    .padding(0.18);
  const y = d3
    .scaleLinear()
    .domain([-xBound, xBound])
    .range([panelHeight, 0])
    .nice();
  const color = d3
    .scaleDiverging(d3.interpolateRdBu)
    .domain([-xBound, 0, xBound]);
  const yTickValues = y.ticks(5);

  series.forEach(({ key, label }, panelIndex) => {
    const panelY = margin.top + panelIndex * (panelHeight + panelGap);
    const group = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${panelY})`);

    group.selectAll(`rect.${key}`)
      .data(rows)
      .join("rect")
      .attr("class", key)
      .attr("x", (row) => x(new Date(row.entryTime).getTime()))
      .attr("y", (row) => y(Math.max(0, valueFor(row, key))))
      .attr("width", x.bandwidth())
      .attr("height", (row) => Math.max(1, Math.abs(y(valueFor(row, key)) - y(0))))
      .attr("fill", (row) => color(valueFor(row, key)))
      .append("title")
      .text((row) => [
        instrumentName(row),
        `Straddle PnL: ${formatUsd(valueFor(row, "shortOptionPnlUsd"))}`,
        `Hedge PnL: ${formatUsd(valueFor(row, "hedgePnlUsd"))}`,
        `Total PnL: ${formatUsd(valueFor(row, "cyclePnlUsd"))}`,
      ].join("\n"));

    const axis = d3.axisLeft(y)
      .tickValues(yTickValues)
      .tickFormat(d3.format("~s"))
      .tickSize(0)
      .tickPadding(8);
    const axisGroup = group.append("g").call(axis);
    axisGroup.attr("font-family", CHART_FONT_FAMILY);
    axisGroup.select(".domain").remove();
    axisGroup.selectAll("text")
      .attr("fill", "rgba(255,255,255,0.36)")
      .attr("font-size", 10);

    group.append("text")
      .attr("x", 0)
      .attr("y", -10)
      .attr("text-anchor", "start")
      .attr("fill", "rgba(255,255,255,0.68)")
      .attr("font-size", 12)
      .attr("font-weight", 500)
      .text(label);
  });

  const labelStep = Math.max(1, Math.ceil(entryTimes.length / 12));
  const entryTickValues = entryTimes.filter((_, index) => index % labelStep === 0);
  const xAxis = d3.axisBottom(x)
    .tickValues(entryTickValues)
    .tickFormat((timestamp) => formatEntryDate(new Date(timestamp)))
    .tickSize(0)
    .tickPadding(10);
  const xAxisGroup = svg.append("g")
    .attr("transform", `translate(${margin.left},${height - margin.bottom})`)
    .call(xAxis);
  xAxisGroup.attr("font-family", CHART_FONT_FAMILY);
  xAxisGroup.select(".domain").remove();
  xAxisGroup.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.62)")
    .attr("font-size", 10);

  svg.append("text")
    .attr("x", margin.left + plotWidth / 2)
    .attr("y", height - 6)
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.58)")
    .attr("font-size", 12)
    .text("Entry time");
};

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});

onUnmounted(() => resizeObserver?.disconnect());

watch(() => props.rows, draw);

function exportPng({
  filename = "hedge-performance.png",
  scale = 3,
  padding = 24,
  title = "",
  subtitle = "",
  source = "",
  metrics = [],
} = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
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
  overflow: auto;
}

.chart :deep(svg) {
  flex: none;
  display: block;
  width: auto;
  min-width: 100%;
  max-width: none;
  height: auto;
  margin-top: 2px;
}
</style>
