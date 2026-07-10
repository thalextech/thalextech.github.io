<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps({
  rows: { type: Array, default: () => [] },
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
  const bounds = element.getBoundingClientRect();
  const width = Math.max(720, bounds.width || 1100);
  const rowHeight = 29;
  const margin = { top: 34, right: 26, bottom: 50, left: 82 };
  const sharpeWidth = 88;
  const columnGap = 34;
  const plotWidth = width - margin.left - margin.right - sharpeWidth - columnGap;
  const height = Math.max(280, margin.top + margin.bottom + rows.length * rowHeight);
  const plotBottom = height - margin.bottom;
  const sharpeX = margin.left + plotWidth + columnGap + sharpeWidth / 2;

  const svg = d3
    .select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", height)
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr(
      "aria-label",
      "Sweep results showing cumulative PnL as horizontal deviation bars with Sharpe ratios",
    );

  if (!rows.length) return;

  const pnlValues = rows.map((row) => Number(row.pnl) || 0);
  const [pnlMin, pnlMax] = d3.extent(pnlValues);
  let xMin = Math.min(0, pnlMin ?? 0);
  let xMax = Math.max(0, pnlMax ?? 0);
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  const pnlBound = Math.max(Math.abs(xMin), Math.abs(xMax)) || 1;
  const x = d3
    .scaleLinear()
    .domain([xMin, xMax])
    .range([margin.left, margin.left + plotWidth])
    .nice();
  const y = d3
    .scaleBand()
    .domain(rows.map((row) => row.key))
    .range([margin.top, plotBottom])
    .padding(0.24);
  const color = d3
    .scaleDiverging(d3.interpolateRdBu)
    .domain([-pnlBound, 0, pnlBound]);
  const ticks = x.ticks(7);

  ticks.forEach((tick) => {
    svg.append("line")
      .attr("x1", x(tick))
      .attr("x2", x(tick))
      .attr("y1", margin.top)
      .attr("y2", plotBottom)
      .attr("stroke", tick === 0 ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.05)");
  });

  svg.append("line")
    .attr("x1", margin.left + plotWidth + columnGap / 2)
    .attr("x2", margin.left + plotWidth + columnGap / 2)
    .attr("y1", margin.top - 18)
    .attr("y2", plotBottom)
    .attr("stroke", "rgba(255,255,255,0.08)");

  svg.append("text")
    .attr("x", sharpeX)
    .attr("y", margin.top - 13)
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.52)")
    .attr("font-size", 11)
    .attr("font-weight", 500)
    .text("SHARPE");

  const rowGroups = svg.selectAll("g.sweep-row")
    .data(rows, (row) => row.key)
    .join("g")
    .attr("class", "sweep-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) =>
      `${row.label}: cumulative PnL ${formatUsd(Number(row.pnl) || 0)}, Sharpe ${Number.isFinite(row.sharpe) ? formatSharpe(row.sharpe) : "not available"}`,
    )
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row))
    .on("keydown", (event, row) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        emit("select", row);
      }
    });

  rowGroups.append("rect")
    .attr("x", margin.left)
    .attr("y", (row) => y(row.key) - y.step() * 0.12)
    .attr("width", plotWidth + columnGap + sharpeWidth)
    .attr("height", y.step())
    .attr("fill", "transparent");

  rowGroups.append("rect")
    .attr("x", (row) => x(Math.min(0, Number(row.pnl) || 0)))
    .attr("y", (row) => y(row.key))
    .attr("width", (row) => Math.max(1, Math.abs(x(Number(row.pnl) || 0) - x(0))))
    .attr("height", y.bandwidth())
    .attr("fill", (row) => color(Number(row.pnl) || 0))
    .append("title")
    .text((row) => [
      row.label,
      `Cumulative PnL: ${formatUsd(Number(row.pnl) || 0)}`,
      `Sharpe: ${Number.isFinite(row.sharpe) ? formatSharpe(row.sharpe) : "n/a"}`,
      `${row.cycles || 0} cycles`,
    ].join("\n"));

  rowGroups.append("text")
    .attr("x", margin.left - 14)
    .attr("y", (row) => y(row.key) + y.bandwidth() / 2)
    .attr("dy", "0.32em")
    .attr("text-anchor", "end")
    .attr("fill", "rgba(255,255,255,0.68)")
    .attr("font-size", 11)
    .text((row) => row.label);

  rowGroups.append("text")
    .attr("x", sharpeX)
    .attr("y", (row) => y(row.key) + y.bandwidth() / 2)
    .attr("dy", "0.32em")
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.78)")
    .attr("font-size", 12)
    .attr("font-variant-numeric", "tabular-nums")
    .text((row) => Number.isFinite(row.sharpe) ? formatSharpe(row.sharpe) : "—");

  rowGroups
    .on("mouseenter", function () {
      d3.select(this).select("rect:first-child").attr("fill", "rgba(255,255,255,0.035)");
    })
    .on("mouseleave", function () {
      d3.select(this).select("rect:first-child").attr("fill", "transparent");
    });

  const axis = d3.axisBottom(x)
    .tickValues(ticks)
    .tickFormat(d3.format("~s"))
    .tickSize(0)
    .tickPadding(9);
  const axisGroup = svg.append("g")
    .attr("transform", `translate(0,${plotBottom})`)
    .call(axis);
  axisGroup.attr("font-family", CHART_FONT_FAMILY);
  axisGroup.select(".domain").remove();
  axisGroup.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.36)")
    .attr("font-size", 10);

  svg.append("text")
    .attr("x", margin.left + plotWidth / 2)
    .attr("y", height - 10)
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.58)")
    .attr("font-size", 12)
    .text("Cumulative PnL (USD)");
};

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});

onUnmounted(() => resizeObserver?.disconnect());
watch(() => props.rows, draw);
</script>

<template>
  <div ref="chartRef" class="chart"></div>
</template>

<style scoped>
.chart {
  width: 100%;
  max-height: calc(100vh - 190px);
  min-height: 280px;
  overflow-y: auto;
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.chart :deep(.sweep-row:focus) {
  outline: none;
}

.chart :deep(.sweep-row:focus > rect:first-child) {
  fill: rgba(125, 211, 252, 0.08);
}
</style>
