<script setup>
import * as d3 from "d3";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  exportChartRegionToPng,
  exportTitledChart,
} from "../lib/exportTitledChart.js";
import {
  calendarWeekKey,
  orderSweepDistributionRows,
} from "../lib/sweepDistribution.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  dimension: { type: String, default: "entry_hour" },
  dimensionLabel: { type: String, default: "Sweep setting" },
});

const emit = defineEmits(["select"]);
const chartRef = ref(null);
const panelRegions = ref([]);
const distributionControlsTop = ref(0);
const distributionView = ref("ranked");
const distributionSort = ref("median");
const distributionSortOpen = ref(false);
const selectedWeekKey = ref("");
let resizeObserver;

const DISTRIBUTION_SORT_OPTIONS = [
  { value: "total", label: "Total P&L" },
  { value: "sharpe", label: "Sharpe" },
  { value: "median", label: "Median P&L" },
  { value: "average_dte", label: "Avg DTE" },
  { value: "average_iv", label: "Avg IV" },
];

const distributionSequenceLabel = computed(() => {
  if (props.dimension === "entry_hour") return "Clock";
  if (props.dimension === "entry_weekday") return "Weekday";
  return "Sequence";
});
const distributionSortLabel = computed(() =>
  DISTRIBUTION_SORT_OPTIONS.find((option) => option.value === distributionSort.value)?.label
  || "Median P&L"
);

const selectDistributionSort = (value) => {
  distributionSort.value = value;
  distributionSortOpen.value = false;
};

const handleSortFocusout = (event) => {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    distributionSortOpen.value = false;
  }
};

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const UI_AXIS_LABEL_COLOR = "rgba(255,255,255,0.46)";
const formatUsd = d3.format("$,.0f");
const formatSharpe = d3.format(".2f");
const formatIv = d3.format(".1%");
const formatDte = (value) => `${d3.format(".1f")(value)}d`;

const rectanglesOverlap = (first, second, padding = 0) => !(
  first.right + padding <= second.left
  || first.left >= second.right + padding
  || first.bottom + padding <= second.top
  || first.top >= second.bottom + padding
);

const pointToSegmentDistance = (point, start, end) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
  ));
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy),
  );
};

