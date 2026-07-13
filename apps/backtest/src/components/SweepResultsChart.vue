<script setup>
import * as d3 from "d3";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  exportChartRegionToPng,
  exportTitledChart,
} from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  dimensionLabel: { type: String, default: "Sweep setting" },
});

const emit = defineEmits(["select"]);
const chartRef = ref(null);
const panelRegions = ref([]);
let resizeObserver;

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatSharpe = d3.format(".2f");
const formatIv = d3.format(".1%");

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
  const rankedHeaderY = 15;
  const rankedColumnsY = rankedHeaderY + 40;
  const rankedRowsY = rankedColumnsY + 18;
  const rankedRowHeight = 25;
  const rankedBottom = rankedRowsY + rows.length * rankedRowHeight;
  const boxHeaderY = rankedBottom + 50;
  const boxPlotTop = boxHeaderY + 24;
  const boxPlotHeight = 382;
  const boxPlotBottom = boxPlotTop + boxPlotHeight;
  const boxAxisY = boxPlotBottom + 8;
  const boxBottom = boxAxisY + 28;
  const distributionHeaderY = boxBottom + 50;
  const distributionAxisY = distributionHeaderY + 39;
  const distributionRowsY = distributionAxisY + 16;
  const distributionRowHeight = 26;
  const distributionBottom = distributionRowsY + rows.length * distributionRowHeight;
  const width = Math.max(availableWidth, margin.left + contentWidth + margin.right);
  const height = distributionBottom + 36;
  panelRegions.value = [
    {
      key: "ranked-sweep",
      label: "Ranked sweep",
      buttonTop: 6,
      region: { x: 0, y: 0, width, height: boxHeaderY - 24 },
    },
    {
      key: "weekly-boxplots",
      label: "Weekly PnL boxplots",
      buttonTop: boxHeaderY - 17,
      region: {
        x: 0,
        y: boxHeaderY - 24,
        width,
        height: distributionHeaderY - boxHeaderY,
      },
    },
    {
      key: "weekly-observations",
      label: "Weekly PnL observations",
      buttonTop: distributionHeaderY - 17,
      region: {
        x: 0,
        y: distributionHeaderY - 24,
        width,
        height: height - distributionHeaderY + 24,
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
    .attr("aria-label", "Ranked sweep analysis with weekly PnL box plots and observed weekly returns");

  const sum = (values) => d3.sum(values);
  const analyzedRows = rows.map((row) => {
    const weeklyPoints = (row.weeklyReturns || [])
      .map((point, sourceIndex) => ({
        value: Number(point.pnl),
        entryDate: point.entryDate,
        sourceIndex,
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
  const weeklyBoxRows = analyzedRows.map((row) => {
    const [weeklyMin = 0, weeklyMax = 0] = d3.extent(row.sortedWeeks);
    const weeklyQ25 = d3.quantileSorted(row.sortedWeeks, 0.25) ?? 0;
    const weeklyMedian = d3.quantileSorted(row.sortedWeeks, 0.5) ?? 0;
    const weeklyQ75 = d3.quantileSorted(row.sortedWeeks, 0.75) ?? 0;
    const iqr = weeklyQ75 - weeklyQ25;
    const lowerFence = weeklyQ25 - 1.5 * iqr;
    const upperFence = weeklyQ75 + 1.5 * iqr;
    const weeklyWhiskerMin = row.sortedWeeks.find((value) => value >= lowerFence) ?? weeklyMin;
    let weeklyWhiskerMax = weeklyMax;
    for (let index = row.sortedWeeks.length - 1; index >= 0; index -= 1) {
      if (row.sortedWeeks[index] <= upperFence) {
        weeklyWhiskerMax = row.sortedWeeks[index];
        break;
      }
    }
    return {
      ...row,
      weeklyMin,
      weeklyQ25,
      weeklyMedian,
      weeklyQ75,
      weeklyMax,
      weeklyWhiskerMin,
      weeklyWhiskerMax,
      weeklyOutliers: row.weeklyPoints.filter(
        (point) => point.value < weeklyWhiskerMin || point.value > weeklyWhiskerMax,
      ),
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
    const tooltipWidth = Math.min(430, Math.max(...lines.map((line) => line.length)) * 5.2 + 18);
    const tooltipHeight = lines.length * 13 + 12;
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
      .attr("fill", "rgba(255,255,255,0.88)").attr("font-size", 9);
    lines.forEach((line, index) => text.append("tspan")
      .attr("x", 9).attr("dy", index === 0 ? 0 : 13).text(line));
  };
  const hideOutlierTooltip = () => svg.selectAll("g.outlier-tooltip").remove();
  const showOutlierTooltip = (event, row, point) => {
    hideOutlierTooltip();
    const [pointerX, pointerY] = d3.pointer(event, svg.node());
    const date = point.entryDate
      ? d3.utcFormat("%d %b %Y")(new Date(point.entryDate))
      : `Week ${point.sourceIndex + 1}`;
    const fence = point.value < row.weeklyWhiskerMin ? "BELOW LOWER FENCE" : "ABOVE UPPER FENCE";
    const tooltipWidth = 150;
    const tooltipHeight = 49;
    const tooltipX = Math.max(
      margin.left,
      Math.min(pointerX + 9, margin.left + contentWidth - tooltipWidth),
    );
    const preferredY = pointerY - tooltipHeight - 8;
    const tooltipY = preferredY > boxPlotTop ? preferredY : pointerY + 8;
    const tooltip = svg.append("g")
      .attr("class", "outlier-tooltip")
      .attr("transform", `translate(${tooltipX},${tooltipY})`)
      .attr("pointer-events", "none");
    tooltip.append("rect")
      .attr("width", tooltipWidth).attr("height", tooltipHeight).attr("rx", 4)
      .attr("fill", "#17191e").attr("stroke", "rgba(255,255,255,0.18)");
    tooltip.append("text")
      .attr("x", 9).attr("y", 14)
      .attr("fill", "rgba(255,255,255,0.58)").attr("font-size", 8)
      .text(`${row.label} · ${date}`);
    tooltip.append("text")
      .attr("x", 9).attr("y", 29)
      .attr("fill", "rgba(255,255,255,0.9)").attr("font-size", 9).attr("font-weight", 500)
      .text(`Weekly PnL  ${formatUsd(point.value)}`);
    tooltip.append("text")
      .attr("x", 9).attr("y", 42)
      .attr("fill", "rgba(255,255,255,0.4)").attr("font-size", 7.5)
      .text(fence);
  };

  const boxPlotLeft = margin.left + 58;
  const boxPlotRight = margin.left + contentWidth - 8;
  const weeklyValues = weeklyBoxRows.flatMap((row) => row.weeks);
  const [weeklyMin = -1, weeklyMax = 1] = d3.extent(weeklyValues);
  const weeklySpan = weeklyMax - weeklyMin;
  const weeklyPadding = weeklySpan > 0
    ? weeklySpan * 0.025
    : Math.max(Math.abs(weeklyMin) * 0.025, 1);
  const weeklyDomain = [
    weeklyMin - weeklyPadding,
    weeklyMax + weeklyPadding,
  ];
  const drawBoxPlotAxes = (plotTop, plotBottom, axisY) => {
    const x = d3.scalePoint()
      .domain(weeklyBoxRows.map((row) => row.key))
      .range([boxPlotLeft, boxPlotRight])
      .padding(0.45);
    const y = d3.scaleLinear().domain(weeklyDomain).range([plotBottom, plotTop]);
    const yAxis = svg.append("g")
      .attr("transform", `translate(${boxPlotLeft},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(boxPlotRight - boxPlotLeft)).tickPadding(8).tickFormat(formatCompactUsd));
    yAxis.select(".domain").remove();
    yAxis.selectAll(".tick line").attr("stroke", "rgba(255,255,255,0.07)");
    yAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.4)").attr("font-size", 8);
    const xAxis = svg.append("g")
      .attr("transform", `translate(0,${axisY})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(7).tickFormat((key) => weeklyBoxRows.find((row) => row.key === key)?.label || key));
    xAxis.select(".domain").attr("stroke", "rgba(255,255,255,0.14)");
    xAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.46)").attr("font-size", 7.5);
    return { x, y };
  };

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", boxHeaderY - 24).attr("y2", boxHeaderY - 24)
    .attr("stroke", "rgba(255,255,255,0.12)");
  svg.append("text")
    .attr("x", margin.left).attr("y", boxHeaderY)
    .attr("fill", "rgba(255,255,255,0.64)").attr("font-size", 10).attr("font-weight", 500)
    .text(`WEEKLY PNL BOXPLOTS · ${props.dimensionLabel.toUpperCase()}`);
  svg.append("text")
    .attr("x", margin.left).attr("y", boxHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)").attr("font-size", 8)
    .text("OBSERVED WEEKS · WHISKER = 1.5× IQR · BOX = 25–75% · LINE = MEDIAN · DOT = OUTLIER");
  const boxScales = drawBoxPlotAxes(boxPlotTop, boxPlotBottom, boxAxisY);
  const boxWidth = Math.min(18, Math.max(8, (boxScales.x.step?.() || 30) * 0.5));
  svg.append("path")
    .datum(weeklyBoxRows)
    .attr("d", d3.line()
      .x((row) => boxScales.x(row.key))
      .y((row) => boxScales.y(row.weeklyMedian)))
    .attr("fill", "none").attr("stroke", "rgba(255,255,255,0.24)").attr("stroke-width", 1.1);
  const boxGroups = svg.selectAll("g.weekly-box")
    .data(weeklyBoxRows, (row) => row.key)
    .join("g")
    .attr("class", "weekly-box")
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));
  boxGroups.each(function (row) {
    const group = d3.select(this);
    const center = boxScales.x(row.key);
    const color = performanceColor(Number(row.sharpe) || 0);
    group.append("line")
      .attr("x1", center).attr("x2", center)
      .attr("y1", boxScales.y(row.weeklyWhiskerMax)).attr("y2", boxScales.y(row.weeklyWhiskerMin))
      .attr("stroke", "rgba(255,255,255,0.32)");
    [row.weeklyWhiskerMin, row.weeklyWhiskerMax].forEach((value) => group.append("line")
      .attr("x1", center - boxWidth * 0.3).attr("x2", center + boxWidth * 0.3)
      .attr("y1", boxScales.y(value)).attr("y2", boxScales.y(value))
      .attr("stroke", "rgba(255,255,255,0.38)"));
    const box = group.append("rect")
      .attr("x", center - boxWidth / 2).attr("width", boxWidth)
      .attr("y", boxScales.y(row.weeklyQ75))
      .attr("height", Math.max(1, boxScales.y(row.weeklyQ25) - boxScales.y(row.weeklyQ75)))
      .attr("rx", 1.5).attr("fill", color).attr("fill-opacity", 0.55);
    group.append("line")
      .attr("x1", center - boxWidth / 2).attr("x2", center + boxWidth / 2)
      .attr("y1", boxScales.y(row.weeklyMedian)).attr("y2", boxScales.y(row.weeklyMedian))
      .attr("stroke", "#ffffff").attr("stroke-width", 1.2);
    const jitterOffsets = [0, -2.2, 2.2, -4.4, 4.4];
    group.selectAll("circle.weekly-outlier")
      .data(row.weeklyOutliers)
      .join("circle")
      .attr("class", "weekly-outlier")
      .attr("cx", (_, index) => center + jitterOffsets[index % jitterOffsets.length])
      .attr("cy", (point) => boxScales.y(point.value))
      .attr("r", 1.7)
      .attr("fill", "#6f747b")
      .attr("fill-opacity", 0.78)
      .attr("stroke", "#0a0b0e")
      .attr("stroke-width", 0.7)
      .style("cursor", "help")
      .on("mouseenter", function (event, point) {
        d3.select(this).attr("fill", "#a9adb3").attr("fill-opacity", 1);
        showOutlierTooltip(event, row, point);
      })
      .on("mousemove", (event, point) => showOutlierTooltip(event, row, point))
      .on("mouseleave", function () {
        d3.select(this).attr("fill", "#6f747b").attr("fill-opacity", 0.78);
        hideOutlierTooltip();
      });
    const outlierSummary = row.weeklyOutliers.length
      ? `\nOutliers (${row.weeklyOutliers.length}): ${row.weeklyOutliers.map((point) => formatUsd(point.value)).join(", ")}`
      : "\nOutliers: none";
    box.append("title").text(`${row.label}\nWhiskers: ${formatUsd(row.weeklyWhiskerMin)} to ${formatUsd(row.weeklyWhiskerMax)}\n25–75%: ${formatUsd(row.weeklyQ25)} to ${formatUsd(row.weeklyQ75)}\nMedian: ${formatUsd(row.weeklyMedian)}${outlierSummary}`);
  });

  svg.append("text")
    .attr("x", margin.left).attr("y", distributionHeaderY)
    .attr("fill", "rgba(255,255,255,0.64)").attr("font-size", 10).attr("font-weight", 500)
    .text("WEEKLY PNL OBSERVATIONS");
  svg.append("text")
    .attr("x", margin.left).attr("y", distributionHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)").attr("font-size", 8)
    .text("ROWS RANKED BY TOTAL PNL · SHARED WEEKLY SCALE · BLUE = UP · RED = DOWN · LINE = MEDIAN · WHITE BORDER = BEST WEEK");

  const distributionPlotLeft = margin.left + 62;
  const distributionSummaryWidth = 260;
  const distributionPlotRight = margin.left + contentWidth - distributionSummaryWidth;
  const distributionSummaryX = distributionPlotRight + 22;
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
  distributionAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.42)").attr("font-size", 8);
  const distributionSummaryColumns = [
    { label: "MAX", x: distributionSummaryX, anchor: "start", value: (weeks) => d3.max(weeks) ?? 0, tooltip: "Largest weekly PnL for this sweep setting." },
    { label: "MIN", x: distributionSummaryX + (distributionSummaryRight - distributionSummaryX) / 3, anchor: "middle", value: (weeks) => d3.min(weeks) ?? 0, tooltip: "Smallest weekly PnL for this sweep setting." },
    { label: "MEAN", x: distributionSummaryX + (distributionSummaryRight - distributionSummaryX) * 2 / 3, anchor: "middle", value: (weeks) => d3.mean(weeks) ?? 0, tooltip: "Mean weekly PnL for this sweep setting." },
    { label: "MEDIAN", x: distributionSummaryRight, anchor: "end", value: (weeks) => d3.median(weeks) ?? 0, tooltip: "Median weekly PnL for this sweep setting." },
  ];
  distributionSummaryColumns.forEach((column) => {
    const header = svg.append("text")
      .attr("x", column.x).attr("y", distributionAxisY - 7).attr("text-anchor", column.anchor)
      .attr("fill", "rgba(255,255,255,0.38)").attr("font-size", 8)
      .text(column.label);
    header
      .on("mouseenter", () => showHeaderTooltip(column.x, distributionAxisY - 7, column.tooltip, column.anchor === "end" ? "end" : "start"))
      .on("mouseleave", hideHeaderTooltip);
  });
  svg.append("line")
    .attr("x1", distributionX(0)).attr("x2", distributionX(0))
    .attr("y1", distributionAxisY).attr("y2", distributionBottom)
    .attr("stroke", "rgba(255,255,255,0.18)");

  const distributionGroups = svg.selectAll("g.distribution-row")
    .data(rankedRows, (row) => row.key)
    .join("g")
    .attr("class", "distribution-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) => `${row.label}: maximum ${formatUsd(d3.max(row.weeks) ?? 0)}, minimum ${formatUsd(d3.min(row.weeks) ?? 0)}, average ${formatUsd(d3.mean(row.weeks) ?? 0)}, median ${formatUsd(d3.median(row.weeks) ?? 0)}`)
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));

  distributionGroups.each(function (row, rowIndex) {
    const group = d3.select(this);
    const top = distributionRowsY + rowIndex * distributionRowHeight;
    const center = top + distributionRowHeight / 2;
    group.append("rect").attr("class", "distribution-hit-area")
      .attr("x", margin.left).attr("y", top).attr("width", contentWidth).attr("height", distributionRowHeight)
      .attr("fill", "transparent");
    group.append("line")
      .attr("x1", margin.left).attr("x2", margin.left + contentWidth).attr("y1", top).attr("y2", top)
      .attr("stroke", "rgba(255,255,255,0.045)");
    group.append("text")
      .attr("x", margin.left).attr("y", center).attr("dy", "0.32em")
      .attr("fill", "rgba(255,255,255,0.76)").attr("font-size", 9).attr("font-weight", 500)
      .text(row.label);

    row.weeks.forEach((value, weekIndex) => {
      const jitter = (((weekIndex * 7 + rowIndex * 3) % 13) - 6) * 0.65;
      const point = group.append("circle")
        .attr("cx", distributionX(value)).attr("cy", center + jitter).attr("r", 2.35)
        .attr("fill", value >= 0 ? "#6ea3d8" : "#cf6a5a").attr("fill-opacity", 0.56)
        .attr("stroke", weekIndex === row.bestIndex ? "#ffffff" : "none")
        .attr("stroke-width", weekIndex === row.bestIndex ? 0.8 : 0);
      const sourcePoint = row.weeklyReturns?.[weekIndex];
      const date = sourcePoint?.entryDate ? d3.utcFormat("%d %b %Y")(new Date(sourcePoint.entryDate)) : `Week ${weekIndex + 1}`;
      point.append("title").text(`${row.label} · ${date}\nWeekly PnL: ${formatUsd(value)}`);
    });
    const median = d3.median(row.weeks) || 0;
    group.append("line")
      .attr("x1", distributionX(median)).attr("x2", distributionX(median))
      .attr("y1", center - 8).attr("y2", center + 8)
      .attr("stroke", "rgba(255,255,255,0.9)").attr("stroke-width", 1.2);
    distributionSummaryColumns.forEach((column) => group.append("text")
      .attr("x", column.x).attr("y", center).attr("dy", "0.32em").attr("text-anchor", column.anchor)
      .attr("fill", "rgba(255,255,255,0.72)").attr("font-size", 8.5)
      .text(formatCompactUsd(column.value(row.weeks))));
  });

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", distributionHeaderY - 24).attr("y2", distributionHeaderY - 24)
    .attr("stroke", "rgba(255,255,255,0.12)");

  svg.append("text")
    .attr("x", margin.left)
    .attr("y", rankedHeaderY)
    .attr("fill", "rgba(255,255,255,0.64)")
    .attr("font-size", 10)
    .attr("font-weight", 500)
    .text("RANKED SWEEP · OUTLIER LENS");
  svg.append("text")
    .attr("x", margin.left)
    .attr("y", rankedHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)")
    .attr("font-size", 8)
    .text("PNL ATTRIBUTION AND ENTRY VOLATILITY · SORTED BY TOTAL PNL");

  const columnX = {
    setting: margin.left,
    spark: margin.left + contentWidth * 0.07,
    optionPnl: margin.left + contentWidth * 0.36,
    hedgePnl: margin.left + contentWidth * 0.46,
    entryIv: margin.left + contentWidth * 0.56,
    sharpe: margin.left + contentWidth * 0.64,
    drawdown: margin.left + contentWidth * 0.71,
    calmar: margin.left + contentWidth * 0.78,
    win: margin.left + contentWidth * 0.84,
    profitFactor: margin.left + contentWidth * 0.90,
    cvar: margin.left + contentWidth * 0.97,
  };
  const headers = [
    { label: "SETTING", x: columnX.setting, anchor: "start", tooltip: "The sweep parameter value used for this backtest variant." },
    { label: "EQUITY", x: columnX.spark, anchor: "start", tooltip: "Cumulative weekly PnL. The white dot marks the best individual week." },
    { label: "OPTION PNL", x: columnX.optionPnl, anchor: "end", tooltip: "Cumulative option-leg PnL across completed cycles, before hedge PnL." },
    { label: "HEDGE PNL", x: columnX.hedgePnl, anchor: "end", tooltip: "Cumulative perpetual-futures hedge PnL across completed cycles." },
    { label: "AVG ENTRY IV", x: columnX.entryIv, anchor: "end", tooltip: "Mean normalized entry implied volatility across selected option legs in completed cycles." },
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
      .attr("fill", "rgba(255,255,255,0.45)").attr("font-size", 8).text(label);
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
    .attr("aria-label", (row) => `${row.label}: option PnL ${formatUsd(Number(row.optionPnl) || 0)}, hedge PnL ${formatUsd(Number(row.hedgePnl) || 0)}, average entry IV ${Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "not available"}, Sharpe ${formatSharpe(Number(row.sharpe) || 0)}, Calmar ${Number.isFinite(row.calmar) ? formatSharpe(row.calmar) : "not available"}`)
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
      .attr("fill", "rgba(255,255,255,0.78)").attr("font-size", 9).attr("font-weight", 500).text(row.label);

    const [cumMin, cumMax] = d3.extent(row.cumulative);
    const sparkX = d3.scaleLinear().domain([0, Math.max(1, row.cumulative.length - 1)]).range([columnX.spark, columnX.spark + sparkWidth]);
    const sparkY = d3.scaleLinear().domain(cumMin === cumMax ? [cumMin - 1, cumMax + 1] : [cumMin, cumMax]).range([center + 7, center - 7]);
    group.append("line").attr("x1", columnX.spark).attr("x2", columnX.spark + sparkWidth)
      .attr("y1", sparkY(0)).attr("y2", sparkY(0)).attr("stroke", "rgba(255,255,255,0.1)");
    group.append("path").datum(row.cumulative)
      .attr("d", d3.line().x((_, i) => sparkX(i)).y((value) => sparkY(value)))
      .attr("fill", "none").attr("stroke", performanceColor(Number(row.sharpe) || 0)).attr("stroke-width", 1.2);
    group.append("circle").attr("cx", sparkX(row.bestIndex + 1)).attr("cy", sparkY(row.cumulative[row.bestIndex + 1] ?? 0))
      .attr("r", 2.2).attr("fill", "#ffffff");

    const addValue = (x, value, color = "rgba(255,255,255,0.7)") => group.append("text")
      .attr("x", x).attr("y", center).attr("dy", "0.32em").attr("text-anchor", "end")
      .attr("fill", color).attr("font-size", 8.5).text(value);
    const optionPnl = Number(row.optionPnl) || 0;
    const hedgePnl = Number(row.hedgePnl) || 0;
    addValue(columnX.optionPnl, formatCompactUsd(optionPnl), optionPnlColor(optionPnl));
    addValue(columnX.hedgePnl, formatCompactUsd(hedgePnl), hedgePnlColor(hedgePnl));
    addValue(columnX.entryIv, Number.isFinite(Number(row.averageEntryIv)) ? formatIv(Number(row.averageEntryIv)) : "—");
    addValue(columnX.sharpe, formatSharpe(Number(row.sharpe) || 0), sharpeTextColor(Number(row.sharpe) || 0));
    addValue(columnX.drawdown, formatCompactUsd(Number(row.maxDrawdown) || 0), drawdownColor(Number(row.maxDrawdown) || 0));
    addValue(columnX.calmar, Number.isFinite(row.calmar) ? formatSharpe(row.calmar) : "—");
    addValue(columnX.win, d3.format(".0%")(row.winRate));
    addValue(columnX.profitFactor, d3.format(".2f")(row.profitFactor));
    addValue(columnX.cvar, formatCompactUsd(row.cvar));
  });

  const setHoveredRow = (key) => {
    distributionGroups.select(".distribution-hit-area").attr("fill", (row) => row.key === key ? "rgba(255,255,255,0.055)" : "transparent");
    rankGroups.select(".rank-hit-area").attr("fill", (row) => row.key === key ? "rgba(255,255,255,0.055)" : "transparent");
  };
  const bindHover = (selection) => selection
    .on("mouseenter", (_, row) => setHoveredRow(row.key)).on("mouseleave", () => setHoveredRow(null))
    .on("focus", (_, row) => setHoveredRow(row.key)).on("blur", () => setHoveredRow(null))
    .on("keydown", (event, row) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); emit("select", row); }
    });
  [distributionGroups, rankGroups].forEach(bindHover);
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
  () => props.rows,
  async () => {
    await nextTick();
    draw();
  },
  { flush: "post", immediate: true, deep: true },
);

function exportPng({
  filename = "sweep.png",
  scale = 3,
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
    scale: 3,
    padding: 18,
  });
}

defineExpose({ exportPng });
</script>

<template>
  <div class="chartViewport">
    <div class="chartSurface">
      <div ref="chartRef" class="chartCanvas"></div>
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

.chartCanvas :deep(.rank-row:focus),
.chartCanvas :deep(.distribution-row:focus) {
  outline: none;
}

.chartCanvas :deep(.rank-row:focus > .rank-hit-area),
.chartCanvas :deep(.distribution-row:focus > .distribution-hit-area) {
  fill: rgba(125, 211, 252, 0.08);
}
</style>
