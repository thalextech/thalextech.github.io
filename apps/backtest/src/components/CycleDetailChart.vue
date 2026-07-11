<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  breakEvens: { type: Object, default: null },
});

const chartRef = ref(null);
let resizeObserver;

const FONT = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatTime = d3.utcFormat("%d %b %H:%M");
const BUY = "#63a67b";
const SELL = "#c96f6f";
const INDEX = "rgba(255,255,255,0.42)";
const BREAK_EVEN = "rgba(255, 255, 255, 0.65)";

const styleAxis = (group) => {
  group.selectAll("line").remove();
  group.selectAll("path").remove();
  group.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.42)")
    .attr("font-family", FONT)
    .attr("font-size", 10);
};

const paddedDomain = (values, ratio = 0.08) => {
  let [lo, hi] = d3.extent(values.filter(Number.isFinite));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  const padding = (hi - lo) * ratio;
  return [lo - padding, hi + padding];
};

const addLegendItem = (legend, x, label, color, shape = "line") => {
  const item = legend.append("g").attr("transform", `translate(${x},0)`);
  if (shape === "square") {
    item.append("rect")
      .attr("x", 0).attr("y", -5).attr("width", 9).attr("height", 9)
      .attr("fill", color);
  } else {
    item.append("line")
      .attr("x1", 0).attr("x2", 18).attr("y1", 0).attr("y2", 0)
      .attr("stroke", color).attr("stroke-width", 2);
  }
  item.append("text")
    .attr("x", shape === "square" ? 15 : 24).attr("y", 4)
    .attr("fill", "rgba(255,255,255,0.72)")
    .attr("font-size", 10).text(label);
};

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";
  const rows = [...(props.rows || [])]
    .filter((row) => row.dateTime && Number.isFinite(row.indexPrice))
    .sort((a, b) => a.ts - b.ts);
  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360);
  const height = Math.max(520, bounds.height || 620);
  const margin = { top: 34, right: 110, bottom: 42, left: 64 };
  const gap = 54;
  const priceHeight = Math.round((height - margin.top - margin.bottom - gap) * 0.52);
  const pnlHeight = height - margin.top - margin.bottom - gap - priceHeight;
  const innerWidth = width - margin.left - margin.right;

  const svg = d3.select(element).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%").attr("height", "100%")
    .attr("font-family", FONT)
    .attr("role", "img")
    .attr("aria-label", "Index price (scatter), break-even lines for the structure, hedge executions, and PnL detail");

  if (!rows.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle").attr("fill", "rgba(255,255,255,0.35)")
      .text("No hourly detail data");
    return;
  }

  const x = d3.scaleUtc()
    .domain(d3.extent(rows, (row) => new Date(row.dateTime)))
    .range([0, innerWidth]);

  // Include break-even levels in the domain so the reference lines are visible even if
  // the week's observed prices never reached them.
  const be = props.breakEvens || null;
  const indexValues = rows.map((row) => row.indexPrice).filter(Number.isFinite);
  if (be) {
    if (Number.isFinite(be.lower)) indexValues.push(be.lower);
    if (Number.isFinite(be.upper)) indexValues.push(be.upper);
  }
  const indexY = d3.scaleLinear()
    .domain(paddedDomain(indexValues)).nice()
    .range([priceHeight, 0]);

  const pnlY = d3.scaleLinear()
    .domain(paddedDomain(rows.flatMap((row) => [row.optionPnlUsd, row.hedgePnlUsd, row.totalPnlUsd]))).nice()
    .range([pnlHeight, 0]);

  const price = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // Index price axis on the left (primary now that we focus on spot vs break-evens)
  price.append("g").call(d3.axisLeft(indexY).ticks(6).tickFormat(d3.format("$,.0f")).tickPadding(10)).call(styleAxis);

  // Break-even levels as white lines across the index scatter (fill between is neutral grey).
  const formatBe = d3.format(",.0f");  // no $ to keep labels short next to lines; axis provides scale
  if (be) {
    const drawBE = (level, suffix) => {
      if (!Number.isFinite(level)) return;
      const y = indexY(level);
      // Clean white lines for break-evens (full width, no dash)
      price.append("line")
        .attr("x1", 0)
        .attr("x2", innerWidth)
        .attr("y1", y)
        .attr("y2", y)
        .attr("stroke", BREAK_EVEN)
        .attr("stroke-width", 1)
        .attr("opacity", 0.9);
      // Label on the right
      const labelText = suffix
        ? `${formatBe(level)} ${suffix}`
        : formatBe(level);
      price.append("text")
        .attr("x", innerWidth + 4)
        .attr("y", y + 3)
        .attr("fill", BREAK_EVEN)
        .attr("font-size", 9)
        .attr("font-weight", 500)
        .text(labelText);
    };

    // When both exist, label one "low" and one "high" to the right of the price
    if (Number.isFinite(be.lower) && Number.isFinite(be.upper)) {
      drawBE(be.lower, "low");
      drawBE(be.upper, "high");
    } else if (Number.isFinite(be.lower)) {
      drawBE(be.lower);
    } else if (Number.isFinite(be.upper)) {
      drawBE(be.upper);
    }
  }

  // Stepline for the index price (to match the stepped PnL lines)
  const indexLine = d3.line()
    .defined((row) => Number.isFinite(row.indexPrice))
    .x((row) => x(new Date(row.dateTime)))
    .y((row) => indexY(row.indexPrice))
    .curve(d3.curveStepBefore);

  price.append("path")
    .datum(rows)
    .attr("d", indexLine)
    .attr("fill", "none")
    .attr("stroke", "rgba(255,255,255,0.75)")
    .attr("stroke-width", 1.25)
    .attr("stroke-linejoin", "round")
    .attr("stroke-linecap", "round");

  // Small markers for regular index points
  price.selectAll("rect.index-point")
    .data(rows.filter(d => !d.hedgeTrade))
    .join("rect")
    .attr("class", "index-point")
    .attr("x", (row) => x(new Date(row.dateTime)) - 1.25)
    .attr("y", (row) => indexY(row.indexPrice) - 1.25)
    .attr("width", 2.5)
    .attr("height", 2.5)
    .attr("fill", "rgba(255,255,255,0.35)")
    .attr("stroke", "none")
    .append("title")
    .text((row) => `${formatTime(new Date(row.dateTime))}\nIndex ${formatUsd(row.indexPrice)}`);

  // Hedge trade markers as circles (larger, colored)
  price.selectAll("circle.hedge-trade")
    .data(rows.filter(d => d.hedgeTrade))
    .join("circle")
    .attr("class", "hedge-trade")
    .attr("cx", (row) => x(new Date(row.dateTime)))
    .attr("cy", (row) => indexY(row.indexPrice))
    .attr("r", 3.5)
    .attr("fill", (row) => row.hedgeTrade.side === "buy" ? BUY : SELL)
    .attr("stroke", (row) => row.hedgeTrade.side === "buy" ? BUY : SELL)
    .attr("stroke-width", 0.8)
    .append("title")
    .text((row) => {
      const trade = row.hedgeTrade
        ? `\n${row.hedgeTrade.side.toUpperCase()} ${row.hedgeTrade.quantity.toFixed(4)} BTC @ ${formatUsd(row.indexPrice)}`
        : "";
      return `${formatTime(new Date(row.dateTime))}\nIndex ${formatUsd(row.indexPrice)}${trade}`;
    });

  const legend = price.append("g").attr("transform", "translate(0,-18)");
  // No more "Combined option mark" — replaced by break-even lines per request
  addLegendItem(legend, 0, "Index", "rgba(255,255,255,0.75)");
  addLegendItem(legend, 80, "Hedge buy", BUY, "square");
  addLegendItem(legend, 170, "Hedge sell", SELL, "square");
  if (be && (Number.isFinite(be.lower) || Number.isFinite(be.upper))) {
    // Small indicator for BE in legend area (positioned after the hedge items)
    legend.append("line")
      .attr("x1", 255).attr("x2", 273)
      .attr("y1", 0).attr("y2", 0)
      .attr("stroke", BREAK_EVEN)
      .attr("stroke-width", 1);
    legend.append("text")
      .attr("x", 277).attr("y", 4)
      .attr("fill", "rgba(255,255,255,0.72)")
      .attr("font-size", 10)
      .text("Break-evens");
  }

  const pnlTop = margin.top + priceHeight + gap;
  const pnl = svg.append("g").attr("transform", `translate(${margin.left},${pnlTop})`);
  pnl.append("g").call(d3.axisLeft(pnlY).ticks(6).tickFormat(d3.format("$,.0f")).tickPadding(10)).call(styleAxis);
  const pnlSeries = [
    { key: "optionPnlUsd", label: "Option PnL", color: "#7dd3fc" },
    { key: "hedgePnlUsd", label: "Hedge PnL", color: "#fbbf24" },
    { key: "totalPnlUsd", label: "Total PnL", color: "#f4f4f5" },
  ];
  pnlSeries.forEach((series) => {
    const line = d3.line()
      .defined((row) => Number.isFinite(row[series.key]))
      .x((row) => x(new Date(row.dateTime)))
      .y((row) => pnlY(row[series.key]))
      .curve(d3.curveStepBefore);
    pnl.append("path").datum(rows).attr("d", line)
      .attr("fill", "none").attr("stroke", series.color)
      .attr("stroke-width", 1.25);
  });
  const pnlLegend = pnl.append("g").attr("transform", "translate(0,-17)");
  pnlSeries.forEach((series, index) => addLegendItem(pnlLegend, index * 95, series.label, series.color));

  const xAxis = d3.axisBottom(x).ticks(8).tickFormat(d3.utcFormat("%d %b %H:%M")).tickPadding(10);
  pnl.append("g").attr("transform", `translate(0,${pnlHeight})`).call(xAxis).call(styleAxis);
};

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});
onUnmounted(() => resizeObserver?.disconnect());
watch(() => props.rows, draw);
watch(() => props.breakEvens, draw, { deep: true });

function exportPng({ filename = "cycle-detail.png", scale = 3, padding = 24, title = "", subtitle = "", source = "", metrics = [] } = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({ svgEl, title, subtitle, source, metrics, filename, scale, padding, background: "#0a0b0e" });
}
defineExpose({ exportPng });
</script>

<template>
  <div ref="chartRef" class="chart"></div>
</template>

<style scoped>
.chart {
  flex: 1;
  min-height: 0;
  background: #0a0b0e;
  display: flex;
}
.chart :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