const layoutScatterLabels = ({ rows, x, y, bounds }) => {
  const points = rows.map((row, index) => ({
    row,
    index,
    x: x(row.weeklySigma),
    y: y(row.weeklyMean),
    width: Math.max(22, String(row.label).length * 5.1),
    height: 11,
  }));
  const dotBoxes = points.map((point) => ({
    left: point.x - 6,
    right: point.x + 6,
    top: point.y - 6,
    bottom: point.y + 6,
  }));
  const orderedPoints = [...points].sort((first, second) => {
    const density = (point) => d3.sum(points, (other) => {
      if (other === point) return 0;
      const distance = Math.hypot(point.x - other.x, point.y - other.y);
      return distance < 60 ? 60 - distance : 0;
    });
    return density(second) - density(first) || first.index - second.index;
  });
  const placed = [];
  const placements = new Map();

  orderedPoints.forEach((point) => {
    const preferred = {
      x: point.x + point.width / 2 + 8,
      y: point.y - 7,
    };
    const candidateCenters = [
      preferred,
      { x: point.x + point.width / 2 + 8, y: point.y + 7 },
      { x: point.x - point.width / 2 - 8, y: point.y - 7 },
      { x: point.x - point.width / 2 - 8, y: point.y + 7 },
      { x: point.x, y: point.y - point.height / 2 - 8 },
      { x: point.x, y: point.y + point.height / 2 + 8 },
    ];
    for (let dy = -104; dy <= 104; dy += 13) {
      for (let dx = -120; dx <= 120; dx += 12) {
        candidateCenters.push({ x: point.x + dx, y: point.y + dy });
      }
    }

    let best = null;
    candidateCenters.forEach((center, candidateIndex) => {
      const box = {
        left: center.x - point.width / 2,
        right: center.x + point.width / 2,
        top: center.y - point.height / 2,
        bottom: center.y + point.height / 2,
      };
      if (
        box.left < bounds.left
        || box.right > bounds.right
        || box.top < bounds.top
        || box.bottom > bounds.bottom
      ) return;

      const labelCollisions = placed.filter((placement) =>
        rectanglesOverlap(box, placement.box, 2),
      ).length;
      const dotCollisions = dotBoxes.filter((dotBox) =>
        rectanglesOverlap(box, dotBox, 1),
      ).length;
      const edge = {
        x: Math.max(box.left, Math.min(point.x, box.right)),
        y: Math.max(box.top, Math.min(point.y, box.bottom)),
      };
      const crossedDots = points.filter((other) =>
        other !== point
        && pointToSegmentDistance(other, point, edge) < 6,
      ).length;
      const anchorDistance = Math.hypot(edge.x - point.x, edge.y - point.y);
      const preferredDistance = Math.hypot(center.x - preferred.x, center.y - preferred.y);
      const score = labelCollisions * 1_000_000
        + dotCollisions * 100_000
        + crossedDots * 5_000
        + anchorDistance
        + preferredDistance * 0.02
        + candidateIndex * 0.0001;
      if (!best || score < best.score) best = { box, center, edge, score };
    });

    if (!best) return;
    const edgeDistance = Math.hypot(best.edge.x - point.x, best.edge.y - point.y);
    const leaderLength = Math.max(0, edgeDistance - 4.5);
    const leader = leaderLength > 4
      ? {
          x1: point.x + (best.edge.x - point.x) * 4.5 / edgeDistance,
          y1: point.y + (best.edge.y - point.y) * 4.5 / edgeDistance,
          x2: best.edge.x,
          y2: best.edge.y,
        }
      : null;
    const placement = { ...best, leader };
    placed.push(placement);
    placements.set(point.row.key, placement);
  });

  return placements;
};

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";
  panelRegions.value = [];

  const rows = props.rows || [];
  if (!rows.length) return;

  const bounds = element.getBoundingClientRect();
  const availableWidth = Math.max(1080, bounds.width || 1100);
  const margin = { right: 24, left: 64 };
  const contentWidth = availableWidth - margin.left - margin.right;
  const mapHeaderY = 15;
  const mapPlotTop = mapHeaderY + 34;
  const mapPlotHeight = 410;
  const mapPlotBottom = mapPlotTop + mapPlotHeight;
  const mapBottom = mapPlotBottom + 42;
  const rankedHeaderY = mapBottom + 42;
  const rankedColumnsY = rankedHeaderY + 28;
  const rankedRowsY = rankedColumnsY + 18;
  const rankedRowHeight = 25;
  const rankedBottom = rankedRowsY + rows.length * rankedRowHeight;
  const realizedHeaderY = rankedBottom + 50;
  const realizedPlotTop = realizedHeaderY + 34;
  const realizedPlotHeight = 350;
  const realizedPlotBottom = realizedPlotTop + realizedPlotHeight;
  const realizedAxisY = realizedPlotBottom + 8;
  const realizedBottom = realizedAxisY + 28;
  const distributionHeaderY = realizedBottom + 62;
  const distributionAxisY = distributionHeaderY + 43;
  const distributionRowsY = distributionAxisY + 16;
  const distributionRowHeight = 31;
  const distributionBottom = distributionRowsY + rows.length * distributionRowHeight;
  distributionControlsTop.value = distributionHeaderY - 20;
  const width = Math.max(availableWidth, margin.left + contentWidth + margin.right);
  const height = distributionBottom + 36;
  const panelSeparatorInset = 2;
  const rankedSeparatorY = rankedHeaderY - 24;
  const realizedSeparatorY = realizedHeaderY - 24;
  const distributionSeparatorY = distributionHeaderY - 36;
  panelRegions.value = [
    {
      key: "comparison",
      label: "Comparison",
      buttonTop: 6,
      region: {
        x: 0,
        y: 0,
        width,
        height: rankedSeparatorY - panelSeparatorInset,
      },
    },
    {
      key: "ranked-sweep",
      label: "Ranked sweep",
      buttonTop: rankedHeaderY - 17,
      region: {
        x: 0,
        y: rankedSeparatorY + panelSeparatorInset,
        width,
        height: realizedSeparatorY - rankedSeparatorY - panelSeparatorInset * 2,
      },
    },
    {
      key: "realized-vol",
      label: "Realized volatility",
      buttonTop: realizedHeaderY - 17,
      region: {
        x: 0,
        y: realizedSeparatorY + panelSeparatorInset,
        width,
        height: distributionSeparatorY - realizedSeparatorY - panelSeparatorInset * 2,
      },
    },
    {
      key: "weekly-observations",
      label: "Weekly PnL observations",
      buttonTop: distributionHeaderY - 17,
      region: {
        x: 0,
        y: distributionSeparatorY + panelSeparatorInset,
        width,
        height: height - distributionSeparatorY - panelSeparatorInset,
      },
    },
  ];

  const shVals = rows.map((r) => Number(r.sharpe)).filter(Number.isFinite);
  const sharpeMin = d3.min(shVals) ?? 0;
  const sharpeMax = d3.max(shVals) ?? 1;
  const sharpeMid = d3.median(shVals) ?? (sharpeMin + sharpeMax) / 2;
  const readableBlue = (t) => d3.interpolateBlues(0.38 + t * 0.3);
  const sharpeTextColor = sharpeMin === sharpeMax
    ? () => readableBlue(0.5)
    : d3.scaleSequential(readableBlue).domain([sharpeMin, sharpeMax]).clamp(true);
  const performanceColor = sharpeMin === sharpeMax
    ? () => d3.interpolateRdBu(0.5)
    : d3.scaleDiverging(d3.interpolateRdBu)
        .domain([sharpeMin, sharpeMid, sharpeMax])
        .clamp(true);

  const svg = d3.select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr("aria-label", "Sweep comparison, ranked sweep analysis, realized volatility, and observed weekly returns");

  const sum = (values) => d3.sum(values);
  const analyzedRows = rows.map((row) => {
    const weeklyPoints = (row.weeklyReturns || [])
      .map((point, sourceIndex) => ({
        value: Number(point.pnl),
        entryDate: point.entryDate,
        sourceIndex,
        weekKey: calendarWeekKey(point.entryDate, `week-${sourceIndex}`),
      }))
      .filter((point) => Number.isFinite(point.value));
    const weeks = weeklyPoints.map((point) => point.value);
    const total = Number.isFinite(Number(row.pnl)) ? Number(row.pnl) : sum(weeks);
    const bestWeek = d3.max(weeks) ?? 0;
    const bestIndex = weeks.indexOf(bestWeek);
    const sortedWeeks = [...weeks].sort((a, b) => a - b);
    const positive = sum(weeks.filter((value) => value > 0));
    const negative = Math.abs(sum(weeks.filter((value) => value < 0)));
    const maxDrawdown = Math.abs(Number(row.maxDrawdown) || 0);
    const annualizedPnl = weeks.length ? total * 52 / weeks.length : 0;
    const cumulative = [0];
    weeks.forEach((value) => cumulative.push(cumulative[cumulative.length - 1] + value));
    return {
      ...row,
      weeks,
      weeklyPoints,
      total,
      winRate: weeks.length ? weeks.filter((value) => value > 0).length / weeks.length : 0,
      profitFactor: negative ? positive / negative : 0,
      calmar: maxDrawdown ? annualizedPnl / maxDrawdown : Number.NaN,
      cvar: d3.mean(sortedWeeks.slice(0, 3)) ?? 0,
      cumulative,
      bestIndex,
      sortedWeeks,
    };
  });
  const drawdownValues = analyzedRows.map((row) => Number(row.maxDrawdown)).filter(Number.isFinite);
  const drawdownMin = d3.min(drawdownValues) ?? 0;
  const drawdownMax = d3.max(drawdownValues) ?? 0;
  const readableRed = (t) => d3.interpolateReds(0.36 + t * 0.28);
  const drawdownColor = drawdownMin === drawdownMax
    ? () => readableRed(0.5)
    : d3.scaleSequential(readableRed).domain([drawdownMax, drawdownMin]).clamp(true);
  const readableRedBlue = (t) => d3.interpolateRdBu(0.25 + t * 0.5);
  const buildAttributionPnlColor = (key) => {
    const maxAbs = d3.max(
      analyzedRows.map((row) => Math.abs(Number(row[key]))).filter(Number.isFinite),
    ) || 1;
    return d3.scaleDiverging(readableRedBlue).domain([-maxAbs, 0, maxAbs]).clamp(true);
  };
  const optionPnlColor = buildAttributionPnlColor("optionPnl");
  const hedgePnlColor = buildAttributionPnlColor("hedgePnl");
  const rankedRows = [...analyzedRows].sort((a, b) => b.total - a.total);
  const formatCompactUsd = (value) => {
    const numeric = Number(value) || 0;
    const sign = numeric < 0 ? "−" : "";
    const absolute = Math.abs(numeric);
    if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}m`;
    if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}k`;
    return `${sign}$${d3.format(",.0f")(absolute)}`;
  };
  const wrapTooltip = (text, maxCharacters = 58) => {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxCharacters && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line);
    return lines;
  };
  const hideHeaderTooltip = () => svg.selectAll("g.header-tooltip").remove();
  const showHeaderTooltip = (x, y, tooltip, anchor = "start") => {
    hideHeaderTooltip();
    const lines = wrapTooltip(tooltip);
    const tooltipWidth = Math.min(430, Math.max(...lines.map((line) => line.length)) * 5.8 + 18);
    const tooltipHeight = lines.length * 14 + 12;
    const preferredX = anchor === "end" ? x - tooltipWidth : x;
    const tooltipX = Math.max(margin.left, Math.min(preferredX, margin.left + contentWidth - tooltipWidth));
    const tooltipY = y + 8;
    const group = svg.append("g")
      .attr("class", "header-tooltip")
      .attr("transform", `translate(${tooltipX},${tooltipY})`)
      .attr("pointer-events", "none");
    group.append("rect")
      .attr("width", tooltipWidth).attr("height", tooltipHeight).attr("rx", 4)
      .attr("fill", "#17191e").attr("stroke", "rgba(255,255,255,0.18)");
    const text = group.append("text").attr("x", 9).attr("y", 15)
      .attr("fill", "rgba(255,255,255,0.88)").attr("font-size", 11);
    lines.forEach((line, index) => text.append("tspan")
      .attr("x", 9).attr("dy", index === 0 ? 0 : 14).text(line));
  };
  const appendPanelHeading = ({ y, title, subtitle }) => {
    const heading = svg.append("text")
      .attr("x", margin.left).attr("y", y);
    heading.append("tspan")
      .attr("fill", "rgba(255,255,255,0.64)")
      .attr("font-size", 12)
      .attr("font-weight", 500)
      .text(title);
    heading.append("tspan")
      .attr("dx", 10)
      .attr("fill", "rgba(255,255,255,0.36)")
      .attr("font-size", 10)
      .attr("font-weight", 400)
      .text(subtitle);
  };

  const mapPnlValues = analyzedRows.map((row) => row.total);
  const mapPnlMin = d3.min(mapPnlValues) ?? 0;
  const mapPnlMax = d3.max(mapPnlValues) ?? 1;
  const mapPnlMid = d3.median(mapPnlValues) ?? (mapPnlMin + mapPnlMax) / 2;
  const readableMapPnl = (t) => d3.interpolateRdBu(0.12 + t * 0.76);
  const mapPnlColor = mapPnlMin === mapPnlMax
    ? () => readableMapPnl(0.5)
    : d3.scaleDiverging(readableMapPnl)
        .domain([mapPnlMin, mapPnlMid, mapPnlMax])
        .clamp(true);
  const sweepMapRows = analyzedRows.map((row) => ({
    ...row,
    mapColor: mapPnlColor(row.total),
    weeklyMean: d3.mean(row.weeks) ?? 0,
    weeklySigma: d3.deviation(row.weeks) ?? 0,
  }));
  const mapPlotLeft = margin.left + 40;
  const realizedPlotLeft = margin.left + 32;
  const mapPlotRight = margin.left + contentWidth - 48;
  let mapPointGroups = svg.selectAll("g.sweep-map-point");
  let realizedGroups = svg.selectAll("g.realized-vol-setting");

  appendPanelHeading({
    y: mapHeaderY,
    title: "COMPARISON ·",
    subtitle: "SHARPE SCATTER · X = WEEKLY PNL σ · Y = MEAN WEEKLY PNL · COLOR = CUMULATIVE PNL",
  });

  const [minWeeklySigma = 0, maxWeeklySigma = 1] = d3.extent(
    sweepMapRows,
    (row) => row.weeklySigma,
  );
  const weeklySigmaSpan = maxWeeklySigma - minWeeklySigma;
  const weeklySigmaPadding = weeklySigmaSpan > 0
    ? weeklySigmaSpan * 0.08
    : Math.max(Math.abs(maxWeeklySigma) * 0.05, 1);
  const meanExtent = d3.extent(sweepMapRows, (row) => row.weeklyMean);
  let mapMeanMin = Math.min(0, meanExtent[0] ?? 0);
  let mapMeanMax = Math.max(0, meanExtent[1] ?? 0);
  if (mapMeanMin === mapMeanMax) {
    mapMeanMin = -1;
    mapMeanMax = 1;
  } else {
    const meanPadding = (mapMeanMax - mapMeanMin) * 0.1;
    mapMeanMin -= meanPadding;
    mapMeanMax += meanPadding;
  }
  const mapX = d3.scaleLinear()
    .domain([
      Math.max(0, minWeeklySigma - weeklySigmaPadding),
      maxWeeklySigma + weeklySigmaPadding,
    ])
    .range([mapPlotLeft, mapPlotRight])
    .nice(6);
  const mapY = d3.scaleLinear()
    .domain([mapMeanMin, mapMeanMax])
    .range([mapPlotBottom, mapPlotTop])
    .nice(6);
  const mapXTicks = mapX.ticks(6);
  let mapYTicks = mapY.ticks(6);
  if (!mapYTicks.includes(0)) mapYTicks = [...mapYTicks, 0].sort((a, b) => a - b);

  mapXTicks.forEach((tick) => svg.append("line")
    .attr("x1", mapX(tick)).attr("x2", mapX(tick))
    .attr("y1", mapPlotTop).attr("y2", mapPlotBottom)
    .attr("stroke", "rgba(255,255,255,0.045)"));
  mapYTicks.forEach((tick) => svg.append("line")
    .attr("x1", mapPlotLeft).attr("x2", mapPlotRight)
    .attr("y1", mapY(tick)).attr("y2", mapY(tick))
    .attr("stroke", tick === 0 ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.055)"));

  const annualization = Math.sqrt(52);
  [1, 2, 3].forEach((sharpe) => {
    const slope = sharpe / annualization;
    const startSigma = Math.max(mapX.domain()[0], mapY.domain()[0] / slope, 0);
    const endSigma = Math.min(mapX.domain()[1], mapY.domain()[1] / slope);
    if (!(endSigma > startSigma)) return;
    const startMean = slope * startSigma;
    const endMean = sharpe * endSigma / annualization;
    svg.append("line")
      .attr("x1", mapX(startSigma)).attr("y1", mapY(startMean))
      .attr("x2", mapX(endSigma)).attr("y2", mapY(endMean))
      .attr("stroke", "rgba(255,255,255,0.2)")
      .attr("stroke-width", 0.9)
      .attr("stroke-dasharray", "3 3");
    const labelX = mapPlotLeft + 9;
    const labelSigma = mapX.invert(labelX);
    const labelMean = slope * labelSigma;
    svg.append("text")
      .attr("x", labelX).attr("y", mapY(labelMean) - 5)
      .attr("text-anchor", "start")
      .attr("fill", "rgba(255,255,255,0.42)")
      .attr("font-size", 9.5)
      .text(`S ${sharpe}`);
  });

  const mapXAxis = svg.append("g")
    .attr("transform", `translate(0,${mapPlotBottom})`)
    .call(d3.axisBottom(mapX).tickValues(mapXTicks).tickSize(0).tickPadding(15).tickFormat(formatCompactUsd));
  mapXAxis.select(".domain").remove();
  mapXAxis.selectAll("text").attr("fill", UI_AXIS_LABEL_COLOR).attr("font-size", 10);
  const mapYAxis = svg.append("g")
    .attr("class", "export-y-axis")
    .attr("transform", `translate(${mapPlotLeft},0)`)
    .call(d3.axisLeft(mapY).tickValues(mapYTicks).tickSize(0).tickPadding(14).tickFormat(formatCompactUsd));
  mapYAxis.select(".domain").remove();
  mapYAxis.selectAll("text")
    .attr("x", margin.left - mapPlotLeft)
    .attr("text-anchor", "start")
    .attr("fill", UI_AXIS_LABEL_COLOR)
    .attr("font-size", 10);
  svg.append("text")
    .attr("x", (mapPlotLeft + mapPlotRight) / 2).attr("y", mapPlotBottom + 37)
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.38)").attr("font-size", 10)
    .text("WEEKLY PNL σ");

  const mapLabelPlacements = layoutScatterLabels({
    rows: sweepMapRows,
    x: mapX,
    y: mapY,
    bounds: {
      left: mapPlotLeft + 2,
      right: mapPlotRight - 2,
      top: mapPlotTop + 2,
      bottom: mapPlotBottom - 2,
    },
  });
  svg.selectAll("line.comparison-label-leader")
    .data(sweepMapRows.filter((row) => mapLabelPlacements.get(row.key)?.leader), (row) => row.key)
    .join("line")
    .attr("class", "comparison-label-leader")
    .attr("x1", (row) => mapLabelPlacements.get(row.key).leader.x1)
    .attr("y1", (row) => mapLabelPlacements.get(row.key).leader.y1)
    .attr("x2", (row) => mapLabelPlacements.get(row.key).leader.x2)
    .attr("y2", (row) => mapLabelPlacements.get(row.key).leader.y2)
    .attr("stroke", "rgba(255,255,255,0.28)")
    .attr("stroke-width", 0.65);

  mapPointGroups = svg.selectAll("g.sweep-map-point")
    .data(sweepMapRows, (row) => row.key)
    .join("g")
    .attr("class", "sweep-map-point")
    .attr("role", "button")
    .attr("tabindex", 0)
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));
  mapPointGroups.append("circle")
    .attr("class", "comparison-scatter-dot")
    .attr("cx", (row) => mapX(row.weeklySigma))
    .attr("cy", (row) => mapY(row.weeklyMean))
    .attr("r", 4.5)
    .attr("fill", (row) => row.mapColor)
    .attr("stroke", "#000000")
    .attr("stroke-width", 0.2);
  mapPointGroups.append("text")
    .attr("x", (row) => mapLabelPlacements.get(row.key)?.center.x ?? mapX(row.weeklySigma) + 6)
    .attr("y", (row) => mapLabelPlacements.get(row.key)?.center.y ?? mapY(row.weeklyMean) - 5)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .attr("fill", "rgba(255,255,255,0.58)")
    .attr("font-size", 9.5)
    .attr("stroke", "#090a0d")
    .attr("stroke-width", 2.2)
    .attr("paint-order", "stroke")
    .text((row) => row.label);
  mapPointGroups.append("title")
    .text((row) => `${row.label}\nCumulative PnL: ${formatUsd(row.total)}\nMean weekly PnL: ${formatUsd(row.weeklyMean)}\nWeekly PnL σ: ${formatUsd(row.weeklySigma)}\nSharpe: ${formatSharpe(Number(row.sharpe) || 0)}`);

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", realizedHeaderY - 24).attr("y2", realizedHeaderY - 24)
    .attr("stroke", "rgba(255,255,255,0.12)");
  appendPanelHeading({
    y: realizedHeaderY,
    title: `REALIZED VOL · ${props.dimensionLabel.toUpperCase()}`,
    subtitle: "ANNUALIZED · BLUE = HEDGE-SAMPLED RV · WHITE = ENTRY IV · CONNECTOR = VOL GAP",
  });

  const realizedRows = sweepMapRows.filter((row) => [
    row.averageSampledRealizedVol,
    row.averageEntryIv,
  ].some((value) => Number.isFinite(Number(value))));
  const realizedValues = realizedRows.flatMap((row) => [
    Number(row.averageSampledRealizedVol),
    Number(row.averageEntryIv),
  ].filter(Number.isFinite));
  if (realizedRows.length && realizedValues.length) {
    const [realizedMin = 0, realizedMax = 1] = d3.extent(realizedValues);
    const realizedSpan = realizedMax - realizedMin;
    const realizedPadding = realizedSpan > 0
      ? realizedSpan * 0.08
      : Math.max(Math.abs(realizedMax) * 0.05, 0.01);
    const realizedX = d3.scalePoint()
      .domain(realizedRows.map((row) => row.key))
      .range([realizedPlotLeft, mapPlotRight])
      .padding(0.5);
    const realizedY = d3.scaleLinear()
      .domain([
        Math.max(0, realizedMin - realizedPadding),
        realizedMax + realizedPadding,
      ])
      .range([realizedPlotBottom, realizedPlotTop])
      .nice(5);
    const realizedYTicks = realizedY.ticks(5);
    realizedYTicks.forEach((tick) => svg.append("line")
      .attr("x1", realizedPlotLeft).attr("x2", mapPlotRight)
      .attr("y1", realizedY(tick)).attr("y2", realizedY(tick))
      .attr("stroke", "rgba(255,255,255,0.055)"));
    const realizedYAxis = svg.append("g")
      .attr("class", "export-y-axis")
      .attr("transform", `translate(${realizedPlotLeft},0)`)
      .call(d3.axisLeft(realizedY)
        .tickValues(realizedYTicks)
        .tickSize(0)
        .tickPadding(14)
        .tickFormat(d3.format(".0%")));
    realizedYAxis.select(".domain").remove();
    realizedYAxis.selectAll("text")
      .attr("x", margin.left - realizedPlotLeft)
      .attr("text-anchor", "start")
      .attr("fill", UI_AXIS_LABEL_COLOR)
      .attr("font-size", 10);
    const realizedXAxis = svg.append("g")
      .attr("transform", `translate(0,${realizedAxisY})`)
      .call(d3.axisBottom(realizedX)
        .tickSize(0)
        .tickPadding(7)
        .tickFormat((key) => realizedRows.find((row) => row.key === key)?.label || key));
    realizedXAxis.select(".domain").remove();
    realizedXAxis.selectAll("text")
      .attr("fill", UI_AXIS_LABEL_COLOR)
      .attr("font-size", 9.5);

    realizedGroups = svg.selectAll("g.realized-vol-setting")
      .data(realizedRows, (row) => row.key)
      .join("g")
      .attr("class", "realized-vol-setting")
      .attr("role", "button")
      .attr("tabindex", 0)
      .style("cursor", "pointer")
      .on("click", (_, row) => emit("select", row));
    realizedGroups.each(function (row) {
      const group = d3.select(this);
      const x = realizedX(row.key);
      const sampledVol = Number(row.averageSampledRealizedVol);
      const entryIv = Number(row.averageEntryIv);
      if (Number.isFinite(sampledVol) && Number.isFinite(entryIv)) {
        group.append("line")
          .attr("x1", x).attr("x2", x)
          .attr("y1", realizedY(entryIv)).attr("y2", realizedY(sampledVol))
          .attr("stroke", sampledVol > entryIv ? "#cf6a5a" : "#6ea3d8")
          .attr("stroke-opacity", 0.5)
          .attr("stroke-width", 1.1);
      }
      if (Number.isFinite(entryIv)) {
        group.append("circle")
          .attr("cx", x).attr("cy", realizedY(entryIv)).attr("r", 3.15)
          .attr("fill", "#0a0b0e")
          .attr("stroke", "rgba(255,255,255,0.82)")
          .attr("stroke-width", 0.9);
      }
      if (Number.isFinite(sampledVol)) {
        group.append("circle")
          .attr("cx", x).attr("cy", realizedY(sampledVol)).attr("r", 2.7)
          .attr("fill", "#6ea3d8")
          .attr("stroke", "#0a0b0e")
          .attr("stroke-width", 0.6);
      }
      const spread = sampledVol - entryIv;
      group.append("title").text([
        row.label,
        `Hedge-sampled RV: ${Number.isFinite(sampledVol) ? d3.format(".1%")(sampledVol) : "—"}`,
        `Entry IV: ${Number.isFinite(entryIv) ? d3.format(".1%")(entryIv) : "—"}`,
        `RV − IV: ${Number.isFinite(spread) ? d3.format("+.1%")(spread) : "—"}`,
      ].join("\n"));
    });
  } else {
    svg.append("text")
      .attr("x", realizedPlotLeft).attr("y", realizedPlotTop + 24)
      .attr("fill", "rgba(255,255,255,0.38)")
      .attr("font-size", 10)
      .text("NO REALIZED-VOL METRICS AVAILABLE");
  }

  appendPanelHeading({
    y: distributionHeaderY,
    title: "WEEKLY PNL OBSERVATIONS",
    subtitle: distributionView.value === "ranked"
      ? `RANKED BY ${distributionSortLabel.value.toUpperCase()} · LEFT ACCENT = TOP-3 RANK · THICK WHITE BAR = MEDIAN · BOX = MIDDLE 50% · THIN WHISKER = 10TH–90TH`
      : `${distributionSequenceLabel.value.toUpperCase()} ORDER · LEFT ACCENT = TOP-3 PERFORMANCE RANK · THICK WHITE BAR = MEDIAN · BOX = MIDDLE 50% · THIN WHISKER = 10TH–90TH`,
  });

  const distributionRows = orderSweepDistributionRows(analyzedRows, {
    view: distributionView.value,
    sortBy: distributionSort.value,
    dimension: props.dimension,
  });
  const distributionPlotLeft = margin.left + 92;
  const distributionSummaryWidth = 430;
  const distributionPlotRight = margin.left + contentWidth - distributionSummaryWidth;
  const distributionSummaryX = distributionPlotRight + 18;
  const distributionSummaryRight = margin.left + contentWidth;
  const allDistributionValues = analyzedRows.flatMap((row) => row.weeks);
  const [distributionMin = -1, distributionMax = 1] = d3.extent(allDistributionValues);
  const distributionSpan = distributionMax - distributionMin || 1;
  const distributionX = d3.scaleLinear()
    .domain([
      Math.min(0, distributionMin) - distributionSpan * 0.04,
      Math.max(0, distributionMax) + distributionSpan * 0.04,
    ])
    .range([distributionPlotLeft, distributionPlotRight]);
  const distributionAxis = svg.append("g")
    .attr("transform", `translate(0,${distributionAxisY})`)
    .call(d3.axisTop(distributionX).ticks(7).tickSize(0).tickPadding(6).tickFormat(formatCompactUsd));
  distributionAxis.select(".domain").remove();
  distributionAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.42)").attr("font-size", 10);
  svg.append("rect")
    .attr("x", distributionPlotLeft)
    .attr("y", distributionAxisY)
    .attr("width", Math.max(0, distributionX(0) - distributionPlotLeft))
    .attr("height", distributionBottom - distributionAxisY)
    .attr("fill", "#cf6a5a")
    .attr("fill-opacity", 0.025);
  svg.append("rect")
    .attr("x", distributionX(0))
    .attr("y", distributionAxisY)
    .attr("width", Math.max(0, distributionPlotRight - distributionX(0)))
    .attr("height", distributionBottom - distributionAxisY)
    .attr("fill", "#6ea3d8")
    .attr("fill-opacity", 0.025);
  const distributionSummaryColumns = [
    { label: "TOTAL PNL", x: distributionSummaryX + 58, value: (row) => formatCompactUsd(row.total), tooltip: "Cumulative PnL across all displayed weekly observations." },
    { label: "SHARPE", x: distributionSummaryX + 114, value: (row) => formatSharpe(Number(row.sharpe) || 0), tooltip: "Annualized Sharpe computed from the displayed weekly PnL observations." },
    { label: "AVG IV", x: distributionSummaryX + 170, value: (row) => Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "—", tooltip: "Mean normalized entry implied volatility across selected option legs in completed cycles." },
    { label: "AVG DTE", x: distributionSummaryX + 234, value: (row) => Number.isFinite(Number(row.averageEntryDteDays)) ? formatDte(Number(row.averageEntryDteDays)) : "—", tooltip: "Mean option days to expiry at entry across completed cycles." },
    { label: "WORST WEEK", x: distributionSummaryX + 326, value: (row) => formatCompactUsd(d3.min(row.weeks) ?? 0), tooltip: "Smallest weekly PnL observation for this sweep setting." },
    { label: "POSITIVE", x: distributionSummaryRight, value: (row) => d3.format(".0%")(row.winRate), tooltip: "Share of displayed weeks with positive PnL." },
  ];
  distributionSummaryColumns.forEach((column) => {
    const header = svg.append("text")
      .attr("x", column.x).attr("y", distributionAxisY - 7).attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.38)").attr("font-size", 10)
      .text(column.label);
    header
      .on("mouseenter", () => showHeaderTooltip(column.x, distributionAxisY - 7, column.tooltip, "end"))
      .on("mouseleave", hideHeaderTooltip);
  });
  svg.append("line")
    .attr("x1", distributionX(0)).attr("x2", distributionX(0))
    .attr("y1", distributionAxisY).attr("y2", distributionBottom)
    .attr("stroke", "rgba(255,255,255,0.48)")
    .attr("stroke-width", 1.4);

  const sessionForRow = (row) => {
    if (props.dimension !== "entry_hour") return null;
    const hour = Number(row.config?.entryHourUtc);
    if (!Number.isFinite(hour)) return null;
    if (hour < 8) return { label: "Asia", color: "#6ea3d8", background: "rgba(110,163,216,0.025)" };
    if (hour < 16) return { label: "Europe", color: "#c8a66a", background: "rgba(200,166,106,0.025)" };
    return { label: "US", color: "#cf6a5a", background: "rgba(207,106,90,0.025)" };
  };
  const distributionRowFill = (row, rowIndex) => {
    const session = distributionView.value === "clock" ? sessionForRow(row) : null;
    if (session) return session.background;
    return rowIndex % 2 ? "rgba(255,255,255,0.014)" : "transparent";
  };

  const distributionGroups = svg.selectAll("g.distribution-row")
    .data(distributionRows, (row) => row.key)
    .join("g")
    .attr("class", "distribution-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) => `${row.label}, rank ${row.distributionRank}: total ${formatUsd(row.total)}, Sharpe ${formatSharpe(Number(row.sharpe) || 0)}, average entry IV ${Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "not available"}, average entry DTE ${Number.isFinite(Number(row.averageEntryDteDays)) ? formatDte(Number(row.averageEntryDteDays)) : "not available"}, worst week ${formatUsd(d3.min(row.weeks) ?? 0)}, positive week rate ${d3.format(".0%")(row.winRate)}`)
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));

  distributionGroups.each(function (row, rowIndex) {
    const group = d3.select(this);
    const top = distributionRowsY + rowIndex * distributionRowHeight;
    const center = top + distributionRowHeight / 2;
    group.append("rect").attr("class", "distribution-hit-area")
      .attr("x", margin.left).attr("y", top).attr("width", contentWidth).attr("height", distributionRowHeight)
      .attr("fill", distributionRowFill(row, rowIndex));
    group.append("line")
      .attr("x1", margin.left).attr("x2", margin.left + contentWidth).attr("y1", top).attr("y2", top)
      .attr("stroke", "rgba(255,255,255,0.045)");
    if (row.distributionRank <= 3) {
      group.append("rect")
        .attr("x", margin.left - 8)
        .attr("y", top + 4)
        .attr("width", 2)
        .attr("height", distributionRowHeight - 8)
        .attr("rx", 1)
        .attr("fill", row.distributionRank === 1 ? "#d7a85d" : row.distributionRank === 2 ? "#9ba7b3" : "#a97555")
        .attr("fill-opacity", 0.9);
    }
    group.append("text")
      .attr("x", margin.left).attr("y", center).attr("dy", "0.32em")
      .attr("fill", "rgba(255,255,255,0.28)").attr("font-size", 9.5)
      .text(String(row.distributionRank).padStart(2, "0"));
    group.append("text")
      .attr("x", margin.left + 24).attr("y", center).attr("dy", "0.32em")
      .attr("fill", UI_AXIS_LABEL_COLOR).attr("font-size", 11).attr("font-weight", 500)
      .text(row.label);

    const q10 = d3.quantileSorted(row.sortedWeeks, 0.10) ?? 0;
    const q25 = d3.quantileSorted(row.sortedWeeks, 0.25) ?? 0;
    const median = d3.quantileSorted(row.sortedWeeks, 0.50) ?? 0;
    const q75 = d3.quantileSorted(row.sortedWeeks, 0.75) ?? 0;
    const q90 = d3.quantileSorted(row.sortedWeeks, 0.90) ?? 0;
    group.append("line")
      .attr("x1", distributionX(q10)).attr("x2", distributionX(q90))
      .attr("y1", center).attr("y2", center)
      .attr("stroke", "rgba(255,255,255,0.36)").attr("stroke-width", 1);
    [q10, q90].forEach((value) => group.append("line")
      .attr("x1", distributionX(value)).attr("x2", distributionX(value))
      .attr("y1", center - 3).attr("y2", center + 3)
      .attr("stroke", "rgba(255,255,255,0.42)").attr("stroke-width", 1));
    group.append("rect")
      .attr("x", Math.min(distributionX(q25), distributionX(q75)))
      .attr("y", center - 4)
      .attr("width", Math.max(1, Math.abs(distributionX(q75) - distributionX(q25))))
      .attr("height", 8)
      .attr("rx", 2)
      .attr("fill", "rgba(255,255,255,0.16)")
      .attr("stroke", "rgba(255,255,255,0.22)")
      .attr("stroke-width", 0.6);
    group.append("line")
      .attr("x1", distributionX(median)).attr("x2", distributionX(median))
      .attr("y1", center - 7).attr("y2", center + 7)
      .attr("stroke", "rgba(255,255,255,0.94)").attr("stroke-width", 2.2);

    row.weeklyPoints.forEach((weeklyPoint, weekIndex) => {
      const jitter = (((weekIndex * 7 + rowIndex * 3) % 13) - 6) * 0.65;
      const isSelectedWeek = weeklyPoint.weekKey === selectedWeekKey.value;
      const pointColor = performanceColor(Number(row.sharpe) || 0);
      const point = group.append("circle")
        .datum({ ...weeklyPoint, rowKey: row.key })
        .attr("class", "weekly-point")
        .attr("cx", distributionX(weeklyPoint.value)).attr("cy", center + jitter).attr("r", 2.2)
        .attr("fill", pointColor).attr("fill-opacity", isSelectedWeek ? 0.96 : 0.72)
        .attr("stroke", isSelectedWeek ? "#ffffff" : "none")
        .attr("stroke-width", isSelectedWeek ? 1.1 : 0)
        .style("cursor", "pointer")
        .on("mouseenter", function () { d3.select(this).attr("fill-opacity", 0.95).attr("r", 2.7); })
        .on("mouseleave", function () { d3.select(this).attr("fill-opacity", isSelectedWeek ? 0.96 : 0.72).attr("r", 2.2); })
        .on("click", (event) => {
          event.stopPropagation();
          selectedWeekKey.value = selectedWeekKey.value === weeklyPoint.weekKey
            ? ""
            : weeklyPoint.weekKey;
        });
      const date = weeklyPoint.entryDate ? d3.utcFormat("%d %b %Y")(new Date(weeklyPoint.entryDate)) : `Week ${weekIndex + 1}`;
      point.append("title").text(`${row.label} · ${date}\nWeekly PnL: ${formatUsd(weeklyPoint.value)}\nClick to compare this calendar week across rows.`);
    });
    distributionSummaryColumns.forEach((column) => group.append("text")
      .attr("x", column.x).attr("y", center).attr("dy", "0.32em").attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.72)").attr("font-size", 10.5)
      .text(column.value(row)));
  });

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", distributionSeparatorY).attr("y2", distributionSeparatorY)
    .attr("stroke", "rgba(255,255,255,0.12)");

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", rankedHeaderY - 24).attr("y2", rankedHeaderY - 24)
    .attr("stroke", "rgba(255,255,255,0.12)");

  appendPanelHeading({
    y: rankedHeaderY,
    title: "RANKED SWEEP",
    subtitle: "PNL ATTRIBUTION AND ENTRY VOLATILITY · SORTED BY TOTAL PNL",
  });

  const columnX = {
    setting: margin.left,
    spark: margin.left + contentWidth * 0.07,
    optionPnl: margin.left + contentWidth * 0.36,
    hedgePnl: margin.left + contentWidth * 0.46,
    entryIv: margin.left + contentWidth * 0.52,
    entryDte: margin.left + contentWidth * 0.58,
    holdingPeriod: margin.left + contentWidth * 0.64,
    sharpe: margin.left + contentWidth * 0.695,
    drawdown: margin.left + contentWidth * 0.75,
    calmar: margin.left + contentWidth * 0.81,
    win: margin.left + contentWidth * 0.86,
    profitFactor: margin.left + contentWidth * 0.915,
    cvar: margin.left + contentWidth * 0.97,
  };
  const headers = [
    { label: "SETTING", x: columnX.setting, anchor: "start", tooltip: "The sweep parameter value used for this backtest variant." },
    { label: "EQUITY", x: columnX.spark, anchor: "start", tooltip: "Cumulative weekly PnL. The white dot marks the best individual week." },
    { label: "OPTION PNL", x: columnX.optionPnl, anchor: "end", tooltip: "Cumulative option-leg PnL across completed cycles, before hedge PnL." },
    { label: "HEDGE PNL", x: columnX.hedgePnl, anchor: "end", tooltip: "Cumulative perpetual-futures hedge PnL across completed cycles." },
    { label: "AVG ENTRY IV", x: columnX.entryIv, anchor: "end", tooltip: "Mean normalized entry implied volatility across selected option legs in completed cycles." },
    { label: "AVG DTE", x: columnX.entryDte, anchor: "end", tooltip: "Mean option days to expiry at entry across completed cycles. For Friday hourly sweeps, entries after the 08:00 UTC expiry use a shorter DTE and may be flat until the next entry slot." },
    { label: "AVG HOLD", x: columnX.holdingPeriod, anchor: "end", tooltip: "Mean elapsed time from entry to exit across completed cycles. This can be shorter than the configured roll interval when the option expires first." },
    { label: "SHARPE", x: columnX.sharpe, anchor: "end", tooltip: "Annualized weekly Sharpe: average weekly PnL divided by weekly PnL volatility, multiplied by √52." },
    { label: "MAX DD", x: columnX.drawdown, anchor: "end", tooltip: "Largest peak-to-trough loss in cumulative PnL during the backtest." },
    { label: "CALMAR", x: columnX.calmar, anchor: "end", tooltip: "Annualized weekly PnL divided by absolute maximum drawdown. Higher means more return per unit of peak-to-trough loss." },
    { label: "WIN", x: columnX.win, anchor: "end", tooltip: "Percentage of weeks with positive PnL." },
    { label: "PF", x: columnX.profitFactor, anchor: "end", tooltip: "Profit factor: gross PnL from winning weeks divided by the absolute gross loss from losing weeks. Above 1 means gains exceed losses." },
    { label: "CVAR WK", x: columnX.cvar, anchor: "end", tooltip: "Weekly tail loss: the average PnL of the three worst weeks. More negative means a heavier downside tail." },
  ];
  headers.forEach(({ label, x, anchor, tooltip }) => {
    const header = svg.append("text")
      .attr("x", x).attr("y", rankedColumnsY).attr("text-anchor", anchor)
      .attr("fill", label === "SETTING" ? UI_AXIS_LABEL_COLOR : "rgba(255,255,255,0.45)")
      .attr("font-size", 10).text(label);
    header
      .on("mouseenter", () => showHeaderTooltip(x, rankedColumnsY, tooltip, anchor))
      .on("mouseleave", hideHeaderTooltip);
  });

  const sparkWidth = contentWidth * 0.145;
  const rankGroups = svg.selectAll("g.rank-row")
    .data(rankedRows, (row) => row.key)
    .join("g")
    .attr("class", "rank-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) => `${row.label}: average entry DTE ${Number.isFinite(Number(row.averageEntryDteDays)) ? formatDte(Number(row.averageEntryDteDays)) : "not available"}, average holding period ${Number.isFinite(Number(row.averageHoldingPeriodDays)) ? formatDte(Number(row.averageHoldingPeriodDays)) : "not available"}, option PnL ${formatUsd(Number(row.optionPnl) || 0)}, hedge PnL ${formatUsd(Number(row.hedgePnl) || 0)}, average entry IV ${Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "not available"}, Sharpe ${formatSharpe(Number(row.sharpe) || 0)}, Calmar ${Number.isFinite(row.calmar) ? formatSharpe(row.calmar) : "not available"}`)
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));

  rankGroups.each(function (row, index) {
    const group = d3.select(this);
    const top = rankedRowsY + index * rankedRowHeight;
    const center = top + rankedRowHeight / 2;
    group.append("rect").attr("class", "rank-hit-area")
      .attr("x", margin.left).attr("y", top).attr("width", contentWidth).attr("height", rankedRowHeight)
      .attr("fill", "transparent");
    group.append("line").attr("x1", margin.left).attr("x2", margin.left + contentWidth)
      .attr("y1", top).attr("y2", top).attr("stroke", "rgba(255,255,255,0.05)");
    group.append("text").attr("x", columnX.setting).attr("y", center).attr("dy", "0.32em")
      .attr("fill", UI_AXIS_LABEL_COLOR).attr("font-size", 11).attr("font-weight", 500).text(row.label);

    const [cumMin, cumMax] = d3.extent(row.cumulative);
    const sparkX = d3.scaleLinear().domain([0, Math.max(1, row.cumulative.length - 1)]).range([columnX.spark, columnX.spark + sparkWidth]);
    const sparkY = d3.scaleLinear().domain(cumMin === cumMax ? [cumMin - 1, cumMax + 1] : [cumMin, cumMax]).range([center + 7, center - 7]);
    group.append("path").datum(row.cumulative)
      .attr("d", d3.line().x((_, i) => sparkX(i)).y((value) => sparkY(value)))
      .attr("fill", "none").attr("stroke", performanceColor(Number(row.sharpe) || 0)).attr("stroke-width", 1.2);
    group.append("circle").attr("cx", sparkX(row.bestIndex + 1)).attr("cy", sparkY(row.cumulative[row.bestIndex + 1] ?? 0))
      .attr("r", 2.2).attr("fill", "#ffffff");

    const addValue = (x, value, color = "rgba(255,255,255,0.7)") => group.append("text")
      .attr("x", x).attr("y", center).attr("dy", "0.32em").attr("text-anchor", "end")
      .attr("fill", color).attr("font-size", 10.5).text(value);
    const optionPnl = Number(row.optionPnl) || 0;
    const hedgePnl = Number(row.hedgePnl) || 0;
    addValue(columnX.optionPnl, formatCompactUsd(optionPnl), optionPnlColor(optionPnl));
    addValue(columnX.hedgePnl, formatCompactUsd(hedgePnl), hedgePnlColor(hedgePnl));
    addValue(columnX.entryIv, Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "—");
    addValue(columnX.entryDte, Number.isFinite(Number(row.averageEntryDteDays)) ? formatDte(Number(row.averageEntryDteDays)) : "—");
    addValue(columnX.holdingPeriod, Number.isFinite(Number(row.averageHoldingPeriodDays)) ? formatDte(Number(row.averageHoldingPeriodDays)) : "—");
    addValue(columnX.sharpe, formatSharpe(Number(row.sharpe) || 0), sharpeTextColor(Number(row.sharpe) || 0));
    addValue(columnX.drawdown, formatCompactUsd(Number(row.maxDrawdown) || 0), drawdownColor(Number(row.maxDrawdown) || 0));
    addValue(columnX.calmar, Number.isFinite(row.calmar) ? formatSharpe(row.calmar) : "—");
    addValue(columnX.win, d3.format(".0%")(row.winRate));
    addValue(columnX.profitFactor, d3.format(".2f")(row.profitFactor));
    addValue(columnX.cvar, formatCompactUsd(row.cvar));
  });

  const setHoveredRow = (key) => {
    mapPointGroups.select(".comparison-scatter-dot")
      .attr("stroke", "#000000")
      .attr("stroke-width", (row) => row.key === key ? 1.4 : 0.2);
    realizedGroups.attr("opacity", (row) => !key || row.key === key ? 1 : 0.3);
    distributionGroups.select(".distribution-hit-area")
      .attr("fill", (row, index) => row.key === key
        ? "rgba(255,255,255,0.055)"
        : distributionRowFill(row, index));
    distributionGroups.selectAll(".weekly-point")
      .attr("fill-opacity", (point) => {
        if (point.weekKey === selectedWeekKey.value) return 0.96;
        if (!key) return 0.72;
        return point.rowKey === key ? 0.9 : 0.28;
      });
    rankGroups.select(".rank-hit-area").attr("fill", (row) => row.key === key ? "rgba(255,255,255,0.055)" : "transparent");
  };
  const bindHover = (selection) => selection
    .on("mouseenter", (_, row) => setHoveredRow(row.key)).on("mouseleave", () => setHoveredRow(null))
    .on("focus", (_, row) => setHoveredRow(row.key)).on("blur", () => setHoveredRow(null))
    .on("keydown", (event, row) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); emit("select", row); }
    });
  [mapPointGroups, realizedGroups, distributionGroups, rankGroups].forEach(bindHover);
};

