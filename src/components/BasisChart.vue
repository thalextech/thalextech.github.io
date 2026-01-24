<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  detailData: { type: Array, default: () => [] },
  instrumentName: { type: String, default: "" },
  detailResolution: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
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
  detailPointsGroup: null,
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

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#d6d7de")
    .style("font-family", SVG_FONT_FAMILY);
};

const ensureChartElements = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return null;
  const svg = d3.select(svgEl);

  const appendText = (parent, { fill, size, weight, anchor, text }) => {
    const node = parent
      .append("text")
      .attr("fill", fill)
      .style("font-size", size)
      .style("font-family", SVG_FONT_FAMILY);
    if (anchor) node.attr("text-anchor", anchor);
    if (weight != null) node.style("font-weight", weight);
    if (text != null) node.text(text);
    return node;
  };

  const appendAxisLabel = (parent, text) =>
    appendText(parent, {
      fill: "#d6d7de",
      size: "12px",
      weight: 700,
      anchor: "middle",
      text,
    });

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
    chartState.background = svg.append("rect").attr("fill", "#000");
  }

  if (!chartState.mainTitleText) {
    chartState.mainTitleText = appendText(svg, {
      fill: "#fff",
      size: "18px",
      weight: 650,
      anchor: "middle",
    });
  }

  if (!chartState.mainSubtitleText) {
    chartState.mainSubtitleText = appendText(svg, {
      fill: "#c9c9cf",
      size: "13px",
      anchor: "middle",
    });
  }

  if (!chartState.detailTitleText) {
    chartState.detailTitleText = appendText(svg, {
      fill: "#fff",
      size: "16px",
      weight: 600,
      anchor: "middle",
    });
  }

  if (!chartState.detailSubtitleText) {
    chartState.detailSubtitleText = appendText(svg, {
      fill: "#c9c9cf",
      size: "12px",
      anchor: "middle",
    });
  }

  if (!chartState.legendGroup) {
    chartState.legendGroup = svg.append("g");
    chartState.legendTitle = appendText(chartState.legendGroup, {
      fill: "#d6d7de",
      size: "12px",
      text: "Annualized basis",
    });
    chartState.legendRect = chartState.legendGroup
      .append("rect")
      .attr("stroke", "#2e3040");
    chartState.legendMinText = appendText(chartState.legendGroup, {
      fill: "#a9abb6",
      size: "11px",
    });
    chartState.legendMaxText = appendText(chartState.legendGroup, {
      fill: "#a9abb6",
      size: "11px",
      anchor: "end",
    });
  }

  if (!chartState.noDataText) {
    chartState.noDataText = appendText(svg, {
      fill: "#c9c9cf",
      size: "14px",
      anchor: "middle",
    });
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
    chartState.detailPointsGroup = chartState.detailLayer.append("g");
    chartState.detailMessageText = appendText(chartState.detailLayer, {
      fill: "#c9c9cf",
      size: "13px",
      anchor: "middle",
    });
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
    detailPointsGroup,
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
  } = ctx;

  if (!detailSource.length || !detailDomainFull[0] || !detailDomainFull[1]) {
    detailMessageText
      .attr("x", scatterInnerWidth / 2)
      .attr("y", innerHeight / 2)
      .text("No detail data available.")
      .attr("display", null);
    detailPointsGroup.selectAll("circle.detail-point").data([]).join("circle");
    return;
  }

  if (!Array.isArray(domain)) {
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
    detailPointsGroup.selectAll("circle.detail-point").data([]).join("circle");
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

  const detailPointsSelection = detailPointsGroup
    .selectAll("circle.detail-point")
    .data(detailPoints, (d) =>
      d.date ? d.date.getTime() : d.mark_price_close,
    );

  detailPointsSelection
    .join((enter) =>
      enter
        .append("circle")
        .attr("class", "detail-point")
        .attr("r", 3.6)
        .attr("stroke", "black")
        .attr("stroke-width", 0.2)
        .attr("opacity", 0.7),
    )
    .attr("cx", (d) => detailX(d.mark_price_close))
    .attr("cy", (d) => detailY(d.basis_pct))
    .attr("fill", (d) => colorForBasis(d.basis_pct));
}

const BRUSH_THROTTLE_MS = 10;
let brushPendingDomain = null;
let brushTimer = null;
let lastBrushTime = 0;

const getNow = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const runBrushUpdate = () => {
  brushTimer = null;
  lastBrushTime = getNow();
  const domain = brushPendingDomain;
  brushPendingDomain = null;
  renderDetail(domain);
};

const scheduleBrushUpdate = (domain) => {
  brushPendingDomain = domain;
  const now = getNow();
  const elapsed = now - lastBrushTime;
  if (elapsed >= BRUSH_THROTTLE_MS && !brushTimer) {
    runBrushUpdate();
    return;
  }
  const delay = Math.max(0, BRUSH_THROTTLE_MS - elapsed);
  if (brushTimer) {
    clearTimeout(brushTimer);
  }
  brushTimer = setTimeout(runBrushUpdate, delay);
};

const flushBrushUpdate = () => {
  if (brushTimer) {
    clearTimeout(brushTimer);
    brushTimer = null;
  }
  if (brushPendingDomain !== null) {
    runBrushUpdate();
  }
};

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

  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .style("font-family", SVG_FONT_FAMILY);
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
    detailRenderContext = null;
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.legendGroup.attr("display", null);

  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const xDomain = d3.extent(data, (d) => d.date);
  const yDomain = d3.extent(data, (d) => d.mark_price_close);

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
    detailPointsGroup: chartState.detailPointsGroup,
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
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    "Apple Color Emoji",
    "Segoe UI Emoji";
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
