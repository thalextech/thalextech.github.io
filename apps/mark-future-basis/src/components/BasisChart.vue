<script setup>
import * as d3 from "d3";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  detailData: { type: Array, default: () => [] },
  instrumentName: { type: String, default: "" },
  detailResolution: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const scatterCanvasRef = ref(null);
const internalDetailRange = ref(null);
const gradientId = `basis-gradient-${Math.random().toString(16).slice(2)}`;
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  mainWidth: 1200,
  panelHeight: 650,
  margin: { top: 74, right: 38, bottom: 54, left: 74 },
  panelGap: 60,
};

const TEXT_STYLES = {
  axisText: { fill: "#d6d7de" },
  axisLabel: { fill: "#d6d7de", size: "12px", weight: 700 },
  mainTitle: { fill: "#fff", size: "18px", weight: 650 },
  mainSubtitle: { fill: "#c9c9cf", size: "13px" },
  detailTitle: { fill: "#fff", size: "16px", weight: 600 },
  detailSubtitle: { fill: "#c9c9cf", size: "12px" },
  legendTitle: { fill: "#d6d7de", size: "12px" },
  legendLabel: { fill: "#a9abb6", size: "11px" },
  noData: { fill: "#c9c9cf", size: "14px" },
  detailMessage: { fill: "#c9c9cf", size: "13px" },
};

const chartState = {
  gradient: null,
  background: null,
  mainTitleText: null,
  mainSubtitleText: null,
  detailTitleText: null,
  detailSubtitleText: null,
  mainGroup: null,
  xAxisGroup: null,
  yAxisGroup: null,
  pointsGroup: null,
  mainXAxisLabel: null,
  mainYAxisLabel: null,
  legendGroup: null,
  legendTitle: null,
  legendRect: null,
  legendMinText: null,
  legendMaxText: null,
  detailContainer: null,
  detailLayer: null,
  detailXAxisGroup: null,
  detailYAxisGroup: null,
  detailMessageText: null,
  detailXAxisLabel: null,
  detailYAxisLabel: null,
  brushGroup: null,
  noDataText: null,
  currentXScale: null,
};

let detailRenderContext = null;

const mainTitle = computed(
  () => `${props.instrumentName || "Instrument"} Basis`,
);

const subtitle = computed(() => {
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const data = props.data;
  if (!data.length) return "";
  const start = data[0].date;
  const end = data[data.length - 1].date;
  return `${fmt(start)} — ${fmt(end)}`;
});

const applyTextStyle = (node, styleKey) => {
  const style = TEXT_STYLES[styleKey];
  if (!style) return node;
  node.style("font-family", SVG_FONT_FAMILY);
  if (style.fill) node.attr("fill", style.fill);
  if (style.size) node.style("font-size", style.size);
  if (style.weight != null) node.style("font-weight", style.weight);
  return node;
};

let scatterCanvasScaleX = 1;
let scatterCanvasScaleY = 1;

const syncScatterCanvas = (viewWidth, viewHeight) => {
  const canvas = scatterCanvasRef.value;
  if (!canvas) return;
  let rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    const svgRect = svgRef.value?.getBoundingClientRect();
    if (!svgRect?.width || !svgRect?.height) return;
    rect = svgRect;
  }
  const ratio = window.devicePixelRatio || 1;
  const nextWidth = Math.round(rect.width * ratio);
  const nextHeight = Math.round(rect.height * ratio);
  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
  scatterCanvasScaleX = (rect.width * ratio) / viewWidth;
  scatterCanvasScaleY = (rect.height * ratio) / viewHeight;
};

const clearScatterCanvas = () => {
  const canvas = scatterCanvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  applyTextStyle(axisG.selectAll("text"), "axisText");
};