onMounted(async () => {
  await nextTick();
  draw();
  if (typeof ResizeObserver !== "undefined" && chartRef.value) {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(chartRef.value);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());

watch(
  () => [
    props.rows,
    props.dimension,
    props.dimensionLabel,
    distributionView.value,
    distributionSort.value,
    selectedWeekKey.value,
  ],
  async () => {
    await nextTick();
    draw();
  },
  { flush: "post", immediate: true, deep: true },
);

function exportPng({
  filename = "sweep.png",
  scale = 4,
  padding = 24,
  title = "",
  subtitle = "",
  source = "",
  metrics = [],
} = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({
    svgEl,
    title,
    subtitle,
    source,
    metrics,
    filename,
    scale,
    padding,
    background: "#0a0b0e",
  });
}

function exportPanel(panel) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl || !panel?.region) return;
  const date = new Date().toISOString().slice(0, 10);
  exportChartRegionToPng({
    svgEl,
    region: panel.region,
    filename: `sweep-${panel.key}-${date}.png`,
    scale: 4,
    padding: 18,
  });
}

defineExpose({ exportPng });
</script>

<template>
  <div class="chartViewport">
    <div class="chartSurface">
      <div ref="chartRef" class="chartCanvas"></div>
      <div
        v-if="panelRegions.length"
        class="distributionControls"
        :style="{ top: `${distributionControlsTop}px` }"
        aria-label="Weekly PnL observation order"
      >
        <div class="distributionViewToggle" role="group" aria-label="Distribution view">
          <button
            type="button"
            :class="{ active: distributionView === 'clock' }"
            :aria-pressed="distributionView === 'clock'"
            @click="distributionView = 'clock'"
          >
            {{ distributionSequenceLabel }}
          </button>
          <button
            type="button"
            :class="{ active: distributionView === 'ranked' }"
            :aria-pressed="distributionView === 'ranked'"
            @click="distributionView = 'ranked'"
          >
            Ranked
          </button>
        </div>
        <div
          class="distributionSortControl"
          @focusout="handleSortFocusout"
          @keydown.esc="distributionSortOpen = false"
        >
          <span>Rank by</span>
          <button
            class="distributionSortTrigger"
            type="button"
            aria-haspopup="listbox"
            :aria-expanded="distributionSortOpen"
            @click="distributionSortOpen = !distributionSortOpen"
          >
            {{ distributionSortLabel }}
            <span class="distributionSortChevron" aria-hidden="true"></span>
          </button>
          <div
            v-if="distributionSortOpen"
            class="distributionSortMenu"
            role="listbox"
            aria-label="Rank weekly PnL observations by"
          >
            <button
              v-for="option in DISTRIBUTION_SORT_OPTIONS"
              :key="option.value"
              type="button"
              role="option"
              :aria-selected="distributionSort === option.value"
              :class="{ active: distributionSort === option.value }"
              @click="selectDistributionSort(option.value)"
            >
              <span>{{ option.label }}</span>
              <span v-if="distributionSort === option.value" class="distributionSortCheck" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
      </div>
      <button
        v-for="panel in panelRegions"
        :key="panel.key"
        class="panelExportButton"
        type="button"
        :style="{ top: `${panel.buttonTop}px` }"
        :title="`Save ${panel.label} as PNG`"
        :aria-label="`Save ${panel.label} as PNG`"
        @click="exportPanel(panel)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.5 7.5 9 5.25h6l1.5 2.25H19A2 2 0 0 1 21 9.5v7A2 2 0 0 1 19 18.5H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.5Z" />
          <circle cx="12" cy="13" r="3.25" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chartViewport {
  width: 100%;
  min-height: 280px;
  max-height: calc(100vh - 210px);
  overflow: auto;
}

