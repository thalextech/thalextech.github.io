<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  title: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  loadingPanels: { type: Array, default: () => [] },
  mode: { type: String, default: "single" },
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
const PANEL_X_TICK_COUNT = 5;

const TEXT_STYLES = {
  axisText: { fill: "#ffffff", size: "12px" },
  axisLabel: { fill: "#ffffff", size: "16px", weight: 600 },
  title: { fill: "#ffffff", size: "22px", weight: 600 },
  subtitle: { fill: "#ffffff", size: "18px" },
  panelTitle: { fill: "#ffffff", size: "20px", weight: 700 },
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

function exportPng({ filename = "greeks.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
    drawBefore: ({ ctx, width, height, padding: p }) => {
      const canvas = canvasRef.value;
      if (!canvas) return;
      ctx.drawImage(canvas, p, p, width, height);
    },
  });
}

defineExpose({ exportPng });

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

  const chartTitle = props.title || "";
  const chartSubtitle = props.subtitle || "";

  if (chartTitle) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", 32)
        .attr("text-anchor", "middle")
        .text(chartTitle),
      "title",
    );
  }

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

  const isGammaThetaMode = props.greek === "gamma_theta";
  const useStrike = !isGammaThetaMode && props.xMode === "strike";

  const greekKey = ["delta", "gamma", "theta", "vega", "vanna"].includes(
    props.greek,
  )
    ? props.greek
    : "delta";
  const xLabel = isGammaThetaMode ? "S/K" : useStrike ? "strike" : "S/K";
  const gammaScaleFactor = 1e4;
  const ratioLabel = "|gamma/theta|";
  const isGamma = greekKey === "gamma";
  const yLabel = isGammaThetaMode
    ? ratioLabel
    : isGamma
      ? `${greekKey} [x10^4]`
      : greekKey;
  const normalizeGreekValue = (key, value) =>
    key === "vega" && Number.isFinite(value)
      ? value / 100
      : key === "gamma" && Number.isFinite(value)
        ? value * gammaScaleFactor
        : value;

  const xAccessor = (d) => {
    if (isGammaThetaMode) return d.m;
    if (useStrike) return d.strike;
    return d.m;
  };

  const yAccessor = (d) => {
    if (isGammaThetaMode) {
      const gamma = Number(d?.gamma);
      const theta = Number(d?.theta);
      if (!Number.isFinite(gamma) || !Number.isFinite(theta) || theta === 0) {
        return NaN;
      }
      return Math.abs(gamma / theta);
    }
    return normalizeGreekValue(greekKey, d[greekKey]);
  };
  const yValues = props.data.map(yAccessor).filter(Number.isFinite);
  if (!yValues.length) return;

  const isMultiMode = props.mode === "multi";
  const mainChartRight = width - margin.right;
  const panelGap = 56;
  const expiryLabels = Array.from(
    new Set(
      props.data
        .map((point) => point?.expiry_date)
        .filter((expiry) => typeof expiry === "string" && expiry.length),
    ),
  ).sort(
    (a, b) =>
      (props.data.find((point) => point?.expiry_date === a)?.expiry_rank ??
        Number.MAX_SAFE_INTEGER) -
      (props.data.find((point) => point?.expiry_date === b)?.expiry_rank ??
        Number.MAX_SAFE_INTEGER),
  );
  if (!expiryLabels.length) return;
  const panelLabels = isMultiMode ? ["__multi__"] : expiryLabels.slice(0, 1);
  const panelCount = panelLabels.length;
  const totalGap = panelCount > 1 ? panelGap * (panelCount - 1) : 0;
  const panelWidth = (mainChartRight - margin.left - totalGap) / panelCount;
  if (!(panelWidth > 0)) return;
  const loadingPanelSet = new Set(
    isMultiMode
      ? []
      : (props.loadingPanels || []).filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < panelCount,
        ),
  );

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

  const panelScaleByLabel = new Map();
  const panelConfigs = [];
  if (isMultiMode) {
    const panelXValues = props.data.map(xAccessor).filter(Number.isFinite);
    const xExtent = d3.extent(panelXValues);
    if (!Number.isFinite(xExtent[0]) || !Number.isFinite(xExtent[1])) return;
    const left = margin.left;
    const right = mainChartRight;
    const x = d3.scaleLinear().domain(xExtent).nice().range([left, right]);
    const xAxis = d3
      .axisBottom(x)
      .ticks(PANEL_X_TICK_COUNT)
      .tickSize(0)
      .tickPadding(20);
    if (useStrike) {
      xAxis.tickFormat(d3.format(",.0f"));
    } else if (isGammaThetaMode) {
      xAxis.tickFormat(d3.format(".3f"));
    }
    panelConfigs.push({ label: null, x, xAxis, left, right });
    expiryLabels.forEach((label) => {
      panelScaleByLabel.set(label, { x, xAxis, left, right });
    });
  } else {
    panelLabels.forEach((label, index) => {
      const panelPoints = props.data.filter(
        (point) => point?.expiry_date === label,
      );
      const panelXValues = panelPoints.map(xAccessor).filter(Number.isFinite);
      if (!panelXValues.length) return;
      const xExtent = d3.extent(panelXValues);
      if (!Number.isFinite(xExtent[0]) || !Number.isFinite(xExtent[1])) return;

      const left = margin.left + index * (panelWidth + panelGap);
      const right = left + panelWidth;
      const x = d3.scaleLinear().domain(xExtent).nice().range([left, right]);
      const xAxis = d3
        .axisBottom(x)
        .ticks(PANEL_X_TICK_COUNT)
        .tickSize(0)
        .tickPadding(20);
      if (useStrike) {
        xAxis.tickFormat(d3.format(",.0f"));
      } else if (isGammaThetaMode) {
        xAxis.tickFormat(d3.format(".3f"));
      }
      panelConfigs.push({ label, x, xAxis, left, right });
      panelScaleByLabel.set(label, { x, xAxis, left, right });
    });
  }
  if (!panelScaleByLabel.size) return;

  const mainGroup = svg.append("g");

  const yAxis = d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(20);

  mainGroup
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(yAxis)
    .call(axisStyle);

  panelConfigs.forEach((panel, index) => {
    if (!panel) return;

    mainGroup
      .append("g")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(panel.xAxis)
      .call(axisStyle);

    applyTextStyle(
      svg
        .append("text")
        .attr("x", (panel.left + panel.right) / 2)
        .attr("y", height - 24)
        .attr("text-anchor", "middle")
        .text(xLabel),
      "axisLabel",
    );

    if (!isMultiMode && panel.label) {
      applyTextStyle(
        svg
          .append("text")
          .attr("x", (panel.left + panel.right) / 2)
          .attr("y", 58)
          .attr("text-anchor", "middle")
          .text(panel.label),
        "panelTitle",
      );
    }

    if (panelCount > 1 && index < panelCount - 1) {
      const separatorX = panel.right + panelGap / 2;
      svg
        .append("line")
        .attr("x1", separatorX)
        .attr("x2", separatorX)
        .attr("y1", margin.top)
        .attr("y2", height - margin.bottom)
        .attr("stroke", "#2e3040")
        .attr("stroke-width", 1);
    }

    if (loadingPanelSet.has(index)) {
      svg
        .append("rect")
        .attr("x", panel.left)
        .attr("y", margin.top)
        .attr("width", panel.right - panel.left)
        .attr("height", height - margin.top - margin.bottom)
        .attr("fill", "rgba(0, 0, 0, 0.35)")
        .attr("pointer-events", "none");

      applyTextStyle(
        svg
          .append("text")
          .attr("x", (panel.left + panel.right) / 2)
          .attr("y", margin.top + (height - margin.top - margin.bottom) / 2)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle")
          .text("Loading..."),
        "noData",
      );
    }
  });

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

  const colorAccessor = (d) => {
    const value = yAccessor(d);
    return Number.isFinite(value) ? Math.abs(value) : NaN;
  };
  const colorLabel = isGammaThetaMode
    ? `|${ratioLabel}|`
    : isGamma
      ? `|${greekKey}| [x10^4]`
      : `|${greekKey}|`;

  const colorExtent = d3.extent(props.data, colorAccessor);
  const domainMin = Number.isFinite(colorExtent[0]) ? colorExtent[0] : 0;
  const domainMax = Number.isFinite(colorExtent[1])
    ? colorExtent[1]
    : domainMin + 1;

  const expiryIndexByLabel = new Map(
    expiryLabels.map((label, index) => [label, index]),
  );
  const expiryColorMinT = 0.08;
  const expiryColorMaxT = 0.92;
  const expiryColorScale = d3
    .scaleSequential()
    .domain([0, Math.max(1, expiryLabels.length - 1)])
    .interpolator(
      (t) => d3.interpolateRdBu(expiryColorMinT + (expiryColorMaxT - expiryColorMinT) * t),
    );
  const greekColorScale = d3
    .scaleSequential()
    .domain([domainMin, domainMax])
    .interpolator((t) => d3.interpolateRdBu(1 - t));
  const pointColor = (point) => {
    if (isMultiMode) {
      const rank = expiryIndexByLabel.get(point?.expiry_date) ?? 0;
      return expiryColorScale(rank);
    }
    return greekColorScale(colorAccessor(point));
  };

  const points = [...props.data].filter(
    (d) =>
      Number.isFinite(xAccessor(d)) &&
      Number.isFinite(yAccessor(d)) &&
      panelScaleByLabel.has(d.expiry_date),
  );

  // Create canvas for rendering points
  if (!canvas || !ctx) return;

  // Function to draw all points on canvas
  function drawPoints(highlightedTs = selectedTimestamp.value) {
    ctx.clearRect(0, 0, width, height);

    // Adjust opacity based on resolution
    const baseOpacity = 0.2;
    const highlightOpacity = 0.96;
    const normalPointSize = 90;
    const highlightPointSize = 120;

    // Draw non-highlighted points first
    points.forEach((d) => {
      if (d.ts === highlightedTs) return;
      const panel = panelScaleByLabel.get(d.expiry_date);
      if (!panel) return;

      const cx = panel.x(xAccessor(d));
      const cy = y(yAccessor(d));
      const size = normalPointSize;
      const radius = Math.sqrt(size / Math.PI);

      ctx.globalAlpha = baseOpacity;
      ctx.fillStyle = pointColor(d);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 0.8;

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
      const panel = panelScaleByLabel.get(d.expiry_date);
      if (!panel) return;
      const cx = panel.x(xAccessor(d));
      const cy = y(yAccessor(d));
      const size = highlightPointSize;
      const radius = Math.sqrt(size / Math.PI);

      ctx.globalAlpha = highlightOpacity;
      ctx.fillStyle = pointColor(d);
      ctx.strokeStyle = "#000000";
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

  const legendWidth = 160;
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

  if (isMultiMode) {
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
  } else {
    gradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", d3.interpolateRdBu(1));
    gradient
      .append("stop")
      .attr("offset", "50%")
      .attr("stop-color", d3.interpolateRdBu(0.5));
    gradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", d3.interpolateRdBu(0));
  }

  const legend = svg
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  applyTextStyle(
    legend
      .append("text")
      .attr("x", 0)
      .attr("y", 0)
      .text(isMultiMode ? "Expiry" : colorLabel),
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
    legend
      .append("text")
      .attr("x", 0)
      .attr("y", 32)
      .text(isMultiMode ? expiryLabels[0] || "short" : domainMin.toFixed(2)),
    "legendLabel",
  );

  applyTextStyle(
    legend
      .append("text")
      .attr("x", legendWidth)
      .attr("y", 32)
      .attr("text-anchor", "end")
      .text(
        isMultiMode
          ? expiryLabels[expiryLabels.length - 1] || "long"
          : domainMax.toFixed(2),
      ),
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
      `Expiry: ${d.expiry_date || "N/A"}`,
      `Index: ${formatIndexPrice(d.index_price_close)}`,
      `Delta: ${formatGreek(d.delta)}`,
      `Gamma: ${formatGreek(d.gamma, 6)}`,
      `Theta: ${formatGreek(d.theta)}`,
      `Vega: ${formatGreek(normalizeGreekValue("vega", d.vega), 2)}`,
      `Vanna: ${formatGreek(d.vanna, 6)}`,
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
      const panel = panelScaleByLabel.get(d.expiry_date);
      if (!panel) return;
      const px = panel.x(xAccessor(d));
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
    props.loadingPanels,
    props.mode,
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