const ensureChartElements = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return null;
  const svg = d3.select(svgEl);

  const appendText = (parent, styleKey, { anchor, text } = {}) => {
    const node = parent.append("text");
    applyTextStyle(node, styleKey);
    if (anchor) node.attr("text-anchor", anchor);
    if (text != null) node.text(text);
    return node;
  };

  const appendAxisLabel = (parent, text) =>
    appendText(parent, "axisLabel", { anchor: "middle", text });

  if (!chartState.gradient) {
    const defs = svg.append("defs");
    chartState.gradient = defs
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0%")
      .attr("x2", "100%")
      .attr("y1", "0%")
      .attr("y2", "0%");
  }

  if (!chartState.background) {
    chartState.background = svg.append("rect").attr("fill", "none");
  }

  if (!chartState.mainTitleText) {
    chartState.mainTitleText = appendText(svg, "mainTitle", {
      anchor: "middle",
    });
  }

  if (!chartState.mainSubtitleText) {
    chartState.mainSubtitleText = appendText(svg, "mainSubtitle", {
      anchor: "middle",
    });
  }

  if (!chartState.detailTitleText) {
    chartState.detailTitleText = appendText(svg, "detailTitle", {
      anchor: "middle",
    });
  }

  if (!chartState.detailSubtitleText) {
    chartState.detailSubtitleText = appendText(svg, "detailSubtitle", {
      anchor: "middle",
    });
  }

  if (!chartState.legendGroup) {
    chartState.legendGroup = svg.append("g");
    chartState.legendTitle = appendText(chartState.legendGroup, "legendTitle", {
      text: "Annualized basis",
    });
    chartState.legendRect = chartState.legendGroup
      .append("rect")
      .attr("stroke", "#2e3040");
    chartState.legendMinText = appendText(
      chartState.legendGroup,
      "legendLabel",
    );
    chartState.legendMaxText = appendText(
      chartState.legendGroup,
      "legendLabel",
      { anchor: "end" },
    );
  }

  if (!chartState.noDataText) {
    chartState.noDataText = appendText(svg, "noData", { anchor: "middle" });
  }

  if (!chartState.mainGroup) {
    chartState.mainGroup = svg.append("g");
    chartState.xAxisGroup = chartState.mainGroup.append("g");
    chartState.yAxisGroup = chartState.mainGroup.append("g");
    chartState.pointsGroup = chartState.mainGroup.append("g");
    chartState.mainXAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Date (UTC)",
    );
    chartState.mainYAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Mark Price (Close)",
    );
    chartState.brushGroup = chartState.mainGroup
      .append("g")
      .attr("class", "brush");
  }

  if (!chartState.detailContainer) {
    chartState.detailContainer = svg.append("g");
    chartState.detailLayer = chartState.detailContainer.append("g");
    chartState.detailXAxisGroup = chartState.detailLayer.append("g");
    chartState.detailYAxisGroup = chartState.detailLayer.append("g");
    chartState.detailMessageText = appendText(
      chartState.detailLayer,
      "detailMessage",
      { anchor: "middle" },
    );
    chartState.detailXAxisLabel = appendAxisLabel(
      chartState.detailLayer,
      "Mark Price (Close)",
    );
    chartState.detailYAxisLabel = appendAxisLabel(
      chartState.detailLayer,
      "Annualized Basis",
    );
  }

  return svg;
};

