<script setup>
import * as d3 from "d3";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { SECONDS_PER_YEAR } from "../../../../lib/thalex.js";
import {
  getDatumTs,
  syncSelectionWithData as syncSelectionWithDataUtil,
  updateSelectedRange as computeSelectedRange,
} from "../../../../lib/chartUtils.js";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  basisData: { type: Array, default: () => [] },
  futureBasisData: { type: Array, default: () => [] },
  instrumentName: { type: String, default: "" },
  futureInstrumentName: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  showRollPnl: { type: Boolean, default: false },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `funding-gradient-${Math.random().toString(16).slice(2)}`;
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const layout = {
  mainWidth: 860,
  detailWidth: 420,
  panelGap: 36,
  height: 560,
  margin: { top: 74, right: 38, bottom: 54, left: 74 },
};

const TEXT_STYLES = {
  axisText: { fill: "#d6d7de" },
  axisLabel: { fill: "#d6d7de", size: "12px", weight: 700 },
  mainTitle: { fill: "#fff", size: "18px", weight: 650 },
  mainSubtitle: { fill: "#c9c9cf", size: "13px" },
  detailTitle: { fill: "#fff", size: "14px", weight: 600 },
  detailSubtitle: { fill: "#a9abb6", size: "12px" },
  detailMetric: { fill: "#a9abb6", size: "12px", weight: 400 },
  detailLegend: { fill: "#a9abb6", size: "11px", weight: 500 },
  legendTitle: { fill: "#d6d7de", size: "12px" },
  legendLabel: { fill: "#a9abb6", size: "11px" },
  noData: { fill: "#c9c9cf", size: "14px" },
  detailMessage: { fill: "#c9c9cf", size: "12px" },
};

const chartState = {
  gradient: null,
  background: null,
  mainTitleText: null,
  mainSubtitleText: null,
  mainGroup: null,
  xAxisGroup: null,
  yAxisGroup: null,
  pointsGroup: null,
  selectionLine: null,
  selectionLabel: null,
  mainXAxisLabel: null,
  mainYAxisLabel: null,
  legendGroup: null,
  legendTitle: null,
  legendRect: null,
  legendMinText: null,
  legendMaxText: null,
  detailGroup: null,
  detailLayer: null,
  detailXAxisGroup: null,
  detailYAxisGroup: null,
  detailXAxisLabel: null,
  detailYAxisLabel: null,
  detailTitleText: null,
  detailSubtitleText: null,
  detailMetricText: null,
  detailMessageText: null,
  detailLegendGroup: null,
  detailLegendFundingLine: null,
  detailLegendFundingText: null,
  detailLegendBasisLine: null,
  detailLegendBasisText: null,
  detailLinePath: null,
  detailBasisLinePath: null,
  currentXScale: null,
  currentYScale: null,
  noDataText: null,
};

const POINT_RADIUS = 4;
const POINT_RADIUS_DIMMED = 2.8;
const POINT_RADIUS_HOVER = 10;
const HOVER_RELEASE_HITBOX_PX = 14;
const TAP_SELECT_HITBOX_PX = 22;
const TOOLTIP_HITBOX_PX = 18;
const TOOLTIP_FADE_DELAY_MS = 1000;
const LAYOUT_TRANSITION_MS = 160;
const DETAIL_COLORS = {
  carry: { funding: "#c9c9cf", secondary: "#7aa2ff" },
  roll: { funding: "#f0c58a", secondary: "#ffffff" },
};
let hoveredDatum = null;
let selectedDatums = [];
let selectedRange = null;
let detailActive = false;
let lineRevealTimer = null;
let lineRevealPending = false;
const legendMetricMode = ref("funding");
let suppressClearClick = false;
let tooltipDatum = null;
let lastPointerInMain = null;
let tooltipFadeTimer = null;

const clearTooltipFadeTimer = () => {
  if (tooltipFadeTimer) {
    clearTimeout(tooltipFadeTimer);
    tooltipFadeTimer = null;
  }
};

const isCursorInTooltipDatumHitbox = (datum) => {
  const x = chartState.currentXScale;
  const y = chartState.currentYScale;
  if (!datum || !x || !y || !lastPointerInMain) return false;
  if (!(datum.date instanceof Date)) return false;
  if (!Number.isFinite(datum.index_price_close)) return false;
  const px = x(datum.date);
  const py = y(datum.index_price_close);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  return (
    Math.abs(lastPointerInMain.x - px) <= TOOLTIP_HITBOX_PX &&
    Math.abs(lastPointerInMain.y - py) <= TOOLTIP_HITBOX_PX
  );
};

const scheduleTooltipAutoFade = () => {
  clearTooltipFadeTimer();
  tooltipFadeTimer = setTimeout(() => {
    tooltipFadeTimer = null;
    if (!tooltipDatum) return;
    if (isCursorInTooltipDatumHitbox(tooltipDatum)) {
      scheduleTooltipAutoFade();
      return;
    }
    hideTooltip();
  }, TOOLTIP_FADE_DELAY_MS);
};

const updateSelectedRange = () => {
  selectedRange = computeSelectedRange(selectedDatums);
};

const syncSelectionWithData = (data) => {
  const synced = syncSelectionWithDataUtil({
    data,
    selectedDatums,
    selectedRange,
    getTs: getDatumTs,
  });
  selectedDatums = synced.selectedDatums;
  selectedRange = synced.selectedRange;
};

