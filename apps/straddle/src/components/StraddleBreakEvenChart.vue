<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  actualData: { type: Array, default: () => [] },
  projectedData: { type: Array, default: () => [] },
  breakEvenLow: { type: Number, default: null },
  breakEvenHigh: { type: Number, default: null },
  currentIndex: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  title: { type: String, default: "BTC Straddle Break-Evens" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const CHART_FONT_FAMILY =
  '"Helvetica Neue", Helvetica, -apple-system, sans-serif';

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 96, right: 84, bottom: 78, left: 80 },
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#70767d")
    .style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY);
};

function exportPng({ filename = "straddle-break-even.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#0a0b0e");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .style("font-size", "18px")
    .style("font-weight", 650)
    .style("font-family", CHART_FONT_FAMILY)
    .text(props.title);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 62)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(props.subtitle);
  }

  const actual = (props.actualData || []).filter(
    (d) => d?.date instanceof Date && Number.isFinite(d?.value),
  );

  if (!actual.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "12px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(props.loading ? "Loading..." : "No data available.");
    return;
  }

  const firstDate = actual[0].date;
  const lastActualDate = actual[actual.length - 1].date;
  const expiryDate = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000)
    : null;
  const maxDate =
    expiryDate instanceof Date && expiryDate > lastActualDate
      ? expiryDate
      : lastActualDate;

  const yValues = [];
  for (const point of actual) {
    if (Number.isFinite(point.value)) yValues.push(point.value);
    if (Number.isFinite(point.low)) yValues.push(point.low);
    if (Number.isFinite(point.high)) yValues.push(point.high);
  }
  if (Number.isFinite(props.breakEvenLow)) yValues.push(props.breakEvenLow);
  if (Number.isFinite(props.breakEvenHigh)) yValues.push(props.breakEvenHigh);
  if (Number.isFinite(props.currentIndex)) yValues.push(props.currentIndex);

  const minBase = d3.min(yValues) ?? 0;
  const maxBase = d3.max(yValues) ?? 1;
  let domainMin = minBase * 0.99;
  let domainMax = maxBase * 1.01;
  if (domainMin === domainMax) {
    const pad = Math.abs(domainMin || 1) * 0.01;
    domainMin -= pad;
    domainMax += pad;
  }

  const x = d3.scaleUtc().domain([firstDate, maxDate]).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain([domainMin, domainMax])
    .nice()
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(15))
    .call(axisStyle);

  g.append("g")
    .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(15).tickFormat(d3.format(",.0f")))
    .call(axisStyle);

  const line = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.value))
    .curve(d3.curveBasis);

  g.append("path")
    .datum(actual)
    .attr("fill", "none")
    .attr("stroke", "#f5f5f7")
    .attr("stroke-width", 1.75)
    .attr("d", line);

  const projected = (props.projectedData || []).filter(
    (d) => d?.date instanceof Date && Number.isFinite(d?.value),
  );
  if (projected.length >= 2) {
    g.append("path")
      .datum(projected)
      .attr("fill", "none")
      .attr("stroke", "#f5f5f7")
      .attr("stroke-width", 1.75)
      .attr("stroke-dasharray", "6,4")
      .attr("opacity", 0.8)
      .attr("d", line);
  }

  if (Number.isFinite(props.breakEvenLow)) {
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", y(props.breakEvenLow))
      .attr("y2", y(props.breakEvenLow))
      .attr("stroke", "firebrick")
      .attr("stroke-width", 2);
  }
  if (Number.isFinite(props.breakEvenHigh)) {
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", y(props.breakEvenHigh))
      .attr("y2", y(props.breakEvenHigh))
      .attr("stroke", "forestgreen")
      .attr("stroke-width", 2);
  }

  const rightX = innerWidth - 8;
  if (Number.isFinite(props.breakEvenLow)) {
    g.append("text")
      .attr("x", rightX)
      .attr("y", y(props.breakEvenLow) - 10)
      .attr("text-anchor", "end")
      .attr("fill", "firebrick")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(`BE Low = ${d3.format(",.0f")(props.breakEvenLow)}`);
  }
  if (Number.isFinite(props.breakEvenHigh)) {
    g.append("text")
      .attr("x", rightX)
      .attr("y", y(props.breakEvenHigh) - 10)
      .attr("text-anchor", "end")
      .attr("fill", "forestgreen")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(`BE High = ${d3.format(",.0f")(props.breakEvenHigh)}`);
  }
  if (Number.isFinite(props.currentIndex)) {
    g.append("text")
      .attr("x", rightX)
      .attr("y", y(props.currentIndex) - 10)
      .attr("text-anchor", "end")
      .attr("fill", "#f5f5f7")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(`Current = ${d3.format(",.0f")(props.currentIndex)}`);
  }
}

watch(
  () => [
    props.actualData,
    props.projectedData,
    props.breakEvenLow,
    props.breakEvenHigh,
    props.currentIndex,
    props.expiryTs,
    props.title,
    props.subtitle,
    props.loading,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 7px;
  overflow: hidden;
  background: #0a0b0e;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
}
</style>
