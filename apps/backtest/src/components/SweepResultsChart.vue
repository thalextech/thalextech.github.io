<script setup>
import * as d3 from "d3";
import { nextTick, onMounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});

const emit = defineEmits(["select"]);
const chartRef = ref(null);

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatSharpe = d3.format(".2f");

const weekKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
};

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

  const rows = props.rows || [];
  if (!rows.length) return;

  // Build weeks from weeklyReturns for the left heatmap grid
  const weeks = [...new Set(
    rows.flatMap((row) => (row.weeklyReturns || [])
      .map((p) => weekKey(p.entryDate))
      .filter(Boolean)
    )
  )].sort();

  const hasWeeks = weeks.length > 0;

  const bounds = element.getBoundingClientRect();
  const availableWidth = Math.max(720, bounds.width || 1100);
  const margin = { top: 42, right: 24, bottom: 32, left: 64 };
  const summaryLeadGap = 28;
  const summaryColumnGap = 24;
  const summaryValueGap = 6;
  const summaryColumns = [
    { key: "pnl", title: "TOTAL PNL", labelWidth: 62 },
    { key: "sharpe", title: "SHARPE", labelWidth: 42 },
    { key: "drawdown", title: "MAX DRAWDOWN", labelWidth: 70 },
  ];

  const summaryWidthFor = (size) => summaryColumns.reduce(
    (total, column) => total + size + summaryValueGap + column.labelWidth,
    summaryColumnGap * (summaryColumns.length - 1),
  );

  // Reserve room for each aggregate square and its right-hand data label.
  const estimatedSummaryWidth = summaryWidthFor(16);
  let cellSize = 16;
  let gridW = 0;
  let gridH = rows.length * 18;
  if (hasWeeks) {
    const gridAvail = availableWidth
      - margin.left
      - margin.right
      - summaryLeadGap
      - estimatedSummaryWidth;
    cellSize = Math.max(7, Math.min(20, Math.floor(gridAvail / weeks.length)));
    gridW = weeks.length * cellSize;
    gridH = rows.length * cellSize;
  }

  const summaryStart = margin.left + gridW + summaryLeadGap;
  const summaryCellSize = hasWeeks ? Math.max(1, cellSize - 1) : 16;
  let summaryCursor = summaryStart;
  summaryColumns.forEach((column, index) => {
    column.squareX = summaryCursor;
    column.labelX = column.squareX + summaryCellSize + summaryValueGap;
    column.endX = column.labelX + column.labelWidth;
    summaryCursor = column.endX + (index < summaryColumns.length - 1 ? summaryColumnGap : 0);
  });

  const [pnlColumn, sharpeColumn, drawdownColumn] = summaryColumns;
  const width = Math.max(availableWidth, summaryCursor + margin.right);
  const height = margin.top + gridH + margin.bottom;

  // Data for left grid (weekly PnL squares)
  const valuesByRowWeek = new Map();
  const allWeeklyPnl = [];
  rows.forEach((row) => {
    (row.weeklyReturns || []).forEach((point) => {
      const wk = weekKey(point.entryDate);
      const pnl = Number(point.pnl);
      if (wk && Number.isFinite(pnl)) {
        valuesByRowWeek.set(`${row.key}|${wk}`, pnl);
        allWeeklyPnl.push(pnl);
      }
    });
  });

  const wBound = d3.max(allWeeklyPnl, (v) => Math.abs(v)) || 1;
  const weekColor = d3.scaleDiverging(d3.interpolateRdBu).domain([-wBound, 0, wBound]);

  // Separate color scales for the right summary squares
  const pnlVals = rows.map((r) => Number(r.pnl) || 0);
  const pBound = d3.max(pnlVals, (v) => Math.abs(v)) || 1;
  const pnlColor = d3.scaleDiverging(d3.interpolateRdBu).domain([-pBound, 0, pBound]);

  const shVals = rows.map((r) => Number(r.sharpe)).filter(Number.isFinite);
  const shBound = d3.max(shVals.map((v) => Math.abs(v))) || 1;
  const shColor = d3.scaleDiverging(d3.interpolateRdBu).domain([-shBound, 0, shBound]);

  const ddVals = rows.map((r) => Number(r.maxDrawdown) || 0);
  const ddBound = Math.max(1, d3.max(ddVals, (v) => Math.abs(v)) || 1);
  const ddColor = d3.scaleSequential(d3.interpolateReds).domain([0, ddBound]);

  const svg = d3.select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr("aria-label", "Weekly PnL heatmap grid with aligned summary column heatmaps for PNL, Sharpe and Max Drawdown");

  // Top labels
  if (hasWeeks) {
    svg.append("text")
      .attr("x", margin.left)
      .attr("y", 15)
      .attr("fill", "rgba(255,255,255,0.52)")
      .attr("font-size", 10)
      .attr("font-weight", 500)
      .text("WEEKLY PNL (GLOBAL SCALE ACROSS ALL)");
  }

  // Vertical separator between week grid and the three summary columns
  if (hasWeeks) {
    const sepX = summaryStart - 4;
    svg.append("line")
      .attr("x1", sepX)
      .attr("x2", sepX)
      .attr("y1", margin.top - 12)
      .attr("y2", margin.top + gridH)
      .attr("stroke", "rgba(255,255,255,0.12)");
  }

  // Headers align with the square + right-hand value label for each metric.
  const rHeadY = 15;
  const addSummaryHeader = (column) => svg.append("text")
    .attr("x", column.squareX)
    .attr("y", rHeadY)
    .attr("text-anchor", "start")
    .attr("fill", "rgba(255,255,255,0.55)")
    .attr("font-size", 10)
    .attr("font-weight", 500)
    .text(column.title);

  summaryColumns.forEach(addSummaryHeader);

  const rowGroups = svg.selectAll("g.sweep-row")
    .data(rows, (row) => row.key)
    .join("g")
    .attr("class", "sweep-row")
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (row) => {
      const s = Number.isFinite(row.sharpe) ? formatSharpe(row.sharpe) : "n/a";
      const d = Number.isFinite(row.maxDrawdown) ? formatUsd(row.maxDrawdown) : "n/a";
      return `${row.label}: PnL ${formatUsd(Number(row.pnl) || 0)}, Sharpe ${s}, Max DD ${d}`;
    })
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row))
    .on("keydown", (event, row) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        emit("select", row);
      }
    });

  // Full-row hit area spanning grid + right columns (covers the spread summary slots)
  const rightEnd = drawdownColumn.endX + 4;
  const hitW = rightEnd - margin.left;
  const rowSlotH = hasWeeks ? cellSize : 18;
  rowGroups.append("rect")
    .attr("class", "row-hit-area")
    .attr("x", margin.left)
    .attr("y", (_, i) => margin.top + i * rowSlotH)
    .attr("width", hitW)
    .attr("height", rowSlotH)
    .attr("fill", "transparent");

  // Row labels
  const rowSlot = hasWeeks ? cellSize : 18;
  rowGroups.append("text")
    .attr("x", margin.left - 8)
    .attr("y", (_, i) => margin.top + i * rowSlot + rowSlot / 2)
    .attr("dy", "0.32em")
    .attr("text-anchor", "end")
    .attr("fill", "rgba(255,255,255,0.68)")
    .attr("font-size", Math.max(8, Math.min(10, (hasWeeks ? cellSize : 16) * 0.52)))
    .text((row) => row.label);

  // Draw per row: week squares on left + three summary squares on right
  rowGroups.each(function (row, rowIndex) {
    const group = d3.select(this);
    const rowSlot = hasWeeks ? cellSize : 18;
    const y = margin.top + rowIndex * rowSlot;

    // LEFT: weekly PnL heatmap squares (one per week)
    if (hasWeeks) {
      weeks.forEach((wk, wIdx) => {
        const v = valuesByRowWeek.get(`${row.key}|${wk}`);
        const cell = group.append("rect")
          .attr("x", margin.left + wIdx * cellSize + 0.5)
          .attr("y", y + 0.5)
          .attr("width", Math.max(1, cellSize - 1))
          .attr("height", Math.max(1, cellSize - 1))
          .attr("fill", Number.isFinite(v) ? weekColor(v) : "rgba(255,255,255,0.025)");
        cell.append("title").text(
          Number.isFinite(v)
            ? `${row.label} · ${d3.utcFormat("%d %b %Y")(new Date(`${wk}T00:00:00Z`))}\nWeekly PnL: ${formatUsd(v)}`
            : `${row.label} · ${wk}\nNo data`
        );
      });
    }

    // RIGHT: three summary column heatmaps (squares, same size + style as week cells)
    const cellInset = 0.5;
    const cellW = summaryCellSize;
    const labelY = y + rowSlot / 2;
    const appendValueLabel = (x, value) => group.append("text")
      .attr("x", x)
      .attr("y", labelY)
      .attr("dy", "0.32em")
      .attr("text-anchor", "start")
      .attr("fill", "rgba(255,255,255,0.68)")
      .attr("font-size", Math.max(8, Math.min(10, rowSlot * 0.52)))
      .text(value);

    // PNL summary square (one column heatmap)
    const pv = Number(row.pnl) || 0;
    group.append("rect")
      .attr("x", pnlColumn.squareX + cellInset)
      .attr("y", y + cellInset)
      .attr("width", cellW)
      .attr("height", cellW)
      .attr("fill", pnlColor(pv))
      .append("title")
      .text(`${row.label}\nTotal PnL: ${formatUsd(pv)}`);
    appendValueLabel(pnlColumn.labelX, formatUsd(pv));

    // Sharpe summary square (one column heatmap)
    const sv = Number(row.sharpe);
    const hasSv = Number.isFinite(sv);
    group.append("rect")
      .attr("x", sharpeColumn.squareX + cellInset)
      .attr("y", y + cellInset)
      .attr("width", cellW)
      .attr("height", cellW)
      .attr("fill", hasSv ? shColor(sv) : "rgba(255,255,255,0.025)")
      .append("title")
      .text(`${row.label}\nSharpe: ${hasSv ? formatSharpe(sv) : "n/a"}`);
    appendValueLabel(sharpeColumn.labelX, hasSv ? formatSharpe(sv) : "n/a");

    // Max DD summary square (one column heatmap)
    const dv = Number(row.maxDrawdown) || 0;
    group.append("rect")
      .attr("x", drawdownColumn.squareX + cellInset)
      .attr("y", y + cellInset)
      .attr("width", cellW)
      .attr("height", cellW)
      .attr("fill", ddColor(Math.abs(dv)))
      .append("title")
      .text(`${row.label}\nMax Drawdown: ${formatUsd(dv)}`);
    appendValueLabel(drawdownColumn.labelX, formatUsd(dv));
  });

  // Hover
  rowGroups
    .on("mouseenter", function () {
      d3.select(this).select(".row-hit-area").attr("fill", "rgba(255,255,255,0.04)");
    })
    .on("mouseleave", function () {
      d3.select(this).select(".row-hit-area").attr("fill", "transparent");
    });

  // Bottom week labels (rotated, sampled)
  if (hasWeeks) {
    const labelEvery = Math.max(1, Math.ceil(weeks.length / 18));
    weeks.forEach((wk, idx) => {
      if (idx % labelEvery !== 0) return;
      const lx = margin.left + idx * cellSize + cellSize / 2;
      const ly = margin.top + gridH + 10;
      svg.append("text")
        .attr("x", lx)
        .attr("y", ly)
        .attr("text-anchor", "end")
        .attr("transform", `rotate(-50 ${lx} ${ly})`)
        .attr("fill", "rgba(255,255,255,0.32)")
        .attr("font-size", 8)
        .text(d3.utcFormat("%d %b")(new Date(`${wk}T00:00:00Z`)));
    });
  }
};

onMounted(async () => {
  await nextTick();
  draw();
});

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

.chart :deep(.sweep-row:focus) {
  outline: none;
}

.chart :deep(.sweep-row:focus > .row-hit-area) {
  fill: rgba(125, 211, 252, 0.08);
}
</style>