const handleChartClick = (event) => {
  if (suppressClearClick) {
    suppressClearClick = false;
    return;
  }
  const target = event?.target;
  const isPoint = target?.closest?.("circle.main-point");
  if (isPoint) return;
  if (selectedDatums.length) {
    selectedDatums = [];
    selectedRange = null;
    render();
    resetHoverStyles();
    hideTooltip();
  }
};

const mainTitle = computed(
  () => `${props.instrumentName.slice(0, 3)} Index Price`,
);

const subtitle = computed(() => {
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const data = props.data;
  if (!data.length) return "";
  const start = data[0].date;
  const end = data[data.length - 1].date;
  return `${fmt(start)} - ${fmt(end)}`;
});

const detailTitle = computed(() => {
  const base = props.futureInstrumentName
    ? `${props.futureInstrumentName}-PERPETUAL`
    : props.instrumentName || "Perpetual";
  return props.showRollPnl
    ? `Roll price ${base}`
    : `Relative carry ${base}`;
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

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  applyTextStyle(axisG.selectAll("text"), "axisText");
};

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatIndex = d3.format(",");
const formatFunding = d3.format("+.2%");
const formatCurrency = d3.format("$,.2f");

const scheduleLineReveal = () => {
  lineRevealPending = true;
  if (lineRevealTimer) clearTimeout(lineRevealTimer);
  lineRevealTimer = setTimeout(() => {
    lineRevealPending = false;
    lineRevealTimer = null;
    updateSelectionLine();
  }, LAYOUT_TRANSITION_MS);
};

const applySelectionStyles = () => {
  if (!chartState.pointsGroup) return;
  const points = chartState.pointsGroup
    .selectAll("circle.main-point")
    .attr("stroke", (d) =>
      selectedDatums.includes(d) ? "#000" : "transparent",
    )
    .attr("stroke-width", (d) => (selectedDatums.includes(d) ? 2.6 : 0))
    .attr("r", (d) => {
      if (selectedDatums.includes(d)) return POINT_RADIUS_HOVER;
      if (selectedDatums.length === 2) return POINT_RADIUS_DIMMED;
      return POINT_RADIUS;
    })
    .attr("opacity", (d) =>
      selectedDatums.length > 0 && !selectedDatums.includes(d) ? 0.5 : 0.9,
    );
  points.filter((d) => selectedDatums.includes(d)).raise();
};

const updateSelectionLine = () => {
  const line = chartState.selectionLine;
  const x = chartState.currentXScale;
  const y = chartState.currentYScale;
  const label = chartState.selectionLabel;
  if (!line || !x || !y || !label) return;
  if (lineRevealPending) {
    line.attr("display", "none");
    label.attr("display", "none");
    return;
  }

  let lineStart = null;
  let lineEnd = null;
  if (selectedDatums.length === 2) {
    [lineStart, lineEnd] = selectedDatums;
  } else if (selectedDatums.length === 1 && hoveredDatum) {
    lineStart = selectedDatums[0];
    lineEnd = hoveredDatum;
  }

  if (
    lineStart?.date instanceof Date &&
    lineEnd?.date instanceof Date &&
    Number.isFinite(lineStart.index_price_close) &&
    Number.isFinite(lineEnd.index_price_close)
  ) {
    const x1 = x(lineStart.date);
    const y1 = y(lineStart.index_price_close);
    const x2 = x(lineEnd.date);
    const y2 = y(lineEnd.index_price_close);
    line
      .attr("display", null)
      .attr("x1", x1)
      .attr("y1", y1)
      .attr("x2", x2)
      .attr("y2", y2)
      .attr("opacity", 0.8);
    const days = Math.abs(lineEnd.date - lineStart.date) / MS_PER_DAY;
    label
      .attr("x", (x1 + x2) / 2)
      .attr("y", (y1 + y2) / 2 - 10)
      .text(`${days.toFixed(1)} days`)
      .attr("display", null);
  } else {
    line.attr("display", "none");
    label.attr("display", "none");
  }
};

const resetHoverStyles = () => {
  if (!chartState.pointsGroup) return;
  chartState.pointsGroup
    .selectAll("circle.main-point")
    .attr("opacity", 0.8)
    .attr("r", POINT_RADIUS);
  applySelectionStyles();
};

const showTooltip = (event, datum, metricLabel, metricValue) => {
  const tooltip = tooltipRef.value;
  const svgEl = svgRef.value;
  const wrapper = svgEl?.closest(".chartWrap");
  if (!tooltip || !wrapper || !svgEl) return;
  const mainNode = chartState.mainGroup?.node();
  if (mainNode) {
    const [px, py] = d3.pointer(event, mainNode);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      lastPointerInMain = { x: px, y: py };
    }
  }
  tooltipDatum = datum;
  clearTooltipFadeTimer();
  const wrapperRect = wrapper.getBoundingClientRect();
  const x = event.clientX - wrapperRect.left;
  const y = event.clientY - wrapperRect.top;
  const indexValue = Number.isFinite(datum.index_price_close)
    ? formatIndex(datum.index_price_close)
    : "n/a";
  const legendMetricValue = Number.isFinite(metricValue)
    ? formatFunding(metricValue)
    : "n/a";
  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date)}</div>
    <div>Index: ${indexValue}</div>
    <div>${metricLabel}: ${legendMetricValue}</div>
  `;
  const xScale = chartState.currentXScale;
  const yScale = chartState.currentYScale;
  let anchorX = x;
  let anchorY = y;
  if (
    xScale &&
    yScale &&
    datum?.date instanceof Date &&
    Number.isFinite(datum?.index_price_close)
  ) {
    const viewBox = svgEl.viewBox?.baseVal;
    const viewBoxWidth = Number(viewBox?.width);
    const viewBoxHeight = Number(viewBox?.height);
    const anchorSvgX = layout.margin.left + xScale(datum.date);
    const anchorSvgY = layout.margin.top + yScale(datum.index_price_close);
    const svgRect = svgEl.getBoundingClientRect();
    const wrapperOffsetX = svgRect.left - wrapperRect.left;
    const wrapperOffsetY = svgRect.top - wrapperRect.top;
    if (
      Number.isFinite(viewBoxWidth) &&
      viewBoxWidth > 0 &&
      Number.isFinite(viewBoxHeight) &&
      viewBoxHeight > 0
    ) {
      anchorX = wrapperOffsetX + (anchorSvgX / viewBoxWidth) * svgRect.width;
      anchorY = wrapperOffsetY + (anchorSvgY / viewBoxHeight) * svgRect.height;
    } else {
      anchorX = anchorSvgX;
      anchorY = anchorSvgY;
    }
  }
  tooltip.style.left = `${anchorX}px`;
  tooltip.style.top = `${anchorY}px`;
  tooltip.style.opacity = "1";
  const tooltipRect = tooltip.getBoundingClientRect();
  const wrapperRectUpdated = wrapper.getBoundingClientRect();
  const edgePadding = 8;
  const verticalGap = 36;
  const centeredLeft = anchorX - tooltipRect.width / 2;
  const clampedLeft = Math.max(
    edgePadding,
    Math.min(
      wrapperRectUpdated.width - tooltipRect.width - edgePadding,
      centeredLeft,
    ),
  );
  const minTop = layout.margin.top + 4;
  const maxTop = Math.max(
    minTop,
    wrapperRectUpdated.height - tooltipRect.height - edgePadding,
  );
  const aboveTop = anchorY - tooltipRect.height - verticalGap;
  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${Math.max(minTop, Math.min(maxTop, aboveTop))}px`;
  scheduleTooltipAutoFade();
};

