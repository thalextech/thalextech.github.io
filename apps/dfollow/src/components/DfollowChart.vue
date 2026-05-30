<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  trades: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
let resizeObserver = null;

const layout = {
  fallbackWidth: 1800,
  fallbackHeight: 980,
  margin: { top: 74, right: 56, bottom: 64, left: 78 },
};

const fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

function exportPng({ filename = "dfollow.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

const axisStyle = (axisG) => {
  axisG.selectAll("line").attr("stroke", "rgba(255,255,255,0.09)");
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#aeb4c2")
    .style("font-size", "13px")
    .style("font-family", fontFamily);
};

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const wrap = svgEl.parentElement;
  const width = Math.max(
    480,
    Math.round(wrap?.clientWidth || layout.fallbackWidth),
  );
  const height = Math.max(
    420,
    Math.round(wrap?.clientHeight || layout.fallbackHeight),
  );
  const { margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const panelGap = Math.min(58, Math.max(36, innerHeight * 0.07));
  const pnlHeight = Math.min(280, Math.max(160, innerHeight * 0.28));
  const priceHeight = innerHeight - pnlHeight - panelGap;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "none");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#020204");

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", margin.left)
      .attr("y", 38)
      .attr("fill", "#aeb4c2")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.subtitle);
  }

  const rows = (props.data || []).filter(
    (row) => row?.date instanceof Date && Number.isFinite(row?.hedgePrice),
  );

  if (!rows.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.loading ? "Loading..." : "No mark-price data.");
    return;
  }

  const x = d3
    .scaleUtc()
    .domain(d3.extent(rows, (d) => d.date))
    .range([0, innerWidth]);

  const yValues = rows.map((d) => d.hedgePrice);
  for (const trade of props.trades || []) {
    if (Number.isFinite(trade?.hedgePrice)) yValues.push(trade.hedgePrice);
  }
  const priceExtent = d3.extent(yValues);
  const pricePad = Math.max(1, (priceExtent[1] - priceExtent[0]) * 0.08);
  const y = d3
    .scaleLinear()
    .domain([priceExtent[0] - pricePad, priceExtent[1] + pricePad])
    .nice()
    .range([priceHeight, 0]);

  const priceG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);
  const pnlG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top + priceHeight + panelGap})`);

  priceG
    .append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(7)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  priceG
    .append("text")
    .attr("x", -66)
    .attr("y", priceHeight / 2)
    .attr("transform", `rotate(-90,-66,${priceHeight / 2})`)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text("Mark price");

  const priceLine = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.hedgePrice))
    .curve(d3.curveStepAfter);

  priceG
    .append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", "mistyrose")
    .attr("stroke-width", 2)
    .attr("d", priceLine);

  const tradeRows = (props.trades || []).filter(
    (trade) =>
      trade?.date instanceof Date &&
      Number.isFinite(trade?.hedgePrice) &&
      Number.isFinite(trade?.tradeAmount),
  );

  priceG
    .append("g")
    .selectAll("circle")
    .data(tradeRows)
    .join("circle")
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.hedgePrice))
    .attr("r", 6.5)
    .attr("fill", (d) => (d.tradeAmount >= 0 ? "#16a34a" : "#dc2626"))
    .attr("stroke", "#020204")
    .attr("stroke-width", 1.8);

  const legend = priceG
    .append("g")
    .attr("transform", `translate(${innerWidth - 220},${-36})`);
  const legendItems = [
    { label: "Buy", color: "#16a34a" },
    { label: "Sell", color: "#dc2626" },
  ];

  legend
    .selectAll("g")
    .data(legendItems)
    .join("g")
    .attr("transform", (_, i) => `translate(${i * 98},0)`)
    .call((item) => {
      item
        .append("circle")
        .attr("cx", 0)
        .attr("cy", 0)
        .attr("r", 6)
        .attr("fill", (d) => d.color);
      item
        .append("text")
        .attr("x", 14)
        .attr("y", 4)
        .attr("fill", "#cfd3dd")
        .style("font-size", "12px")
        .style("font-family", fontFamily)
        .text((d) => d.label);
    });

  const pnlRows = rows.filter(
    (row) => Number.isFinite(row?.botPnl) && Number.isFinite(row?.optionPnl),
  );
  if (!pnlRows.length) return;

  const pnlExtent = d3.extent([
    0,
    ...pnlRows.map((row) => row.botPnl),
    ...pnlRows.map((row) => row.optionPnl),
  ]);
  const pnlPad = Math.max(1, (pnlExtent[1] - pnlExtent[0]) * 0.12);
  const yPnl = d3
    .scaleLinear()
    .domain([pnlExtent[0] - pnlPad, pnlExtent[1] + pnlPad])
    .nice()
    .range([pnlHeight, 0]);

  pnlG
    .append("g")
    .call(
      d3
        .axisLeft(yPnl)
        .ticks(5)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  pnlG
    .append("g")
    .attr("transform", `translate(0,${pnlHeight})`)
    .call(d3.axisBottom(x).ticks(9).tickSize(0).tickPadding(16))
    .call(axisStyle);

  pnlG
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", yPnl(0))
    .attr("y2", yPnl(0))
    .attr("stroke", "rgba(255,255,255,0.22)")
    .attr("stroke-width", 1);

  pnlG
    .append("text")
    .attr("x", -66)
    .attr("y", pnlHeight / 2)
    .attr("transform", `rotate(-90,-66,${pnlHeight / 2})`)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text("Cumulative PnL");

  const botPnlLine = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => yPnl(d.botPnl))
    .curve(d3.curveStepAfter);
  const optionPnlLine = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => yPnl(d.optionPnl))
    .curve(d3.curveStepAfter);

  pnlG
    .append("path")
    .datum(pnlRows)
    .attr("fill", "none")
    .attr("stroke", "#7aa2ff")
    .attr("stroke-width", 2)
    .attr("d", botPnlLine);

  pnlG
    .append("path")
    .datum(pnlRows)
    .attr("fill", "none")
    .attr("stroke", "#f59e0b")
    .attr("stroke-width", 2)
    .attr("d", optionPnlLine);

  const pnlLegend = pnlG
    .append("g")
    .attr("transform", `translate(${innerWidth - 310},${-28})`);
  const pnlLegendItems = [
    { label: "DFollow PnL", color: "#7aa2ff" },
    { label: "Option PnL", color: "#f59e0b" },
  ];

  pnlLegend
    .selectAll("g")
    .data(pnlLegendItems)
    .join("g")
    .attr("transform", (_, i) => `translate(${i * 150},0)`)
    .call((item) => {
      item
        .append("line")
        .attr("x1", 0)
        .attr("x2", 22)
        .attr("y1", 0)
        .attr("y2", 0)
        .attr("stroke", (d) => d.color)
        .attr("stroke-width", 3);
      item
        .append("text")
        .attr("x", 30)
        .attr("y", 4)
        .attr("fill", "#cfd3dd")
        .style("font-size", "12px")
        .style("font-family", fontFamily)
        .text((d) => d.label);
    });
}

watch(
  () => [props.data, props.trades, props.subtitle, props.loading],
  () => render(),
  { deep: false },
);

onMounted(() => {
  render();
  const svgEl = svgRef.value;
  const wrap = svgEl?.parentElement;
  if (wrap && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => render());
    resizeObserver.observe(wrap);
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #020204;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  color: #d6d7de;
  font-size: 14px;
  pointer-events: none;
}
</style>
