<script setup>
import * as d3 from "d3";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  detailData: { type: Array, default: () => [] },
  indexName: { type: String, default: "" },
  detailResolution: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  visualizationMode: { type: String, default: "heatmap" }, // "heatmap" or "line"
});

const svgRef = ref(null);
const scatterCanvasRef = ref(null);
const internalDetailRange = ref(null);
const gradientId = `volatility-gradient-${Math.random().toString(16).slice(2)}`;
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
  avgVolatilityText: null,
  detailTitleText: null,
  detailSubtitleText: null,
  mainGroup: null,
  xAxisGroup: null,
  yAxisGroup: null,
  yAxisGroupRight: null,
  pointsGroup: null,
  barsGroup: null,
  lineGroup: null,
  mainXAxisLabel: null,
  mainYAxisLabel: null,
  mainYAxisLabelRight: null,
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
  logoGroup: null,
};

let detailRenderContext = null;

const mainTitle = computed(() => {
  if (props.visualizationMode === "line") {
    return `${props.indexName || "Index"} Price & Realized Volatility`;
  }
  return `${props.indexName || "Index"} Realized Volatility (Heatmap)`;
});

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

  if (!chartState.avgVolatilityText) {
    chartState.avgVolatilityText = appendText(svg, "mainSubtitle", {
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
      text: "Realized Volatility",
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
    chartState.yAxisGroupRight = chartState.mainGroup.append("g");
    chartState.pointsGroup = chartState.mainGroup.append("g");
    chartState.barsGroup = chartState.mainGroup.append("g");
    chartState.lineGroup = chartState.mainGroup.append("g");
    chartState.mainXAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Date (UTC)",
    );
    chartState.mainYAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Index Price (Close)",
    );
    chartState.mainYAxisLabelRight = appendAxisLabel(
      chartState.mainGroup,
      "Realized Volatility (%)",
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
      "Index Price (Close)",
    );
    chartState.detailYAxisLabel = appendAxisLabel(
      chartState.detailLayer,
      "Realized Volatility",
    );
  }

  if (!chartState.logoGroup) {
    chartState.logoGroup = svg.append("g").attr("class", "logo-watermark");
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
    colorForVol,
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
        Number.isFinite(d.index_price_close) && Number.isFinite(d.realized_vol),
    )
    .sort((a, b) => a.index_price_close - b.index_price_close);

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

  const detailXDomain = d3.extent(detailPoints, (d) => d.index_price_close);
  const detailYDomain = d3.extent(detailPoints, (d) => d.realized_vol);

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
    .tickFormat((d) => `${d.toFixed(2)}%`);

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
    const x = scatterOffsetX + margin.left + detailX(point.index_price_close);
    const y = margin.top + detailY(point.realized_vol);
    canvasCtx.beginPath();
    canvasCtx.arc(x, y, 3.6, 0, Math.PI * 2);
    canvasCtx.fillStyle = colorForVol(point.realized_vol);
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
  filename = "volatility-chart.png",
  scale = 2,
  padding = 16,
} = {}) {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const viewBox = svgEl.getAttribute("viewBox");
  let width = 1200;
  let height = 650;
  if (viewBox) {
    const [, , vbWidth, vbHeight] = viewBox.split(" ").map(Number);
    if (Number.isFinite(vbWidth) && Number.isFinite(vbHeight)) {
      width = vbWidth;
      height = vbHeight;
    }
  }

  const svgClone = svgEl.cloneNode(true);
  if (!svgClone.getAttribute("xmlns")) {
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  svgClone.setAttribute("width", String(width));
  svgClone.setAttribute("height", String(height));

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgClone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const image = new Image();
  image.onload = () => {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((width + safePadding * 2) * safeScale);
    canvas.height = Math.round((height + safePadding * 2) * safeScale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.scale(safeScale, safeScale);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
    const scatterCanvas = scatterCanvasRef.value;
    if (scatterCanvas && scatterCanvas.width && scatterCanvas.height) {
      ctx.drawImage(scatterCanvas, safePadding, safePadding, width, height);
    }
    ctx.drawImage(image, safePadding, safePadding, width, height);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        URL.revokeObjectURL(url);
        return;
      }
      const downloadUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.src = url;
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

  // Calculate and display average volatility for line mode
  if (props.visualizationMode === "line") {
    const volValues = data
      .map((d) => d?.realized_vol)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    
    if (volValues.length > 0) {
      const avgVol = volValues.reduce((sum, val) => sum + val, 0) / volValues.length;
      chartState.avgVolatilityText
        .attr("x", mainWidth / 2)
        .attr("y", 78)
        .attr("display", null)
        .text(`Average realized volatility: ${avgVol.toFixed(2)}%`);
    } else {
      chartState.avgVolatilityText.attr("display", "none");
    }
  } else {
    chartState.avgVolatilityText.attr("display", "none");
  }

  const detailTitle = "Realized Volatility vs Price";
  const detailSubtitle = props.detailResolution
    ? `${props.detailResolution} resolution`
    : "";
  chartState.detailTitleText
    .attr("x", scatterOffsetX + scatterWidth / 2)
    .attr("y", 30)
    .text(detailTitle)
    .attr("display", detailActive && props.visualizationMode === "heatmap" ? null : "none");
  chartState.detailSubtitleText
    .attr("x", scatterOffsetX + scatterWidth / 2)
    .attr("y", 54)
    .text(detailSubtitle)
    .attr("display", detailActive && props.visualizationMode === "heatmap" ? null : "none");

  if (!data.length) {
    chartState.noDataText
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("visibility", props.loading ? "hidden" : "visible")
      .text("No data for this range.");
    chartState.pointsGroup.selectAll("circle.main-point").remove();
    chartState.lineGroup.selectAll("path").remove();
    chartState.barsGroup.selectAll("rect").remove();
    chartState.yAxisGroupRight.selectAll("*").remove();
    chartState.legendGroup.attr("display", "none");
    chartState.detailContainer.attr("display", "none");
    clearScatterCanvas();
    detailRenderContext = null;
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  
  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const validDates = data.map((d) => d.date).filter((d) => d instanceof Date);
  const validPrices = data
    .map((d) => d.index_price_close)
    .filter((v) => Number.isFinite(v));
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validPrices);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain(yDomain).nice().range([innerHeight, 0]);

  chartState.currentXScale = x;

  const axisTitlePadding = 10;
  const xAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(10);

  chartState.xAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis)
    .call(axisStyle);
  chartState.mainXAxisLabel
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding);

  if (props.visualizationMode === "line") {
    // Line visualization mode - index price + volatility lines
    chartState.legendGroup.attr("display", "none");
    chartState.detailContainer.attr("display", "none");
    clearScatterCanvas();
    // Clear heatmap elements
    chartState.pointsGroup.selectAll("circle.main-point").remove();
    chartState.barsGroup.selectAll("rect.volatility-bar").remove();

    // Left Y-axis for index price
    const yAxis = d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10);
    chartState.yAxisGroup.call(yAxis).call(axisStyle);
    chartState.mainYAxisLabel
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -52 - axisTitlePadding)
      .attr("display", null);

    // Right Y-axis for volatility
    const volValues = data
      .map((d) => d?.realized_vol)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    const hasVolData = volValues.length > 0;
    const [volMin, volMax] = d3.extent(volValues);
    const volDomain = hasVolData && Number.isFinite(volMax)
      ? [Math.max(0, volMin - 5), volMax + 5]
      : [0, 100];
    const yRight = d3
      .scaleLinear()
      .domain(volDomain)
      .nice()
      .range([innerHeight, 0]);
    const yAxisRight = d3
      .axisRight(yRight)
      .ticks(6)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat((d) => `${d.toFixed(0)}%`);

    chartState.yAxisGroupRight
      .attr("transform", `translate(${innerWidth},0)`)
      .call(yAxisRight)
      .call(axisStyle);
    chartState.mainYAxisLabelRight
      .attr("transform", "rotate(90)")
      .attr("x", innerHeight / 2)
      .attr("y", innerWidth + 52 + axisTitlePadding)
      .attr("display", null);

    // Index price line
    const priceLine = d3
      .line()
      .x((d) => x(d.date))
      .y((d) => y(d.index_price_close))
      .defined((d) => Number.isFinite(d.index_price_close));

    chartState.lineGroup
      .selectAll("path.price-line")
      .data([data])
      .join("path")
      .attr("class", "price-line")
      .attr("fill", "none")
      .attr("stroke", "#00d4aa")
      .attr("stroke-width", 2)
      .attr("opacity", 0.9)
      .attr("d", priceLine);

    // Realized volatility line
    if (hasVolData) {
      chartState.noDataText.attr("visibility", "hidden");

      const volLine = d3
        .line()
        .x((d) => x(d.date))
        .y((d) => yRight(d.realized_vol))
        .defined((d) => Number.isFinite(d.realized_vol));

      chartState.lineGroup
        .selectAll("path.volatility-line")
        .data([data])
        .join("path")
        .attr("class", "volatility-line")
        .attr("fill", "none")
        .attr("stroke", "#f9b113")
        .attr("stroke-width", 2)
        .attr("opacity", 0.9)
        .attr("d", volLine);
    } else {
      chartState.noDataText
        .attr("x", width / 2)
        .attr("y", height / 2 + 20)
        .attr("visibility", "visible")
        .text("No volatility data available.");
      chartState.lineGroup.selectAll("path.volatility-line").remove();
    }

    // Disable brush for line mode
    chartState.brushGroup.call(brush.move, null);
  } else {
    // Heatmap visualization mode
    chartState.legendGroup.attr("display", null);

    const yAxis = d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10);
    chartState.yAxisGroup.call(yAxis).call(axisStyle);
    chartState.mainYAxisLabel
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -52 - axisTitlePadding)
      .attr("display", null);
    chartState.mainYAxisLabelRight.attr("display", "none");
    // Clear right axis completely
    chartState.yAxisGroupRight.selectAll("*").remove();

    const volValues = [...data, ...detailData]
      .map((d) => d?.realized_vol)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    const [extentMin, extentMax] = d3.extent(volValues);
    const hasValidExtent =
      Number.isFinite(extentMin) && Number.isFinite(extentMax);
    const domainMin = hasValidExtent ? extentMin : 0;
    const domainMax = hasValidExtent ? extentMax : 100;
    const domainSpan = domainMax - domainMin;
    const hasSpread = hasValidExtent && domainSpan !== 0;
    const fallbackColor = "#7c7f8f";
    const colorForVol = (value) => {
      if (!Number.isFinite(value) || !hasValidExtent) {
        return fallbackColor;
      }
      if (!hasSpread) {
        return d3.interpolateRdBu(0.5);
      }
      const normalized = (value - domainMin) / domainSpan;
      const clamped = Math.max(0, Math.min(1, normalized));
      // RdBu goes red->blue, reverse so low vol = blue, high vol = red
      return d3.interpolateRdBu(1 - clamped);
    };
    const formatVolPct = (value) =>
      Number.isFinite(value) ? `${value.toFixed(2)}%` : "n/a";

    const mainPoints = chartState.pointsGroup
      .selectAll("circle.main-point")
      .data(data, (d) => (d.date ? d.date.getTime() : d.index_price_close));

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
      .attr("cy", (d) => y(d.index_price_close))
      .attr("fill", (d) => colorForVol(d.realized_vol));

    // Clear bars and lines for heatmap mode
    chartState.barsGroup.selectAll("rect.volatility-bar").remove();
    chartState.lineGroup.selectAll("path.price-line").remove();
    chartState.lineGroup.selectAll("path.volatility-line").remove();

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
      .attr("stop-color", (d) => colorForVol(d.value));

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
      .text(formatVolPct(extentMin));
    chartState.legendMaxText
      .attr("x", legendWidth)
      .attr("y", legendLabelY)
      .text(formatVolPct(extentMax));

    // Detail view for basis mode
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
      colorForVol,
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

  // Add logo watermark in bottom left corner, inside the axes
  const logoScale = 2.0; // 4x bigger than before (was 0.5)
  const logoPadding = 12;
  const logoX = margin.left + logoPadding; // Inside left margin
  const logoY = height - margin.bottom - 23 * logoScale - logoPadding; // Inside bottom margin
  const logoId = `logo-${Math.random().toString(16).slice(2)}`;

  chartState.logoGroup
    .attr("transform", `translate(${logoX},${logoY}) scale(${logoScale})`)
    .attr("opacity", 0.3); // Make it less bright

  // Clear and add logo SVG content
  chartState.logoGroup.selectAll("*").remove();
  
  const logoDefs = chartState.logoGroup.append("defs");
  logoDefs.append("clipPath").attr("id", `${logoId}-clip`).append("rect").attr("width", 91).attr("height", 23);
  
  const logoG = chartState.logoGroup.append("g").attr("clip-path", `url(#${logoId}-clip)`);
  
  // Add logo paths
  logoG.append("path").attr("d", "M8.13956 0.429949V4.51406H10.7794C10.9994 4.51406 11.2193 4.72901 11.2193 4.94397V8.09662C11.2193 8.31157 10.9994 8.52652 10.7794 8.52652H8.13956V16.838C8.13956 17.5546 8.28622 17.9845 8.5062 18.2711C8.72619 18.5577 9.23948 18.701 9.97276 18.701C10.3394 18.701 10.706 18.701 10.9994 18.6293C11.2193 18.6293 11.4393 18.7726 11.4393 19.0592V22.2119C11.4393 22.4268 11.2927 22.5701 11.146 22.6418C10.1927 22.9284 9.23948 23.0717 8.21289 23.0717C6.23304 23.0717 4.76648 22.6418 3.81321 21.7103C2.85995 20.7789 2.34665 19.3458 2.34665 17.4829V8.45487H0.440128C0.220144 8.45487 0.000160217 8.23992 0.000160217 8.02496V4.94397C0.000160217 4.72901 0.220144 4.51406 0.440128 4.51406H2.41998V0.429949C2.34665 0.214995 2.56664 4.19617e-05 2.78662 4.19617e-05H7.77292C7.99291 4.19617e-05 8.13956 0.214995 8.13956 0.429949Z").attr("fill", "white");
  logoG.append("path").attr("d", "M19.214 6.44864C20.4606 4.94397 22.0005 4.15581 23.9804 4.15581C26.0335 4.15581 27.5734 4.72901 28.6 5.94708C29.6266 7.16515 30.1399 8.88478 30.2132 11.1776V22.2119C30.2132 22.4268 29.9933 22.6418 29.7733 22.6418H24.787C24.567 22.6418 24.347 22.4268 24.347 22.2119V11.3209C24.347 10.3895 24.127 9.67294 23.7604 9.17138C23.3937 8.74148 22.6605 8.52652 21.7072 8.52652C20.5339 8.52652 19.654 8.88478 19.214 9.60129V22.2119C19.214 22.4268 18.9941 22.6418 18.7741 22.6418H13.7878C13.5678 22.6418 13.3478 22.4268 13.3478 22.2119V0.429949C13.3478 0.214995 13.5678 4.19617e-05 13.7878 4.19617e-05H18.7741C18.9941 4.19617e-05 19.214 0.214995 19.214 0.429949V6.44864Z").attr("fill", "white");
  logoG.append("path").attr("d", "M48.2497 18.5582V10.5332C48.2497 8.59866 47.5164 7.02234 46.1232 5.87592C44.7299 4.7295 42.8967 4.15629 40.4769 4.15629C38.0571 4.15629 36.1506 4.7295 34.6107 5.80427C33.2174 6.80738 32.4108 8.0971 32.3375 9.67343C32.3375 9.88838 32.4842 10.1033 32.7775 10.1033H37.7638C37.9838 10.1033 38.1304 9.96003 38.2037 9.74508C38.3504 8.67031 39.0103 8.0971 40.2569 8.0971C41.7235 8.0971 42.4568 8.95692 42.4568 10.6049V11.5364H40.6969C37.8371 11.5364 35.7106 12.0379 34.1707 13.041C32.7041 14.0441 31.9709 15.5488 31.9709 17.4834C31.9709 19.0597 32.5575 20.3494 33.8041 21.3526C35.0506 22.3557 36.5172 22.9289 38.2771 22.9289C40.1836 22.9289 41.6501 22.284 42.7501 20.9943C42.8967 21.5675 43.0434 22.0691 43.19 22.4273C43.2634 22.5706 43.41 22.6423 43.5567 22.6423H48.4696C48.763 22.6423 48.9829 22.3557 48.8363 22.0691C48.4696 21.2093 48.323 19.9195 48.2497 18.5582ZM42.4568 17.4834C42.2368 17.8417 41.9435 18.1999 41.4302 18.4865C40.9902 18.7731 40.3302 18.9164 39.6703 18.9164C39.157 18.9164 38.6437 18.7731 38.2771 18.4149C37.9104 18.0566 37.7638 17.6983 37.7638 17.1968C37.7638 15.4055 38.7904 14.5457 40.7702 14.5457H42.4568V17.4834Z").attr("fill", "white");
  logoG.append("path").attr("d", "M55.8756 22.7134H50.8893C50.6694 22.7134 50.4494 22.4985 50.4494 22.2835V0.429949C50.4494 0.214995 50.6694 4.19617e-05 50.8893 4.19617e-05H55.8756C56.0956 4.19617e-05 56.3156 0.214995 56.3156 0.429949V22.2835C56.3156 22.4985 56.0956 22.7134 55.8756 22.7134Z").attr("fill", "white");
  logoG.append("path").attr("d", "M67.607 22.9999C64.7472 22.9999 62.4741 22.1401 60.7142 20.4921C58.9543 18.8442 58.0744 16.6946 58.0744 13.9719V13.4703C58.0744 11.6074 58.441 9.95942 59.101 8.52639C59.7609 7.09337 60.8608 6.01861 62.1807 5.23044C63.5006 4.44228 65.1139 4.08403 67.0204 4.08403C69.6602 4.08403 71.7134 4.87219 73.1799 6.44851C74.6465 8.02484 75.4531 10.246 75.4531 13.0404V14.8317C75.4531 15.0466 75.2331 15.2616 75.0131 15.2616H63.9406C64.1606 16.2647 64.6006 17.0529 65.3338 17.6977C66.0671 18.2709 66.9471 18.5575 68.047 18.5575C69.7335 18.5575 71.0534 18.056 72.0067 17.0529C72.1533 16.9096 72.4467 16.8379 72.6666 17.0529L74.7931 19.489C74.9398 19.6323 74.9398 19.8473 74.7931 19.9906C74.0599 20.8504 73.1066 21.4952 71.9334 22.0684C70.6135 22.7133 69.1469 22.9999 67.607 22.9999ZM67.0204 8.52639C65.3338 8.52639 64.3073 9.60116 64.0139 11.8223H69.8802V11.3924C69.8802 10.461 69.6602 9.81611 69.1469 9.31456C68.6336 8.813 67.9003 8.52639 67.0204 8.52639Z").attr("fill", "white");
  
  // Add gradient paths for the "X" part
  const logoGrad0 = logoDefs.append("linearGradient").attr("id", `${logoId}-grad0`).attr("x1", "83.8953").attr("y1", "4").attr("x2", "83.8953").attr("y2", "22.9993").attr("gradientUnits", "userSpaceOnUse");
  logoGrad0.append("stop").attr("stop-color", "white");
  logoGrad0.append("stop").attr("offset", "1").attr("stop-color", "white");
  
  const logoGrad1 = logoDefs.append("linearGradient").attr("id", `${logoId}-grad1`).attr("x1", "87.8043").attr("y1", "4").attr("x2", "87.8043").attr("y2", "11.6598").attr("gradientUnits", "userSpaceOnUse");
  logoGrad1.append("stop").attr("stop-color", "white");
  logoGrad1.append("stop").attr("offset", "1").attr("stop-color", "white");
  
  const logoGrad2 = logoDefs.append("linearGradient").attr("id", `${logoId}-grad2`).attr("x1", "79.9664").attr("y1", "15.34").attr("x2", "79.9664").attr("y2", "22.9998").attr("gradientUnits", "userSpaceOnUse");
  logoGrad2.append("stop").attr("stop-color", "white");
  logoGrad2.append("stop").attr("offset", "1").attr("stop-color", "white");
  
  logoG.append("path").attr("d", "M81.9053 4L91.7429 22.3985C91.8931 22.6989 91.6678 22.9993 91.3674 22.9993H85.8854L76.0478 4.60077C75.8976 4.30038 76.1229 4 76.4233 4H81.9053Z").attr("fill", `url(#${logoId}-grad0)`);
  logoG.append("path").attr("d", "M91.3631 4H83.8535L87.9087 11.6598L91.6635 4.67586C91.8888 4.37548 91.6635 4 91.3631 4Z").attr("fill", `url(#${logoId}-grad1)`);
  logoG.append("path").attr("d", "M79.8026 15.34L76.0478 22.399C75.8976 22.6994 76.1229 22.9998 76.4233 22.9998H83.9329L79.8026 15.34Z").attr("fill", `url(#${logoId}-grad2)`);
}

watch(
  () => [
    props.data,
    props.detailData,
    props.indexName,
    props.detailResolution,
    props.visualizationMode,
    internalDetailRange.value,
  ],
  () => render(),
  { deep: false },
);

watch(
  () => [props.indexName, props.detailResolution],
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