const hideTooltip = () => {
  const tooltip = tooltipRef.value;
  if (!tooltip) return;
  tooltip.style.opacity = "0";
  tooltipDatum = null;
  clearTooltipFadeTimer();
};

const handlePointerMove = (event) => {
  const mainNode = chartState.mainGroup?.node();
  if (!mainNode) return;
  const [px, py] = d3.pointer(event, mainNode);
  if (Number.isFinite(px) && Number.isFinite(py)) {
    lastPointerInMain = { x: px, y: py };
    if (
      hoveredDatum &&
      chartState.currentXScale &&
      chartState.currentYScale &&
      hoveredDatum.date instanceof Date &&
      Number.isFinite(hoveredDatum.index_price_close)
    ) {
      const hx = chartState.currentXScale(hoveredDatum.date);
      const hy = chartState.currentYScale(hoveredDatum.index_price_close);
      const cursorOutsideHoveredDot =
        !Number.isFinite(hx) ||
        !Number.isFinite(hy) ||
        Math.abs(px - hx) > HOVER_RELEASE_HITBOX_PX ||
        Math.abs(py - hy) > HOVER_RELEASE_HITBOX_PX;
      if (cursorOutsideHoveredDot) {
        hoveredDatum = null;
        resetHoverStyles();
        updateSelectionLine();
        if (tooltipDatum) {
          scheduleTooltipAutoFade();
        }
      }
    }
  }
};

const handlePointerLeave = () => {
  lastPointerInMain = null;
  if (hoveredDatum) {
    hoveredDatum = null;
    resetHoverStyles();
    updateSelectionLine();
  }
  if (tooltipDatum) {
    scheduleTooltipAutoFade();
  }
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
    chartState.background = svg.append("rect").attr("fill", "#000");
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

  if (!chartState.legendGroup) {
    chartState.legendGroup = svg.append("g");
    chartState.legendGroup
      .style("cursor", "pointer")
      .on("click", (event) => {
        event.stopPropagation();
        legendMetricMode.value =
          legendMetricMode.value === "funding" ? "basis" : "funding";
        render();
      });
    chartState.legendTitle = appendText(chartState.legendGroup, "legendTitle", {
      text: "Annualized funding rate",
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
    chartState.selectionLine = chartState.mainGroup
      .append("line")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.6)
      .attr("stroke-dasharray", "6 6")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.8)
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.selectionLabel = chartState.mainGroup
      .append("text")
      .attr("text-anchor", "middle")
      .attr("fill", "#e8e8ea")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "11px")
      .style("font-weight", 600)
      .attr("paint-order", "stroke")
      .attr("stroke", "#000")
      .attr("stroke-width", 3)
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.pointsGroup = chartState.mainGroup.append("g");
    chartState.mainXAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Date (UTC)",
    );
    chartState.mainYAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Index Price (Close)",
    );
  }

  if (!chartState.detailGroup) {
    chartState.detailGroup = svg.append("g").style("opacity", 0);
    chartState.detailTitleText = appendText(
      chartState.detailGroup,
      "detailTitle",
      {
        anchor: "middle",
      },
    );
    chartState.detailSubtitleText = appendText(
      chartState.detailGroup,
      "detailSubtitle",
      { anchor: "middle" },
    );
    chartState.detailMetricText = appendText(
      chartState.detailGroup,
      "detailMetric",
      { anchor: "middle" },
    );
    chartState.detailLegendGroup = chartState.detailGroup.append("g");
    chartState.detailLegendFundingLine = chartState.detailLegendGroup
      .append("line")
      .attr("stroke", "#c9c9cf")
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round");
    chartState.detailLegendFundingText = appendText(
      chartState.detailLegendGroup,
      "detailLegend",
    );
    chartState.detailLegendBasisLine = chartState.detailLegendGroup
      .append("line")
      .attr("stroke", "#7aa2ff")
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round");
    chartState.detailLegendBasisText = appendText(
      chartState.detailLegendGroup,
      "detailLegend",
    );
    chartState.detailLayer = chartState.detailGroup.append("g");
    chartState.detailXAxisGroup = chartState.detailLayer.append("g");
    chartState.detailYAxisGroup = chartState.detailLayer.append("g");
    chartState.detailLinePath = chartState.detailLayer
      .append("path")
      .attr("fill", "none")
      .attr("stroke", "#c9c9cf")
      .attr("stroke-width", 1.6);
    chartState.detailBasisLinePath = chartState.detailLayer
      .append("path")
      .attr("fill", "none")
      .attr("stroke", "#7aa2ff")
      .attr("stroke-width", 1.6)
      .attr("stroke-linecap", "round");
    chartState.detailMessageText = appendText(
      chartState.detailLayer,
      "detailMessage",
      { anchor: "middle" },
    );
    chartState.detailXAxisLabel = appendAxisLabel(
      chartState.detailLayer,
      "Date (UTC)",
    );
    chartState.detailYAxisLabel = appendAxisLabel(
      chartState.detailLayer,
      "Cumulative ($)",
    );
  }

  return svg;
};