function renderDetail(domain) {
  const ctx = detailRenderContext;
  if (!ctx || !ctx.detailActive) return;

  const {
    detailXAxisGroup,
    detailYAxisGroup,
    detailMessageText,
    detailXAxisLabel,
    detailYAxisLabel,
    scatterInnerWidth,
    innerHeight,
    axisTitlePadding,
    colorForBasis,
    detailSource,
    detailDomainFull,
    margin,
    scatterOffsetX,
    viewWidth,
    viewHeight,
  } = ctx;

  if (!detailSource.length || !detailDomainFull[0] || !detailDomainFull[1]) {
    detailMessageText
      .attr("x", scatterInnerWidth / 2)
      .attr("y", innerHeight / 2)
      .text("No detail data available.")
      .attr("display", null);
    clearScatterCanvas();
    return;
  }

  if (!Array.isArray(domain)) {
    clearScatterCanvas();
    return;
  }

  const [domainStart, domainEnd] = domain;
  const detailView = detailSource.filter(
    (d) => d.date >= domainStart && d.date <= domainEnd,
  );
  const detailPoints = detailView
    .filter(
      (d) =>
        Number.isFinite(d.mark_price_close) && Number.isFinite(d.basis_pct),
    )
    .sort((a, b) => a.mark_price_close - b.mark_price_close);

  if (!detailPoints.length) {
    detailMessageText
      .attr("x", scatterInnerWidth / 2)
      .attr("y", innerHeight / 2)
      .text("No basis data available.")
      .attr("display", null);
    clearScatterCanvas();
    return;
  }

  detailMessageText.attr("display", "none");

  const detailXDomain = d3.extent(detailPoints, (d) => d.mark_price_close);
  const detailYDomain = d3.extent(detailPoints, (d) => d.basis_pct);

  const detailX = d3
    .scaleLinear()
    .domain(detailXDomain)
    .nice()
    .range([0, scatterInnerWidth]);
  const detailY = d3
    .scaleLinear()
    .domain(detailYDomain)
    .nice()
    .range([innerHeight, 0]);

  const detailXAxis = d3
    .axisBottom(detailX)
    .ticks(5)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(d3.format(","));
  const detailYAxis = d3
    .axisLeft(detailY)
    .ticks(6)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(d3.format(".2%"));

  detailXAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(detailXAxis)
    .call(axisStyle);
  detailYAxisGroup.call(detailYAxis).call(axisStyle);

  detailXAxisLabel
    .attr("x", scatterInnerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding)
    .attr("display", null);
  detailYAxisLabel
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding)
    .attr("display", null);

  syncScatterCanvas(viewWidth, viewHeight);
  const canvas = scatterCanvasRef.value;
  const canvasCtx = canvas ? canvas.getContext("2d") : null;
  if (!canvasCtx || !canvas) return;
  canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
  canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  canvasCtx.setTransform(scatterCanvasScaleX, 0, 0, scatterCanvasScaleY, 0, 0);
  canvasCtx.globalAlpha = 0.5;
  canvasCtx.lineWidth = 0;
  for (const point of detailPoints) {
    const x = scatterOffsetX + margin.left + detailX(point.mark_price_close);
    const y = margin.top + detailY(point.basis_pct);
    canvasCtx.beginPath();
    canvasCtx.arc(x, y, 3.6, 0, Math.PI * 2);
    canvasCtx.fillStyle = colorForBasis(point.basis_pct);
    canvasCtx.fill();
  }
}

let brushPendingDomain = null;
let brushRafId = null;

const scheduleBrushUpdate = (domain) => {
  brushPendingDomain = domain;
  if (brushRafId != null) return;
  brushRafId = requestAnimationFrame(() => {
    brushRafId = null;
    const pending = brushPendingDomain;
    brushPendingDomain = null;
    renderDetail(pending);
  });
};

const flushBrushUpdate = () => {
  if (brushRafId != null) {
    cancelAnimationFrame(brushRafId);
    brushRafId = null;
  }
  if (brushPendingDomain !== null) {
    const pending = brushPendingDomain;
    brushPendingDomain = null;
    renderDetail(pending);
  }
};

onBeforeUnmount(() => {
  if (brushRafId != null) {
    cancelAnimationFrame(brushRafId);
    brushRafId = null;
  }
  brushPendingDomain = null;
});

const handleBrush = (event) => {
  const xScale = chartState.currentXScale;
  if (!xScale) return;
  const selection = event.selection;
  const domain = selection ? selection.map(xScale.invert) : null;
  scheduleBrushUpdate(domain);
};

const handleBrushEnd = (event) => {
  handleBrush(event);
  flushBrushUpdate();
  if (!event.sourceEvent) return;
  const selection = event.selection;
  if (!selection) {
    internalDetailRange.value = null;
    return;
  }
  const xScale = chartState.currentXScale;
  if (!xScale) {
    internalDetailRange.value = null;
    return;
  }
  const [from, to] = selection.map(xScale.invert);
  const range = {
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
  };
  internalDetailRange.value = range;
};

const brush = d3
  .brushX()
  .extent([
    [0, 0],
    [0, 0],
  ])
  .filter((event) => !event.ctrlKey && !event.button && event.detail < 2)
  .on("brush", handleBrush)
  .on("end", handleBrushEnd);

const clearBrush = (event) => {
  event?.preventDefault?.();
  const brushNode = chartState.brushGroup?.node?.();
  if (brushNode?.__brush) {
    chartState.brushGroup.call(brush.move, null);
  }
  internalDetailRange.value = null;
};

