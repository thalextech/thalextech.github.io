<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});
const emit = defineEmits(["select"]);

const chartRef = ref(null);
let resizeObserver;

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.2f");
const formatEntryDate = d3.utcFormat("%d %b %y");
const valueFor = (row, key) => Number(row[key]) || 0;
const instrumentName = (row) =>
  row.legs?.length
    ? row.legs.map((leg) => leg.instrumentName).join(" / ")
    : `Cycle ${row.cycle || ""}`;

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
  const height = Math.max(720, allocatedHeight * 0.98);
  const margin = { top: 26, right: 24, bottom: 42, left: 64 };
  const panelGap = 52;
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
      "PnL decomposition over entry time comparing option, hedge, and total PnL",
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
    { key: "shortOptionPnlUsd", label: "Option PnL" },
    { key: "hedgePnlUsd", label: "Hedge PnL" },
    { key: "cyclePnlUsd", label: "Total PnL" },
  ];
  const entryTimes = rows.map((row) => new Date(row.entryTime).getTime());
  const x = d3
    .scaleBand()
    .domain(entryTimes)
    .range([0, plotWidth])
    .padding(0.18);
  const panels = series.map(({ key, label }) => {
    const values = rows.map((row) => valueFor(row, key));
    const [dataMin = 0, dataMax = 0] = d3.extent(values);
    let domainMin = Math.min(0, dataMin);
    let domainMax = Math.max(0, dataMax);
    if (domainMin === domainMax) {
      domainMin = -1;
      domainMax = 1;
    } else {
      const padding = (domainMax - domainMin) * 0.08;
      if (domainMin < 0) domainMin -= padding;
      if (domainMax > 0) domainMax += padding;
    }
    const y = d3.scaleLinear()
      .domain([domainMin, domainMax])
      .range([panelHeight, 0])
      .nice(5);
    const color = d3.scaleDiverging(d3.interpolateRdBu)
      .domain([
        Math.min(dataMin, -Number.EPSILON),
        0,
        Math.max(dataMax, Number.EPSILON),
      ]);
    let yTickValues = y.ticks(5);
    const [yMin, yMax] = y.domain();
    if (!yTickValues.includes(0) && yMin <= 0 && yMax >= 0) {
      yTickValues = [...yTickValues, 0].sort((a, b) => a - b);
    }
    return { key, label, y, color, yTickValues };
  });

  panels.forEach(({ key, label, y, color, yTickValues }, panelIndex) => {
    const panelY = margin.top + panelIndex * (panelHeight + panelGap);
    const group = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${panelY})`);

    const bars = group.selectAll(`rect.${key}`)
      .data(rows)
      .join("rect")
      .attr("class", key)
      .attr("x", (row) => x(new Date(row.entryTime).getTime()))
      .attr("y", (row) => y(Math.max(0, valueFor(row, key))))
      .attr("width", x.bandwidth())
      .attr("height", (row) => Math.max(1, Math.abs(y(valueFor(row, key)) - y(0))))
      .attr("fill", (row) => color(valueFor(row, key)))
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (row) =>
        `${formatEntryDate(new Date(row.entryTime))} ${label}; open cycle detail`,
      )
      .style("cursor", "pointer")
      .on("click", (_, row) => emit("select", row))
      .on("keydown", (event, row) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        emit("select", row);
      });

    bars.append("title")
      .text((row) => [
        instrumentName(row),
        `Option PnL: ${formatUsd(valueFor(row, "shortOptionPnlUsd"))}`,
        `Hedge PnL: ${formatUsd(valueFor(row, "hedgePnlUsd"))}`,
        `Total PnL: ${formatUsd(valueFor(row, "cyclePnlUsd"))}`,
        "Click to open cycle detail",
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
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 11);

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
    .attr("fill", "rgba(255,255,255,0.28)")
    .attr("font-size", 10);

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
