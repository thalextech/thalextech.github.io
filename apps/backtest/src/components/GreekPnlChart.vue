<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import { calculateRvPlotLayout } from "../lib/rvChartLayout.js";
import { varianceContribution } from "../lib/statistics.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  cycleRows: { type: Array, default: () => [] },
  underlying: { type: String, default: "BTC" },
});

const chartRef = ref(null);
let resizeObserver;
let brushedDomain = null;

const FONT = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatDate = d3.utcFormat("%d %b %Y");
const INDEX_COLOR = "#a4a8ae";
const TOTAL_COLOR = "#f1f2f4";
const SERIES = [
  { key: "cumulativeGammaThetaPnlUsd", cycleKey: "gammaThetaPnlUsd", label: "Gamma–theta", color: "#6f9fe8", width: 1.15 },
  { key: "cumulativeNetDeltaPnlUsd", cycleKey: "netDeltaPnlUsd", label: "Net delta", color: "#f47a43", width: 1.15 },
  { key: "cumulativeVegaPnlUsd", cycleKey: "vegaPnlUsd", label: "Vega", color: "#71c7c9", width: 1.15 },
  { key: "cumulativeVannaPnlUsd", cycleKey: "vannaPnlUsd", label: "Vanna", color: "#e5c76b", width: 1.15 },
  { key: "cumulativeVolgaPnlUsd", cycleKey: "volgaPnlUsd", label: "Volga", color: "#a883d1", width: 1.15 },
  { key: "cumulativeResidualPnlUsd", cycleKey: "residualPnlUsd", label: "Residual", color: "#8f949c", width: 1.15 },
  { key: "cumulativeTotalPnlUsd", cycleKey: "totalPnlUsd", label: "Total", color: TOTAL_COLOR, width: 2 },
];
const TOTAL_SERIES = SERIES.at(-1);
let selectedSeriesKey = TOTAL_SERIES.key;

function normalizeRows(rows) {
  return (rows || [])
    .map((row) => ({
      ...row,
      ts: Number(row?.ts),
      date: new Date(Number(row?.ts) * 1000),
    }))
    .filter((row) => Number.isFinite(row.ts) && !Number.isNaN(row.date.getTime()))
    .sort((first, second) => first.ts - second.ts);
}

function normalizeCycleRows(rows) {
  return (rows || [])
    .map((row) => ({
      ...row,
      exitTs: Number(row?.exitTs),
      exitDate: new Date(Number(row?.exitTs) * 1000),
    }))
    .filter((row) => Number.isFinite(row.exitTs) && !Number.isNaN(row.exitDate.getTime()))
    .sort((first, second) => first.exitTs - second.exitTs);
}

function paddedDomain(values, ratio = 0.07) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [-1, 1];
  let [low, high] = d3.extent(finite);
  if (low === high) {
    const padding = Math.max(1, Math.abs(low) * ratio);
    return [low - padding, high + padding];
  }
  const padding = Math.max(1, (high - low) * ratio);
  return [low - padding, high + padding];
}

function styleAxis(group) {
  group.selectAll("path, line").remove();
  group.selectAll("text")
    .attr("fill", "#8f949c")
    .style("font", `11px ${FONT}`);
}

function addLegendItem(group, series, x) {
  const item = group.append("g")
    .attr("transform", `translate(${x},0)`);
  item.append("line")
    .attr("x2", 20)
    .attr("stroke", series.color)
    .attr("stroke-width", series.width)
    .attr("stroke-dasharray", series.dasharray || null);
  item.append("text")
    .attr("x", 27).attr("y", 4)
    .attr("fill", "#c5c8cd")
    .style("font", `11px ${FONT}`)
    .text(series.label);
  return Math.max(82, series.label.length * 6.2 + 46);
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort(d3.ascending);
  if (!sorted.length) return null;
  return {
    median: d3.quantileSorted(sorted, 0.5),
    q10: d3.quantileSorted(sorted, 0.1),
    q25: d3.quantileSorted(sorted, 0.25),
    q75: d3.quantileSorted(sorted, 0.75),
    q90: d3.quantileSorted(sorted, 0.9),
    winRate: d3.mean(sorted, (value) => value > 0 ? 1 : 0),
    sum: d3.sum(sorted),
  };
}

function sumComponent(cycles, key) {
  return d3.sum(cycles, (row) => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? value : 0;
  });
}

function selectOverviewSeries(key) {
  if (selectedSeriesKey === key) return;
  selectedSeriesKey = key;
  draw();
}

