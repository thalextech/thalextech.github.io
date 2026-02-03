<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";
import {
  getDatumTs,
  syncSelectionWithData as syncSelectionWithDataUtil,
  updateSelectedRange as computeSelectedRange,
} from "../../../../lib/chartUtils.js";

const VOL_WINDOW = 20;

const props = defineProps({
  indexData: { type: Array, default: () => [] },
  resolution: { type: String, default: "1d" },
  previewPoints: { type: Number, default: 120 },
  backtest: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(["range-selected"]);

const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `vol-gradient-${Math.random().toString(16).slice(2)}`;
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
const LAYOUT_TRANSITION_MS = 260;

const POINT_RADIUS = 4;
const POINT_RADIUS_DIMMED = 2.8;
const POINT_RADIUS_HOVER = 10;
let hoveredDatum = null;
let selectedDatums = [];
let selectedRange = null;
let detailActive = false;
let lineRevealTimer = null;
let lineRevealPending = false;

const TEXT_STYLES = {
  axisText: { fill: "#d6d7de" },
  axisLabel: { fill: "#d6d7de", size: "12px", weight: 700 },
  mainTitle: { fill: "#fff", size: "18px", weight: 650 },
  mainSubtitle: { fill: "#c9c9cf", size: "13px" },
  detailTitle: { fill: "#fff", size: "14px", weight: 600 },
  detailSubtitle: { fill: "#a9abb6", size: "12px" },
  detailLegend: { fill: "#a9abb6", size: "11px", weight: 500 },
  legendTitle: { fill: "#d6d7de", size: "12px" },
  legendLabel: { fill: "#a9abb6", size: "11px" },
  noData: { fill: "#c9c9cf", size: "14px" },
  detailMessage: { fill: "#c9c9cf", size: "12px" },
};

const chartState = {
  background: null,
  gradient: null,
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
  detailYAxisRight: null,
  detailTitleText: null,
  detailSubtitleText: null,
  detailSeriesGroup: null,
  detailLegendGroup: null,
  detailMessageText: null,
  currentXScale: null,
  currentYScale: null,
  noDataText: null,
};

function computeRealisedVolSeries(raw, resolution) {
  const rows = raw
    .filter((r) => Number.isFinite(r?.ts) && Number.isFinite(r?.index_price_close))
    .map((r) => ({
      ts: r.ts,
      date: r.date instanceof Date ? r.date : new Date(r.ts * 1000),
      index_price_close: r.index_price_close,
    }));
  if (rows.length < 2) return rows.map((r) => ({ ...r, realised_vol: null }));

  const resSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 }[resolution] || 86400;
  const periodsPerYear = (365 * 24 * 60 * 60) / resSeconds;
  const annualize = Math.sqrt(periodsPerYear);

  const returns = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].index_price_close;
    const curr = rows[i].index_price_close;
    if (prev > 0 && curr > 0) returns.push({ i, logReturn: Math.log(curr / prev) });
  }

  const result = rows.map((r, idx) => ({ ...r, realised_vol: null }));
  for (let j = VOL_WINDOW - 1; j < returns.length; j++) {
    const start = returns[j - VOL_WINDOW + 1].i;
    const end = returns[j].i;
    const windowReturns = returns.slice(j - VOL_WINDOW + 1, j + 1).map((x) => x.logReturn);
    const mean = windowReturns.reduce((s, r) => s + r, 0) / windowReturns.length;
    const variance = windowReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / windowReturns.length;
    const vol = Math.sqrt(variance) * annualize * 100;
    if (Number.isFinite(vol)) result[end].realised_vol = vol;
  }
  return result;
}

const fullSeriesWithVol = computed(() =>
  computeRealisedVolSeries(props.indexData || [], props.resolution || "1d")
);

const mainSeries = computed(() => {
  const full = fullSeriesWithVol.value;
  if (!full.length) return full;
  const n = Math.max(1, props.previewPoints || 120);
  return full.length <= n ? full : full.slice(-n);
});

const updateSelectedRangeLocal = () => {
  selectedRange = computeSelectedRange(selectedDatums, getDatumTs);
  if (selectedRange && selectedDatums.length === 2) {
    const [a, b] = selectedDatums;
    const from = Math.min(getDatumTs(a), getDatumTs(b));
    const to = Math.max(getDatumTs(a), getDatumTs(b));
    emit("range-selected", { from, to });
  }
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
  const target = event?.target;
  const isPoint = target?.closest?.("circle.main-point");
  if (isPoint) return;
  if (selectedDatums.length) {
    selectedDatums = [];
    selectedRange = null;
    emit("range-selected", null);
    render();
    resetHoverStyles();
    hideTooltip();
  }
};

