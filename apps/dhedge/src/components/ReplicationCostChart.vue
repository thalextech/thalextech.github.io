<script setup>
import * as d3 from "d3";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  getDatumTs,
  syncSelectionWithData as syncSelectionWithDataUtil,
  updateSelectedRange as computeSelectedRange,
} from "../../../../lib/chartUtils.js";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  replicationData: { type: Array, default: () => [] },
  optionInstrumentName: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  showPnlMode: { type: Boolean, default: false },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `gamma-gradient-${Math.random().toString(16).slice(2)}`;
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  mainWidth: 860,
  detailWidth: 420,
  panelGap: 36,
  height: 560,
  margin: { top: 74, right: 38, bottom: 54, left: 74 },
};
const MAIN_TOP_INSET = 28;
const DETAIL_TOP_INSET = 28;
const LEGEND_TOP_OFFSET = -5;

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

const DETAIL_SERIES_CONFIG_MARK = [
  {
    key: "replication_cost",
    label: "Replication cost",
    color: "#2f5aa6",
    strokeWidth: 1.2,
  },
  {
    key: "option_mark_change",
    label: "Option mark change",
    color: "#ffb703",
    strokeWidth: 1.2,
  },
];

const DETAIL_SERIES_CONFIG_PNL = [
  {
    key: "total_pnl",
    label: "Total P&L",
    color: "#94b3fd",
    strokeWidth: 1.6,
  },
  {
    key: "hedge_pnl",
    label: "Delta hedge P&L",
    color: "#8ecae6",
    strokeWidth: 1.2,
  },
  {
    key: "short_option_pnl",
    label: "Short option P&L",
    color: "#ffb703",
    strokeWidth: 1.2,
  },
];

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
  detailRoiText: null,
  detailMessageText: null,
  detailLegendGroup: null,
  detailSeriesGroup: null,
  detailAreaPath: null,
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
const LAYOUT_TRANSITION_MS = 260;
let hoveredDatum = null;
let selectedDatums = [];
let selectedRange = null;
let detailActive = false;
let lineRevealTimer = null;
let lineRevealPending = false;
let hiddenDetailSeriesKeys = new Set();
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

