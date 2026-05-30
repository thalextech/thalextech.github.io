<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  trades: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);

const layout = {
  width: 1800,
  height: 980,
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

  const { width, height, margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

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
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(7)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(9).tickSize(0).tickPadding(16))
    .call(axisStyle);

  g.append("text")
    .attr("x", -54)
    .attr("y", innerHeight / 2)
    .attr("transform", `rotate(-90,-54,${innerHeight / 2})`)
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

  g.append("path")
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

  g.append("g")
    .selectAll("circle")
    .data(tradeRows)
    .join("circle")
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.hedgePrice))
    .attr("r", 6.5)
    .attr("fill", (d) => (d.tradeAmount >= 0 ? "#16a34a" : "#dc2626"))
    .attr("stroke", "#020204")
    .attr("stroke-width", 1.8);

  const legend = g
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
}

watch(
  () => [props.data, props.trades, props.subtitle, props.loading],
  () => render(),
  { deep: false },
);

onMounted(() => render());
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
