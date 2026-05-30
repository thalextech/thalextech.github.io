<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
let resizeObserver = null;

const layout = {
  fallbackWidth: 1800,
  fallbackHeight: 980,
  margin: { top: 74, right: 56, bottom: 72, left: 82 },
};

const fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

function exportPng({ filename = "binary.png", scale = 4, padding = 24 } = {}) {
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
    (row) => row?.date instanceof Date && Number.isFinite(row?.nd2),
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
      .text(props.loading ? "Loading..." : "No N(d2) data.");
    return;
  }

  const x = d3
    .scaleUtc()
    .domain(d3.extent(rows, (d) => d.date))
    .range([0, innerWidth]);
  const y = d3.scaleLinear().domain([0, 1]).range([innerHeight, 0]);

  const chartG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  chartG
    .append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(".0%")),
    )
    .call(axisStyle);

  chartG
    .append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(9).tickSize(0).tickPadding(16))
    .call(axisStyle);

  chartG
    .append("text")
    .attr("x", -68)
    .attr("y", innerHeight / 2)
    .attr("transform", `rotate(-90,-68,${innerHeight / 2})`)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text(rows[0]?.optionType === "put" ? "N(-d2)" : "N(d2)");

  const probabilityLine = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.nd2))
    .curve(d3.curveStepAfter);

  chartG
    .append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", "#7aa2ff")
    .attr("stroke-width", 2)
    .attr("d", probabilityLine);

  const last = rows[rows.length - 1];
  chartG
    .append("circle")
    .attr("cx", x(last.date))
    .attr("cy", y(last.nd2))
    .attr("r", 4)
    .attr("fill", "#7aa2ff")
    .attr("stroke", "#020204")
    .attr("stroke-width", 1.5);

  chartG
    .append("text")
    .attr("x", Math.min(innerWidth - 70, x(last.date) + 12))
    .attr("y", y(last.nd2) - 12)
    .attr("fill", "#dbe6ff")
    .style("font-size", "13px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text(d3.format(".1%")(last.nd2));
}

watch(
  () => [props.data, props.subtitle, props.loading],
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