const bindBrushHandlers = () => {
  if (!chartState.brushGroup) return;
  chartState.brushGroup
    .selectAll(".selection,.handle")
    .on("dblclick", clearBrush);
  const overlay = chartState.brushGroup.selectAll(".overlay");
  overlay.on("dblclick", clearBrush);
  overlay.on("click", (event) => {
    if (!event?.defaultPrevented) {
      clearBrush(event);
    }
  });
};

function exportPng({
  filename = "basis-chart.png",
  scale = 4,
  padding = 24,
} = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
    drawBefore: ({ ctx, width, height, padding }) => {
      const scatterCanvas = scatterCanvasRef.value;
      if (scatterCanvas && scatterCanvas.width && scatterCanvas.height) {
        ctx.drawImage(scatterCanvas, padding, padding, width, height);
      }
    },
  });
}

defineExpose({ exportPng });

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const data = props.data;
  const detailData = props.detailData;

  const svg = ensureChartElements();
  if (!svg) return;

  const panelHeight = layout.panelHeight;
  const margin = layout.margin;
  const detailActive =
    typeof internalDetailRange.value?.from === "number" &&
    typeof internalDetailRange.value?.to === "number";
  const mainWidth = layout.mainWidth;
  const innerWidth = mainWidth - margin.left - margin.right;
  const innerHeight = panelHeight - margin.top - margin.bottom;
  const scatterInnerWidth = innerHeight;
  const panelGap = detailActive ? layout.panelGap : 0;
  const scatterWidth = detailActive
    ? scatterInnerWidth + margin.left + margin.right
    : 0;
  const width = mainWidth + panelGap + scatterWidth;
  const height = panelHeight;
  const scatterOffsetX = mainWidth + panelGap;

  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
  syncScatterCanvas(width, height);
  if (!detailActive) {
    clearScatterCanvas();
  }
  chartState.background
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height);

  chartState.mainTitleText
    .attr("x", mainWidth / 2)
    .attr("y", 30)
    .text(mainTitle.value);
  chartState.mainSubtitleText
    .attr("x", mainWidth / 2)
    .attr("y", 54)
    .text(subtitle.value);

  const detailTitle = "Basis vs Price";
  const detailSubtitle = props.detailResolution
    ? `${props.detailResolution} resolution`
    : "";
  chartState.detailTitleText
    .attr("x", scatterOffsetX + scatterWidth / 2)
    .attr("y", 30)
    .text(detailTitle)
    .attr("display", detailActive ? null : "none");
  chartState.detailSubtitleText
    .attr("x", scatterOffsetX + scatterWidth / 2)
    .attr("y", 54)
    .text(detailSubtitle)
    .attr("display", detailActive ? null : "none");

  if (!data.length) {
    chartState.noDataText
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("visibility", props.loading ? "hidden" : "visible")
      .text("No data for this range.");
    chartState.pointsGroup
      .selectAll("circle.main-point")
      .data([])
      .join("circle");
    chartState.legendGroup.attr("display", "none");
    chartState.detailContainer.attr("display", "none");
    clearScatterCanvas();
    detailRenderContext = null;
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.legendGroup.attr("display", null);

  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const validDates = data.map((d) => d.date).filter((d) => d instanceof Date);
  const validMarks = data
    .map((d) => d.mark_price_close)
    .filter((v) => Number.isFinite(v));
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validMarks);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain(yDomain).nice().range([innerHeight, 0]);

  chartState.currentXScale = x;

  const basisValues = [...data, ...detailData]
    .map((d) => d?.basis_pct)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const [extentMin, extentMax] = d3.extent(basisValues);
  const hasValidExtent =
    Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent ? extentMin : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";
  const colorForBasis = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) {
      return fallbackColor;
    }
    if (!hasSpread) {
      return d3.interpolateRdBu(0.5);
    }
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    return d3.interpolateRdBu(1 - clamped);
  };
  const formatBasisPct = (value) =>
    Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";

  const axisTitlePadding = 10;

  const xAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(10);
  const yAxis = d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10);

  chartState.xAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis)
    .call(axisStyle);
  chartState.yAxisGroup.call(yAxis).call(axisStyle);
  chartState.mainXAxisLabel
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding);
  chartState.mainYAxisLabel
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding);

  const mainPoints = chartState.pointsGroup
    .selectAll("circle.main-point")
    .data(data, (d) => (d.date ? d.date.getTime() : d.mark_price_close));

  mainPoints
    .join((enter) => {
      const circles = enter
        .append("circle")
        .attr("class", "main-point")
        .attr("r", 0)
        .attr("stroke", "whitesmoke")
        .attr("stroke-width", 0.2)
        .attr("opacity", 0.9);
      circles.transition().duration(300).attr("r", 4.4);
      return circles;
    })
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.mark_price_close))
    .attr("fill", (d) => colorForBasis(d.basis_pct));

  const gradientStops = hasValidExtent
    ? [
        { offset: "0%", value: domainMin },
        { offset: "50%", value: domainMin + domainSpan / 2 },
        { offset: "100%", value: domainMax },
      ]
    : [
        { offset: "0%", value: 0 },
        { offset: "100%", value: 0 },
      ];

  chartState.gradient
    .selectAll("stop")
    .data(gradientStops)
    .join((enter) => enter.append("stop"))
    .attr("offset", (d) => d.offset)
    .attr("stop-color", (d) => colorForBasis(d.value));

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
  const legendY = margin.top - 52;
  chartState.legendGroup.attr("transform", `translate(${legendX},${legendY})`);
  const legendPaddingY = 8;
  const legendTitleY = legendPaddingY;
  const legendBarTop = legendTitleY + 14;
  const legendLabelY = legendBarTop + legendHeight + 16;

  chartState.legendTitle?.attr("x", 0).attr("y", legendTitleY);
  chartState.legendRect
    .attr("x", 0)
    .attr("y", legendBarTop)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`);
  chartState.legendMinText
    .attr("x", 0)
    .attr("y", legendLabelY)
    .text(formatBasisPct(extentMin));
  chartState.legendMaxText
    .attr("x", legendWidth)
    .attr("y", legendLabelY)
    .text(formatBasisPct(extentMax));

  chartState.detailContainer
    .attr("transform", `translate(${scatterOffsetX},0)`)
    .attr("display", detailActive ? null : "none");
  chartState.detailLayer.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const detailSource = detailData.length ? detailData : data;
  const detailDomainFull = d3.extent(detailSource, (d) => d.date);
  detailRenderContext = {
    detailActive,
    detailLayer: chartState.detailLayer,
    detailXAxisGroup: chartState.detailXAxisGroup,
    detailYAxisGroup: chartState.detailYAxisGroup,
    detailMessageText: chartState.detailMessageText,
    detailXAxisLabel: chartState.detailXAxisLabel,
    detailYAxisLabel: chartState.detailYAxisLabel,
    scatterInnerWidth,
    innerHeight,
    axisTitlePadding,
    margin,
    scatterOffsetX,
    colorForBasis,
    detailSource,
    detailDomainFull,
    viewWidth: width,
    viewHeight: height,
  };

  brush.extent([
    [0, 0],
    [innerWidth, innerHeight],
  ]);
  chartState.brushGroup.call(brush);
  bindBrushHandlers();

  if (
    internalDetailRange.value?.from != null &&
    internalDetailRange.value?.to != null
  ) {
    chartState.brushGroup.call(brush.move, [
      x(new Date(internalDetailRange.value.from * 1000)),
      x(new Date(internalDetailRange.value.to * 1000)),
    ]);
  } else {
    chartState.brushGroup.call(brush.move, null);
  }

  const initialDomain = internalDetailRange.value?.from
    ? [
        new Date(internalDetailRange.value.from * 1000),
        new Date(internalDetailRange.value.to * 1000),
      ]
    : null;
  renderDetail(initialDomain);
}

watch(
  () => [
    props.data,
    props.detailData,
    props.instrumentName,
    props.detailResolution,
    internalDetailRange.value,
  ],
  () => render(),
  { deep: false },
);

watch(
  () => [props.instrumentName, props.detailResolution],
  () => {
    clearBrush();
  },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <canvas ref="scatterCanvasRef" class="scatterCanvas" />
    <svg ref="svgRef" />
    <div v-if="loading" class="overlay">Loading…</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

svg {
  display: block;
  width: 100%;
  height: auto;
  position: relative;
  z-index: 1;
}

.scatterCanvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
  z-index: 2;
}
</style>
