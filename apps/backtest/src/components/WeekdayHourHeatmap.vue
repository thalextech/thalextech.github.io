<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import {
  RV_AXIS_COLOR,
  RV_AXIS_FONT_SIZE,
  RV_PLOT_GUTTERS,
  calculateRvPlotLayout,
} from "../lib/rvChartLayout.js";

const props = defineProps({
  cells: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  measureLabel: { type: String, default: "Mean annualized hourly RV" },
  legendLabel: { type: String, default: "Avg RV (ann.)" },
  loadingMessage: { type: String, default: "Loading hourly realized volatility…" },
  emptyMessage: { type: String, default: "No hourly realized-volatility observations." },
  ariaLabel: { type: String, default: "Hourly realized volatility by weekday and UTC hour" },
  gradientId: { type: String, default: "rv-hourly-red-gradient" },
  colorMode: { type: String, default: "sequential-red" },
  legendDecimals: { type: Number, default: 0 },
  valueDecimals: { type: Number, default: 2 },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
let resizeObserver;
const font = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';

defineExpose({
  exportPng(options = {}) {
    exportChartToPng({ element: svgRef.value, ...options });
  },
});

function styleAxis(group) {
  group.selectAll("path, line").remove();
  group.selectAll("text")
    .attr("fill", RV_AXIS_COLOR)
    .style("font", `${RV_AXIS_FONT_SIZE}px ${font}`);
}

function formatValue(value, decimals = props.valueDecimals) {
  const formatted = d3.format(`.${decimals}%`)(value);
  return props.colorMode === "diverging" && value > 0 ? `+${formatted}` : formatted;
}

function aggregateTooltip(row) {
  const values = (row.values || []).filter(Number.isFinite).sort(d3.ascending);
  const median = d3.quantileSorted(values, 0.5);
  const deviation = d3.deviation(values);
  return [
    `${row.weekdayLabel} ${String(row.hour).padStart(2, "0")}:00 UTC`,
    `Mean  ${formatValue(row.average)}`,
    `Median  ${formatValue(median)}`,
    `Min / max  ${formatValue(values[0])} / ${formatValue(values.at(-1))}`,
    `Std dev  ${Number.isFinite(deviation) ? formatValue(deviation) : "—"}`,
    `Observations  ${values.length.toLocaleString()}`,
  ].join("\n");
}

function positionTooltip(event) {
  const tooltip = tooltipRef.value;
  const host = svgRef.value?.parentElement;
  if (!tooltip || !host) return;
  const bounds = host.getBoundingClientRect();
  const left = Math.min(event.clientX - bounds.left + 12, bounds.width - tooltip.offsetWidth - 8);
  const top = Math.max(8, event.clientY - bounds.top - tooltip.offsetHeight - 10);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function render() {
  if (!svgRef.value) return;
  if (tooltipRef.value) tooltipRef.value.hidden = true;
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  const host = svgRef.value.parentElement;
  const width = Math.max(620, host?.clientWidth || 1100);
  const height = Math.max(440, host?.clientHeight || 620);
  const margin = { top: 34, right: RV_PLOT_GUTTERS.right, bottom: 70, left: RV_PLOT_GUTTERS.left };
  const innerHeight = height - margin.top - margin.bottom;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const cells = (props.cells || []).filter((cell) => Number.isFinite(cell.average));
  if (!cells.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle")
      .attr("fill", "#666c73").style("font", `12px ${font}`)
      .text(props.loading ? props.loadingMessage : props.emptyMessage);
    return;
  }

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const commonLayout = calculateRvPlotLayout(width);
  const gridWidth = commonLayout.plotWidth;
  const gridHeight = gridWidth * 7 / 24;
  const gridX = commonLayout.plotLeft;
  const gridY = margin.top + (innerHeight - gridHeight) / 2;
  const x = d3.scaleBand().domain(hours).range([0, gridWidth]);
  const y = d3.scaleBand().domain(weekdays).range([0, gridHeight]);
  const dataExtent = d3.extent(cells, (cell) => cell.average);
  const maxAbsolute = Math.max(Math.abs(dataExtent[0]), Math.abs(dataExtent[1]));
  const extent = props.colorMode === "diverging"
    ? [-maxAbsolute, maxAbsolute]
    : dataExtent;
  const color = props.colorMode === "diverging"
    ? maxAbsolute === 0
      ? () => d3.interpolateRdBu(0.5)
      : d3.scaleDiverging(d3.interpolateRdBu).domain([extent[0], 0, extent[1]]).clamp(true)
    : extent[0] === extent[1]
      ? () => d3.interpolateReds(0.58)
      : d3.scaleSequential((value) => d3.interpolateReds(0.18 + value * 0.76)).domain(extent).clamp(true);
  const chart = svg.append("g").attr("transform", `translate(${gridX},${gridY})`);

  chart.append("g").attr("transform", `translate(0,${gridHeight})`)
    .call(d3.axisBottom(x).tickSize(0).tickPadding(10).tickFormat((hour) => String(hour))).call(styleAxis)
    .selectAll("text")
    .attr("text-anchor", "end")
    .attr("transform", "rotate(-90)")
    .attr("dx", "-0.55em")
    .attr("dy", "-0.15em");
  chart.append("g").call(d3.axisLeft(y).tickSize(0).tickPadding(12)).call(styleAxis);
  chart.append("text").attr("x", gridWidth / 2).attr("y", gridHeight + 58)
    .attr("text-anchor", "middle").attr("fill", RV_AXIS_COLOR).style("font", `${RV_AXIS_FONT_SIZE}px ${font}`).text("Hour (UTC)");
  chart.append("text").attr("transform", "rotate(-90)").attr("x", -gridHeight / 2).attr("y", -58)
    .attr("text-anchor", "middle").attr("fill", RV_AXIS_COLOR).style("font", `${RV_AXIS_FONT_SIZE}px ${font}`).text("Day of Week");

  const cell = chart.selectAll("g.heat-cell").data(cells, (row) => row.key).join("g")
    .attr("class", "heat-cell").attr("transform", (row) => `translate(${x(row.hour)},${y(row.weekdayLabel)})`);
  cell.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth())
    .attr("fill", (row) => color(row.average)).attr("stroke", "#090a0d").attr("stroke-width", 1)
    .attr("aria-label", (row) => aggregateTooltip(row).replaceAll("\n", ". "))
    .on("mouseenter", function (event, row) {
      d3.select(this).attr("stroke", "#000000").attr("stroke-width", 2);
      if (tooltipRef.value) {
        tooltipRef.value.textContent = aggregateTooltip(row);
        tooltipRef.value.hidden = false;
        positionTooltip(event);
      }
    })
    .on("mousemove", positionTooltip)
    .on("mouseleave", function () {
      d3.select(this).attr("stroke", "#090a0d").attr("stroke-width", 1);
      if (tooltipRef.value) tooltipRef.value.hidden = true;
    });

  const legendHeight = Math.min(180, gridHeight * 0.58);
  const legendX = gridX + gridWidth + 24;
  const legendY = gridY + (gridHeight - legendHeight) / 2;
  const legend = svg.append("g").attr("transform", `translate(${legendX},${legendY})`);
  const gradient = svg.append("defs").append("linearGradient").attr("id", props.gradientId)
    .attr("x1", "0%").attr("x2", "0%").attr("y1", "100%").attr("y2", "0%");
  gradient.selectAll("stop").data(d3.range(0, 1.01, 0.1)).join("stop")
    .attr("offset", (value) => `${value * 100}%`).attr("stop-color", (value) => color(extent[0] + value * (extent[1] - extent[0])));
  legend.append("rect").attr("width", 14).attr("height", legendHeight).attr("fill", `url(#${props.gradientId})`)
    .attr("stroke", "#090a0d").attr("stroke-width", 1);
  legend.append("text").attr("x", -2).attr("y", -10).attr("fill", RV_AXIS_COLOR).style("font", `${RV_AXIS_FONT_SIZE}px ${font}`).text(props.legendLabel);
  [extent[0], (extent[0] + extent[1]) / 2, extent[1]].forEach((value, index) => {
    const yPos = legendHeight - index * legendHeight / 2;
    legend.append("text").attr("x", 24).attr("y", yPos + 3).attr("fill", RV_AXIS_COLOR).style("font", `${RV_AXIS_FONT_SIZE}px ${font}`).text(formatValue(value, props.legendDecimals));
  });
}

watch(() => [props.cells, props.loading, props.measureLabel, props.legendLabel, props.colorMode, props.legendDecimals, props.valueDecimals], render, { deep: true });
onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  if (svgRef.value?.parentElement) resizeObserver.observe(svgRef.value.parentElement);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg" role="img" :aria-label="ariaLabel"></svg>
    <div ref="tooltipRef" class="chartTooltip" hidden></div>
  </div>
</template>

<style scoped>
.chartWrap { position: relative; }
.chartWrap,
.chartSvg { width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; }
.chartTooltip {
  position: absolute;
  z-index: 2;
  min-width: 174px;
  padding: 9px 10px;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  background: rgba(8,9,12,0.96);
  color: #f2f3f5;
  font: 11px/1.55 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(0,0,0,0.34);
}
</style>
