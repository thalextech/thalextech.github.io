<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  showIndex: { type: Boolean, default: false },
});

const svgRef = ref(null);
let resizeObserver;
const colors = { iv: "#7fa6ff", rv: "#f2f3f5" };
const font = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';

defineExpose({
  exportPng(options = {}) {
    exportChartToPng({ element: svgRef.value, ...options });
  },
});

function styleAxis(group) {
  group.selectAll("path, line").remove();
  group.selectAll("text").attr("fill", "#9ba0a7").style("font", `11px ${font}`);
}

function render() {
  if (!svgRef.value) return;
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  const host = svgRef.value.parentElement;
  const width = Math.max(520, host?.clientWidth || 1000);
  const height = Math.max(380, host?.clientHeight || 620);
  const margin = { top: 42, right: props.showIndex ? 66 : 28, bottom: 50, left: 66 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const rows = (props.rows || []).filter((row) => row.date instanceof Date);
  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle")
      .attr("fill", "#666c73").style("font", `12px ${font}`)
      .text(props.loading ? "Loading hourly IV/RV data…" : "No IV/RV observations in this range.");
    return;
  }

  const values = rows.flatMap((row) => [row.iv, row.rv]).filter(Number.isFinite);
  const extent = d3.extent(values);
  const pad = Math.max(0.01, (extent[1] - extent[0]) * 0.08);
  const x = d3.scaleUtc().domain(d3.extent(rows, (row) => row.date)).range([0, innerWidth]);
  const y = d3.scaleLinear().domain([Math.max(0, extent[0] - pad), extent[1] + pad]).nice().range([innerHeight, 0]);
  const indexRows = props.showIndex ? rows.filter((row) => Number.isFinite(row.close)) : [];
  const indexExtent = d3.extent(indexRows, (row) => row.close);
  const indexPad = indexRows.length ? Math.max(1, (indexExtent[1] - indexExtent[0]) * 0.08) : 0;
  const y2 = indexRows.length
    ? d3.scaleLinear().domain([indexExtent[0] - indexPad, indexExtent[1] + indexPad]).nice().range([innerHeight, 0])
    : null;
  const chart = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  chart.append("g").attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(width < 760 ? 4 : 8).tickPadding(14)).call(styleAxis);
  chart.append("g").call(d3.axisLeft(y).ticks(7).tickFormat(d3.format(".0%")).tickPadding(14)).call(styleAxis);
  if (y2) {
    chart.append("g").attr("transform", `translate(${innerWidth},0)`)
      .call(d3.axisRight(y2).ticks(6).tickFormat(d3.format(",.0f")).tickPadding(12)).call(styleAxis);
  }
  chart.append("text").attr("transform", "rotate(-90)").attr("x", -innerHeight / 2).attr("y", -50)
    .attr("text-anchor", "middle").attr("fill", "#9ba0a7").style("font", `11px ${font}`).text("ANNUALIZED VOL");

  const legend = chart.append("g").attr("transform", "translate(0,-22)");
  const legendRows = [["iv", "ATM IV"], ["rv", "PARKINSON RV"], ...(y2 ? [["index", "INDEX"]] : [])];
  legendRows.forEach(([key, label], index) => {
    const item = legend.append("g").attr("transform", `translate(${index * 126},0)`);
    if (key === "index") {
      item.append("rect").attr("x", 9).attr("y", -4).attr("width", 8).attr("height", 8)
        .attr("fill", "none").attr("stroke", "#f2f3f5").attr("stroke-opacity", 0.55).attr("stroke-width", 0.7);
    } else {
      item.append("line").attr("x2", 24).attr("stroke", colors[key]).attr("stroke-width", 2);
    }
    item.append("text").attr("x", 32).attr("y", 4).attr("fill", "#d7dade").style("font", `11px ${font}`).text(label);
  });

  const line = (key) => d3.line().defined((row) => Number.isFinite(row[key]))
    .x((row) => x(row.date)).y((row) => y(row[key])).curve(d3.curveStepAfter);
  for (const key of ["iv", "rv"]) {
    chart.append("path").datum(rows).attr("fill", "none").attr("stroke", colors[key])
      .attr("stroke-width", key === "iv" ? 1.8 : 1.5).attr("d", line(key));
  }
  if (y2) {
    const squareSize = width < 760 ? 2.4 : 3.2;
    chart.append("g").selectAll("rect").data(indexRows).join("rect")
      .attr("x", (row) => x(row.date) - squareSize / 2)
      .attr("y", (row) => y2(row.close) - squareSize / 2)
      .attr("width", squareSize).attr("height", squareSize)
      .attr("fill", "none").attr("stroke", "#f2f3f5")
      .attr("stroke-opacity", 0.55).attr("stroke-width", 0.7);
  }

  const hover = chart.append("g").style("pointer-events", "none");
  const bisect = d3.bisector((row) => row.ts).center;
  chart.append("rect").attr("width", innerWidth).attr("height", innerHeight).attr("fill", "transparent")
    .on("mousemove", (event) => {
      hover.selectAll("*").remove();
      const [px] = d3.pointer(event);
      const ts = x.invert(px).getTime() / 1000;
      const row = rows[Math.max(0, Math.min(rows.length - 1, bisect(rows, ts)))];
      const xpos = x(row.date);
      hover.append("line").attr("x1", xpos).attr("x2", xpos).attr("y2", innerHeight)
        .attr("stroke", "rgba(255,255,255,.22)");
      for (const key of ["iv", "rv"]) if (Number.isFinite(row[key])) {
        hover.append("circle").attr("cx", xpos).attr("cy", y(row[key])).attr("r", 4)
          .attr("fill", colors[key]).attr("stroke", "#090a0d");
      }
      if (y2 && Number.isFinite(row.close)) {
        hover.append("rect").attr("x", xpos - 3).attr("y", y2(row.close) - 3)
          .attr("width", 6).attr("height", 6).attr("fill", "#f2f3f5").attr("stroke", "#090a0d");
      }
      const boxWidth = 185;
      const boxX = xpos > innerWidth - boxWidth - 12 ? xpos - boxWidth - 12 : xpos + 12;
      const box = hover.append("g").attr("transform", `translate(${boxX},12)`);
      box.append("rect").attr("width", boxWidth).attr("height", y2 ? 95 : 76).attr("rx", 6)
        .attr("fill", "rgba(8,9,12,.95)").attr("stroke", "rgba(255,255,255,.12)");
      box.append("text").attr("x", 11).attr("y", 20).attr("fill", "#d7dade").style("font", `11px ${font}`)
        .text(d3.utcFormat("%Y-%m-%d %H:%M UTC")(row.date));
      [["iv", "ATM IV"], ["rv", "Parkinson RV"]].forEach(([key, label], index) => {
        box.append("text").attr("x", 11).attr("y", 42 + index * 19).attr("fill", colors[key]).style("font", `11px ${font}`)
          .text(`${label}: ${Number.isFinite(row[key]) ? d3.format(".2%")(row[key]) : "—"}`);
      });
      if (y2) {
        box.append("text").attr("x", 11).attr("y", 80).attr("fill", "#f2f3f5").style("font", `11px ${font}`)
          .text(`Index: ${Number.isFinite(row.close) ? d3.format(",.0f")(row.close) : "—"}`);
      }
    }).on("mouseleave", () => hover.selectAll("*").remove());
}

watch(() => [props.rows, props.loading, props.showIndex], render, { deep: true });
onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  if (svgRef.value?.parentElement) resizeObserver.observe(svgRef.value.parentElement);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="chartWrap"><svg ref="svgRef" class="chartSvg" role="img" aria-label="ATM IV versus realized volatility"></svg></div>
</template>

<style scoped>
.chartWrap, .chartSvg { width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; }
</style>
