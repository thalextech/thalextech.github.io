<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  title: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  xMode: { type: String, default: "strike" },
  greek: { type: String, default: "delta" },
  resolution: { type: String, default: "1h" },
});

const svgRef = ref(null);
const canvasRef = ref(null);
const selectedTimestamp = ref(null);
const gradientId = `iv-gradient-${Math.random().toString(16).slice(2)}`;

const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 90, right: 70, bottom: 80, left: 80 },
};

const TEXT_STYLES = {
  axisText: { fill: "#ffffff", size: "12px" },
  axisLabel: { fill: "#ffffff", size: "16px", weight: 600 },
  title: { fill: "#ffffff", size: "22px", weight: 600 },
  subtitle: { fill: "#ffffff", size: "18px" },
  legendTitle: { fill: "#ffffff", size: "12px", weight: 600 },
  legendLabel: { fill: "#ffffff", size: "11px" },
  noData: { fill: "#c9c9cf", size: "14px" },
};

const applyTextStyle = (node, styleKey) => {
  const style = TEXT_STYLES[styleKey];
  if (!style) return node;
  node.style("font-family", SVG_FONT_FAMILY);
  if (style.fill) node.attr("fill", style.fill);
  if (style.size) node.style("font-size", style.size);
  if (style.weight != null) node.style("font-weight", style.weight);
  return node;
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  applyTextStyle(axisG.selectAll("text"), "axisText");
};

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin } = layout;
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  // Transparent background to let canvas show through
  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "none")
    .attr("pointer-events", "all");

  const canvas = canvasRef.value;
  let ctx = null;
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    ctx = canvas.getContext("2d", { alpha: true });
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }

  const chartTitle = props.title || "Options delta vs moneyness";
  const chartSubtitle = props.subtitle || "";

  applyTextStyle(
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 32)
      .attr("text-anchor", "middle")
      .text(chartTitle),
    "title",
  );

  if (chartSubtitle) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", 58)
        .attr("text-anchor", "middle")
        .text(chartSubtitle),
      "subtitle",
    );
  }

  if (!props.data || !props.data.length) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .text(props.loading ? "Loading data..." : "No data available."),
      "noData",
    );
    return;
  }

  // Group data by timestamp to get unique timestamps with index prices
  const dataByTimestamp = new Map();
  props.data.forEach((d) => {
    if (!dataByTimestamp.has(d.ts)) {
      dataByTimestamp.set(d.ts, {
        ts: d.ts,
        date_time: d.date_time,
        index_price_close: d.index_price_close,
      });
    }
  });
  const timeSeriesData = Array.from(dataByTimestamp.values()).sort(
    (a, b) => a.ts - b.ts,
  );

  // Initialize selected timestamp to the latest if not set
  if (timeSeriesData.length > 0) {
    const latestTs = timeSeriesData[timeSeriesData.length - 1].ts;
    const hasCurrent = timeSeriesData.some(
      (d) => d.ts === selectedTimestamp.value,
    );
    if (selectedTimestamp.value === null || !hasCurrent) {
      selectedTimestamp.value = latestTs;
    }
  }

  const useStrike = props.xMode === "strike";

  const greekKey = ["delta", "gamma", "theta", "vega"].includes(props.greek)
    ? props.greek
    : "delta";
  const xLabel = useStrike ? "strike" : "S/K";
  const yLabel = greekKey;
  const normalizeGreekValue = (key, value) =>
    key === "vega" && Number.isFinite(value) ? value / 100 : value;

  const xAccessor = (d) => {
    if (useStrike) return d.strike;
    return d.m;
  };

  const yAccessor = (d) => normalizeGreekValue(greekKey, d[greekKey]);

  const yValues = props.data.map(yAccessor).filter(Number.isFinite);

  if (!yValues.length) return;

  const mainChartRight = width - margin.right;

  let x = null;
  let xAxis = null;
  if (useStrike) {
    const strikes = [
      ...new Set(props.data.map((d) => d.strike).filter(Number.isFinite)),
    ].sort((a, b) => a - b);
    if (!strikes.length) return;
    x = d3
      .scalePoint()
      .domain(strikes)
      .range([margin.left, mainChartRight])
      .padding(0.5);
    const tickStep = Math.max(1, Math.ceil(strikes.length / 10));
    const tickValues = strikes.filter((_, i) => i % tickStep === 0);
    xAxis = d3
      .axisBottom(x)
      .tickValues(tickValues)
      .tickFormat(d3.format("~g"))
      .tickSize(0)
      .tickPadding(20);
  } else {
    const xValues = props.data.map(xAccessor).filter(Number.isFinite);
    if (!xValues.length) return;
    const xExtent = d3.extent(xValues);
    if (!Number.isFinite(xExtent[0]) || !Number.isFinite(xExtent[1])) {
      console.error("Invalid data extents", { xExtent });
      return;
    }
    x = d3
      .scaleLinear()
      .domain(xExtent)
      .nice()
      .range([margin.left, mainChartRight]);
    xAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(20);
  }

  const yExtent = d3.extent(yValues);
  if (!Number.isFinite(yExtent[0]) || !Number.isFinite(yExtent[1])) {
    console.error("Invalid data extents", { yExtent });
    return;
  }

  const y = d3
    .scaleLinear()
    .domain(yExtent)
    .nice()
    .range([height - margin.bottom, margin.top]);

  const mainGroup = svg.append("g");

  const yAxis = d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(20);

  mainGroup
    .append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(xAxis)
    .call(axisStyle);
  mainGroup
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(yAxis)
    .call(axisStyle);

  applyTextStyle(
    svg
      .append("text")
      .attr("x", (margin.left + mainChartRight) / 2)
      .attr("y", height - 24)
      .attr("text-anchor", "middle")
      .text(xLabel),
    "axisLabel",
  );

  applyTextStyle(
    svg
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -height / 2)
      .attr("y", 26)
      .attr("text-anchor", "middle")
      .text(yLabel),
    "axisLabel",
  );

  const colorAccessor = (d) => normalizeGreekValue(greekKey, d[greekKey]);
  const colorLabel = greekKey;

  const colorExtent = d3.extent(props.data, colorAccessor);
  const domainMin = Number.isFinite(colorExtent[0]) ? colorExtent[0] : 0;
  const domainMax = Number.isFinite(colorExtent[1])
    ? colorExtent[1]
    : domainMin + 1;

  const color = d3
    .scaleSequential()
    .domain([domainMin, domainMax])
    .interpolator(d3.interpolateRdBu);

  const points = [...props.data].filter(
    (d) => Number.isFinite(xAccessor(d)) && Number.isFinite(yAccessor(d)),
  );

  // Create canvas for rendering points
  if (!canvas || !ctx) return;

  // Function to draw all points on canvas
  function drawPoints(highlightedTs = selectedTimestamp.value) {
    ctx.clearRect(0, 0, width, height);

    // Adjust opacity based on resolution
    const baseOpacity = props.resolution === "1d" ? 0.2 : 0.05;
    const highlightOpacity = props.resolution === "1d" ? 0.9 : 0.8;

    // Draw non-highlighted points first
    points.forEach((d) => {
      if (d.ts === highlightedTs) return;

      const cx = x(xAccessor(d));
      const cy = y(yAccessor(d));
      const size = 100;
      const radius = Math.sqrt(size / Math.PI);

      ctx.globalAlpha = baseOpacity;
      ctx.fillStyle = color(colorAccessor(d));
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 0.3;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    });

    // Get highlighted points and sort by x value for curve
    const highlightedPoints = points
      .filter((d) => d.ts === highlightedTs)
      .sort((a, b) => xAccessor(a) - xAccessor(b));

    // Draw highlighted points on top
    highlightedPoints.forEach((d) => {
      const cx = x(xAccessor(d));
      const cy = y(yAccessor(d));
      const size = 250;
      const radius = Math.sqrt(size / Math.PI);

      ctx.globalAlpha = highlightOpacity;
      ctx.fillStyle = color(colorAccessor(d));
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 0.2;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  }

  // Initial draw
  drawPoints();

  const legendWidth = 140;
  const legendHeight = 10;
  const legendX = mainChartRight - legendWidth - 10;
  const legendY = 40;

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

  const legend = svg
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  applyTextStyle(
    legend.append("text").attr("x", 0).attr("y", 0).text(colorLabel),
    "legendTitle",
  );

  legend
    .append("rect")
    .attr("x", 0)
    .attr("y", 8)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`)
    .attr("stroke", "#2e3040");

  applyTextStyle(
    legend.append("text").attr("x", 0).attr("y", 32).text(domainMin.toFixed(2)),
    "legendLabel",
  );

  applyTextStyle(
    legend
      .append("text")
      .attr("x", legendWidth)
      .attr("y", 32)
      .attr("text-anchor", "end")
      .text(domainMax.toFixed(2)),
    "legendLabel",
  );

  // === Tooltip for data points ===
  const tooltip = svg
    .append("g")
    .attr("class", "tooltip")
    .attr("visibility", "hidden")
    .attr("pointer-events", "none");

  const tooltipBg = tooltip
    .append("rect")
    .attr("fill", "rgba(0, 0, 0, 0.85)")
    .attr("stroke", "#444")
    .attr("rx", 6)
    .attr("ry", 6);

  const tooltipText = tooltip
    .append("text")
    .attr("fill", "#fff")
    .attr("font-size", "12px")
    .attr("font-family", SVG_FONT_FAMILY);

  const formatGreek = (val, decimals = 4) =>
    Number.isFinite(val) ? val.toFixed(decimals) : "N/A";
  const formatIndexPrice = (val) =>
    Number.isFinite(val) ? d3.format("$,.2f")(val) : "N/A";

  function showTooltip(d, px, py) {
    const lines = [
      d.instrument_name,
      `Index: ${formatIndexPrice(d.index_price_close)}`,
      `Delta: ${formatGreek(d.delta)}`,
      `Gamma: ${formatGreek(d.gamma, 6)}`,
      `Theta: ${formatGreek(d.theta)}`,
      `Vega: ${formatGreek(normalizeGreekValue("vega", d.vega), 2)}`,
    ];

    tooltipText.selectAll("tspan").remove();
    lines.forEach((line, i) => {
      tooltipText
        .append("tspan")
        .attr("x", 10)
        .attr("dy", i === 0 ? 18 : 16)
        .attr("font-weight", i === 0 ? 600 : 400)
        .text(line);
    });

    const bbox = tooltipText.node().getBBox();
    const padding = 10;
    tooltipBg
      .attr("width", bbox.width + padding * 2)
      .attr("height", bbox.height + padding);

    // Position tooltip, keeping it within chart bounds
    let tx = px + 15;
    let ty = py - bbox.height / 2;
    if (tx + bbox.width + padding * 2 > mainChartRight) {
      tx = px - bbox.width - padding * 2 - 15;
    }
    if (ty < margin.top) ty = margin.top;
    if (ty + bbox.height + padding > height - margin.bottom) {
      ty = height - margin.bottom - bbox.height - padding;
    }

    tooltip.attr("transform", `translate(${tx}, ${ty})`);
    tooltip.attr("visibility", "visible");
  }

  function hideTooltip() {
    tooltip.attr("visibility", "hidden");
  }

  // Interaction overlay for main chart area
  const chartOverlay = svg
    .append("rect")
    .attr("x", margin.left)
    .attr("y", margin.top)
    .attr("width", mainChartRight - margin.left)
    .attr("height", height - margin.top - margin.bottom)
    .attr("fill", "transparent")
    .attr("cursor", "crosshair");

  chartOverlay.on("mousemove", function (event) {
    const [mouseX, mouseY] = d3.pointer(event, svg.node());

    if (!points.length) {
      hideTooltip();
      return;
    }

    // Find closest point
    let closest = null;
    let minDist = Infinity;
    const maxDist = 30; // Max pixel distance to show tooltip

    points.forEach((d) => {
      const px = x(xAccessor(d));
      const py = y(yAccessor(d));
      const dist = Math.sqrt((mouseX - px) ** 2 + (mouseY - py) ** 2);
      if (dist < minDist) {
        minDist = dist;
        closest = { d, px, py };
      }
    });

    if (closest && minDist < maxDist) {
      showTooltip(closest.d, closest.px, closest.py);
    } else {
      hideTooltip();
    }
  });

  chartOverlay.on("mouseleave", hideTooltip);
};

watch(
  () => [
    props.data,
    props.title,
    props.subtitle,
    props.loading,
    props.xMode,
    props.greek,
    props.resolution,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <canvas ref="canvasRef" class="chart-canvas" />
    <svg ref="svgRef" class="chart-svg" />
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

.chart-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

.chart-svg {
  display: block;
  width: 100%;
  height: auto;
  position: relative;
  z-index: 2;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
  z-index: 3;
}
</style>
