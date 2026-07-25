<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import StyledSelectMenu from "./StyledSelectMenu.vue";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});
const emit = defineEmits(["select"]);

const chartRef = ref(null);
const xAxisMode = ref("hedge");
let resizeObserver;

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.2f");
const formatAxisUsd = d3.format("$,.0f");
const formatAxisDate = d3.utcFormat("%b %y");
const formatTooltipDate = d3.utcFormat("%d %b %Y");

const X_AXIS_MODES = [
  { value: "time", label: "Time", key: null },
  { value: "total", label: "Total PnL", key: "cyclePnlUsd" },
  { value: "option", label: "Option PnL", key: "shortOptionPnlUsd" },
  { value: "hedge", label: "Hedge PnL", key: "hedgePnlUsd" },
];

const SERIES = [
  { key: "shortOptionPnlUsd", label: "Option", opacity: 1 },
  { key: "hedgePnlUsd", label: "Hedge", opacity: 0.62 },
];

const valueFor = (row, key) => Number(row[key]) || 0;
const instrumentName = (row) =>
  row.legs?.length
    ? row.legs.map((leg) => leg.instrumentName).join(" / ")
    : `Cycle ${row.cycle || ""}`;

/** Diverging stack: positives grow up from 0, negatives down from 0. */
function stackSegments(row) {
  let pos = 0;
  let neg = 0;
  return SERIES.map((series) => {
    const value = valueFor(row, series.key);
    if (value >= 0) {
      const y0 = pos;
      pos += value;
      return { ...series, value, y0, y1: pos };
    }
    const y1 = neg;
    neg += value;
    return { ...series, value, y0: neg, y1 };
  });
}

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

  const sortKey = X_AXIS_MODES.find((mode) => mode.value === xAxisMode.value)?.key;
  const rows = [...(props.rows || [])]
    .filter((row) => row.closed !== false)
    .sort((a, b) => sortKey
      ? valueFor(b, sortKey) - valueFor(a, sortKey)
        || new Date(a.entryTime) - new Date(b.entryTime)
      : new Date(a.entryTime) - new Date(b.entryTime));

  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360);
  const allocatedHeight = Math.max(300, bounds.height || 470);
  const height = allocatedHeight * 0.95;
  const plotTop = 20;
  const plotBottom = height - 30;
  const X0 = 62;
  const X1 = width - 28;

  const orderLabel = X_AXIS_MODES.find((mode) => mode.value === xAxisMode.value)?.label || "Time";
  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr(
      "aria-label",
      `Stacked bar chart of option and hedge PnL by cycle, ordered by ${orderLabel}`,
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

  const stacked = rows.map((row) => ({
    row,
    segments: stackSegments(row),
    total: valueFor(row, "cyclePnlUsd"),
  }));

  const allEnds = stacked.flatMap(({ segments }) =>
    segments.flatMap((seg) => [seg.y0, seg.y1]),
  );
  let [dataMin, dataMax] = d3.extent(allEnds);
  if (!Number.isFinite(dataMin)) dataMin = 0;
  if (!Number.isFinite(dataMax)) dataMax = 0;
  if (dataMin > 0) dataMin = 0;
  if (dataMax < 0) dataMax = 0;
  if (dataMin === dataMax) {
    dataMin = -1;
    dataMax = 1;
  } else {
    const pad = (dataMax - dataMin) * 0.08;
    if (dataMin < 0) dataMin -= pad;
    if (dataMax > 0) dataMax += pad;
  }

  const y = d3.scaleLinear()
    .domain([dataMin, dataMax])
    .range([plotBottom, plotTop])
    .nice(7);

  const slot = (X1 - X0) / Math.max(1, rows.length);
  const x = d3.scaleLinear()
    .domain([0, Math.max(1, rows.length - 1)])
    .range([X0 + slot / 2, X1 - slot / 2]);
  const bw = Math.max(2, slot - 1);

  // RdBu by segment PnL (same diverging scheme as the original panels / weekly chart)
  const segmentValues = stacked.flatMap(({ segments }) =>
    segments.map((seg) => seg.value),
  );
  const [segMin = 0, segMax = 0] = d3.extent(segmentValues);
  const barColor = d3.scaleDiverging(d3.interpolateRdBu)
    .domain([
      Math.min(segMin, -Number.EPSILON),
      0,
      Math.max(segMax, Number.EPSILON),
    ]);

  // Horizontal grid + y-axis labels
  const [yLo, yHi] = y.domain();
  let ticks = y.ticks(7);
  if (!ticks.includes(0) && yLo <= 0 && yHi >= 0) ticks.push(0);
  ticks = ticks.filter((v) => v >= yLo && v <= yHi).sort((a, b) => a - b);
  ticks.forEach((v) => {
    const gy = y(v);
    svg.append("line")
      .attr("x1", X0 - 8)
      .attr("x2", X1)
      .attr("y1", gy)
      .attr("y2", gy)
      .attr("stroke", v === 0 ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.055)");
    svg.append("text")
      .attr("x", X0 - 12)
      .attr("y", gy + 3)
      .attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 12)
      .text(formatAxisUsd(v));
  });

  // Stacked bars (option + hedge). Invisible full-height hit target for click.
  stacked.forEach(({ row, segments, total }, i) => {
    const cx = x(i);
    const group = svg.append("g")
      .attr("class", "cycle-bar")
      .style("cursor", "pointer")
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr(
        "aria-label",
        `${formatTooltipDate(new Date(row.entryTime))}: total ${formatUsd(total)}. Open cycle detail`,
      )
      .on("click", () => emit("select", row))
      .on("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        emit("select", row);
      });

    group.append("title").text([
      instrumentName(row),
      formatTooltipDate(new Date(row.entryTime)),
      `Option PnL: ${formatUsd(valueFor(row, "shortOptionPnlUsd"))}`,
      `Hedge PnL: ${formatUsd(valueFor(row, "hedgePnlUsd"))}`,
      `Total PnL: ${formatUsd(total)}`,
      "Click to open cycle detail",
    ].join("\n"));

    // Widen click target without drawing a visible bar
    group.append("rect")
      .attr("x", cx - bw / 2)
      .attr("y", plotTop)
      .attr("width", bw)
      .attr("height", Math.max(1, plotBottom - plotTop))
      .attr("fill", "transparent");

    segments.forEach((seg) => {
      if (seg.value === 0) return;
      const top = y(Math.max(seg.y0, seg.y1));
      const bottom = y(Math.min(seg.y0, seg.y1));
      group.append("rect")
        .attr("x", cx - bw / 2)
        .attr("y", top)
        .attr("width", bw)
        .attr("height", Math.max(1, bottom - top))
        .attr("fill", barColor(seg.value))
        .attr("fill-opacity", seg.opacity)
        .attr("pointer-events", "none");
    });
  });

  // Smoothed total PnL line + dots at each cycle
  const totalPoints = stacked
    .map(({ total }, i) => ({ i, total }))
    .filter(({ total }) => Number.isFinite(total));

  if (totalPoints.length) {
    const totalLine = d3.line()
      .x((d) => x(d.i))
      .y((d) => y(d.total))
      .curve(d3.curveCatmullRom.alpha(0.5));

    svg.append("path")
      .datum(totalPoints)
      .attr("d", totalLine)
      .attr("fill", "none")
      .attr("stroke", "#f1f2f4")
      .attr("stroke-width", 1.6)
      .attr("stroke-linejoin", "round")
      .attr("stroke-linecap", "round")
      .attr("pointer-events", "none");

    const dotR = Math.min(3.25, Math.max(2, bw * 0.22));
    svg.selectAll("circle.total-dot")
      .data(totalPoints)
      .join("circle")
      .attr("class", "total-dot")
      .attr("cx", (d) => x(d.i))
      .attr("cy", (d) => y(d.total))
      .attr("r", dotR)
      .attr("fill", "#f1f2f4")
      .attr("pointer-events", "none");
  }

  // X labels from entry dates
  const tickCount = Math.min(14, rows.length);
  const tickIndexes = [...new Set(Array.from(
    { length: tickCount },
    (_, index) => Math.round(index * (rows.length - 1) / Math.max(1, tickCount - 1)),
  ))];
  tickIndexes.forEach((idx) => {
    svg.append("text")
      .attr("x", x(idx))
      .attr("y", height - 6)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.28)")
      .attr("font-size", 12)
      .text(formatAxisDate(new Date(rows[idx].entryTime)));
  });
};

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});

onUnmounted(() => resizeObserver?.disconnect());

watch(() => props.rows, draw);
watch(xAxisMode, draw);

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
    <div class="xAxisControl">
      <StyledSelectMenu
        v-model="xAxisMode"
        label="X-axis"
        :options="X_AXIS_MODES"
      />
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
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  height: 95%;
  margin-top: 2px;
}

.xAxisControl {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 8;
}
</style>