.chartSurface {
  position: relative;
  min-width: 1080px;
}

.chartCanvas :deep(svg) {
  display: block;
  max-width: none;
}

.distributionControls {
  position: absolute;
  right: 58px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 7px;
}

.distributionViewToggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(10, 11, 14, 0.78);
  backdrop-filter: blur(6px);
}

.distributionViewToggle button {
  height: 20px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #777d84;
  font: 500 10px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  cursor: pointer;
}

.distributionViewToggle button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.distributionSortControl {
  position: relative;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-left: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 5px;
  background: rgba(10, 11, 14, 0.78);
  color: #777d84;
  font: 500 10px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  backdrop-filter: blur(6px);
}

.distributionSortTrigger {
  min-width: 88px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  border-radius: 4px;
  padding: 0 7px 0 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #d8dadd;
  font: inherit;
  cursor: pointer;
}

.distributionSortTrigger:hover,
.distributionSortTrigger:focus-visible {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.distributionSortChevron {
  width: 5px;
  height: 5px;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  transform: translateY(-1px) rotate(45deg);
}

.distributionSortMenu {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 8;
  min-width: 126px;
  overflow: hidden;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 6px;
  background: #14161a;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}

.distributionSortMenu button {
  width: 100%;
  height: 27px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 0;
  border-radius: 4px;
  padding: 0 8px;
  background: transparent;
  color: #9ba0a7;
  font: 500 11px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  text-align: left;
  cursor: pointer;
}

.distributionSortMenu button:hover,
.distributionSortMenu button:focus-visible {
  background: rgba(255, 255, 255, 0.07);
  color: #f2f3f5;
  outline: none;
}

.distributionSortMenu button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.distributionSortCheck {
  color: #d8dadd;
  font-size: 12px;
}

.panelExportButton {
  position: absolute;
  right: 24px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  height: 24px;
  width: 24px;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(10, 11, 14, 0.72);
  color: rgba(255, 255, 255, 0.38);
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}

.panelExportButton svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}

.panelExportButton:hover,
.panelExportButton:focus-visible {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(23, 25, 30, 0.92);
  color: rgba(255, 255, 255, 0.82);
  outline: none;
}

.chartCanvas :deep(.sweep-map-point:focus),
.chartCanvas :deep(.realized-vol-setting:focus),
.chartCanvas :deep(.rank-row:focus),
.chartCanvas :deep(.distribution-row:focus) {
  outline: none;
}

.chartCanvas :deep(.rank-row:focus > .rank-hit-area),
.chartCanvas :deep(.distribution-row:focus > .distribution-hit-area) {
  fill: rgba(125, 211, 252, 0.08);
}
</style>