function draw() {
  const host = chartRef.value;
  if (!host) return;
  host.innerHTML = "";
  const rows = normalizeRows(props.rows);
  const cycleRows = normalizeCycleRows(props.cycleRows);
  const activeSeries = SERIES.find((series) => series.key === selectedSeriesKey) || TOTAL_SERIES;
  const bounds = host.getBoundingClientRect();
  const width = Math.max(860, bounds.width || 1200);
  const height = Math.max(720, bounds.height || window.innerHeight - bounds.top - 18);
  const { plotLeft, plotWidth } = calculateRvPlotLayout(width);
  const margin = {
    top: 34,
    right: width - plotLeft - plotWidth,
    bottom: 26,
    left: plotLeft,
  };
  const gap = Math.round(Math.max(72, Math.min(112, height * 0.105)));
  const overviewHeight = Math.round(Math.max(260, Math.min(360, height * 0.36)));
  const detailTop = margin.top + overviewHeight + gap;
  const innerWidth = plotWidth;

  const svg = d3.select(host).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", height)
    .attr("font-family", FONT)
    .attr("role", "img")
    .attr("aria-label", `${activeSeries.label} PnL and ${props.underlying} index overview with brushed Greek contribution summary table`);

  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle")
      .attr("fill", "#777c84").attr("font-size", 13)
      .text("No attribution data");
    return;
  }

  let fullDateDomain = d3.extent(rows, (row) => row.date);
  if (+fullDateDomain[0] === +fullDateDomain[1]) {
    fullDateDomain = [
      new Date(+fullDateDomain[0] - 43_200_000),
      new Date(+fullDateDomain[1] + 43_200_000),
    ];
  }
  const xOverview = d3.scaleUtc().domain(fullDateDomain).range([0, innerWidth]);
  const yOverview = d3.scaleLinear()
    .domain(paddedDomain([
      0,
      ...rows.map((row) => row[activeSeries.key]),
    ]))
    .nice(5)
    .range([overviewHeight, 0]);
  const indexRows = rows.filter((row) => Number.isFinite(row.indexPrice));
  const yIndex = d3.scaleLinear()
    .domain(paddedDomain(indexRows.map((row) => row.indexPrice)))
    .nice(5)
    .range([overviewHeight, 0]);
  const overview = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  overview.append("text")
    .attr("x", 0).attr("y", -18)
    .attr("fill", "#8f949c").style("font", `10px ${FONT}`)
    .text("OVERVIEW · DRAG TO SELECT A PERIOD");
  overview.append("g")
    .call(d3.axisLeft(yOverview).ticks(4).tickFormat(formatUsd).tickPadding(12))
    .call(styleAxis);
  overview.append("g")
    .attr("transform", `translate(${innerWidth},0)`)
    .call(d3.axisRight(yIndex).ticks(4).tickFormat(d3.format("~s")).tickPadding(12))
    .call(styleAxis);
  overview.append("g")
    .attr("transform", `translate(0,${overviewHeight})`)
    .call(d3.axisBottom(xOverview).ticks(width < 960 ? 5 : 9).tickFormat(d3.utcFormat("%b %y")).tickPadding(12))
    .call(styleAxis);

  const overviewLegend = overview.append("g")
    .attr("transform", "translate(260,-18)");
  const activeLegendWidth = addLegendItem(overviewLegend, activeSeries, 0);
  addLegendItem(overviewLegend, {
    key: "indexPrice",
    label: `${props.underlying} index`,
    color: INDEX_COLOR,
    width: 1,
    dasharray: "3 4",
  }, activeLegendWidth);

  const overviewLine = d3.line()
    .defined((row) => Number.isFinite(row[activeSeries.key]))
    .x((row) => xOverview(row.date))
    .y((row) => yOverview(row[activeSeries.key]))
    .curve(d3.curveStepAfter);
  overview.append("path")
    .datum(rows)
    .attr("fill", "none").attr("stroke", activeSeries.color).attr("stroke-width", activeSeries.width)
    .attr("d", overviewLine);

  const indexLine = d3.line()
    .defined((row) => Number.isFinite(row.indexPrice))
    .x((row) => xOverview(row.date))
    .y((row) => yIndex(row.indexPrice))
    .curve(d3.curveLinear);
  overview.append("path")
    .datum(indexRows)
    .attr("fill", "none").attr("stroke", INDEX_COLOR).attr("stroke-width", 1)
    .attr("stroke-opacity", 0.72).attr("stroke-dasharray", "3 4")
    .attr("d", indexLine);

  const detail = svg.append("g")
    .attr("transform", `translate(${margin.left},${detailTop})`);

  const drawDetail = (domain = null) => {
    detail.selectAll("*").remove();
    const from = domain?.[0] || fullDateDomain[0];
    const to = domain?.[1] || fullDateDomain[1];
    const selectedCycles = cycleRows.filter(
      (row) => row.exitDate >= from && row.exitDate <= to,
    );
    const rangeText = `${formatDate(from)} – ${formatDate(to)}`;

    detail.append("text")
      .attr("x", 0).attr("y", -10)
      .attr("fill", "#8f949c").style("font", `11px ${FONT}`)
      .text(`Distribution across ${selectedCycles.length} closed cycles · exits ${rangeText} · click a component to plot it above`);

    if (!selectedCycles.length) {
      detail.append("text")
        .attr("x", innerWidth / 2).attr("y", 150).attr("text-anchor", "middle")
        .attr("fill", "#777c84").style("font", `12px ${FONT}`)
        .text("No closed cycles in the selected period");
      return;
    }

    const totalOutcomes = selectedCycles.map((row) => Number(row.totalPnlUsd));
    const totalPnl = d3.sum(totalOutcomes);
    const rankedCycles = selectedCycles
      .filter((row) => Number.isFinite(Number(row.totalPnlUsd)))
      .sort((first, second) => Number(first.totalPnlUsd) - Number(second.totalPnlUsd));
    const extremeCount = Math.min(5, rankedCycles.length);
    const worstCycles = rankedCycles.slice(0, extremeCount);
    const bestCycles = rankedCycles.slice(-extremeCount);
    const summaries = SERIES.map((series) => {
      const outcomes = selectedCycles.map((row) => Number(row[series.cycleKey]));
      const stats = summarize(outcomes);
      return {
        ...series,
        ...stats,
        share: series.cycleKey === "totalPnlUsd"
          ? 1
          : Math.abs(totalPnl) > 1e-9 ? stats.sum / totalPnl : Number.NaN,
        varianceShare: varianceContribution(outcomes, totalOutcomes),
        worstExtremeSum: sumComponent(worstCycles, series.cycleKey),
        bestExtremeSum: sumComponent(bestCycles, series.cycleKey),
      };
    });
    const componentX = 0;
    const medianX = innerWidth * 0.16;
    const distributionStart = innerWidth * 0.21;
    const distributionEnd = innerWidth * 0.43;
    const distributionMid = (distributionStart + distributionEnd) / 2;
    const contributionX = innerWidth * 0.51;
    const shareX = innerWidth * 0.61;
    const varianceX = innerWidth * 0.70;
    const winX = innerWidth * 0.78;
    const worstX = innerWidth * 0.90;
    const bestX = innerWidth - 4;
    const headerY = 24;
    const rowStart = 49;
    const rowHeight = height < 840 ? 36 : height < 920 ? 39 : 43;
    const maxDistributionMagnitude = Math.max(
      1,
      ...summaries.flatMap((row) => [Math.abs(row.q10), Math.abs(row.q90)]),
    );
    const distributionX = d3.scaleLinear()
      .domain([-maxDistributionMagnitude, maxDistributionMagnitude])
      .range([distributionStart, distributionEnd]);

    const header = (text, x, anchor = "middle") => detail.append("text")
      .attr("x", x).attr("y", headerY).attr("text-anchor", anchor)
      .attr("fill", "#aeb2b8").style("font", `11px ${FONT}`).text(text);
    header("Component", componentX, "start");
    header("Median", medianX, "end");
    header("IQR (25%–75%)", distributionMid);
    header("Total P&L", contributionX);
    header("% of total P&L", shareX);
    header("Variance %", varianceX).append("title")
      .text("Covariance of component and total P&L divided by variance of total P&L");
    header("Win %", winX);
    header(`Worst ${extremeCount} sum`, worstX, "end").append("title")
      .text(`Dollar sum for this component across the ${extremeCount} cycles with the lowest total strategy P&L`);
    header(`Best ${extremeCount} sum`, bestX, "end").append("title")
      .text(`Dollar sum for this component across the ${extremeCount} cycles with the highest total strategy P&L`);
    detail.append("line")
      .attr("x1", 0).attr("x2", innerWidth).attr("y1", 34).attr("y2", 34)
      .attr("stroke", "rgba(255,255,255,.13)");
    detail.append("line")
      .attr("x1", distributionX(0)).attr("x2", distributionX(0))
      .attr("y1", rowStart - 11).attr("y2", rowStart + (summaries.length - 1) * rowHeight + 11)
      .attr("stroke", "rgba(255,255,255,.12)");

    summaries.forEach((row, index) => {
      const y = rowStart + index * rowHeight;
      const isTotal = row.cycleKey === "totalPnlUsd";
      if (isTotal) {
        detail.append("line")
          .attr("x1", 0).attr("x2", innerWidth).attr("y1", y - 22).attr("y2", y - 22)
          .attr("stroke", "rgba(255,255,255,.24)");
      }
      const isSelected = row.key === activeSeries.key;
      const rowGroup = detail.append("g")
        .attr("role", "button")
        .attr("tabindex", 0)
        .attr("aria-label", `Show cumulative ${row.label} P&L in the overview`)
        .attr("aria-pressed", isSelected ? "true" : "false")
        .style("cursor", "pointer")
        .on("click", () => selectOverviewSeries(row.key))
        .on("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectOverviewSeries(row.key);
        });
      rowGroup.append("rect")
        .attr("x", -6).attr("y", y - 14)
        .attr("width", innerWidth + 12).attr("height", 35).attr("rx", 4)
        .attr("fill", isSelected ? "rgba(255,255,255,.055)" : "transparent");
      if (!isTotal) {
        rowGroup.append("circle")
          .attr("cx", componentX + 4).attr("cy", y - 1).attr("r", 4)
          .attr("fill", row.color);
      }
      rowGroup.append("text")
        .attr("x", componentX + (isTotal ? 0 : 16)).attr("y", y + 3)
        .attr("fill", "#e3e5e8").style("font", `${isTotal ? 500 : 400} 12px ${FONT}`)
        .text(row.label);
      rowGroup.append("text")
        .attr("x", medianX).attr("y", y + 3).attr("text-anchor", "end")
        .attr("fill", row.median < 0 ? "#f47a43" : "#d7dade")
        .style("font", `${isTotal ? 500 : 400} 12px ${FONT}`)
        .text(formatUsd(row.median));

      const boxplot = rowGroup.append("g");
      boxplot.append("line")
        .attr("x1", distributionX(row.q10)).attr("x2", distributionX(row.q90))
        .attr("y1", y).attr("y2", y).attr("stroke", row.color).attr("stroke-opacity", 0.8);
      [row.q10, row.q90].forEach((value) => {
        boxplot.append("line")
          .attr("x1", distributionX(value)).attr("x2", distributionX(value))
          .attr("y1", y - 4).attr("y2", y + 4).attr("stroke", row.color);
      });
      boxplot.append("rect")
        .attr("x", distributionX(row.q25))
        .attr("y", y - 7)
        .attr("width", Math.max(2, distributionX(row.q75) - distributionX(row.q25)))
        .attr("height", 14).attr("fill", row.color).attr("fill-opacity", 0.72);
      boxplot.append("line")
        .attr("x1", distributionX(row.median)).attr("x2", distributionX(row.median))
        .attr("y1", y - 10).attr("y2", y + 10)
        .attr("stroke", "#f3f4f6").attr("stroke-width", 1.2);
      boxplot.append("title").text(
        `10th ${formatUsd(row.q10)} · 25th ${formatUsd(row.q25)} · Median ${formatUsd(row.median)} · 75th ${formatUsd(row.q75)} · 90th ${formatUsd(row.q90)}`,
      );

      rowGroup.append("text")
        .attr("x", shareX).attr("y", y + 3).attr("text-anchor", "middle")
        .attr("fill", row.share < 0 ? "#f47a43" : "#d7dade")
        .style("font", `${isTotal ? 500 : 400} 12px ${FONT}`)
        .text(Number.isFinite(row.share) ? d3.format(".0%")(row.share) : "—");
      rowGroup.append("text")
        .attr("x", contributionX).attr("y", y + 3).attr("text-anchor", "middle")
        .attr("fill", row.sum < 0 ? "#f47a43" : "#d7dade")
        .style("font", `${isTotal ? 500 : 400} 12px ${FONT}`)
        .text(formatUsd(row.sum));
      rowGroup.append("text")
        .attr("x", varianceX).attr("y", y + 3).attr("text-anchor", "middle")
        .attr("fill", row.varianceShare < 0 ? "#f47a43" : "#d7dade")
        .style("font", `${isTotal ? 500 : 400} 12px ${FONT}`)
        .text(Number.isFinite(row.varianceShare) ? d3.format(".0%")(row.varianceShare) : "—");
      rowGroup.append("text")
        .attr("x", winX).attr("y", y + 3).attr("text-anchor", "middle")
        .attr("fill", "#d7dade").style("font", `12px ${FONT}`)
        .text(d3.format(".0%")(row.winRate));
      rowGroup.append("text")
        .attr("x", worstX).attr("y", y + 3).attr("text-anchor", "end")
        .attr("fill", row.worstExtremeSum < 0 ? "#f47a43" : "#d7dade")
        .style("font", `12px ${FONT}`).text(formatUsd(row.worstExtremeSum));
      rowGroup.append("text")
        .attr("x", bestX).attr("y", y + 3).attr("text-anchor", "end")
        .attr("fill", row.bestExtremeSum < 0 ? "#f47a43" : "#d7dade")
        .style("font", `12px ${FONT}`).text(formatUsd(row.bestExtremeSum));
      rowGroup.append("line")
        .attr("x1", 0).attr("x2", innerWidth).attr("y1", y + 21).attr("y2", y + 21)
        .attr("stroke", "rgba(255,255,255,.07)");
    });

    const footerY = rowStart + summaries.length * rowHeight + 2;
    detail.append("text")
      .attr("x", 0).attr("y", footerY)
      .attr("fill", "#777c84").style("font", `10px ${FONT}`)
      .text(`IQR = middle 50% · whiskers = 10th–90th percentile · extremes = component sums across the same ${extremeCount} worst/best strategy cycles`);
    detail.append("text")
      .attr("x", innerWidth).attr("y", footerY).attr("text-anchor", "end")
      .attr("fill", "#777c84").style("font", `10px ${FONT}`)
      .text("% of total P&L = aggregate component contribution ÷ aggregate strategy P&L");
    detail.append("text")
      .attr("x", innerWidth).attr("y", footerY + 15).attr("text-anchor", "end")
      .attr("fill", "#777c84").style("font", `10px ${FONT}`)
      .text("Variance % = Cov(component P&L, strategy P&L) ÷ Var(strategy P&L)");
  };

  let brushBorders;
  const updateBrushBorders = (selection) => {
    brushBorders?.selectAll("*").remove();
    if (!selection || !brushBorders) return;
    const [fromX, toX] = selection;
    for (const y of [0.5, overviewHeight - 0.5]) {
      brushBorders.append("line")
        .attr("x1", fromX).attr("x2", toX)
        .attr("y1", y).attr("y2", y)
        .attr("stroke", "#93c5fd")
        .attr("stroke-opacity", 0.72)
        .attr("stroke-width", 1);
    }
  };

  const brush = d3.brushX()
    .extent([[0, 0], [innerWidth, overviewHeight]])
    .filter((event) => !event.ctrlKey && !event.button)
    .on("brush", (event) => {
      updateBrushBorders(event.selection);
      if (!event.selection) {
        drawDetail(null);
        return;
      }
      const [from, to] = event.selection.map(xOverview.invert);
      drawDetail(from <= to ? [from, to] : [to, from]);
    })
    .on("end", (event) => {
      updateBrushBorders(event.selection);
      if (!event.selection) {
        brushedDomain = null;
        drawDetail(null);
        return;
      }
      const [from, to] = event.selection.map(xOverview.invert);
      brushedDomain = from <= to ? [from, to] : [to, from];
      drawDetail(brushedDomain);
    });
  const brushGroup = overview.append("g").attr("class", "brush").call(brush);
  brushGroup.selectAll(".selection")
    .attr("fill", "#93c5fd").attr("fill-opacity", 0.16)
    .attr("stroke", "none");
  brushGroup.selectAll(".handle")
    .attr("fill", "transparent")
    .attr("stroke", "none");
  brushBorders = overview.append("g")
    .attr("class", "brush-borders")
    .attr("pointer-events", "none");
  if (Array.isArray(brushedDomain) && brushedDomain.length === 2) {
    const clamped = [
      new Date(Math.max(+fullDateDomain[0], +brushedDomain[0])),
      new Date(Math.min(+fullDateDomain[1], +brushedDomain[1])),
    ];
    if (+clamped[0] < +clamped[1]) {
      brushedDomain = clamped;
      brushGroup.call(brush.move, clamped.map(xOverview));
    } else {
      brushedDomain = null;
    }
  }
  if (!brushedDomain) drawDetail(null);
}

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
watch(() => [props.rows, props.cycleRows], () => {
  brushedDomain = null;
  draw();
});

function exportPng({
  filename = "greek-pnl-attribution.png",
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
    svgEl, title, subtitle, source, metrics, filename, scale, padding, background: "#0a0b0e",
  });
}

defineExpose({ exportPng });
</script>

<template>
  <div ref="chartRef" class="greekChart"></div>
</template>

<style scoped>
.greekChart {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 720px;
  min-width: 0;
  overflow: hidden;
  background: #0a0b0e;
}
.greekChart :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>
