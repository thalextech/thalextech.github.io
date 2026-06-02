<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  title: { type: String, default: "Volume Bars (USD)" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
let resizeObserver = null;

const layout = {
  fallbackWidth: 1600,
  fallbackHeight: 900,
  margin: { top: 80, right: 40, bottom: 86, left: 86 },
};

const colors = {
  up: "#23ba75",
  down: "#f5395e",
  strokeUp: "palegreen",
  strokeDown: "#ff2c2c",
  background: "black",
  text: "white",
  grid: "whitesmoke",
};

const fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

function exportPng({
  filename = "dollar-bars.png",
  scale = 3,
  padding = 24,
} = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

const axisStyle = (axisG) => {
  axisG.selectAll("path").remove();
  axisG.selectAll("line").attr("stroke", "none");
  axisG
    .selectAll("text")
    .attr("fill", colors.text)
    .style("font-size", "14px")
    .style("font-family", fontFamily);
};

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const wrap = svgEl.parentElement;
  const width = Math.max(
    520,
    Math.round(wrap?.clientWidth || layout.fallbackWidth),
  );
  const height = Math.max(
    420,
    Math.round(wrap?.clientHeight || layout.fallbackHeight),
  );
  const { margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "none");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", colors.background);

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 35)
    .attr("text-anchor", "middle")
    .attr("fill", colors.text)
    .style("font-size", "20px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text(props.title);

  const rows = (props.data || []).filter(
    (row) =>
      row?.date instanceof Date &&
      !Number.isNaN(row.date.getTime()) &&
      Number.isFinite(row.open) &&
      Number.isFinite(row.high) &&
      Number.isFinite(row.low) &&
      Number.isFinite(row.close),
  );

  if (!rows.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", colors.text)
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.loading ? "Loading..." : "No candle data.");
    return;
  }

  const x = d3
    .scaleBand()
    .domain(rows.map((row) => row.key))
    .range([0, innerWidth])
    .paddingInner(0.18)
    .paddingOuter(0.08);

  const yExtent = d3.extent(rows.flatMap((row) => [row.low, row.high]));
  const pad = Math.max(1, (yExtent[1] - yExtent[0]) * 0.04);
  const y = d3
    .scaleLinear()
    .domain([yExtent[0] - pad, yExtent[1] + pad])
    .nice()
    .range([innerHeight, 0]);

  const chartG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const yGrid = chartG
    .append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(5)
        .tickSize(-innerWidth)
        .tickPadding(20)
        .tickFormat(d3.format(".2s")),
    );

  yGrid.selectAll("path").remove();
  yGrid
    .selectAll("line")
    .attr("stroke", colors.grid)
    .attr("stroke-opacity", 0.5)
    .attr("stroke-width", 1);
  yGrid
    .selectAll("text")
    .attr("fill", colors.text)
    .style("font-size", "14px")
    .style("font-family", fontFamily);

  const tickKeys = x.domain().filter((_, index) => {
    const targetTickCount = width < 760 ? 4 : 8;
    return index % Math.max(1, Math.ceil(rows.length / targetTickCount)) === 0;
  });

  chartG
    .append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(
      d3
        .axisBottom(x)
        .tickValues(tickKeys)
        .tickSize(0)
        .tickPadding(40)
        .tickFormat((key) => {
          const row = rows.find((item) => item.key === key);
          return row ? d3.utcFormat("%b %d %Y")(row.date) : "";
        }),
    )
    .call(axisStyle);

  chartG
    .append("g")
    .selectAll("line")
    .data(rows)
    .join("line")
    .attr("x1", (d) => x(d.key) + x.bandwidth() / 2)
    .attr("x2", (d) => x(d.key) + x.bandwidth() / 2)
    .attr("y1", (d) => y(d.low))
    .attr("y2", (d) => y(d.high))
    .attr("stroke", (d) => (d.open <= d.close ? colors.up : colors.down))
    .attr("stroke-width", (d) => (d.open <= d.close ? 1.5 : 1.9));

  const minBodyHeight = 1;

  chartG
    .append("g")
    .selectAll("rect")
    .data(rows)
    .join("rect")
    .attr("x", (d) => x(d.key))
    .attr("y", (d) => Math.min(y(d.open), y(d.close)))
    .attr("width", x.bandwidth())
    .attr("height", (d) =>
      Math.max(minBodyHeight, Math.abs(y(d.open) - y(d.close))),
    )
    .attr("fill", (d) => (d.open <= d.close ? colors.up : colors.down))
    .attr("fill-opacity", 1)
    .attr("stroke", (d) =>
      d.open <= d.close ? colors.strokeUp : colors.strokeDown,
    )
    .attr("stroke-width", 0.8);
}

onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  if (svgRef.value?.parentElement) {
    resizeObserver.observe(svgRef.value.parentElement);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(() => [props.data, props.loading, props.title], render, { deep: true });
</script>

<template>
  <div class="chartFrame">
    <svg ref="svgRef" role="img" :aria-label="title"></svg>
  </div>
</template>

<style scoped>
.chartFrame {
  width: 100%;
  min-height: 680px;
  height: calc(100vh - 178px);
}

svg {
  display: block;
  width: 100%;
  height: 100%;
}

@media (max-width: 760px) {
  .chartFrame {
    min-height: 520px;
    height: calc(100vh - 260px);
  }
}
</style>
