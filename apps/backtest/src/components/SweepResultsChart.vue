<script setup>
import * as d3 from "d3";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  dimensionLabel: { type: String, default: "Sweep setting" },
});

const emit = defineEmits(["select"]);
const chartRef = ref(null);
let resizeObserver;

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatSharpe = d3.format(".2f");

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

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
  const responseHeaderY = rankedBottom + 50;
  const responsePlotTop = responseHeaderY + 46;
  const responsePlotHeight = 190;
  const responsePlotBottom = responsePlotTop + responsePlotHeight;
  const responseAxisY = responsePlotBottom + 8;
  const responseBottom = responseAxisY + 28;
  const distributionHeaderY = responseBottom + 50;
  const distributionAxisY = distributionHeaderY + 39;
  const distributionRowsY = distributionAxisY + 16;
  const distributionRowHeight = 26;
  const distributionBottom = distributionRowsY + rows.length * distributionRowHeight;
  const width = Math.max(availableWidth, margin.left + contentWidth + margin.right);
  const height = distributionBottom + 36;

  const shVals = rows.map((r) => Number(r.sharpe)).filter(Number.isFinite);
  const sharpeMin = d3.min(shVals) ?? 0;
  const sharpeMax = d3.max(shVals) ?? 1;
  const sharpeMid = d3.median(shVals) ?? (sharpeMin + sharpeMax) / 2;
  const sharpeColor = sharpeMin === sharpeMax
    ? () => d3.interpolateRdBu(0.5)
    : d3.scaleDiverging(d3.interpolateRdBu).domain([sharpeMin, sharpeMid, sharpeMax]).clamp(true);

  const svg = d3.select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr("aria-label", "Ranked sweep analysis with parameter response curves and weekly PnL distributions");

  const sum = (values) => d3.sum(values);
  const analyzedRows = rows.map((row) => {
    const weeks = (row.weeklyReturns || [])
      .map((point) => Number(point.pnl))
      .filter(Number.isFinite);
    const total = Number.isFinite(Number(row.pnl)) ? Number(row.pnl) : sum(weeks);
    const bestWeek = d3.max(weeks) ?? 0;
    const worstWeek = d3.min(weeks) ?? 0;
    const bestIndex = weeks.indexOf(bestWeek);
    const sorted = [...weeks].sort((a, b) => b - a);
    const positive = sum(weeks.filter((value) => value > 0));
    const negative = Math.abs(sum(weeks.filter((value) => value < 0)));
    const cumulative = [0];
    weeks.forEach((value) => cumulative.push(cumulative[cumulative.length - 1] + value));
    return {
      ...row,
      weeks,
      total,
      robustPnl: total - bestWeek,
      trimmedPnl: total - bestWeek - worstWeek,
      trimmedThreePnl: total - sum(sorted.slice(0, 3)) - sum(sorted.slice(-3)),
      winRate: weeks.length ? weeks.filter((value) => value > 0).length / weeks.length : 0,
      profitFactor: negative ? positive / negative : 0,
      cvar: d3.mean(sorted.slice(-3)) ?? 0,
      cumulative,
      bestIndex,
    };
  });
  const cvarValues = analyzedRows.map((row) => row.cvar).filter(Number.isFinite);
  const cvarMin = d3.min(cvarValues) ?? 0;
  const cvarMax = d3.max(cvarValues) ?? 0;
  const cvarMid = d3.median(cvarValues) ?? (cvarMin + cvarMax) / 2;
  const cvarColor = cvarMin === cvarMax
    ? () => d3.interpolateRdBu(0.5)
    : d3.scaleDiverging(d3.interpolateRdBu).domain([cvarMin, cvarMid, cvarMax]).clamp(true);
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

  svg.append("line")
    .attr("x1", margin.left).attr("x2", margin.left + contentWidth)
    .attr("y1", responseHeaderY - 24).attr("y2", responseHeaderY - 24)
    .attr("stroke", "rgba(255,255,255,0.12)");
  svg.append("text")
    .attr("x", margin.left).attr("y", responseHeaderY)
    .attr("fill", "rgba(255,255,255,0.64)").attr("font-size", 10).attr("font-weight", 500)
    .text(`RESPONSE CURVE · ${props.dimensionLabel.toUpperCase()}`);
  svg.append("text")
    .attr("x", margin.left).attr("y", responseHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)").attr("font-size", 8)
    .text("PARAMETER ORDER · TOTAL PNL COMPARED AFTER TRIMMING ONE OR THREE WEEKS FROM EACH TAIL");

  const responsePlotLeft = margin.left + 58;
  const responsePlotRight = margin.left + contentWidth - 8;
  const responseValues = analyzedRows.flatMap((row) => [row.total, row.trimmedPnl, row.trimmedThreePnl]);
  const [responseMin = -1, responseMax = 1] = d3.extent(responseValues);
  const responseSpan = responseMax - responseMin || Math.max(Math.abs(responseMin), 1);
  const responseX = d3.scalePoint()
    .domain(analyzedRows.map((row) => row.key))
    .range([responsePlotLeft, responsePlotRight])
    .padding(0.35);
  const responseY = d3.scaleLinear()
    .domain([responseMin - responseSpan * 0.08, responseMax + responseSpan * 0.08])
    .nice()
    .range([responsePlotBottom, responsePlotTop]);
  const responseYAxis = svg.append("g")
    .attr("transform", `translate(${responsePlotLeft},0)`)
    .call(d3.axisLeft(responseY).ticks(5).tickSize(-(responsePlotRight - responsePlotLeft)).tickPadding(8).tickFormat(formatCompactUsd));
  responseYAxis.select(".domain").remove();
  responseYAxis.selectAll(".tick line").attr("stroke", "rgba(255,255,255,0.07)");
  responseYAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.4)").attr("font-size", 8);
  if (responseY.domain()[0] <= 0 && responseY.domain()[1] >= 0) {
    svg.append("line")
      .attr("x1", responsePlotLeft).attr("x2", responsePlotRight)
      .attr("y1", responseY(0)).attr("y2", responseY(0))
      .attr("stroke", "rgba(255,255,255,0.28)");
  }
  const responseXAxis = svg.append("g")
    .attr("transform", `translate(0,${responseAxisY})`)
    .call(d3.axisBottom(responseX).tickSize(0).tickPadding(7).tickFormat((key) => analyzedRows.find((row) => row.key === key)?.label || key));
  responseXAxis.select(".domain").attr("stroke", "rgba(255,255,255,0.14)");
  responseXAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.46)").attr("font-size", 7.5);

  const responseSeries = [
    { label: "Total PnL", field: "total", color: "#78aadc", dash: null },
    { label: "Ex best + worst", field: "trimmedPnl", color: "rgba(255,255,255,0.72)", dash: "4 3" },
    { label: "Ex top + bottom 3", field: "trimmedThreePnl", color: "#c9a66b", dash: "2 3" },
  ];
  const responseLine = (field) => d3.line()
    .x((row) => responseX(row.key))
    .y((row) => responseY(row[field]));
  responseSeries.forEach((series) => {
    svg.append("path")
      .datum(analyzedRows)
      .attr("d", responseLine(series.field))
      .attr("fill", "none").attr("stroke", series.color).attr("stroke-width", 1.5)
      .attr("stroke-dasharray", series.dash);
    const points = svg.selectAll(`circle.response-${series.field}`)
      .data(analyzedRows, (row) => row.key)
      .join("circle")
      .attr("class", `response-${series.field}`)
      .attr("cx", (row) => responseX(row.key)).attr("cy", (row) => responseY(row[series.field]))
      .attr("r", series.field === "total" ? 2.4 : 1.9)
      .attr("fill", series.color)
      .style("cursor", "pointer")
      .on("click", (_, row) => emit("select", row));
    points.append("title").text((row) => `${row.label} · ${series.label}\n${formatUsd(row[series.field])}`);
  });
  let legendX = responsePlotRight;
  [...responseSeries].reverse().forEach((series) => {
    const labelWidth = series.label.length * 5.4 + 31;
    legendX -= labelWidth;
    svg.append("line")
      .attr("x1", legendX).attr("x2", legendX + 20).attr("y1", responseHeaderY).attr("y2", responseHeaderY)
      .attr("stroke", series.color).attr("stroke-width", 1.5).attr("stroke-dasharray", series.dash);
    svg.append("text")
      .attr("x", legendX + 25).attr("y", responseHeaderY).attr("dy", "0.32em")
      .attr("fill", "rgba(255,255,255,0.52)").attr("font-size", 8)
      .text(series.label);
  });

  svg.append("text")
    .attr("x", margin.left).attr("y", distributionHeaderY)
    .attr("fill", "rgba(255,255,255,0.64)").attr("font-size", 10).attr("font-weight", 500)
    .text("WEEKLY PNL DISTRIBUTION");
  svg.append("text")
    .attr("x", margin.left).attr("y", distributionHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)").attr("font-size", 8)
    .text("ROWS RANKED BY TOTAL PNL · SHARED WEEKLY SCALE · BLUE = UP · RED = DOWN · LINE = MEDIAN · WHITE BORDER = BEST WEEK");

  const distributionPlotLeft = margin.left + 62;
  const distributionSummaryWidth = 300;
  const distributionPlotRight = margin.left + contentWidth - distributionSummaryWidth;
  const distributionSummaryX = distributionPlotRight + 22;
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
  distributionAxis.select(".domain").attr("stroke", "rgba(255,255,255,0.16)");
  distributionAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.42)").attr("font-size", 8);
  const distributionSummaryHeader = svg.append("text")
    .attr("x", distributionSummaryX).attr("y", distributionAxisY - 7)
    .attr("fill", "rgba(255,255,255,0.38)").attr("font-size", 8)
    .text("MAX · MIN · AVG · MEDIAN");
  distributionSummaryHeader
    .on("mouseenter", () => showHeaderTooltip(distributionSummaryX, distributionAxisY - 7, "Maximum, minimum, average, and median weekly PnL for each sweep setting."))
    .on("mouseleave", hideHeaderTooltip);
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
    group.append("text")
      .attr("x", distributionSummaryX).attr("y", center).attr("dy", "0.32em")
      .attr("fill", "rgba(255,255,255,0.72)").attr("font-size", 8.5)
      .text(`${formatCompactUsd(d3.max(row.weeks) ?? 0)} · ${formatCompactUsd(d3.min(row.weeks) ?? 0)} · ${formatCompactUsd(d3.mean(row.weeks) ?? 0)} · ${formatCompactUsd(median)}`);
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
    .text("TOTAL PNL COMPARED WITH PNL AFTER REMOVING THE BEST WEEK · SORTED BY TOTAL PNL");

  const columnX = {
    setting: margin.left,
    spark: margin.left + contentWidth * 0.07,
    pnl: margin.left + contentWidth * 0.25,
    pnlValue: margin.left + contentWidth * 0.56,
    sharpe: margin.left + contentWidth * 0.64,
    drawdown: margin.left + contentWidth * 0.72,
    win: margin.left + contentWidth * 0.79,
    profitFactor: margin.left + contentWidth * 0.86,
    cvar: margin.left + contentWidth * 0.93,
  };
  const headers = [
    { label: "SETTING", x: columnX.setting, anchor: "start", tooltip: "The sweep parameter value used for this backtest variant." },
    { label: "EQUITY", x: columnX.spark, anchor: "start", tooltip: "Cumulative weekly PnL. The white dot marks the best individual week." },
    { label: "TOTAL → EX BEST", x: columnX.pnl, anchor: "start", tooltip: "Total PnL compared with total PnL after subtracting the single best week. A large gap indicates outlier dependence." },
    { label: "SHARPE", x: columnX.sharpe, anchor: "end", tooltip: "Annualized weekly Sharpe: average weekly PnL divided by weekly PnL volatility, multiplied by √52." },
    { label: "MAX DD", x: columnX.drawdown, anchor: "end", tooltip: "Largest peak-to-trough loss in cumulative PnL during the backtest." },
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

  const maxAbsPnl = d3.max(analyzedRows.flatMap((row) => [Math.abs(row.total), Math.abs(row.robustPnl)])) || 1;
  const pnlBarWidth = contentWidth * 0.18;
  const pnlBarScale = d3.scaleLinear().domain([0, maxAbsPnl]).range([0, pnlBarWidth]);
  const sparkWidth = contentWidth * 0.145;
  const rankGroups = svg.selectAll("g.rank-row")
    .data(rankedRows, (row) => row.key)
    .join("g")
    .attr("class", "rank-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) => `${row.label}: total PnL ${formatUsd(row.total)}, excluding best week ${formatUsd(row.robustPnl)}, Sharpe ${formatSharpe(Number(row.sharpe) || 0)}`)
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
      .attr("fill", "none").attr("stroke", sharpeColor(Number(row.sharpe) || 0)).attr("stroke-width", 1.2);
    group.append("circle").attr("cx", sparkX(row.bestIndex + 1)).attr("cy", sparkY(row.cumulative[row.bestIndex + 1] ?? 0))
      .attr("r", 2.2).attr("fill", "#ffffff");

    [[row.total, 0, 0.32], [row.robustPnl, 6, 0.9]].forEach(([value, offset, opacity]) => {
      group.append("rect").attr("x", columnX.pnl).attr("y", center - 6 + offset)
        .attr("width", pnlBarScale(Math.abs(value))).attr("height", 5).attr("rx", 1)
        .attr("fill", value >= 0 ? "#78aadc" : "#cf6a5a").attr("fill-opacity", opacity);
    });
    group.append("text").attr("x", columnX.pnlValue).attr("y", center).attr("dy", "0.32em")
      .attr("text-anchor", "end").attr("fill", "rgba(255,255,255,0.72)").attr("font-size", 8.5)
      .text(`${formatCompactUsd(row.total)} → ${formatCompactUsd(row.robustPnl)}`);
    const addValue = (x, value, color = "rgba(255,255,255,0.7)") => group.append("text")
      .attr("x", x).attr("y", center).attr("dy", "0.32em").attr("text-anchor", "end")
      .attr("fill", color).attr("font-size", 8.5).text(value);
    addValue(columnX.sharpe, formatSharpe(Number(row.sharpe) || 0), sharpeColor(Number(row.sharpe) || 0));
    addValue(columnX.drawdown, formatCompactUsd(Number(row.maxDrawdown) || 0));
    addValue(columnX.win, d3.format(".0%")(row.winRate));
    addValue(columnX.profitFactor, d3.format(".2f")(row.profitFactor));
    addValue(columnX.cvar, formatCompactUsd(row.cvar), cvarColor(row.cvar));
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

defineExpose({ exportPng });
</script>

<template>
  <div ref="chartRef" class="chart"></div>
</template>

<style scoped>
.chart {
  width: 100%;
  min-height: 280px;
  max-height: calc(100vh - 210px);
  overflow: auto;
}

.chart :deep(svg) {
  display: block;
  max-width: none;
}

.chart :deep(.rank-row:focus),
.chart :deep(.distribution-row:focus) {
  outline: none;
}

.chart :deep(.rank-row:focus > .rank-hit-area),
.chart :deep(.distribution-row:focus > .distribution-hit-area) {
  fill: rgba(125, 211, 252, 0.08);
}
</style>