function exportPng({
  filename = "funding-chart.png",
  scale = 4,
  padding = 24,
} = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

function createLegendMetricContext({ data, futureBasisByTs, mode }) {
  const isBasisLegendMode = mode === "basis";
  const label = isBasisLegendMode ? "Basis (ann.)" : "Funding (ann.)";
  const title = isBasisLegendMode
    ? "Annualized basis (future)"
    : "Annualized funding rate";

  const getBasisAnnualized = (datum) => {
    if (!datum) return null;
    const ts = Number.isFinite(datum.ts) ? datum.ts : getDatumTs(datum);
    if (!Number.isFinite(ts)) return null;
    const value = futureBasisByTs.get(ts);
    return Number.isFinite(value) ? value : null;
  };

  const getValue = (datum) =>
    isBasisLegendMode ? getBasisAnnualized(datum) : datum.funding_rate_annualized;

  const values = data
    .map((datum) => getValue(datum))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const [extentMin, extentMax] = d3.extent(values);
  const hasValidExtent =
    Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent
    ? isBasisLegendMode
      ? extentMin
      : Math.max(extentMin, -0.05)
    : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";

  const colorForValue = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) {
      return fallbackColor;
    }
    if (!hasSpread) {
      return d3.interpolateRdBu(0.5);
    }
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    const ramp = 0.32 + 0.68 * clamped;
    return d3.interpolateRdBu(1 - ramp);
  };

  const formatValue = (value) =>
    Number.isFinite(value) ? d3.format("+.2%")(value) : "n/a";

  return {
    label,
    title,
    extentMin,
    domainMin,
    domainMax,
    domainSpan,
    hasValidExtent,
    getValue,
    colorForValue,
    formatValue,
  };
}

const futureBasisByTs = computed(() => {
  const map = new Map();
  for (const row of props.futureBasisData || []) {
    if (!Number.isFinite(row?.ts) || !Number.isFinite(row?.basis_pct)) continue;
    map.set(row.ts, row.basis_pct);
  }
  return map;
});

