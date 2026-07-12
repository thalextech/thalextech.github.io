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
  const boxHeaderY = rankedBottom + 50;
  const boxPlotTop = boxHeaderY + 46;
  const boxPlotBottom = boxPlotTop + 280;
  const boxAxisY = boxPlotBottom + 8;
  const boxBottom = boxAxisY + 28;
  const distributionHeaderY = boxBottom + 50;
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
    .attr("aria-label", "Ranked sweep analysis with bootstrap box plots and weekly PnL distributions");

  const sum = (values) => d3.sum(values);
  const analyzedRows = rows.map((row) => {
    const weeks = (row.weeklyReturns || [])
      .map((point) => Number(point.pnl))
      .filter(Number.isFinite);
    const total = Number.isFinite(Number(row.pnl)) ? Number(row.pnl) : sum(weeks);
    const bestWeek = d3.max(weeks) ?? 0;
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
      winRate: weeks.length ? weeks.filter((value) => value > 0).length / weeks.length : 0,
      profitFactor: negative ? positive / negative : 0,
      cvar: d3.mean(sorted.slice(-3)) ?? 0,
      cumulative,
      bestIndex,
    };
  });
  const bootstrapCount = 400;
  const sharedWeekCount = d3.min(analyzedRows.map((row) => row.weeks.length)) ?? 0;
  let randomState = 0x5f3759df;
  const nextRandom = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const bootstrapIndices = Array.from({ length: bootstrapCount }, () =>
    Array.from({ length: sharedWeekCount }, () => Math.floor(nextRandom() * sharedWeekCount)),
  );
  const bootstrapRows = analyzedRows.map((row) => {
    const samples = bootstrapIndices
      .map((indices) => sum(indices.map((index) => row.weeks[index])))
      .sort((a, b) => a - b);
    return {
      ...row,
      bootstrapSamples: samples,
      bootstrapQ05: d3.quantileSorted(samples, 0.05) ?? 0,
      bootstrapQ25: d3.quantileSorted(samples, 0.25) ?? 0,
      bootstrapMedian: d3.quantileSorted(samples, 0.5) ?? 0,
      bootstrapQ75: d3.quantileSorted(samples, 0.75) ?? 0,
      bootstrapQ95: d3.quantileSorted(samples, 0.95) ?? 0,
    };
  });
  const drawdownValues = analyzedRows.map((row) => Number(row.maxDrawdown)).filter(Number.isFinite);
  const drawdownMin = d3.min(drawdownValues) ?? 0;
  const drawdownMax = d3.max(drawdownValues) ?? 0;
  const drawdownMid = d3.median(drawdownValues) ?? (drawdownMin + drawdownMax) / 2;
  const drawdownColor = drawdownMin === drawdownMax
    ? () => d3.interpolateRdBu(0.5)
    : d3.scaleDiverging(d3.interpolateRdBu).domain([drawdownMin, drawdownMid, drawdownMax]).clamp(true);
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

  const bootstrapPlotLeft = margin.left + 58;
  const bootstrapPlotRight = margin.left + contentWidth - 8;
  const bootstrapValues = bootstrapRows.flatMap((row) => [...row.bootstrapSamples, row.total]);
  const [bootstrapMin = -1, bootstrapMax = 1] = d3.extent(bootstrapValues);
  const bootstrapSpan = bootstrapMax - bootstrapMin || Math.max(Math.abs(bootstrapMin), 1);
  const bootstrapDomain = [bootstrapMin - bootstrapSpan * 0.06, bootstrapMax + bootstrapSpan * 0.06];
  const drawBootstrapAxes = (plotTop, plotBottom, axisY) => {
    const x = d3.scalePoint()
      .domain(bootstrapRows.map((row) => row.key))
      .range([bootstrapPlotLeft, bootstrapPlotRight])
      .padding(0.45);
    const y = d3.scaleLinear().domain(bootstrapDomain).nice().range([plotBottom, plotTop]);
    const yAxis = svg.append("g")
      .attr("transform", `translate(${bootstrapPlotLeft},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(bootstrapPlotRight - bootstrapPlotLeft)).tickPadding(8).tickFormat(formatCompactUsd));
    yAxis.select(".domain").remove();
    yAxis.selectAll(".tick line").attr("stroke", "rgba(255,255,255,0.07)");
    yAxis.selectAll("text").attr("fill", "rgba(255,255,255,0.4)").attr("font-size", 8);
    const xAxis = svg.append("g")
      .attr("transform", `translate(0,${axisY})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(7).tickFormat((key) => bootstrapRows.find((row) => row.key === key)?.label || key));
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
    .text(`RESAMPLED TOTAL PNL · ${props.dimensionLabel.toUpperCase()}`);
  svg.append("text")
    .attr("x", margin.left).attr("y", boxHeaderY + 16)
    .attr("fill", "rgba(255,255,255,0.36)").attr("font-size", 8)
    .text("400 ALIGNED BOOTSTRAPS · WHISKER = 5–95% · BOX = 25–75% · LINE = MEDIAN · DOT = ACTUAL · BAND = WINNER 25–75%");
  const boxScales = drawBootstrapAxes(boxPlotTop, boxPlotBottom, boxAxisY);
  const boxWidth = Math.min(18, Math.max(8, (boxScales.x.step?.() || 30) * 0.5));
  const champion = d3.greatest(bootstrapRows, (row) => row.total);
  if (champion) {
    svg.append("rect")
      .attr("x", bootstrapPlotLeft)
      .attr("y", boxScales.y(champion.bootstrapQ75))
      .attr("width", bootstrapPlotRight - bootstrapPlotLeft)
      .attr("height", Math.max(1, boxScales.y(champion.bootstrapQ25) - boxScales.y(champion.bootstrapQ75)))
      .attr("fill", "#78aadc").attr("fill-opacity", 0.08);
    [champion.bootstrapQ25, champion.bootstrapQ75].forEach((value) => svg.append("line")
      .attr("x1", bootstrapPlotLeft).attr("x2", bootstrapPlotRight)
      .attr("y1", boxScales.y(value)).attr("y2", boxScales.y(value))
      .attr("stroke", "#78aadc").attr("stroke-opacity", 0.24).attr("stroke-width", 0.8));
    svg.append("text")
      .attr("x", bootstrapPlotRight).attr("y", boxScales.y(champion.bootstrapQ75) - 5)
      .attr("text-anchor", "end").attr("fill", "rgba(120,170,220,0.72)").attr("font-size", 8)
      .text(`WINNER IQR · ${champion.label}`);
  }
  svg.append("path")
    .datum(bootstrapRows)
    .attr("d", d3.line()
      .x((row) => boxScales.x(row.key))
      .y((row) => boxScales.y(row.bootstrapMedian)))
    .attr("fill", "none").attr("stroke", "rgba(255,255,255,0.24)").attr("stroke-width", 1.1);
  const boxGroups = svg.selectAll("g.bootstrap-box")
    .data(bootstrapRows, (row) => row.key)
    .join("g")
    .attr("class", "bootstrap-box")
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row));
  boxGroups.each(function (row) {
    const group = d3.select(this);
    const center = boxScales.x(row.key);
    const color = sharpeColor(Number(row.sharpe) || 0);
    group.append("line")
      .attr("x1", center).attr("x2", center)
      .attr("y1", boxScales.y(row.bootstrapQ95)).attr("y2", boxScales.y(row.bootstrapQ05))
      .attr("stroke", "rgba(255,255,255,0.45)");
    [row.bootstrapQ05, row.bootstrapQ95].forEach((value) => group.append("line")
      .attr("x1", center - boxWidth * 0.3).attr("x2", center + boxWidth * 0.3)
      .attr("y1", boxScales.y(value)).attr("y2", boxScales.y(value))
      .attr("stroke", "rgba(255,255,255,0.45)"));
    group.append("rect")
      .attr("x", center - boxWidth / 2).attr("width", boxWidth)
      .attr("y", boxScales.y(row.bootstrapQ75))
      .attr("height", Math.max(1, boxScales.y(row.bootstrapQ25) - boxScales.y(row.bootstrapQ75)))
      .attr("rx", 1.5).attr("fill", color).attr("fill-opacity", 0.55);
    group.append("line")
      .attr("x1", center - boxWidth / 2).attr("x2", center + boxWidth / 2)
      .attr("y1", boxScales.y(row.bootstrapMedian)).attr("y2", boxScales.y(row.bootstrapMedian))
      .attr("stroke", "#ffffff").attr("stroke-width", 1.2);
    group.append("circle")
      .attr("cx", center).attr("cy", boxScales.y(row.total)).attr("r", 2.2)
      .attr("fill", "#c9a66b");
    group.append("title").text(`${row.label}\n5–95%: ${formatUsd(row.bootstrapQ05)} to ${formatUsd(row.bootstrapQ95)}\n25–75%: ${formatUsd(row.bootstrapQ25)} to ${formatUsd(row.bootstrapQ75)}\nMedian: ${formatUsd(row.bootstrapMedian)}\nActual: ${formatUsd(row.total)}`);
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
  distributionAxis.select(".domain").attr("stroke", "rgba(255,255,255,0.16)");
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
    addValue(columnX.drawdown, formatCompactUsd(Number(row.maxDrawdown) || 0), drawdownColor(Number(row.maxDrawdown) || 0));
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