const toggleDetailSeries = (key) => {
  if (!key) return;
  if (hiddenDetailSeriesKeys.has(key)) {
    hiddenDetailSeriesKeys.delete(key);
  } else {
    hiddenDetailSeriesKeys.add(key);
  }
  render();
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

const mainTitle = computed(() =>
  props.optionInstrumentName ? props.optionInstrumentName : "Options",
);

const subtitle = computed(() => {
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const data = props.data;
  if (!data.length) return "";
  const start = data[0].date;
  const end = data[data.length - 1].date;
  return `${fmt(start)} - ${fmt(end)}`;
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
const formatIndex = d3.format(",.2f");
const formatIndexAxis = d3.format(",.0f");
const formatPnl = d3.format("$,.0f");
const formatGamma = d3.format(".2e");

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
      selectedDatums.length > 0 && !selectedDatums.includes(d) ? 0.4 : 0.8,
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
    const days =
      Math.abs(lineEnd.date - lineStart.date) / (24 * 60 * 60 * 1000);
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

const showTooltip = (event, datum) => {
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
  const gammaValue = Number.isFinite(datum.gamma)
    ? formatGamma(Math.abs(datum.gamma))
    : "n/a";
  const optionMarkValue = Number.isFinite(datum.option_mark_price)
    ? formatIndex(datum.option_mark_price)
    : "n/a";
  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date)}</div>
    <div>Index: ${indexValue}</div>
    <div>Option Mark: ${optionMarkValue}</div>
    <div>Gamma: ${gammaValue}</div>
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
    chartState.legendTitle = appendText(chartState.legendGroup, "legendTitle", {
      text: "|Gamma|",
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
    chartState.legendGroup.attr("opacity", 0);
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
      { anchor: "middle" },
    );
    chartState.detailSubtitleText = appendText(
      chartState.detailGroup,
      "detailSubtitle",
      { anchor: "middle" },
    );
    chartState.detailMetricText = appendText(
      chartState.detailGroup,
      "detailMetric",
      { anchor: "end" },
    );
    chartState.detailRoiText = appendText(
      chartState.detailGroup,
      "detailMetric",
      { anchor: "start" },
    );
    chartState.detailLegendGroup = chartState.detailGroup.append("g");
    chartState.detailLayer = chartState.detailGroup.append("g");
    chartState.detailXAxisGroup = chartState.detailLayer.append("g");
    chartState.detailYAxisGroup = chartState.detailLayer.append("g");
    chartState.detailSeriesGroup = chartState.detailLayer.append("g");
    chartState.detailAreaPath = chartState.detailSeriesGroup
      .append("path")
      .attr("class", "detail-area")
      .attr("fill", "#94b3fd")
      .attr("fill-opacity", 0.16)
      .attr("stroke", "none")
      .attr("display", "none");
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
  filename = "replication-chart.png",
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
  const hasSelectionRange = Boolean(
    selectedRange &&
    Number.isFinite(selectedRange.from) &&
    Number.isFinite(selectedRange.to),
  );
  const isDetailActive = selectedDatums.length === 2 || hasSelectionRange;
  const animateLayout = isDetailActive !== detailActive;
  detailActive = isDetailActive;
  if (animateLayout && isDetailActive) {
    hoveredDatum = null;
    hideTooltip();
    scheduleLineReveal();
  } else if (!isDetailActive) {
    if (lineRevealTimer) clearTimeout(lineRevealTimer);
    lineRevealTimer = null;
    lineRevealPending = false;
  }
  const panelGap = isDetailActive ? layout.panelGap : 0;
  const mainWidth = isDetailActive
    ? Math.round((fullWidth - panelGap) / 2)
    : fullWidth;
  const detailWidth = isDetailActive
    ? Math.max(0, fullWidth - panelGap - mainWidth)
    : layout.detailWidth;
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
    chartState.legendGroup.interrupt().attr("display", "none").attr("opacity", 0);
    chartState.detailGroup?.attr("display", "none");
    hideTooltip();
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.legendGroup.interrupt().attr("display", null).attr("opacity", 1);
  chartState.detailGroup.attr("display", null);

  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const detailOffsetX = mainWidth + panelGap;
  const detailInnerWidth = detailWidth - margin.left - margin.right;
  let detailRangeLabel = "Select two points";
  let rangeStart = null;
  let rangeEnd = null;
  if (selectedDatums.length === 2) {
    const first = selectedDatums[0];
    const second = selectedDatums[1];
    rangeStart = first.date <= second.date ? first.date : second.date;
    rangeEnd = first.date <= second.date ? second.date : first.date;
  }
  if (!rangeStart && hasSelectionRange) {
    const startTs = Math.min(selectedRange.from, selectedRange.to);
    const endTs = Math.max(selectedRange.from, selectedRange.to);
    rangeStart = new Date(startTs * 1000);
    rangeEnd = new Date(endTs * 1000);
  }
  if (rangeStart instanceof Date && rangeEnd instanceof Date) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const days = (rangeEnd - rangeStart) / msPerDay;
    detailRangeLabel = `${formatDate(rangeStart)} - ${formatDate(rangeEnd)} (${days.toFixed(
      1,
    )} days)`;
  }
  chartState.detailGroup
    .call(withLayoutTransition)
    .attr("transform", `translate(${detailOffsetX},0)`)
    .style("opacity", isDetailActive ? 1 : 0);
  chartState.detailLayer.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );
  chartState.detailTitleText
    .attr("x", detailWidth / 2)
    .attr("y", 30)
    .text(props.showPnlMode ? "Short Option + Delta Hedge P&L" : "Replication vs Option");
  chartState.detailSubtitleText
    .attr("x", detailWidth / 2)
    .attr("y", 54)
    .text(detailRangeLabel);
  chartState.detailMetricText
    .attr("x", detailWidth / 2 - 8)
    .attr("y", 72)
    .attr("text-anchor", "end");
  chartState.detailRoiText
    .attr("x", detailWidth / 2 + 8)
    .attr("y", 72)
    .attr("text-anchor", "start");

  const legendLineLength = 18;
  const legendLabelOffset = 6;
  const legendRowGap = 20;
  const legendColGap = 150;
  const legendCols = 2;
  const detailLegendX = margin.left;
  const detailLegendY = 92;
  chartState.detailLegendGroup.attr(
    "transform",
    `translate(${detailLegendX},${detailLegendY})`,
  );

  const validDates = [];
  const validIndex = [];
  const gammaValues = [];
  for (const d of data) {
    if (d.date instanceof Date) validDates.push(d.date);
    if (Number.isFinite(d.index_price_close))
      validIndex.push(d.index_price_close);
    if (Number.isFinite(d.gamma)) gammaValues.push(Math.abs(d.gamma));
  }
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validIndex);
  const [extentMin, extentMax] = d3.extent(gammaValues);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain(yDomain)
    .nice()
    .range([innerHeight, MAIN_TOP_INSET]);
  chartState.currentXScale = x;
  chartState.currentYScale = y;
  const hasValidExtent =
    Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent ? Math.max(extentMin, 0) : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";
  const colorForGamma = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) {
      return fallbackColor;
    }
    if (!hasSpread) {
      return d3.interpolateRdBu(0.5);
    }
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    const ramp = 0.12 + 0.88 * clamped;
    return d3.interpolateRdBu(1 - ramp);
  };
  const formatGammaValue = (value) =>
    Number.isFinite(value) ? formatGamma(value) : "n/a";

  const axisTitlePadding = 10;

  const mainTickCount = isDetailActive ? 5 : 10;
  const xAxis = d3
    .axisBottom(x)
    .ticks(mainTickCount)
    .tickSize(0)
    .tickPadding(10);
  const yAxis = d3
    .axisLeft(y)
    .ticks(6)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(formatIndexAxis);

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

  const renderDetailWindow = (selection, range) => {
    let start = null;
    let end = null;
    if (selection && selection.length === 2) {
      const firstDate = selection[0]?.date;
      const secondDate = selection[1]?.date;
      if (firstDate instanceof Date && secondDate instanceof Date) {
        start = firstDate <= secondDate ? firstDate : secondDate;
        end = firstDate <= secondDate ? secondDate : firstDate;
      }
    }
    if (!start && range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
      start = new Date(Math.min(range.from, range.to) * 1000);
      end = new Date(Math.max(range.from, range.to) * 1000);
    }
    if (!(start instanceof Date) || !(end instanceof Date)) {
      chartState.detailSeriesGroup
        .selectAll("path.detail-line")
        .attr("display", "none");
      chartState.detailAreaPath?.attr("display", "none");
      chartState.detailXAxisGroup.attr("display", "none");
      chartState.detailYAxisGroup.attr("display", "none");
      chartState.detailXAxisLabel.attr("display", "none");
      chartState.detailYAxisLabel.attr("display", "none");
      chartState.detailLegendGroup.attr("display", "none");
      chartState.detailMessageText.attr("display", "none");
      chartState.detailMetricText.attr("display", "none");
      chartState.detailRoiText.attr("display", "none");
      return;
    }

    const replicationWindow = props.replicationData.filter(
      (point) =>
        point.date instanceof Date &&
        point.date >= start &&
        point.date <= end,
    );

    if (!replicationWindow.length) {
      chartState.detailLegendGroup.attr("display", "none");
      chartState.detailSeriesGroup
        .selectAll("path.detail-line")
        .attr("display", "none");
      chartState.detailAreaPath?.attr("display", "none");
      chartState.detailXAxisGroup.attr("display", "none");
      chartState.detailYAxisGroup.attr("display", "none");
      chartState.detailXAxisLabel.attr("display", "none");
      chartState.detailYAxisLabel.attr("display", "none");
      chartState.detailMetricText.attr("display", "none");
      chartState.detailRoiText.attr("display", "none");
      chartState.detailMessageText
        .attr("x", detailInnerWidth / 2)
        .attr("y", innerHeight / 2)
        .attr("display", null)
        .text(
          props.optionInstrumentName
            ? props.showPnlMode
              ? "No strategy P&L data for this range."
              : "No replication data for this range."
            : props.showPnlMode
              ? "Select an option instrument to view strategy P&L."
              : "Select an option instrument to view replication cost.",
        );
      return;
    }

    const detailSeriesConfig = props.showPnlMode
      ? DETAIL_SERIES_CONFIG_PNL
      : DETAIL_SERIES_CONFIG_MARK;
    const firstPoint = replicationWindow[0] || {};
    const baseByKey = {};
    for (const series of detailSeriesConfig) {
      const baseValue = Number(firstPoint?.[series.key]);
      baseByKey[series.key] = Number.isFinite(baseValue) ? baseValue : 0;
    }
    const seriesByKey = Object.fromEntries(
      detailSeriesConfig.map((series) => [series.key, []]),
    );

    replicationWindow.forEach((point) => {
      const date = point.date;
      if (!(date instanceof Date)) return;
      for (const series of detailSeriesConfig) {
        const rawValue = Number(point?.[series.key]);
        if (!Number.isFinite(rawValue)) continue;
        const baseValue = Number(baseByKey[series.key]);
        const normalizedValue = rawValue - (Number.isFinite(baseValue) ? baseValue : 0);
        seriesByKey[series.key].push({ date, value: normalizedValue });
      }
    });

    const seriesList = detailSeriesConfig.map((series) => ({
      ...series,
      values: seriesByKey[series.key] || [],
    }));

    const allDates = [];
    const allValues = [];
    for (const series of seriesList) {
      for (const d of series.values) {
        allDates.push(d.date);
        allValues.push(d.value);
      }
    }
    const xDomain = d3.extent(allDates);
    const [rawMin, rawMax] = d3.extent(allValues);
    let yMin = rawMin ?? 0;
    let yMax = rawMax ?? 0;
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
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
      .range([innerHeight, DETAIL_TOP_INSET]);
    const detailXAxis = d3
      .axisBottom(detailX)
      .ticks(4)
      .tickSize(0)
      .tickPadding(10);
    const detailYAxis = d3
      .axisLeft(detailY)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat(formatPnl);

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
      .y((d) => detailY(d.value))
      .curve(d3.curveMonotoneX);

    const isHiddenSeries = (key) => hiddenDetailSeriesKeys.has(key);
    chartState.detailAreaPath?.attr("display", "none");

    const seriesPaths = chartState.detailSeriesGroup
      .selectAll("path.detail-line")
      .data(seriesList, (d) => d.key)
      .join((enter) =>
        enter
          .append("path")
          .attr("class", "detail-line")
          .attr("fill", "none")
          .attr("stroke-linecap", "round"),
      );

    seriesPaths
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", (d) => d.strokeWidth || 1.6)
      .attr("d", (d) => line(d.values))
      .attr("display", (d) => (d.values.length ? null : "none"))
      .attr("stroke-opacity", (d) => (isHiddenSeries(d.key) ? 0.16 : 1));

    const legendItems = chartState.detailLegendGroup
      .selectAll("g.detail-legend-item")
      .data(seriesList, (d) => d.key)
      .join((enter) => {
        const item = enter.append("g").attr("class", "detail-legend-item");
        item.append("line").attr("stroke-linecap", "round");
        item.append("text");
        return item;
      });

    legendItems.attr("transform", (d, i) => {
      const col = i % legendCols;
      const row = Math.floor(i / legendCols);
      return `translate(${col * legendColGap},${row * legendRowGap})`;
    });
    legendItems
      .select("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", legendLineLength)
      .attr("y2", 0)
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", (d) => d.strokeWidth || 1.6)
      .attr("stroke-opacity", (d) => (isHiddenSeries(d.key) ? 0.28 : 1));
    legendItems
      .select("text")
      .attr("x", legendLineLength + legendLabelOffset)
      .attr("y", 3)
      .call((text) => applyTextStyle(text, "detailLegend"))
      .text((d) => d.label)
      .attr("fill-opacity", (d) => (isHiddenSeries(d.key) ? 0.45 : 1));

    legendItems
      .attr("role", "button")
      .style("cursor", "pointer")
      .attr("opacity", (d) => (isHiddenSeries(d.key) ? 0.6 : 1))
      .on("click", (event, d) => {
        event.stopPropagation();
        toggleDetailSeries(d.key);
      });

    chartState.detailLegendGroup.attr("display", null);
    chartState.detailMessageText.attr("display", "none");

    if (props.showPnlMode) {
      const lastTotal = seriesByKey.total_pnl?.[seriesByKey.total_pnl.length - 1];
      const lastHedge = seriesByKey.hedge_pnl?.[seriesByKey.hedge_pnl.length - 1];
      const lastShort =
        seriesByKey.short_option_pnl?.[seriesByKey.short_option_pnl.length - 1];
      const totalLabel = Number.isFinite(lastTotal?.value)
        ? formatPnl(lastTotal.value)
        : "n/a";
      const hedgeLabel = Number.isFinite(lastHedge?.value)
        ? formatPnl(lastHedge.value)
        : "n/a";
      const shortLabel = Number.isFinite(lastShort?.value)
        ? formatPnl(lastShort.value)
        : "n/a";
      chartState.detailMetricText
        .text(`Total P&L: ${totalLabel}`)
        .attr("display", null);
      chartState.detailRoiText
        .text(`Hedge: ${hedgeLabel} | Short: ${shortLabel}`)
        .attr("display", null);
    } else {
      const lastReplication =
        seriesByKey.replication_cost[seriesByKey.replication_cost.length - 1];
      const lastOption =
        seriesByKey.option_mark_change[seriesByKey.option_mark_change.length - 1];
      const replicationLabel = Number.isFinite(lastReplication?.value)
        ? formatPnl(lastReplication.value)
        : "n/a";
      const optionLabel = Number.isFinite(lastOption?.value)
        ? formatPnl(lastOption.value)
        : "n/a";
      chartState.detailMetricText
        .text(`Replication: ${replicationLabel}`)
        .attr("display", null);
      chartState.detailRoiText
        .text(`Option: ${optionLabel}`)
        .attr("display", null);
    }
  };

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
    hoveredDatum = null;
    hideTooltip();
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
      py < MAIN_TOP_INSET - TAP_SELECT_HITBOX_PX ||
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
    .attr("fill", (d) => {
      const gammaValue = Number.isFinite(d.gamma) ? Math.abs(d.gamma) : NaN;
      return colorForGamma(gammaValue);
    })
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
      showTooltip(event, datum);
    })
    .on("mousemove", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      showTooltip(event, datum);
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

  renderDetailWindow(selectedDatums, selectedRange);

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
    .attr("stop-color", (d) => colorForGamma(d.value));

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
  const legendY = margin.top - LEGEND_TOP_OFFSET;
  withLayoutTransition(chartState.legendGroup).attr(
    "transform",
    `translate(${legendX},${legendY})`,
  );
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
    .text(formatGammaValue(extentMin));
  chartState.legendMaxText
    .attr("x", legendWidth)
    .attr("y", legendLabelY)
    .text(formatGammaValue(domainMax));
}

watch(
  () => [
    props.data,
    props.replicationData,
    props.optionInstrumentName,
    props.showPnlMode,
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
