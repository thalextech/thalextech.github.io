<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import {
  RV_AXIS_COLOR,
  RV_AXIS_FONT_SIZE,
  RV_CHART_DESCRIPTION_FONT_SIZE,
  RV_CHART_TITLE_FONT_SIZE,
  calculateRvPlotLayout,
} from "../lib/rvChartLayout.js";

const props = defineProps({
  groups: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
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
  group.selectAll("path.domain").remove();
  group.selectAll("text")
    .attr("fill", RV_AXIS_COLOR)
    .style("font", `${RV_AXIS_FONT_SIZE}px ${font}`);
}

function formatVol(value) {
  return Number.isFinite(value) ? d3.format(".1%")(value) : "—";
}

function summarize(group) {
  const values = (group.values || []).filter(Number.isFinite).sort(d3.ascending);
  if (!values.length) return null;
  const q1 = d3.quantileSorted(values, 0.25);
  const median = d3.quantileSorted(values, 0.5);
  const q3 = d3.quantileSorted(values, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const whiskerLow = values.find((value) => value >= lowerFence) ?? values[0];
  const whiskerHigh = values.findLast((value) => value <= upperFence) ?? values.at(-1);
  return {
    ...group,
    values,
    q1,
    median,
    q3,
    whiskerLow,
    whiskerHigh,
    average: d3.mean(values),
  };
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

function showTooltip(event, row) {
  if (!tooltipRef.value) return;
  tooltipRef.value.textContent = [
    row.label,
    `Mean  ${formatVol(row.average)}`,
    `Median  ${formatVol(row.median)}`,
    `Middle 50%  ${formatVol(row.q1)} – ${formatVol(row.q3)}`,
    `Whiskers  ${formatVol(row.whiskerLow)} – ${formatVol(row.whiskerHigh)}`,
    `Observations  ${row.values.length.toLocaleString()}`,
  ].join("\n");
  tooltipRef.value.hidden = false;
  positionTooltip(event);
}

function render() {
  if (!svgRef.value) return;
  if (tooltipRef.value) tooltipRef.value.hidden = true;
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  const host = svgRef.value.parentElement;
  const width = Math.max(620, host?.clientWidth || 1100);
  const height = Math.max(350, host?.clientHeight || 390);
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const rows = (props.groups || []).map(summarize).filter(Boolean);
  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#666c73")
      .style("font", `12px ${font}`)
      .text(props.loading ? "Loading weekday realized volatility…" : "No weekday realized-volatility observations.");
    return;
  }

  const layout = calculateRvPlotLayout(width);
  const margin = { top: 66, right: width - layout.plotLeft - layout.plotWidth, bottom: 54, left: layout.plotLeft };
  const plotWidth = layout.plotWidth;
  const plotHeight = height - margin.top - margin.bottom;
  const x = d3.scaleBand()
    .domain(rows.map((row) => row.label))
    .range([0, plotWidth])
    .paddingInner(0.38)
    .paddingOuter(0.14);
  const visibleMax = d3.max(rows, (row) => row.whiskerHigh) || 1;
  const y = d3.scaleLinear()
    .domain([0, visibleMax * 1.1])
    .nice(5)
    .range([plotHeight, 0]);

  svg.append("text")
    .attr("x", margin.left)
    .attr("y", 18)
    .attr("fill", "#777d84")
    .attr("letter-spacing", "1px")
    .style("font", `${RV_CHART_TITLE_FONT_SIZE}px ${font}`)
    .text("HOURLY REALIZED VOLATILITY · DISTRIBUTION BY WEEKDAY");
  svg.append("text")
    .attr("x", margin.left)
    .attr("y", 40)
    .attr("fill", "#9aa0a6")
    .style("font", `${RV_CHART_DESCRIPTION_FONT_SIZE}px ${font}`)
    .text("Box = middle 50% · line = median · whiskers = 1.5× IQR · fill = mean RV");

  const chart = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  chart.append("g")
    .call(d3.axisLeft(y).ticks(5).tickSize(-plotWidth).tickFormat(d3.format(".0%")))
    .call(styleAxis)
    .selectAll(".tick line")
    .attr("stroke", "rgba(255,255,255,0.055)");
  chart.append("g")
    .attr("transform", `translate(0,${plotHeight})`)
    .call(d3.axisBottom(x).tickSize(0).tickPadding(12))
    .call(styleAxis);
  chart.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -plotHeight / 2)
    .attr("y", -55)
    .attr("text-anchor", "middle")
    .attr("fill", RV_AXIS_COLOR)
    .style("font", `${RV_AXIS_FONT_SIZE}px ${font}`)
    .text("Annualized hourly RV");

  const averageExtent = d3.extent(rows, (row) => row.average);
  const fill = averageExtent[0] === averageExtent[1]
    ? () => d3.interpolateReds(0.62)
    : d3.scaleSequential((value) => d3.interpolateReds(0.3 + value * 0.6))
      .domain(averageExtent)
      .clamp(true);
  const boxWidth = Math.min(38, x.bandwidth());
  const groups = chart.selectAll("g.weekday-box")
    .data(rows, (row) => row.key)
    .join("g")
    .attr("class", "weekday-box")
    .attr("transform", (row) => `translate(${x(row.label) + x.bandwidth() / 2},0)`)
    .style("cursor", "default");

  groups.append("line")
    .attr("y1", (row) => y(row.whiskerLow))
    .attr("y2", (row) => y(row.whiskerHigh))
    .attr("stroke", "#8e949d")
    .attr("stroke-width", 1.2);
  groups.selectAll("line.cap")
    .data((row) => [row.whiskerLow, row.whiskerHigh])
    .join("line")
    .attr("class", "cap")
    .attr("x1", -boxWidth * 0.28)
    .attr("x2", boxWidth * 0.28)
    .attr("y1", (value) => y(value))
    .attr("y2", (value) => y(value))
    .attr("stroke", "#8e949d")
    .attr("stroke-width", 1.2);
  groups.append("rect")
    .attr("x", -boxWidth / 2)
    .attr("width", boxWidth)
    .attr("y", (row) => y(row.q3))
    .attr("height", (row) => Math.max(1, y(row.q1) - y(row.q3)))
    .attr("fill", (row) => fill(row.average));
  groups.append("line")
    .attr("x1", -boxWidth / 2)
    .attr("x2", boxWidth / 2)
    .attr("y1", (row) => y(row.median))
    .attr("y2", (row) => y(row.median))
    .attr("stroke", "#f4f5f7")
    .attr("stroke-width", 1.2);
  groups.selectAll("line, rect").style("pointer-events", "none");
  groups.append("rect")
    .attr("class", "weekday-hit-area")
    .attr("x", -x.step() / 2)
    .attr("width", x.step())
    .attr("height", plotHeight)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .on("mouseenter", (event, row) => showTooltip(event, row))
    .on("mousemove", positionTooltip)
    .on("mouseleave", () => { if (tooltipRef.value) tooltipRef.value.hidden = true; });
}

watch(() => [props.groups, props.loading], render, { deep: true });
onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  if (svgRef.value?.parentElement) resizeObserver.observe(svgRef.value.parentElement);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="boxplotWrap">
    <svg ref="svgRef" class="boxplotSvg" role="img" aria-label="Hourly realized volatility distribution by weekday"></svg>
    <div ref="tooltipRef" class="chartTooltip" hidden></div>
  </div>
</template>

<style scoped>
.boxplotWrap { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.boxplotSvg { width: 100%; height: 100%; display: block; }
.chartTooltip {
  position: absolute;
  z-index: 2;
  min-width: 190px;
  padding: 9px 10px;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  background: rgba(8,9,12,0.96);
  color: #f2f3f5;
  font: 11px/1.55 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  white-space: pre-line;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(0,0,0,0.32);
}
</style>