function renderLegendBar({
  mainWidth,
  margin,
  withLayoutTransition,
  gradientId,
  title,
  extentMin,
  domainMax,
  formatValue,
}) {
  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
  const legendY = margin.top - 52;
  withLayoutTransition(chartState.legendGroup).attr(
    "transform",
    `translate(${legendX},${legendY})`,
  );
  const legendPaddingY = 8;
  const legendTitleY = legendPaddingY;
  const legendBarTop = legendTitleY + 14;
  const legendLabelY = legendBarTop + legendHeight + 16;

  chartState.legendTitle?.attr("x", 0).attr("y", legendTitleY).text(title);
  chartState.legendRect
    .attr("x", 0)
    .attr("y", legendBarTop)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`);
  chartState.legendMinText
    .attr("x", 0)
    .attr("y", legendLabelY)
    .text(formatValue(extentMin));
  chartState.legendMaxText
    .attr("x", legendWidth)
    .attr("y", legendLabelY)
    .text(formatValue(domainMax));
}

function renderDetailWindow({
  selection,
  data,
  basisData,
  isRollMode,
  detailPlaceholder,
  detailWidth,
  detailInnerWidth,
  subtitleY,
  subtitleLine2Y,
  innerHeight,
  axisTitlePadding,
  detailColors,
}) {
  const setSubtitle = (line1, line2 = null, line2Bold = null) => {
    chartState.detailSubtitleText.text("");
    chartState.detailSubtitleText.selectAll("tspan").remove();
    chartState.detailSubtitleText
      .append("tspan")
      .attr("x", detailWidth / 2)
      .attr("y", subtitleY)
      .text(line1);
    if (line2) {
      chartState.detailSubtitleText
        .append("tspan")
        .attr("x", detailWidth / 2)
        .attr("y", subtitleLine2Y)
        .text(line2);
      if (line2Bold) {
        chartState.detailSubtitleText
          .append("tspan")
          .text(line2Bold)
          .style("font-weight", 700);
      }
    }
  };
  if (!selection || selection.length !== 2) {
    setSubtitle(detailPlaceholder);
    chartState.detailLinePath.attr("display", "none");
    chartState.detailBasisLinePath.attr("display", "none");
    chartState.detailXAxisGroup.attr("display", "none");
    chartState.detailYAxisGroup.attr("display", "none");
    chartState.detailXAxisLabel.attr("display", "none");
    chartState.detailYAxisLabel.attr("display", "none");
    chartState.detailMessageText.attr("display", "none");
    chartState.detailMetricText.attr("display", "none");
    chartState.detailLegendGroup.attr("display", "none");
    return;
  }
  chartState.detailLegendGroup.attr("display", null);

  const startIndex = data.indexOf(selection[0]);
  const endIndex = data.indexOf(selection[1]);
  if (startIndex < 0 || endIndex < 0) return;
  const fromIndex = Math.min(startIndex, endIndex);
  const toIndex = Math.max(startIndex, endIndex);
  const window = data.slice(fromIndex, toIndex + 1);
  const windowStart = window[0]?.date;
  const windowEnd = window[window.length - 1]?.date;
  let detailSubtitle = detailPlaceholder;
  if (windowStart instanceof Date && windowEnd instanceof Date) {
    const days = Math.abs((windowEnd - windowStart) / MS_PER_DAY);
    detailSubtitle = `${formatDate(windowStart)} - ${formatDate(windowEnd)} (${days.toFixed(
      1,
    )} days)`;
  }
  let cumulative = 0;
  let fundingSum = 0;
  let fundingCount = 0;
  let indexSum = 0;
  let indexCount = 0;
  const intervalSecondsCandidates = [];
  const series = window.map((point, idx) => {
    const funding = Number.isFinite(point.funding) ? -point.funding : 0;
    if (Number.isFinite(point.funding)) {
      fundingSum += -point.funding;
      fundingCount += 1;
    }
    if (Number.isFinite(point.index_price_close)) {
      indexSum += point.index_price_close;
      indexCount += 1;
    }
    if (idx > 0 && point.date instanceof Date) {
      const prev = window[idx - 1];
      if (prev?.date instanceof Date) {
        const delta = (point.date - prev.date) / 1000;
        if (Number.isFinite(delta) && delta > 0) {
          intervalSecondsCandidates.push(delta);
        }
      }
    }
    cumulative += funding;
    return { date: point.date, cumulative };
  });
  const avgFunding = fundingCount ? fundingSum / fundingCount : null;
  const avgIndex = indexCount ? indexSum / indexCount : null;
  const avgIntervalSeconds = intervalSecondsCandidates.length
    ? intervalSecondsCandidates.reduce((sum, value) => sum + value, 0) /
      intervalSecondsCandidates.length
    : null;
  const avgFundingAnnualized =
    avgFunding != null &&
    avgIndex != null &&
    avgIndex !== 0 &&
    avgIntervalSeconds != null
      ? (avgFunding / avgIndex) * (SECONDS_PER_YEAR / avgIntervalSeconds)
      : null;

  const basisWindow = basisData
    .filter(
      (point) =>
        point.date instanceof Date &&
        windowStart instanceof Date &&
        windowEnd instanceof Date &&
        point.date >= windowStart &&
        point.date <= windowEnd &&
        Number.isFinite(point.basis_close),
    )
    .sort((a, b) => a.date - b.date);
  const basisBase = basisWindow.length ? basisWindow[0].basis_close : 0;
  const basisSeriesRaw = basisWindow.map((point) => ({
    date: point.date,
    cumulative: isRollMode ? point.basis_close : basisBase - point.basis_close,
  }));
  const basisSeries = basisSeriesRaw.map((point, idx) => {
    const start = Math.max(0, idx - 7);
    const slice = basisSeriesRaw.slice(start, idx + 1);
    const mean =
      slice.reduce((sum, entry) => sum + entry.cumulative, 0) / slice.length;
    return { date: point.date, cumulative: mean };
  });
  const rollSeries = basisSeries;
  let fundingIdx = 0;
  let lastFunding = 0;
  const getFundingAtDate = (targetDate) => {
    if (!(targetDate instanceof Date)) return lastFunding;
    while (
      fundingIdx < series.length &&
      series[fundingIdx]?.date instanceof Date &&
      series[fundingIdx].date <= targetDate
    ) {
      lastFunding = series[fundingIdx].cumulative ?? lastFunding;
      fundingIdx += 1;
    }
    return lastFunding;
  };
  const rollStartDate = rollSeries[0]?.date;
  const fundingBase = rollStartDate ? getFundingAtDate(rollStartDate) : 0;
  const adjustedSeries = rollSeries.map((point) => {
    const fundingValue = getFundingAtDate(point.date) - fundingBase;
    return { date: point.date, cumulative: point.cumulative + fundingValue };
  });
  let rollRoiText = null;
  if (isRollMode && adjustedSeries.length >= 2) {
    const startValue = adjustedSeries[0].cumulative;
    const endValue = adjustedSeries[adjustedSeries.length - 1].cumulative;
    const roi =
      Number.isFinite(startValue) &&
      startValue !== 0 &&
      Number.isFinite(endValue)
        ? (endValue - startValue) / Math.abs(startValue)
        : null;
    rollRoiText = roi != null ? d3.format("+.2%")(roi) : "n/a";
  }
  if (isRollMode) {
    const rollLabel = "Adj Roll Price ROI: ";
    const rollValue = rollRoiText || "n/a";
    setSubtitle(detailSubtitle, rollLabel, rollValue);
  } else {
    setSubtitle(detailSubtitle);
  }
  const spanSeconds =
    windowStart instanceof Date && windowEnd instanceof Date
      ? Math.abs((windowEnd - windowStart) / 1000)
      : null;
  const basisAnnualized =
    basisWindow.length &&
    avgIndex != null &&
    avgIndex !== 0 &&
    spanSeconds &&
    spanSeconds > 0
      ? ((basisBase - basisWindow[basisWindow.length - 1].basis_close) /
          avgIndex) *
        (SECONDS_PER_YEAR / spanSeconds)
      : null;
  const hasBasis = basisData.length > 0;
  const hasBasisInWindow = basisWindow.length > 0;
  chartState.detailMetricText.selectAll("tspan").remove();
  if (isRollMode) {
    chartState.detailMetricText.attr("display", "none");
  } else {
    chartState.detailMetricText.attr("display", null);
    const metricFunding =
      avgFundingAnnualized != null ? formatFunding(avgFundingAnnualized) : "n/a";
    const metricBasis =
      basisAnnualized != null ? formatFunding(basisAnnualized) : "n/a";
    chartState.detailMetricText.append("tspan").text("Avg funding: ");
    chartState.detailMetricText
      .append("tspan")
      .text(metricFunding)
      .style("font-weight", 700);
    chartState.detailMetricText.append("tspan").text(" | basis cost: ");
    chartState.detailMetricText
      .append("tspan")
      .text(metricBasis)
      .style("font-weight", 700);
  }

  if (!hasBasisInWindow) {
    const message = hasBasis
      ? isRollMode
        ? "No roll data for the selected window."
        : "No basis data for the selected window."
      : isRollMode
        ? "No roll data available for this future."
        : "No basis data available for this future.";
    chartState.detailMessageText
      .attr("x", detailInnerWidth / 2)
      .attr("y", innerHeight / 2)
      .text(message)
      .attr("display", null);
  } else {
    chartState.detailMessageText.attr("display", "none");
  }

  const primarySeries = isRollMode ? adjustedSeries : series;
  const secondarySeries = isRollMode ? rollSeries : basisSeries;
  const xDomain = d3.extent([...primarySeries, ...secondarySeries], (d) => d.date);
  const combinedValues = [
    ...primarySeries.map((d) => d.cumulative),
    ...secondarySeries.map((d) => d.cumulative),
  ];
  const [rawMin, rawMax] = d3.extent(combinedValues);
  let yMin = rawMin ?? 0;
  let yMax = rawMax ?? 0;
  if (isRollMode && rollSeries.length) {
    const [rollMin, rollMax] = d3.extent(rollSeries.map((d) => d.cumulative));
    if (Number.isFinite(rollMin)) {
      yMin = Math.min(yMin, rollMin - Math.abs(rollMin) * 0.1);
    }
    if (Number.isFinite(rollMax)) {
      yMax = Math.max(yMax, rollMax + Math.abs(rollMax) * 0.1);
    }
  } else if (!isRollMode && basisSeries.length) {
    const [basisMin, basisMax] = d3.extent(basisSeries.map((d) => d.cumulative));
    if (Number.isFinite(basisMin)) {
      yMin = Math.min(yMin, basisMin - Math.abs(basisMin) * 0.1);
    }
    if (Number.isFinite(basisMax)) {
      yMax = Math.max(yMax, basisMax + Math.abs(basisMax) * 0.1);
    }
  }
  if (yMin === yMax) {
    const pad = yMin === 0 ? 0.0001 : Math.abs(yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  const detailX = d3.scaleUtc().domain(xDomain).range([0, detailInnerWidth]);
  const detailY = d3
    .scaleLinear()
    .domain([yMin, yMax])
    .nice()
    .range([innerHeight, 0]);
  const detailXAxis = d3.axisBottom(detailX).ticks(4).tickSize(0).tickPadding(10);
  const detailYAxis = d3
    .axisLeft(detailY)
    .ticks(5)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(d3.format("$,.2f"));

  chartState.detailXAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(detailXAxis)
    .call(axisStyle)
    .attr("display", null);
  chartState.detailYAxisGroup
    .call(detailYAxis)
    .call(axisStyle)
    .attr("display", null);
  chartState.detailXAxisLabel
    .attr("x", detailInnerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding)
    .attr("display", null);
  chartState.detailYAxisLabel
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding)
    .attr("display", null);

  const line = d3
    .line()
    .x((d) => detailX(d.date))
    .y((d) => detailY(d.cumulative))
    .curve(d3.curveMonotoneX);
  chartState.detailLinePath
    .attr("stroke", detailColors.funding)
    .attr("d", line(primarySeries))
    .attr("display", null);
  if (secondarySeries.length) {
    chartState.detailBasisLinePath
      .attr("stroke", detailColors.secondary)
      .attr("d", line(secondarySeries))
      .attr("display", null);
    chartState.detailLegendBasisLine.attr("display", null);
    chartState.detailLegendBasisText.attr("display", null);
  } else {
    chartState.detailBasisLinePath.attr("display", "none");
    chartState.detailLegendBasisLine.attr("display", "none");
    chartState.detailLegendBasisText.attr("display", "none");
  }
  chartState.detailMetricText.attr("display", null);
}

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const data = props.data;

  const svg = ensureChartElements();
  if (!svg) return;

  const { height, margin } = layout;
  const fullWidth = layout.mainWidth + layout.panelGap + layout.detailWidth;
  syncSelectionWithData(data);
  if (hoveredDatum && !data.includes(hoveredDatum)) {
    hoveredDatum = null;
  }
  const isDetailActive = selectedDatums.length === 2;
  const animateLayout = isDetailActive !== detailActive;
  detailActive = isDetailActive;
  if (animateLayout && isDetailActive) {
    scheduleLineReveal();
  } else if (!isDetailActive) {
    if (lineRevealTimer) clearTimeout(lineRevealTimer);
    lineRevealTimer = null;
    lineRevealPending = false;
  }
  const mainWidth = isDetailActive ? layout.mainWidth : fullWidth;
  const detailWidth = layout.detailWidth;
  const panelGap = isDetailActive ? layout.panelGap : 0;
  const width = fullWidth;
  const innerWidth = mainWidth - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const withLayoutTransition = (selection) =>
    animateLayout
      ? selection.interrupt().transition().duration(LAYOUT_TRANSITION_MS)
      : selection.interrupt();

  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
  chartState.background
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height);

  chartState.mainTitleText
    .call(withLayoutTransition)
    .attr("x", mainWidth / 2)
    .attr("y", 30)
    .text(mainTitle.value);
  chartState.mainSubtitleText
    .call(withLayoutTransition)
    .attr("x", mainWidth / 2)
    .attr("y", 54)
    .text(subtitle.value);

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
    chartState.detailGroup?.attr("display", "none");
    hideTooltip();
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.legendGroup.attr("display", null);
  chartState.detailGroup.attr("display", null);

  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const detailOffsetX = mainWidth + panelGap;
  const detailInnerWidth = detailWidth - margin.left - margin.right;
  const detailPlaceholder = "Select two points";
  chartState.detailGroup
    .call(withLayoutTransition)
    .attr("transform", `translate(${detailOffsetX},0)`)
    .style("opacity", isDetailActive ? 1 : 0);
  chartState.detailLayer.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );
  const isRollMode = props.showRollPnl;
  chartState.detailTitleText
    .attr("x", detailWidth / 2)
    .attr("y", 30)
    .text(detailTitle.value);
  const subtitleY = 54;
  const metricY = 72;
  const subtitleLine2Y = metricY;
  chartState.detailSubtitleText.attr("x", detailWidth / 2).attr("y", subtitleY);
  chartState.detailMetricText.attr("x", detailWidth / 2).attr("y", metricY);

  const legendLineLength = 18;
  const legendLabelOffset = 6;
  const legendRowGap = 16;
  const detailLegendX = margin.left;
  const detailLegendY = 92;
  const detailColors = isRollMode ? DETAIL_COLORS.roll : DETAIL_COLORS.carry;
  chartState.detailLegendGroup.attr(
    "transform",
    `translate(${detailLegendX},${detailLegendY})`,
  );
  chartState.detailLegendFundingLine
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", legendLineLength)
    .attr("y2", 0)
    .attr("stroke", detailColors.funding);
  chartState.detailLegendFundingText
    .attr("x", legendLineLength + legendLabelOffset)
    .attr("y", 3)
    .text(isRollMode ? "Adj roll price" : "Funding cost");
  chartState.detailLegendBasisLine
    .attr("x1", 0)
    .attr("y1", legendRowGap)
    .attr("x2", legendLineLength)
    .attr("y2", legendRowGap)
    .attr("stroke", detailColors.secondary);
  chartState.detailLegendBasisText
    .attr("x", legendLineLength + legendLabelOffset)
    .attr("y", legendRowGap + 3)
    .text(isRollMode ? "Roll price" : "Basis cost");

  const validDates = data.map((d) => d.date).filter((d) => d instanceof Date);
  const validIndex = data
    .map((d) => d.index_price_close)
    .filter((v) => Number.isFinite(v));
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validIndex);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain(yDomain).nice().range([innerHeight, 0]);
  chartState.currentXScale = x;
  chartState.currentYScale = y;

  const legendMetric = createLegendMetricContext({
    data,
    futureBasisByTs: futureBasisByTs.value,
    mode: legendMetricMode.value,
  });
  const {
    label: legendMetricLabel,
    title: legendTitleText,
    extentMin,
    domainMin,
    domainMax,
    domainSpan,
    hasValidExtent,
    getValue: getLegendMetricValue,
    colorForValue: colorForLegendMetric,
    formatValue: formatLegendPct,
  } = legendMetric;

  const axisTitlePadding = 10;

  const xAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(10);
  const yAxis = d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10);

  const xAxisSelection = withLayoutTransition(chartState.xAxisGroup)
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis);
  const yAxisSelection = withLayoutTransition(chartState.yAxisGroup).call(
    yAxis,
  );
  if (animateLayout) {
    xAxisSelection.selection().call(axisStyle);
    yAxisSelection.selection().call(axisStyle);
  } else {
    xAxisSelection.call(axisStyle);
    yAxisSelection.call(axisStyle);
  }
  withLayoutTransition(chartState.mainXAxisLabel)
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding);
  withLayoutTransition(chartState.mainYAxisLabel)
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding);

  updateSelectionLine();

  const mainPoints = chartState.pointsGroup
    .selectAll("circle.main-point")
    .data(data, (d) => (d.date ? d.date.getTime() : d.index_price_close));

  const handlePointSelect = (event, datum, fromNearestTap = false) => {
    event.stopPropagation();
    if (event.type === "pointerdown") {
      event.preventDefault();
    }
    if (fromNearestTap) {
      suppressClearClick = true;
    }
    if (selectedDatums.includes(datum)) return;
    if (selectedDatums.length < 2) {
      selectedDatums = [...selectedDatums, datum];
    } else {
      const [first, second] = selectedDatums;
      const firstDate = first?.date;
      const secondDate = second?.date;
      const nextDate = datum?.date;
      if (
        firstDate instanceof Date &&
        secondDate instanceof Date &&
        nextDate instanceof Date
      ) {
        const distToFirst = Math.abs(nextDate - firstDate);
        const distToSecond = Math.abs(nextDate - secondDate);
        const keep = distToFirst <= distToSecond ? second : first;
        selectedDatums = [keep, datum];
      } else {
        selectedDatums = [second || first, datum].filter(Boolean);
      }
    }
    updateSelectedRange();
    render();
  };

  const findNearestDatumForTap = (event) => {
    const mainNode = chartState.mainGroup?.node();
    if (!mainNode) return null;
    const [px, py] = d3.pointer(event, mainNode);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    if (
      px < -TAP_SELECT_HITBOX_PX ||
      px > innerWidth + TAP_SELECT_HITBOX_PX ||
      py < -TAP_SELECT_HITBOX_PX ||
      py > innerHeight + TAP_SELECT_HITBOX_PX
    ) {
      return null;
    }
    let nearest = null;
    let bestDistSq = TAP_SELECT_HITBOX_PX * TAP_SELECT_HITBOX_PX + 1;
    for (const datum of data) {
      if (!(datum?.date instanceof Date)) continue;
      if (!Number.isFinite(datum?.index_price_close)) continue;
      const dx = x(datum.date) - px;
      const dy = y(datum.index_price_close) - py;
      if (Math.abs(dx) > TAP_SELECT_HITBOX_PX || Math.abs(dy) > TAP_SELECT_HITBOX_PX) {
        continue;
      }
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        nearest = datum;
      }
    }
    return nearest;
  };

  chartState.mainGroup.on("pointerdown.nearest-select", (event) => {
    const target = event?.target;
    if (target?.closest?.("circle.main-point")) return;
    const nearest = findNearestDatumForTap(event);
    if (!nearest) return;
    handlePointSelect(event, nearest, true);
  });

  const pointUpdate = mainPoints
    .join((enter) => {
      const circles = enter
        .append("circle")
        .attr("class", "main-point")
        .attr("r", POINT_RADIUS)
        .attr("stroke", "transparent")
        .attr("stroke-width", 0)
        .attr("opacity", 0.8);
      return circles;
    })
    .attr("fill", (d) => colorForLegendMetric(getLegendMetricValue(d)))
    .on("mouseenter", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      applySelectionStyles();
      d3.select(event.currentTarget)
        .attr("r", POINT_RADIUS_HOVER)
        .attr("stroke", "#000")
        .attr("stroke-width", 1.1)
        .attr("opacity", 1)
        .raise();
      showTooltip(
        event,
        datum,
        legendMetricLabel,
        getLegendMetricValue(datum),
      );
    })
    .on("mousemove", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      showTooltip(
        event,
        datum,
        legendMetricLabel,
        getLegendMetricValue(datum),
      );
    })
    .on("mouseleave", (event) => {
      hoveredDatum = null;
      resetHoverStyles();
      updateSelectionLine();
      scheduleTooltipAutoFade();
    })
    .on("pointerdown", (event, datum) => handlePointSelect(event, datum));

  const pointPosition = animateLayout
    ? pointUpdate.transition().duration(LAYOUT_TRANSITION_MS)
    : pointUpdate;
  pointPosition
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.index_price_close));

  applySelectionStyles();
  if (hoveredDatum) {
    chartState.pointsGroup
      .selectAll("circle.main-point")
      .filter((d) => d === hoveredDatum)
      .attr("r", POINT_RADIUS_HOVER)
      .attr("stroke", "#000")
      .attr("stroke-width", 1.1)
      .attr("opacity", 1)
      .raise();
  }

  renderDetailWindow({
    selection: selectedDatums,
    data,
    basisData: props.basisData,
    isRollMode,
    detailPlaceholder,
    detailWidth,
    detailInnerWidth,
    subtitleY,
    subtitleLine2Y,
    innerHeight,
    axisTitlePadding,
    detailColors,
  });

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
    .attr("stop-color", (d) => colorForLegendMetric(d.value));

  renderLegendBar({
    mainWidth,
    margin,
    withLayoutTransition,
    gradientId,
    title: legendTitleText,
    extentMin,
    domainMax,
    formatValue: formatLegendPct,
  });
}

watch(
  () => [
    props.data,
    props.basisData,
    props.futureBasisData,
    props.instrumentName,
    props.futureInstrumentName,
    props.showRollPnl,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
onUnmounted(() => {
  clearTooltipFadeTimer();
});
</script>

<template>
  <div
    class="chartWrap"
    @click="handleChartClick"
    @pointermove="handlePointerMove"
    @pointerleave="handlePointerLeave"
  >
    <svg ref="svgRef" />
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

svg {
  display: block;
  width: 100%;
  height: auto;
  position: relative;
  z-index: 1;
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
  z-index: 2;
}
</style>
