<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  optionPnlData: { type: Array, default: () => [] },
  optionInstrumentName: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `funding-gradient-${Math.random().toString(16).slice(2)}`;
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

const DETAIL_SERIES_CONFIG = [
  { key: "total", label: "Total", color: "#94b3fd", strokeWidth: 2.2 },
  { key: "delta", label: "Delta", color: "#ffb703", strokeWidth: 1.6 },
  {
    key: "gammaTheta",
    label: "Gamma + Theta",
    color: "#8ecae6",
    strokeWidth: 1.6,
  },
  { key: "vega", label: "Vega", color: "#ff6b6b", strokeWidth: 1.6 },
  { key: "residual", label: "Residual", color: "#7c7f8f", strokeWidth: 1.2 },
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
const LAYOUT_TRANSITION_MS = 260;
let hoveredDatum = null;
let selectedDatums = [];
let detailActive = false;
let lineRevealTimer = null;
let lineRevealPending = false;
let hiddenDetailSeriesKeys = new Set();

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
  const target = event?.target;
  const isPoint = target?.closest?.("circle.main-point");
  if (isPoint) return;
  if (selectedDatums.length) {
    selectedDatums = [];
    render();
    resetHoverStyles();
    hideTooltip();
  }
};

const mainTitle = computed(() => "Mark Options");

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
const formatPnl = d3.format("$,.0f");
const formatVol = d3.format(".1%");

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
  const wrapper = svgRef.value?.closest(".chartWrap");
  if (!tooltip || !wrapper) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const x = event.clientX - wrapperRect.left;
  const y = event.clientY - wrapperRect.top;
  const indexValue = Number.isFinite(datum.index_price_close)
    ? formatIndex(datum.index_price_close)
    : "n/a";
  const ivValue = Number.isFinite(datum.iv_close)
    ? formatVol(datum.iv_close)
    : "n/a";
  const optionMarkValue = Number.isFinite(datum.option_mark_price)
    ? formatIndex(datum.option_mark_price)
    : "n/a";
  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date)}</div>
    <div>Index: ${indexValue}</div>
    <div>Option Mark: ${optionMarkValue}</div>
    <div>IV: ${ivValue}</div>
  `;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.style.opacity = "1";
  const tooltipRect = tooltip.getBoundingClientRect();
  const wrapperRectUpdated = wrapper.getBoundingClientRect();
  const centeredLeft = x - tooltipRect.width / 2;
  const clampedLeft = Math.max(
    8,
    Math.min(wrapperRectUpdated.width - tooltipRect.width - 8, centeredLeft),
  );
  const top = y - tooltipRect.height - 12;
  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
};

const hideTooltip = () => {
  const tooltip = tooltipRef.value;
  if (!tooltip) return;
  tooltip.style.opacity = "0";
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
      text: "Implied volatility",
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
      { anchor: "middle" },
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
      "Cumulative P&L ($)",
    );
  }

  return svg;
};

function exportPng({
  filename = "option-chart.png",
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
  if (selectedDatums.length) {
    selectedDatums = selectedDatums.filter((datum) => data.includes(datum));
  }
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
  let detailRangeLabel = "Select two points";
  if (selectedDatums.length === 2) {
    const first = selectedDatums[0];
    const second = selectedDatums[1];
    const start = first.date <= second.date ? first.date : second.date;
    const end = first.date <= second.date ? second.date : first.date;
    const msPerDay = 24 * 60 * 60 * 1000;
    const days = (end - start) / msPerDay;
    detailRangeLabel = `${formatDate(start)} - ${formatDate(end)} (${days.toFixed(
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
    .text("Greeks P&L");
  chartState.detailSubtitleText
    .attr("x", detailWidth / 2)
    .attr("y", 54)
    .text(detailRangeLabel);
  chartState.detailMetricText.attr("x", detailWidth / 2).attr("y", 72);

  const legendLineLength = 18;
  const legendLabelOffset = 6;
  const legendRowGap = 20;
  const legendColGap = 130;
  const legendCols = 3;
  const detailLegendX = margin.left;
  const detailLegendY = 92;
  chartState.detailLegendGroup.attr(
    "transform",
    `translate(${detailLegendX},${detailLegendY})`,
  );

  const validDates = [];
  const validIndex = [];
  const ivValues = [];
  for (const d of data) {
    if (d.date instanceof Date) validDates.push(d.date);
    if (Number.isFinite(d.index_price_close)) validIndex.push(d.index_price_close);
    if (Number.isFinite(d.iv_close)) ivValues.push(d.iv_close);
  }
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validIndex);
  const [extentMin, extentMax] = d3.extent(ivValues);

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
  const colorForVol = (value) => {
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
  const formatVolPct = (value) =>
    Number.isFinite(value) ? formatVol(value) : "n/a";

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
    .tickFormat(formatIndex);

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

  const renderDetailWindow = (selection) => {
    if (!selection || selection.length !== 2) {
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
      return;
    }

    const startIndex = data.indexOf(selection[0]);
    const endIndex = data.indexOf(selection[1]);
    if (startIndex < 0 || endIndex < 0) return;
    const fromIndex = Math.min(startIndex, endIndex);
    const toIndex = Math.max(startIndex, endIndex);
    const window = data.slice(fromIndex, toIndex + 1);
    const windowStart = window[0]?.date;
    const windowEnd = window[window.length - 1]?.date;

    const pnlWindow = props.optionPnlData
      .filter(
        (point) =>
          point.date instanceof Date &&
          windowStart instanceof Date &&
          windowEnd instanceof Date &&
          point.date >= windowStart &&
          point.date <= windowEnd,
      )
      .sort((a, b) => a.date - b.date);

    if (!pnlWindow.length) {
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
      chartState.detailMessageText
        .attr("x", detailInnerWidth / 2)
        .attr("y", innerHeight / 2)
        .attr("display", null)
        .text(
          props.optionInstrumentName
            ? "No option P&L data for this range."
            : "Select an option instrument to see Greeks P&L.",
        );
      return;
    }

    const cumulative = {
      total: 0,
      delta: 0,
      gammaTheta: 0,
      vega: 0,
      residual: 0,
    };
    const seriesByKey = {
      total: [],
      delta: [],
      gammaTheta: [],
      vega: [],
      residual: [],
    };

    pnlWindow.forEach((point, index) => {
      const date = point.date;

      // The first point marks the start of our range (t=0).
      // We set it to zero and skip its P&L values, because point.PL
      // represents the interval *ending* at this timestamp (before our window).
      if (index === 0) {
        seriesByKey.total.push({ date, value: 0 });
        seriesByKey.delta.push({ date, value: 0 });
        seriesByKey.gammaTheta.push({ date, value: 0 });
        seriesByKey.vega.push({ date, value: 0 });
        seriesByKey.residual.push({ date, value: 0 });
        return;
      }

      // Accumulate P&L for all points after the first
      const deltaPL = Number.isFinite(point.delta_PL) ? point.delta_PL : 0;
      const gammaThetaPL = Number.isFinite(point.gamma_theta_PL)
        ? point.gamma_theta_PL
        : 0;
      const vegaPL = Number.isFinite(point.vega_PL) ? point.vega_PL : 0;
      const residualPL = Number.isFinite(point.residual_PL)
        ? point.residual_PL
        : 0;
      const totalPL = Number.isFinite(point.PL)
        ? point.PL
        : deltaPL + gammaThetaPL + vegaPL + residualPL;

      cumulative.delta += deltaPL;
      cumulative.gammaTheta += gammaThetaPL;
      cumulative.vega += vegaPL;
      cumulative.residual += residualPL;
      cumulative.total += totalPL;

      seriesByKey.total.push({ date, value: cumulative.total });
      seriesByKey.delta.push({ date, value: cumulative.delta });
      seriesByKey.gammaTheta.push({ date, value: cumulative.gammaTheta });
      seriesByKey.vega.push({ date, value: cumulative.vega });
      seriesByKey.residual.push({ date, value: cumulative.residual });
    });

    const seriesList = DETAIL_SERIES_CONFIG.map((series) => ({
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
    const totalConfig =
      DETAIL_SERIES_CONFIG.find((series) => series.key === "total") ||
      DETAIL_SERIES_CONFIG[0];
    const totalSeries = seriesByKey.total;
    const totalHidden = isHiddenSeries("total");
    if (totalSeries.length && chartState.detailAreaPath && !totalHidden) {
      const zeroY = detailY(0);
      const area = d3
        .area()
        .x((d) => detailX(d.date))
        .y0(zeroY)
        .y1((d) => detailY(d.value))
        .curve(d3.curveMonotoneX);
      chartState.detailAreaPath
        .attr("d", area(totalSeries))
        .attr("fill", totalConfig.color)
        .attr("fill-opacity", 0.18)
        .attr("display", null);
    } else {
      chartState.detailAreaPath?.attr("display", "none");
    }

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

    const totalLabel = Number.isFinite(cumulative.total)
      ? formatPnl(cumulative.total)
      : "n/a";
    chartState.detailMetricText
      .text(`Total P&L: ${totalLabel}`)
      .attr("display", null);
  };

  const mainPoints = chartState.pointsGroup
    .selectAll("circle.main-point")
    .data(data, (d) => (d.date ? d.date.getTime() : d.index_price_close));

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
    .attr("fill", (d) => colorForVol(d.iv_close))
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
      hideTooltip();
    })
    .on("click", (event, datum) => {
      event.stopPropagation();
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
      render();
    });

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

  renderDetailWindow(selectedDatums);

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
    .text(formatVolPct(extentMin));
  chartState.legendMaxText
    .attr("x", legendWidth)
    .attr("y", legendLabelY)
    .text(formatVolPct(domainMax));
}

watch(
  () => [
    props.data,
    props.optionPnlData,
    props.optionInstrumentName,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap" @click="handleChartClick">
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
