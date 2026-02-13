<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  opacityRange: { type: Array, default: () => [0.12, 0.9] },
  sizeRange: { type: Array, default: () => [0.7, 1.55] },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `delta-skew-gradient-${Math.random().toString(16).slice(2)}`;

const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 100, right: 80, bottom: 70, left: 90 },
  panelGap: 150,
};

const DELTA_MIN = 0.05;
const DELTA_MAX = 0.55;
const DOT_AREA_RANGE = [20, 40];

function exportPng({ filename = "call-put-delta-skew.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

const hideTooltip = () => {
  const tooltip = tooltipRef.value;
  if (!tooltip) return;
  tooltip.style.opacity = "0";
};

const showTooltip = ({ datum, cx, cy }) => {
  const tooltip = tooltipRef.value;
  const svgEl = svgRef.value;
  const wrapper = svgEl?.closest(".chartWrap");
  if (!tooltip || !svgEl || !wrapper) return;

  const formatDate = d3.utcFormat("%d %b %y %H:%M");
  const formatNum = d3.format(",.2f");
  const formatDelta = d3.format(".4f");
  const formatIv = d3.format(".2%");

  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date_time)}</div>
    <div>Type: ${(datum.option_type || "").toUpperCase()}</div>
    <div>Mark: ${formatNum(datum.mark_price_close)}</div>
    <div>Delta abs: ${formatDelta(datum.delta_abs)}</div>
    <div>IV: ${formatIv(datum.iv_close)}</div>
  `;

  const viewBox = svgEl.viewBox?.baseVal;
  const viewBoxWidth = Number(viewBox?.width) || layout.width;
  const viewBoxHeight = Number(viewBox?.height) || layout.height;
  const svgRect = svgEl.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();

  const wrapperOffsetX = svgRect.left - wrapperRect.left;
  const wrapperOffsetY = svgRect.top - wrapperRect.top;

  const anchorX = wrapperOffsetX + (cx / viewBoxWidth) * svgRect.width;
  const anchorY = wrapperOffsetY + (cy / viewBoxHeight) * svgRect.height;

  tooltip.style.left = `${anchorX}px`;
  tooltip.style.top = `${anchorY}px`;
  tooltip.style.opacity = "1";

  const tooltipRect = tooltip.getBoundingClientRect();
  const edgePadding = 8;
  const verticalGap = 18;

  const centeredLeft = anchorX - tooltipRect.width / 2;
  const clampedLeft = Math.max(
    edgePadding,
    Math.min(wrapperRect.width - tooltipRect.width - edgePadding, centeredLeft),
  );
  const aboveTop = anchorY - tooltipRect.height - verticalGap;
  const minTop = layout.margin.top - 10;
  const maxTop = wrapperRect.height - tooltipRect.height - edgePadding;

  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${Math.max(minTop, Math.min(maxTop, aboveTop))}px`;
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#ffffff")
    .style("font-family", SVG_FONT_FAMILY)
    .style("font-size", "14px");
};

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin, panelGap } = layout;
  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");

  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#000");

  const subtitleText = props.subtitle || "";
  if (subtitleText) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 44)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "16px")
      .text(subtitleText);
  }

  const rows = (props.data || []).filter((row) => {
    const type = (row?.option_type || "").toLowerCase();
    if (type !== "call" && type !== "put") return false;
    if (!Number.isFinite(row?.delta_abs)) return false;
    if (!Number.isFinite(row?.iv_close)) return false;
    if (!Number.isFinite(row?.mark_price_close)) return false;
    if (!Number.isFinite(row?.index_price_close)) return false;
    return row.delta_abs > DELTA_MIN && row.delta_abs < DELTA_MAX;
  });

  if (!rows.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "15px")
      .text(props.loading ? "Loading data..." : "No data for selected expiration.");
    hideTooltip();
    return;
  }

  const calls = rows.filter((row) => row.option_type === "call");
  const puts = rows.filter((row) => row.option_type === "put");
  const panels = [
    { title: "Puts", rows: puts, showYAxis: true, reverseX: false },
    { title: "Calls", rows: calls, showYAxis: false, reverseX: true },
  ];

  const innerWidth = width - margin.left - margin.right;
  const panelWidth = (innerWidth - panelGap) / 2;
  const panelTop = margin.top;
  const panelBottom = height - margin.bottom;
  const globalIvExtent = d3.extent(rows, (row) => row.iv_close);
  const globalIvMin = Number.isFinite(globalIvExtent[0]) ? globalIvExtent[0] : 0;
  const globalIvMax = Number.isFinite(globalIvExtent[1]) ? globalIvExtent[1] : 1;
  const sharedY = d3
    .scaleLinear()
    .domain([globalIvMin, globalIvMax])
    .nice()
    .range([panelBottom, panelTop]);

  const colorExtent = d3.extent(rows, (row) => row.index_price_close);
  const colorMin = Number.isFinite(colorExtent[0]) ? colorExtent[0] : 0;
  const colorMax = Number.isFinite(colorExtent[1]) ? colorExtent[1] : 1;
  const colorSpan = colorMax - colorMin;
  const colorForIndex = (value) => {
    if (!Number.isFinite(value)) return "#7c7f8f";
    if (!(colorSpan > 0)) return d3.interpolateRdBu(0.5);
    const t = (value - colorMin) / colorSpan;
    const clamped = Math.max(0, Math.min(1, t));
    return d3.interpolateRdBu(clamped);
  };

  const sizeExtent = d3.extent(rows, (row) => row.mark_price_close);
  const sizeMin = Number.isFinite(sizeExtent[0]) ? sizeExtent[0] : 0;
  const sizeMax = Number.isFinite(sizeExtent[1]) ? sizeExtent[1] : sizeMin + 1;
  const sizeScale = d3
    .scaleLinear()
    .domain([sizeMin, sizeMax])
    .range(DOT_AREA_RANGE)
    .clamp(true);
  const opacityRangeMinRaw = Number(props.opacityRange?.[0]);
  const opacityRangeMaxRaw = Number(props.opacityRange?.[1]);
  const opacityRangeMin = Number.isFinite(opacityRangeMinRaw)
    ? Math.max(0, Math.min(1, Math.min(opacityRangeMinRaw, opacityRangeMaxRaw)))
    : 0.12;
  const opacityRangeMax = Number.isFinite(opacityRangeMaxRaw)
    ? Math.max(0, Math.min(1, Math.max(opacityRangeMinRaw, opacityRangeMaxRaw)))
    : 0.9;
  const sizeRangeMinRaw = Number(props.sizeRange?.[0]);
  const sizeRangeMaxRaw = Number(props.sizeRange?.[1]);
  const sizeRangeMin = Number.isFinite(sizeRangeMinRaw)
    ? Math.max(0.2, Math.min(2.5, Math.min(sizeRangeMinRaw, sizeRangeMaxRaw)))
    : 0.7;
  const sizeRangeMax = Number.isFinite(sizeRangeMaxRaw)
    ? Math.max(0.2, Math.min(2.5, Math.max(sizeRangeMinRaw, sizeRangeMaxRaw)))
    : 1.55;
  const tsExtent = d3.extent(rows, (row) => row.ts);
  const tsMin = Number.isFinite(tsExtent[0]) ? tsExtent[0] : 0;
  const tsMax = Number.isFinite(tsExtent[1]) ? tsExtent[1] : tsMin;
  const tsSpan = tsMax - tsMin;
  const recencyNorm = (row) => {
    const ts = Number(row?.ts);
    if (!Number.isFinite(ts)) return 0;
    if (!(tsSpan > 0)) return 1;
    return Math.max(0, Math.min(1, (ts - tsMin) / tsSpan));
  };
  const opacityForRow = (row) =>
    opacityRangeMin + (opacityRangeMax - opacityRangeMin) * recencyNorm(row);
  const radiusForRow = (row) => {
    const baseRadius = Math.sqrt(sizeScale(row.mark_price_close) / Math.PI);
    const recencySizeFactor =
      sizeRangeMin + (sizeRangeMax - sizeRangeMin) * recencyNorm(row);
    return baseRadius * recencySizeFactor;
  };

  const defs = svg.append("defs");
  const gradient = defs
    .append("linearGradient")
    .attr("id", gradientId)
    .attr("x1", "0%")
    .attr("x2", "100%")
    .attr("y1", "0%")
    .attr("y2", "0%");
  gradient
    .append("stop")
    .attr("offset", "0%")
    .attr("stop-color", d3.interpolateRdBu(0));
  gradient
    .append("stop")
    .attr("offset", "50%")
    .attr("stop-color", d3.interpolateRdBu(0.5));
  gradient
    .append("stop")
    .attr("offset", "100%")
    .attr("stop-color", d3.interpolateRdBu(1));

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = width - margin.right - legendWidth;
  const legendY = 52;
  const formatIndex = d3.format(",.0f");

  const legend = svg
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);
  legend
    .append("text")
    .attr("x", 0)
    .attr("y", -6)
    .attr("fill", "#d6d7de")
    .style("font-family", SVG_FONT_FAMILY)
    .style("font-size", "12px")
    .text("Index Price");
  legend
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`)
    .attr("stroke", "#2e3040");
  legend
    .append("text")
    .attr("x", 0)
    .attr("y", 26)
    .attr("fill", "#a9abb6")
    .style("font-family", SVG_FONT_FAMILY)
    .style("font-size", "11px")
    .text(formatIndex(colorMin));
  legend
    .append("text")
    .attr("x", legendWidth)
    .attr("y", 26)
    .attr("text-anchor", "end")
    .attr("fill", "#a9abb6")
    .style("font-family", SVG_FONT_FAMILY)
    .style("font-size", "11px")
    .text(formatIndex(colorMax));

  panels.forEach((panel, index) => {
    const left = margin.left + index * (panelWidth + panelGap);
    const right = left + panelWidth;

    const panelRows = panel.rows;
    const xExtent = d3.extent(panelRows, (row) => row.delta_abs);
    const xDomain =
      Number.isFinite(xExtent[0]) && Number.isFinite(xExtent[1])
        ? [xExtent[0], xExtent[1]]
        : [DELTA_MIN, DELTA_MAX];

    const x = d3
      .scaleLinear()
      .domain(xDomain)
      .nice()
      .range(panel.reverseX ? [right, left] : [left, right]);

    const xAxis = d3
      .axisBottom(x)
      .ticks(6)
      .tickSize(0)
      .tickPadding(12)
      .tickFormat(d3.format(".2f"));

    const yAxis = d3
      .axisLeft(sharedY)
      .ticks(6)
      .tickSize(0)
      .tickPadding(12)
      .tickFormat(d3.format(".2f"));

    svg
      .append("g")
      .attr("transform", `translate(0,${panelBottom})`)
      .call(xAxis)
      .call(axisStyle);

    if (panel.showYAxis) {
      svg
        .append("g")
        .attr("transform", `translate(${left},0)`)
        .call(yAxis)
        .call(axisStyle);

      svg
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -(panelTop + panelBottom) / 2)
        .attr("y", 26)
        .attr("text-anchor", "middle")
        .attr("fill", "#ffffff")
        .style("font-family", SVG_FONT_FAMILY)
        .style("font-size", "16px")
        .style("font-weight", 600)
        .text("IV");
    }

    svg
      .append("text")
      .attr("x", (left + right) / 2)
      .attr("y", panelBottom + 42)
      .attr("text-anchor", "middle")
      .attr("fill", "#ffffff")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "14px")
      .style("font-weight", 600)
      .text("delta_abs");

    svg
      .append("text")
      .attr("x", (left + right) / 2)
      .attr("y", panelTop - 26)
      .attr("text-anchor", "middle")
      .attr("fill", "#ffffff")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "22px")
      .style("font-weight", 700)
      .text(panel.title);

    if (index === 0) {
      const separatorX = right + panelGap / 2;
      svg
        .append("line")
        .attr("x1", separatorX)
        .attr("x2", separatorX)
        .attr("y1", panelTop)
        .attr("y2", panelBottom)
        .attr("stroke", "#2e3040")
        .attr("stroke-width", 1);
    }

    const panelGroup = svg.append("g");
    panelGroup
      .selectAll("circle.skew-point")
      .data(panelRows)
      .join("circle")
      .attr("class", "skew-point")
      .attr("cx", (row) => x(row.delta_abs))
      .attr("cy", (row) => sharedY(row.iv_close))
      .attr("r", (row) => radiusForRow(row))
      .attr("fill", (row) => colorForIndex(row.index_price_close))
      .attr("opacity", (row) => opacityForRow(row))
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 0.2)
      .on("mouseenter", (event, row) => {
        showTooltip({
          datum: row,
          cx: x(row.delta_abs),
          cy: sharedY(row.iv_close),
        });
        d3.select(event.currentTarget).attr("opacity", 1).attr("stroke-width", 0.8);
      })
      .on("mousemove", (event, row) => {
        showTooltip({
          datum: row,
          cx: x(row.delta_abs),
          cy: sharedY(row.iv_close),
        });
        d3.select(event.currentTarget).attr("opacity", 1).attr("stroke-width", 0.8);
      })
      .on("mouseleave", (event, row) => {
        hideTooltip();
        d3.select(event.currentTarget)
          .attr("opacity", opacityForRow(row))
          .attr("stroke-width", 0.2);
      });
  });
};

watch(
  () => [props.data, props.subtitle, props.loading, props.opacityRange, props.sizeRange],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap" @pointerleave="hideTooltip">
    <svg ref="svgRef" class="chartSvg" />
    <div ref="tooltipRef" class="tooltip" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

.tooltip {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate3d(0, 0, 0);
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid #2e3040;
  color: #e8e8ea;
  font-size: 12px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: nowrap;
  z-index: 3;
}

.tooltip-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
  z-index: 4;
}
</style>