const applySelectionStyles = () => {
  if (!chartState.pointsGroup) return;
  chartState.pointsGroup
    .selectAll("circle.main-point")
    .attr("stroke", (d) => (selectedDatums.includes(d) ? "#000" : "transparent"))
    .attr("stroke-width", (d) => (selectedDatums.includes(d) ? 2.6 : 0))
    .attr("r", (d) => {
      if (selectedDatums.includes(d)) return POINT_RADIUS_HOVER;
      if (selectedDatums.length === 2) return POINT_RADIUS_DIMMED;
      return POINT_RADIUS;
    })
    .attr("opacity", (d) =>
      selectedDatums.length > 0 && !selectedDatums.includes(d) ? 0.4 : 0.8
    );
  chartState.pointsGroup
    .selectAll("circle.main-point")
    .filter((d) => selectedDatums.includes(d))
    .raise();
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
    .attr("opacity", 0.9)
    .attr("r", POINT_RADIUS);
  applySelectionStyles();
};

const formatVolPct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "n/a");

const showTooltip = (event, datum) => {
  const tooltip = tooltipRef.value;
  const wrapper = svgRef.value?.closest(".chartWrap");
  if (!tooltip || !wrapper) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const x = event.clientX - wrapperRect.left;
  const y = event.clientY - wrapperRect.top;
  const formatDate = d3.utcFormat("%d %b %y %H:%M");
  const formatPrice = d3.format(",.2f");
  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date)}</div>
    <div>Index: ${formatPrice(datum.index_price_close)}</div>
    <div>Realised vol: ${formatVolPct(datum.realised_vol)}</div>
  `;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.style.opacity = "1";
  const tooltipRect = tooltip.getBoundingClientRect();
  const centeredLeft = x - tooltipRect.width / 2;
  const clampedLeft = Math.max(
    8,
    Math.min(wrapperRect.width - tooltipRect.width - 8, centeredLeft)
  );
  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${Math.max(8, y - tooltipRect.height - 12)}px`;
};

const hideTooltip = () => {
  if (tooltipRef.value) tooltipRef.value.style.opacity = "0";
};

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatIndex = d3.format(",.2f");
const formatPnl = d3.format("$,.0f");

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

