<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});
const emit = defineEmits(["select"]);

const chartRef = ref(null);
const sortMode = ref("time");
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
    .sort((a, b) => sortMode.value === "pnl"
      ? valueFor(b, "cyclePnlUsd") - valueFor(a, "cyclePnlUsd")
        || new Date(a.entryTime) - new Date(b.entryTime)
      : new Date(a.entryTime) - new Date(b.entryTime));

  const bounds = element.getBoundingClientRect();
  const width = Math.max(1080, bounds.width || 1360);
  const allocatedHeight = Math.max(300, bounds.height || 470);
  const height = Math.max(720, allocatedHeight * 0.98);
  const margin = { top: 54, right: 24, bottom: 20, left: 82 };
  const panelGap = 36;
  const plotHeight = height - margin.top - margin.bottom;
  const panelWidth = (width - margin.left - margin.right - panelGap * 2) / 3;

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
      "Three-column PnL decomposition with horizontal option, hedge, and total PnL bars",
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
  const y = d3
    .scaleBand()
    .domain(entryTimes)
    .range([0, plotHeight])
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
    const x = d3.scaleLinear()
      .domain([domainMin, domainMax])
      .range([0, panelWidth])
      .nice(5);
    const color = d3.scaleDiverging(d3.interpolateRdBu)
      .domain([
        Math.min(dataMin, -Number.EPSILON),
        0,
        Math.max(dataMax, Number.EPSILON),
      ]);
    let xTickValues = x.ticks(4);
    const [xMin, xMax] = x.domain();
    if (!xTickValues.includes(0) && xMin <= 0 && xMax >= 0) {
      xTickValues = [...xTickValues, 0].sort((a, b) => a - b);
    }
    return { key, label, x, color, xTickValues };
  });

  panels.forEach(({ key, label, x, color, xTickValues }, panelIndex) => {
    const panelX = margin.left + panelIndex * (panelWidth + panelGap);
    const group = svg
      .append("g")
      .attr("transform", `translate(${panelX},${margin.top})`);

    xTickValues.forEach((tick) => {
      group.append("line")
        .attr("x1", x(tick)).attr("x2", x(tick))
        .attr("y1", 0).attr("y2", plotHeight)
        .attr("stroke", "rgba(255,255,255,0.055)");
    });

    group.append("line")
      .attr("x1", x(0)).attr("x2", x(0))
      .attr("y1", 0).attr("y2", plotHeight)
      .attr("stroke", "rgba(255,255,255,0.12)");

    const bars = group.selectAll(`rect.${key}`)
      .data(rows)
      .join("rect")
      .attr("class", key)
      .attr("x", (row) => Math.min(x(0), x(valueFor(row, key))))
      .attr("y", (row) => y(new Date(row.entryTime).getTime()))
      .attr("width", (row) => Math.max(1, Math.abs(x(valueFor(row, key)) - x(0))))
      .attr("height", y.bandwidth())
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

    const axis = d3.axisTop(x)
      .tickValues(xTickValues)
      .tickFormat(d3.format("~s"))
      .tickSize(0)
      .tickPadding(7);
    const axisGroup = group.append("g").call(axis);
    axisGroup.attr("font-family", CHART_FONT_FAMILY);
    axisGroup.select(".domain").remove();
    axisGroup.selectAll("text")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 11);

    group.append("text")
      .attr("x", 0)
      .attr("y", -32)
      .attr("text-anchor", "start")
      .attr("fill", "rgba(255,255,255,0.68)")
      .attr("font-size", 12)
      .attr("font-weight", 500)
      .text(label);
  });

  const labelStep = Math.max(1, Math.ceil(entryTimes.length / 12));
  const entryTickValues = entryTimes.filter((_, index) => index % labelStep === 0);
  const entryAxis = d3.axisLeft(y)
    .tickValues(entryTickValues)
    .tickFormat((timestamp) => formatEntryDate(new Date(timestamp)))
    .tickSize(0)
    .tickPadding(7);
  const entryAxisGroup = svg.append("g")
    .attr("transform", `translate(${margin.left - 8},${margin.top})`)
    .call(entryAxis);
  entryAxisGroup.attr("font-family", CHART_FONT_FAMILY);
  entryAxisGroup.select(".domain").remove();
  entryAxisGroup.selectAll("text")
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
watch(sortMode, draw);

function exportPng({
  filename = "hedge-performance.png",
  scale = 4,
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
  <div class="chartWrap">
    <div ref="chartRef" class="chart"></div>
    <div class="sortToggle" role="group" aria-label="Hedge performance row order">
      <button
        type="button"
        :class="{ active: sortMode === 'time' }"
        :aria-pressed="sortMode === 'time'"
        @click="sortMode = 'time'"
      >
        Time
      </button>
      <button
        type="button"
        :class="{ active: sortMode === 'pnl' }"
        :aria-pressed="sortMode === 'pnl'"
        @click="sortMode = 'pnl'"
      >
        PnL high–low
      </button>
    </div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  background: #0a0b0e;
}

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

.sortToggle {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 2;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(10, 11, 14, 0.82);
  backdrop-filter: blur(6px);
}

.sortToggle button {
  height: 22px;
  border: 0;
  border-radius: 4px;
  padding: 0 9px;
  background: transparent;
  color: #777d84;
  font: 500 9px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  cursor: pointer;
}

.sortToggle button:hover {
  color: #d8dadd;
  background: rgba(255, 255, 255, 0.05);
}

.sortToggle button.active {
  color: #f2f3f5;
  background: rgba(255, 255, 255, 0.1);
}
</style>
