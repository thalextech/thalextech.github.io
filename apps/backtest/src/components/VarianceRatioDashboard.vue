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
import { RETURN_ADJUSTMENT } from "../lib/serialCorrelation.js";

const props = defineProps({
  analysis: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  underlying: { type: String, default: "BTC" },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
let resizeObserver;
const font = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const curveColor = d3.interpolateReds(0.72);
const highlightColor = d3.interpolateReds(0.48);

defineExpose({
  exportPng(options = {}) {
    exportChartToPng({ element: svgRef.value, ...options });
  },
});

const formatRatio = (value, digits = 3) =>
  Number.isFinite(value) ? d3.format(`.${digits}f`)(value) : "—";

function styleAxis(group) {
  group.selectAll("path").remove();
  group.selectAll("line").attr("stroke", "rgba(255,255,255,0.08)");
  group.selectAll("text")
    .attr("fill", RV_AXIS_COLOR)
    .style("font", `${RV_AXIS_FONT_SIZE}px ${font}`);
}

function positionTooltip(event) {
  const tooltip = tooltipRef.value;
  const host = svgRef.value?.parentElement;
  if (!tooltip || !host) return;
  const bounds = host.getBoundingClientRect();
  const left = Math.min(
    event.clientX - bounds.left + 12,
    bounds.width - tooltip.offsetWidth - 8,
  );
  const top = Math.max(
    8,
    event.clientY - bounds.top - tooltip.offsetHeight - 10,
  );
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function showTooltip(event, row, title = null) {
  if (!tooltipRef.value) return;
  tooltipRef.value.classList.remove("isMethod");
  const lines = [
    ...(title ? [title] : []),
    `Horizon  ${row.horizon}h`,
    `Variance ratio  ${formatRatio(row.ratio)}`,
    `Valid returns  ${row.count.toLocaleString()}`,
  ];
  if (Number.isFinite(row.ciLower) && Number.isFinite(row.ciUpper)) {
    lines.push(
      `95% day-bootstrap CI  ${formatRatio(row.ciLower)} to ${formatRatio(row.ciUpper)}`,
    );
  } else {
    lines.push("Point estimate only · no interval");
  }
  lines.push(
    row.ratio < 1
      ? "Moves partially reverse within this horizon"
      : row.ratio > 1
        ? "Moves extend within this horizon"
        : "Matches a random walk",
  );
  tooltipRef.value.textContent = lines.join("\n");
  tooltipRef.value.hidden = false;
  positionTooltip(event);
}

function showMethodTooltip(event) {
  if (!tooltipRef.value) return;
  tooltipRef.value.classList.add("isMethod");
  const forward = props.analysis?.anchorMode === "start";
  const varianceStandardized = props.analysis?.returnAdjustment
    === RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED;
  tooltipRef.value.textContent = [
    "METHOD + LIMITS",
    `VR(q) = 1 + 2Σ(1 − k/q)ρₖ. Line + cloud use complete ${forward ? "forward windows from the selected entry" : "selected-close days"}; the bootstrap resamples those windows, never hours.`,
    `All horizons use one ${forward ? "forward-anchored" : "close-anchored"} estimator. The chart stops at 24h rather than joining a different weekly estimator at the daily cutoff.`,
    "The denominator uses the one-hour variance pooled only from the 24 weekday-hour buckets inside the selected block, not from all hours globally.",
    ...(varianceStandardized ? [
      "Returns are additionally divided by an eight-harmonic Fourier estimate of the 168-bucket weekly volatility profile before the variance ratio is calculated.",
    ] : []),
    forward
      ? "The weekday × hour screen contains 168 comparisons. Treat it as exploratory and confirm a selected interval out of sample; one significant cell is not evidence by itself."
      : "There are 24 selectable close hours ≈ 24 tests; expect roughly one to clear 95% by chance, so one significant anchor is not evidence by itself.",
  ].join("\n\n");
  tooltipRef.value.hidden = false;
  positionTooltip(event);
}

function hideTooltip() {
  if (tooltipRef.value) tooltipRef.value.hidden = true;
}

function render() {
  if (!svgRef.value) return;
  hideTooltip();
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  const host = svgRef.value.parentElement;
  const width = Math.max(760, host?.clientWidth || 1100);
  const height = 530;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const analysis = props.analysis;
  const rows = Array.isArray(analysis?.varianceRatios)
    ? analysis.varianceRatios.filter((row) => Number.isFinite(row.ratio))
    : [];
  const headline = analysis?.headline;
  if (!analysis?.sampleSize || !rows.length || !headline) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#666c73")
      .style("font", `13px ${font}`)
      .text(
        props.loading
          ? "Loading hourly returns…"
          : "No complete hourly return sample.",
      );
    return;
  }

  const { plotLeft, plotWidth } = calculateRvPlotLayout(width);
  const margin = { left: plotLeft, right: width - plotLeft - plotWidth };
  const content = { left: plotLeft };
  const reversalIsSignificant =
    Number.isFinite(headline.ciUpper) && headline.ciUpper < 1;
  const extensionIsSignificant =
    Number.isFinite(headline.ciLower) && headline.ciLower > 1;
  const statusColor = reversalIsSignificant ? curveColor : "#9aa0a6";
  const varianceDifferencePct = Math.abs(headline.varianceDifference * 100);
  const varianceDirection = headline.varianceDifference >= 0 ? "less" : "more";
  const volatilityPoints = Math.abs(headline.volatilityDifferencePoints);
  const volatilityDirection =
    headline.volatilityDifferencePoints >= 0 ? "fewer" : "more";
  const varianceStandardized = analysis.returnAdjustment
    === RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED;
  const marketVerdict = reversalIsSignificant
    ? `${props.underlying} reversal is statistically distinguishable in this sample.`
    : extensionIsSignificant
      ? `${props.underlying} moves extend rather than reverse in this sample.`
      : "This sample cannot rule out a pure random walk because 1 is inside the CI.";
  const forward = analysis.anchorMode === "start";

  const answerTop = 65;
  const answerHeight = 72;
  const answerCenterY = answerTop + answerHeight / 2;
  svg
    .append("text")
    .attr("x", content.left + 18)
    .attr("y", answerCenterY)
    .attr("dominant-baseline", "middle")
    .attr("fill", statusColor)
    .style("font", `300 35px ${font}`)
    .text(formatRatio(headline.ratio));
  svg
    .append("text")
    .attr("x", content.left + 150)
    .attr("y", answerCenterY - 20)
    .attr("fill", "#d8dadd")
    .style("font", `400 12.5px ${font}`)
    .text(
      `${forward ? `The following 24h of ${props.underlying} returns carry` : `A day of ${props.underlying} returns carries`} ~${d3.format(".0f")(varianceDifferencePct)}% ${varianceDirection} variance than independent hourly moves imply.`,
    );
  svg
    .append("text")
    .attr("x", content.left + 150)
    .attr("y", answerCenterY)
    .attr("fill", "#d8dadd")
    .style("font", `400 12.5px ${font}`)
    .text(
      varianceStandardized
        ? "Returns scaled by the smoothed 168-bucket weekly volatility profile."
        : `In vol terms: ~${d3.format(".1f")(volatilityPoints)} ${volatilityDirection} points.`,
    );
  svg
    .append("text")
    .attr("x", content.left + 150)
    .attr("y", answerCenterY + 23)
    .attr("fill", statusColor)
    .style("font", `500 11.5px ${font}`)
    .text(marketVerdict);
  const chartHeaderY = 24;
  const plotTop = 165;
  const plotBottom = 440;
  svg
    .append("text")
    .attr("x", content.left)
    .attr("y", chartHeaderY)
    .attr("fill", "#777d84")
    .attr("letter-spacing", "1px")
    .style("font", `${RV_CHART_TITLE_FONT_SIZE}px ${font}`)
    .text(`${forward ? "FORWARD" : "ANCHORED"} TERM STRUCTURE · VR(q), 1H–24H`);
  const readingGuide = svg
    .append("text")
    .attr("x", content.left)
    .attr("y", chartHeaderY + 22)
    .attr("fill", "#9aa0a6")
    .style("font", `${RV_CHART_DESCRIPTION_FONT_SIZE}px ${font}`);
  readingGuide
    .append("tspan")
    .text("Each point: variance of within-block q-hour returns ÷ q × hourly variance.  ");
  readingGuide
    .append("tspan")
    .attr("fill", "#f2f3f5")
    .attr("font-weight", 600)
    .text("1.00 = random walk.  ");
  readingGuide
    .append("tspan")
    .text(
      "Below 1: moves partially reverse. Above 1: they extend.",
    );

  const bandRows = rows.filter(
    (row) => Number.isFinite(row.ciLower) && Number.isFinite(row.ciUpper),
  );
  const yValues = [
    1,
    ...rows.map((row) => row.ratio),
    ...bandRows.flatMap((row) => [row.ciLower, row.ciUpper]),
    headline.ratio,
  ];
  const extent = d3.extent(yValues);
  const yPadding = Math.max((extent[1] - extent[0]) * 0.12, 0.015);
  const x = d3
    .scaleLog()
    .domain([1, d3.max(rows, (row) => row.horizon)])
    .range([margin.left, margin.left + plotWidth]);
  const y = d3
    .scaleLinear()
    .domain([extent[0] - yPadding, extent[1] + yPadding])
    .range([plotBottom, plotTop])
    .nice(6);

  y.ticks(6).forEach((tick) =>
    svg
      .append("line")
      .attr("x1", margin.left)
      .attr("x2", margin.left + plotWidth)
      .attr("y1", y(tick))
      .attr("y2", y(tick))
      .attr("stroke", "rgba(255,255,255,0.055)"),
  );
  svg
    .append("line")
    .attr("x1", margin.left)
    .attr("x2", margin.left + plotWidth)
    .attr("y1", y(1))
    .attr("y2", y(1))
    .attr("stroke", "rgba(255,255,255,0.42)")
    .attr("stroke-dasharray", "5 4");
  svg
    .append("text")
    .attr("x", margin.left + plotWidth + 10)
    .attr("y", y(1))
    .attr("dominant-baseline", "middle")
    .attr("text-anchor", "start")
    .attr("fill", "#8f949b")
    .style("font", `10.5px ${font}`)
    .text("Random walk · VR = 1");

  svg
    .append("rect")
    .attr("x", margin.left)
    .attr("y", plotTop)
    .attr("width", plotWidth)
    .attr("height", plotBottom - plotTop)
    .attr("fill", "transparent")
    .on("mouseenter", showMethodTooltip)
    .on("mousemove", positionTooltip)
    .on("mouseleave", hideTooltip);

  svg
    .append("path")
    .datum(bandRows)
    .attr("fill", curveColor)
    .attr("fill-opacity", 0.16)
    .attr("stroke", "none")
    .style("pointer-events", "none")
    .attr(
      "d",
      d3
        .area()
        .x((row) => x(row.horizon))
        .y0((row) => y(row.ciLower))
        .y1((row) => y(row.ciUpper)),
    );
  svg
    .append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", curveColor)
    .attr("stroke-width", 2.1)
    .style("pointer-events", "none")
    .attr(
      "d",
      d3
        .line()
        .x((row) => x(row.horizon))
        .y((row) => y(row.ratio)),
    );

  svg
    .append("line")
    .attr("x1", x(24))
    .attr("x2", x(24))
    .attr("y1", plotTop)
    .attr("y2", plotBottom)
    .attr("stroke", highlightColor)
    .attr("stroke-opacity", 0.42)
    .attr("stroke-dasharray", "3 4");
  svg
    .append("circle")
    .attr("cx", x(24))
    .attr("cy", y(headline.ratio))
    .attr("r", 5)
    .attr("fill", highlightColor)
    .attr("stroke", "#090a0d")
    .style("cursor", "default")
    .on("mouseenter", (event) => showTooltip(
      event,
      headline,
      `${String(analysis.anchorHour ?? analysis.closeHour).padStart(2, "0")}:00 UTC ${forward ? "entry → +24h" : "anchored daily"} estimate`,
    ))
    .on("mousemove", positionTooltip)
    .on("mouseleave", hideTooltip);

  const trough = analysis.trough;
  if (trough && Number.isFinite(trough.ratio)) {
    const troughX = x(trough.horizon);
    const troughY = y(trough.ratio);
    const labelX = troughX - 14;
    const labelY = Math.min(plotBottom - 38, troughY + 42);
    if (trough.horizon !== 24) {
      svg
        .append("circle")
        .attr("cx", troughX)
        .attr("cy", troughY)
        .attr("r", 4)
        .attr("fill", highlightColor)
        .attr("stroke", "#090a0d");
    }
    svg
      .append("line")
      .attr("x1", troughX)
      .attr("y1", troughY)
      .attr("x2", labelX + 5)
      .attr("y2", labelY - 12)
      .attr("stroke", highlightColor)
      .attr("stroke-opacity", 0.78);
    const troughText = svg
      .append("text")
      .attr("x", labelX)
      .attr("y", labelY - 13)
      .attr("text-anchor", "end")
      .attr("fill", highlightColor)
      .style("font", `500 10.5px ${font}`);
    troughText.append("tspan").text(`Maximum reversal near ${trough.horizon}h`);
    troughText
      .append("tspan")
      .attr("x", labelX)
      .attr("dy", 14)
      .attr("font-weight", 400)
      .text(
        `~${d3.format(".0f")((1 - trough.ratio) * 100)}% of variance given back`,
      );

    if (headline.ratio > trough.ratio + 0.01 && trough.horizon < 24) {
      const recoveryX = x(24) - 10;
      const recoveryY = Math.max(plotTop + 30, y(headline.ratio) - 34);
      svg
        .append("line")
        .attr("x1", x(24))
        .attr("y1", y(headline.ratio))
        .attr("x2", recoveryX - 5)
        .attr("y2", recoveryY + 7)
        .attr("stroke", highlightColor)
        .attr("stroke-opacity", 0.78);
      const recoveryText = svg
        .append("text")
        .attr("x", recoveryX)
        .attr("y", recoveryY)
        .attr("text-anchor", "end")
        .attr("fill", highlightColor)
        .style("font", `500 10.5px ${font}`);
      recoveryText.append("tspan").text("Recovery into 24h");
      recoveryText
        .append("tspan")
        .attr("x", recoveryX)
        .attr("dy", 14)
        .attr("font-weight", 400)
        .text("Reversal partially completes within the day");
    }
  }

  svg
    .selectAll("circle.vr-hit")
    .data(rows, (row) => row.horizon)
    .join("circle")
    .attr("class", "vr-hit")
    .attr("cx", (row) => x(row.horizon))
    .attr("cy", (row) => y(row.ratio))
    .attr("r", 7)
    .attr("fill", "transparent")
    .on("mouseenter", (event, row) => showTooltip(event, row))
    .on("mousemove", positionTooltip)
    .on("mouseleave", hideTooltip);

  svg
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickSize(0)
        .tickPadding(12)
        .tickFormat(d3.format(".2f")),
    )
    .call(styleAxis);
  svg
    .append("g")
    .attr("transform", `translate(0,${plotBottom})`)
    .call(
      d3
        .axisBottom(x)
        .tickValues([1, 2, 4, 8, 12, 24])
        .tickFormat((tick) => `${tick}h`)
        .tickSize(0)
        .tickPadding(10),
    )
    .call(styleAxis);
  svg
    .append("text")
    .attr("x", margin.left + plotWidth / 2)
    .attr("y", plotBottom + 42)
    .attr("text-anchor", "middle")
    .attr("fill", RV_AXIS_COLOR)
    .style("font", `${RV_AXIS_FONT_SIZE}px ${font}`)
    .text("Return horizon q · logarithmic scale");
}

watch(() => [props.analysis, props.loading], render, { deep: true });
onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  if (svgRef.value?.parentElement)
    resizeObserver.observe(svgRef.value.parentElement);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="varianceRatioWrap">
    <svg
      ref="svgRef"
      class="varianceRatioSvg"
      role="img"
      aria-label="VR 24 headline and variance-ratio term structure with bootstrap confidence interval"
    ></svg>
    <div ref="tooltipRef" class="varianceRatioTooltip" hidden></div>
  </div>
</template>

<style scoped>
.varianceRatioWrap {
  position: relative;
  width: 100%;
  height: 530px;
  margin-right: auto;
  margin-left: auto;
  min-width: 0;
}
.varianceRatioSvg {
  display: block;
  width: 100%;
  height: 100%;
}
.varianceRatioTooltip {
  position: absolute;
  z-index: 3;
  min-width: 230px;
  padding: 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  background: rgba(8, 9, 12, 0.97);
  color: #f2f3f5;
  font:
    12px/1.55 "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
}
.varianceRatioTooltip.isMethod {
  width: min(440px, calc(100% - 16px));
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