function ensureChartElements() {
  const svgEl = svgRef.value;
  if (!svgEl) return null;
  const svg = d3.select(svgEl);

  const appendText = (parent, text) => {
    const node = parent.append("text").attr("fill", "#e8e8ea");
    if (text != null) node.text(text);
    node.style("font-family", SVG_FONT_FAMILY);
    return node;
  };

  if (!chartState.background) {
    chartState.background = svg.append("rect").attr("fill", "#000");
  }
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
  if (!chartState.legendGroup) {
    chartState.legendGroup = svg.append("g");
    chartState.legendTitle = chartState.legendGroup
      .append("text")
      .call((n) => applyTextStyle(n, "legendTitle"))
      .text("Realised volatility");
    chartState.legendRect = chartState.legendGroup
      .append("rect")
      .attr("stroke", "#2e3040");
    chartState.legendMinText = chartState.legendGroup
      .append("text")
      .call((n) => applyTextStyle(n, "legendLabel"));
    chartState.legendMaxText = chartState.legendGroup
      .append("text")
      .call((n) => applyTextStyle(n, "legendLabel"))
      .attr("text-anchor", "end");
  }
  if (!chartState.mainTitleText) {
    chartState.mainTitleText = appendText(svg).attr("text-anchor", "middle");
    applyTextStyle(chartState.mainTitleText, "mainTitle");
  }
  if (!chartState.mainSubtitleText) {
    chartState.mainSubtitleText = appendText(svg).attr("text-anchor", "middle");
    applyTextStyle(chartState.mainSubtitleText, "mainSubtitle");
  }
  if (!chartState.noDataText) {
    chartState.noDataText = appendText(svg).attr("text-anchor", "middle");
    applyTextStyle(chartState.noDataText, "noData");
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
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.selectionLabel = chartState.mainGroup
      .append("text")
      .attr("text-anchor", "middle")
      .attr("fill", "#e8e8ea")
      .style("font-size", "11px")
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.pointsGroup = chartState.mainGroup.append("g");
    chartState.mainXAxisLabel = chartState.mainGroup
      .append("text")
      .attr("text-anchor", "middle")
      .text("Date (UTC)");
    applyTextStyle(chartState.mainXAxisLabel, "axisLabel");
    chartState.mainYAxisLabel = chartState.mainGroup
      .append("text")
      .attr("text-anchor", "middle")
      .text("Index Price");
    applyTextStyle(chartState.mainYAxisLabel, "axisLabel");
  }
  if (!chartState.detailGroup) {
    chartState.detailGroup = svg.append("g").style("opacity", 0);
    chartState.detailTitleText = appendText(chartState.detailGroup).attr("text-anchor", "middle");
    applyTextStyle(chartState.detailTitleText, "detailTitle");
    chartState.detailSubtitleText = appendText(chartState.detailGroup).attr("text-anchor", "middle");
    applyTextStyle(chartState.detailSubtitleText, "detailSubtitle");
    chartState.detailLegendGroup = chartState.detailGroup.append("g");
    chartState.detailLayer = chartState.detailGroup.append("g");
    chartState.detailXAxisGroup = chartState.detailLayer.append("g");
    chartState.detailYAxisGroup = chartState.detailLayer.append("g");
    chartState.detailYAxisRight = chartState.detailLayer.append("g");
    chartState.detailSeriesGroup = chartState.detailLayer.append("g");
    chartState.detailMessageText = appendText(chartState.detailLayer).attr("text-anchor", "middle");
    applyTextStyle(chartState.detailMessageText, "detailMessage");
  }
  return svg;
}

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const data = mainSeries.value;
  const svg = ensureChartElements();
  if (!svg) return;

  const { height, margin } = layout;
  const fullWidth =
    layout.mainWidth + layout.panelGap + layout.detailWidth;
  syncSelectionWithData(data);
  if (hoveredDatum && !data.includes(hoveredDatum)) hoveredDatum = null;

  const isDetailActive = selectedDatums.length === 2;
  const animateLayout = isDetailActive !== detailActive;
  detailActive = isDetailActive;

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
  const withLayoutTransition = (sel) =>
    animateLayout
      ? sel.interrupt().transition().duration(LAYOUT_TRANSITION_MS)
      : sel.interrupt();

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
    .text("Index price — click two points to select backtest range");
  chartState.mainSubtitleText
    .call(withLayoutTransition)
    .attr("x", mainWidth / 2)
    .attr("y", 54)
    .text(
      data.length
        ? `${formatDate(data[0].date)} - ${formatDate(data[data.length - 1].date)}`
        : ""
    );

  const detailOffsetX = mainWidth + panelGap;
  const detailInnerWidth = detailWidth - margin.left - margin.right;
  let detailRangeLabel = "Select two points on the chart";
  if (selectedDatums.length === 2) {
    const [first, second] = selectedDatums;
    const start =
      first.date <= second.date ? first.date : second.date;
    const end = first.date <= second.date ? second.date : first.date;
    const days = (end - start) / (24 * 60 * 60 * 1000);
    detailRangeLabel = `${formatDate(start)} - ${formatDate(end)} (${days.toFixed(1)} days)`;
  }
  chartState.detailGroup
    .call(withLayoutTransition)
    .attr("transform", `translate(${detailOffsetX},0)`)
    .style("opacity", isDetailActive ? 1 : 0);
  chartState.detailLayer.attr(
    "transform",
    `translate(${margin.left},${margin.top})`
  );
  chartState.detailTitleText
    .attr("x", detailWidth / 2)
    .attr("y", 30)
    .text("Backtest P&L");
  chartState.detailSubtitleText
    .attr("x", detailWidth / 2)
    .attr("y", 54)
    .text(detailRangeLabel);

  if (!data.length) {
    chartState.noDataText
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("visibility", props.loading ? "hidden" : "visible")
      .text("No index data. Load a range first.");
    chartState.mainGroup.attr("display", "none");
    chartState.legendGroup.attr("display", "none");
    chartState.detailGroup.attr("display", "none");
    hideTooltip();
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.mainGroup.attr("display", null).attr(
    "transform",
    `translate(${margin.left},${margin.top})`
  );
  chartState.detailGroup.attr("display", null);
  chartState.legendGroup.attr("display", null);

  const xDomain = d3.extent(data, (d) => d.date);
  const yDomain = d3.extent(data, (d) => d.index_price_close);
  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain(yDomain)
    .nice()
    .range([innerHeight, MAIN_TOP_INSET]);
  chartState.currentXScale = x;
  chartState.currentYScale = y;

  const xAxis = d3.axisBottom(x).ticks(8).tickSize(0).tickPadding(10);
  const yAxis = d3
    .axisLeft(y)
    .ticks(6)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(formatIndex);

  chartState.xAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis);
  axisStyle(chartState.xAxisGroup);
  chartState.yAxisGroup.call(yAxis);
  axisStyle(chartState.yAxisGroup);
  chartState.mainXAxisLabel
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42);
  chartState.mainYAxisLabel
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52);

  const volValues = data.map((d) => d.realised_vol).filter((v) => Number.isFinite(v));
  const [extentMin, extentMax] = d3.extent(volValues);
  const hasValidExtent = Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent ? Math.max(extentMin, 0) : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";
  const colorForVol = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) return fallbackColor;
    if (!hasSpread) return d3.interpolateRdBu(0.5);
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    const ramp = 0.12 + 0.88 * clamped;
    return d3.interpolateRdBu(1 - ramp);
  };

  const gradientStops = hasValidExtent
    ? [
        { offset: "0%", value: domainMin },
        { offset: "50%", value: domainMin + domainSpan / 2 },
        { offset: "100%", value: domainMax },
      ]
    : [{ offset: "0%", value: 0 }, { offset: "100%", value: 0 }];
  chartState.gradient
    .selectAll("stop")
    .data(gradientStops)
    .join((enter) => enter.append("stop"))
    .attr("offset", (d) => d.offset)
    .attr("stop-color", (d) => (Number.isFinite(d.value) ? colorForVol(d.value) : fallbackColor));

  const legendWidth = 180;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
  const legendY = margin.top - 5;
  chartState.legendGroup
    .attr("display", data.length ? null : "none")
    .attr("transform", `translate(${legendX},${legendY})`);
  chartState.legendTitle?.attr("x", 0).attr("y", 0);
  chartState.legendRect
    .attr("x", 0)
    .attr("y", 14)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`);
  chartState.legendMinText?.attr("x", 0).attr("y", 14 + legendHeight + 14).text(formatVolPct(domainMin));
  chartState.legendMaxText?.attr("x", legendWidth).attr("y", 14 + legendHeight + 14).text(formatVolPct(domainMax));

  updateSelectionLine();

  const mainPoints = chartState.pointsGroup
    .selectAll("circle.main-point")
    .data(data, (d) => (d.date ? d.date.getTime() : d.ts));

  mainPoints
    .join((enter) =>
      enter
        .append("circle")
        .attr("class", "main-point")
        .attr("r", POINT_RADIUS)
        .attr("stroke", "transparent")
        .attr("stroke-width", 0)
        .attr("fill", fallbackColor)
        .attr("opacity", 0.9)
    )
    .attr("fill", (d) => colorForVol(d.realised_vol))
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.index_price_close))
    .on("mouseenter", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      applySelectionStyles();
      d3.select(event.currentTarget)
        .attr("r", POINT_RADIUS_HOVER)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.1)
        .raise();
      showTooltip(event, datum);
    })
    .on("mousemove", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      showTooltip(event, datum);
    })
    .on("mouseleave", () => {
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
        const distToFirst = Math.abs(datum.date - first.date);
        const distToSecond = Math.abs(datum.date - second.date);
        const keep = distToFirst <= distToSecond ? second : first;
        selectedDatums = [keep, datum];
      }
      updateSelectedRangeLocal();
      render();
    });

  applySelectionStyles();

  const pnlSeries = props.backtest?.series || [];
  const hasPnl = isDetailActive && pnlSeries.length > 0;

  if (!hasPnl) {
    chartState.detailSeriesGroup?.selectAll("path").attr("display", "none");
    chartState.detailXAxisGroup?.attr("display", "none");
    chartState.detailYAxisGroup?.attr("display", "none");
    chartState.detailYAxisRight?.attr("display", "none");
    chartState.detailLegendGroup?.attr("display", "none");
    if (chartState.detailMessageText) {
      chartState.detailMessageText
        .attr("x", detailInnerWidth / 2)
        .attr("y", innerHeight / 2)
        .attr("display", null)
        .text(
          isDetailActive
            ? "Run backtest to see P&L (range is set)"
            : "Select two points on the chart"
        );
    }
  } else {
    chartState.detailMessageText?.attr("display", "none");
    const pnlData = pnlSeries.map((d) => {
      const opt = d.cumulativeOptionPnl ?? d.cumulativePnl ?? null;
      const tot = d.cumulativeTotalPnl;
      const hed = d.cumulativeHedgePnl;
      return {
        date: d.date instanceof Date ? d.date : new Date(d.ts * 1000),
        optionPnl: opt != null && Number.isFinite(opt) ? opt : null,
        totalPnl: tot != null && Number.isFinite(tot) ? tot : null,
        hedgePnl: hed != null && Number.isFinite(hed) ? hed : null,
      };
    });
    const xPnl = d3.scaleUtc().domain(d3.extent(pnlData, (d) => d.date)).range([0, detailInnerWidth]);
    const allPnl = [
      ...pnlData.map((d) => d.optionPnl).filter((v) => v != null && Number.isFinite(v)),
      ...pnlData.map((d) => d.totalPnl).filter((v) => v != null && Number.isFinite(v)),
      ...pnlData.map((d) => d.hedgePnl).filter((v) => v != null && Number.isFinite(v)),
    ];
    const [pnlMin, pnlMax] = d3.extent(allPnl);
    const hasPnlRange = pnlMin != null && pnlMax != null && Number.isFinite(pnlMin) && Number.isFinite(pnlMax);
    const pnlPad = hasPnlRange ? Math.max(1, (pnlMax - pnlMin) * 0.1) : 1;
    const yPnl = d3
      .scaleLinear()
      .domain(
        hasPnlRange
          ? [pnlMin - pnlPad, pnlMax + pnlPad]
          : [0, 1]
      )
      .range([innerHeight, MAIN_TOP_INSET]);

    const lineOpt = d3
      .line()
      .x((d) => xPnl(d.date))
      .y((d) => yPnl(d.optionPnl))
      .defined((d) => d.optionPnl != null && Number.isFinite(d.optionPnl));
    const lineTotal = d3
      .line()
      .x((d) => xPnl(d.date))
      .y((d) => yPnl(d.totalPnl))
      .defined((d) => d.totalPnl != null && Number.isFinite(d.totalPnl));
    const lineHedge = d3
      .line()
      .x((d) => xPnl(d.date))
      .y((d) => yPnl(d.hedgePnl))
      .defined((d) => d.hedgePnl != null && Number.isFinite(d.hedgePnl));

    chartState.detailSeriesGroup.selectAll("path").remove();
    chartState.detailSeriesGroup
      .append("path")
      .attr("fill", "none")
      .attr("stroke", "var(--accent, #7aa2ff)")
      .attr("stroke-width", 2)
      .attr("d", lineOpt(pnlData));
    chartState.detailSeriesGroup
      .append("path")
      .attr("fill", "none")
      .attr("stroke", "#5cb85c")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "4,3")
      .attr("d", lineTotal(pnlData));
    chartState.detailSeriesGroup
      .append("path")
      .attr("fill", "none")
      .attr("stroke", "#e6a23c")
      .attr("stroke-width", 2)
      .attr("d", lineHedge(pnlData));

    const detailXAxis = d3.axisBottom(xPnl).ticks(4).tickSize(0).tickPadding(10);
    const detailYAxis = d3
      .axisLeft(yPnl)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat(formatPnl);
    chartState.detailXAxisGroup
      .attr("transform", `translate(0,${innerHeight})`)
      .call(detailXAxis)
      .attr("display", null);
    axisStyle(chartState.detailXAxisGroup);
    chartState.detailYAxisGroup.call(detailYAxis).attr("display", null);
    axisStyle(chartState.detailYAxisGroup);
    chartState.detailYAxisRight?.attr("display", "none");

    const legendConfig = [
      { label: "Option PnL", color: "var(--accent, #7aa2ff)" },
      { label: "Cum. total PnL", color: "#5cb85c" },
      { label: "Delta hedge PnL", color: "#e6a23c" },
    ];
    const legendItems = chartState.detailLegendGroup
      .selectAll("g.legend-item")
      .data(legendConfig)
      .join((enter) => {
        const g = enter.append("g").attr("class", "legend-item");
        g.append("line").attr("stroke-linecap", "round");
        g.append("text").attr("fill", "#a9abb6").style("font-size", "11px");
        return g;
      });
    legendItems.attr("transform", (d, i) => `translate(0,${70 + i * 18})`);
    legendItems
      .select("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", 18)
      .attr("y2", 0)
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", 2);
    legendItems
      .select("text")
      .attr("x", 22)
      .attr("y", 4)
      .text((d) => d.label);
    chartState.detailLegendGroup.attr("display", null);
  }
}

watch(
  () => [props.indexData, props.backtest, props.loading],
  () => render(),
  { deep: true }
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap" @click="handleChartClick">
    <svg ref="svgRef" />
    <div ref="tooltipRef" class="tooltip" />
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
}

.tooltip {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid #222532;
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
