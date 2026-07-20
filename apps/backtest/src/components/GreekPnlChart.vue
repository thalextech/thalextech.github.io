<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  showIndex: { type: Boolean, default: false },
});
const emit = defineEmits(["update:showIndex"]);

const chartRef = ref(null);
let resizeObserver;

const FONT = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const DAY_SECONDS = 86_400;
const formatUsd = d3.format("$,.0f");
const formatIndex = d3.format("$,.0f");
const formatDate = d3.utcFormat("%d %b %Y");
const SERIES = [
  { key: "intervalPnlUsd", label: "Total", color: "#f1f2f4", width: 1.8 },
  { key: "netDeltaPnlUsd", label: "Net delta", color: "#d73027", width: 1.05 },
  { key: "gammaThetaPnlUsd", label: "Gamma–theta", color: "#f46d43", width: 1.05 },
  { key: "vegaPnlUsd", label: "Vega", color: "#fee090", width: 1.05 },
  { key: "vannaPnlUsd", label: "Vanna", color: "#abd9e9", width: 1.05 },
  { key: "volgaPnlUsd", label: "Volga", color: "#74add1", width: 1.05 },
  { key: "residualPnlUsd", label: "Residual", color: "#4575b4", width: 1.05 },
];

function aggregateDaily(rows) {
  const buckets = new Map();
  for (const point of rows.flatMap((row) => row.greekPnlTimeline || [])) {
    if (!Number.isFinite(point.ts) || !Number.isFinite(point.indexPrice)) continue;
    const ts = Math.floor(point.ts / DAY_SECONDS) * DAY_SECONDS;
    let bucket = buckets.get(ts);
    if (!bucket) {
      bucket = {
        ts,
        latestTs: point.ts,
        indexPrice: point.indexPrice,
        ...Object.fromEntries(SERIES.map(({ key }) => [key, 0])),
      };
      buckets.set(ts, bucket);
    }
    if (point.ts >= bucket.latestTs) {
      bucket.latestTs = point.ts;
      bucket.indexPrice = point.indexPrice;
    }
    for (const { key } of SERIES) bucket[key] += Number(point[key]) || 0;
  }

  const cumulative = Object.fromEntries(SERIES.map(({ key }) => [key, 0]));
  return [...buckets.values()]
    .sort((first, second) => first.ts - second.ts)
    .map((bucket) => {
      for (const { key } of SERIES) cumulative[key] += bucket[key];
      return {
        ...bucket,
        date: new Date(bucket.ts * 1000),
        ...Object.fromEntries(SERIES.map(({ key }) => [key, cumulative[key]])),
      };
    });
}

function styleAxis(group) {
  group.selectAll("path, line").remove();
  group.selectAll("text")
    .attr("fill", "#8f949c")
    .style("font", `11px ${FONT}`);
}

function draw() {
  const host = chartRef.value;
  if (!host) return;
  host.innerHTML = "";
  const rows = aggregateDaily(props.rows || []);
  const bounds = host.getBoundingClientRect();
  const width = Math.max(720, bounds.width || 1200);
  const height = Math.max(500, window.innerHeight - bounds.top - 34);
  const margin = { top: 54, right: props.showIndex ? 78 : 34, bottom: 56, left: 82 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const svg = d3.select(host).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", height)
    .attr("font-family", FONT)
    .attr("role", "img")
    .attr("aria-label", `Daily cumulative Greek PnL${props.showIndex ? " with BTC index" : ""}`);

  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle")
      .attr("fill", "#777c84").attr("font-size", 13)
      .text("Calculating daily Greek attribution…");
    return;
  }

  let dateDomain = d3.extent(rows, (row) => row.date);
  if (+dateDomain[0] === +dateDomain[1]) {
    dateDomain = [new Date(+dateDomain[0] - 43_200_000), new Date(+dateDomain[1] + 43_200_000)];
  }
  const pnlValues = rows.flatMap((row) => SERIES.map(({ key }) => row[key]));
  let [pnlLow, pnlHigh] = d3.extent([...pnlValues, 0]);
  const pnlPadding = Math.max(1, (pnlHigh - pnlLow) * 0.07);
  pnlLow -= pnlPadding;
  pnlHigh += pnlPadding;

  const x = d3.scaleUtc().domain(dateDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain([pnlLow, pnlHigh]).nice(5).range([innerHeight, 0]);
  const indexRows = props.showIndex ? rows.filter((row) => Number.isFinite(row.indexPrice)) : [];
  const indexExtent = d3.extent(indexRows, (row) => row.indexPrice);
  const indexPadding = indexRows.length
    ? Math.max(1, (indexExtent[1] - indexExtent[0]) * 0.07)
    : 0;
  const yIndex = indexRows.length
    ? d3.scaleLinear()
      .domain([indexExtent[0] - indexPadding, indexExtent[1] + indexPadding])
      .nice(5).range([innerHeight, 0])
    : null;
  const chart = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  chart.append("g").attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(width < 900 ? 5 : 9).tickFormat(d3.utcFormat("%b %y")).tickPadding(14))
    .call(styleAxis);
  chart.append("g")
    .call(d3.axisLeft(y).ticks(5).tickFormat(formatUsd).tickPadding(14))
    .call(styleAxis);
  if (yIndex) {
    chart.append("g").attr("transform", `translate(${innerWidth},0)`)
      .call(d3.axisRight(yIndex).ticks(5).tickFormat(d3.format("~s")).tickPadding(12))
      .call(styleAxis);
  }
  chart.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2).attr("y", -63).attr("text-anchor", "middle")
    .attr("fill", "#8f949c").style("font", `11px ${FONT}`).text("CUMULATIVE P&L ($)");

  const legend = chart.append("g").attr("transform", "translate(0,-28)");
  const legendItems = [
    ...SERIES,
    ...(yIndex ? [{ key: "indexPrice", label: "Index", color: "#a4a8ae", width: 1 }] : []),
  ];
  let legendX = 0;
  legendItems.forEach((item) => {
    const group = legend.append("g").attr("transform", `translate(${legendX},0)`);
    group.append("line")
      .attr("x2", 22).attr("stroke", item.color).attr("stroke-width", item.width)
      .attr("stroke-dasharray", item.key === "indexPrice" ? "3 4" : null);
    group.append("text")
      .attr("x", 30).attr("y", 4).attr("fill", "#c5c8cd")
      .style("font", `11px ${FONT}`).text(item.label);
    legendX += item.label.length * 6.4 + 54;
  });

  const line = (key, scale = y) => d3.line()
    .defined((row) => Number.isFinite(row[key]))
    .x((row) => x(row.date)).y((row) => scale(row[key]))
    .curve(d3.curveLinear);
  for (const series of SERIES) {
    chart.append("path").datum(rows)
      .attr("fill", "none").attr("stroke", series.color)
      .attr("stroke-width", series.width).attr("stroke-linejoin", "round")
      .attr("d", line(series.key));
  }
  if (yIndex) {
    chart.append("path").datum(indexRows)
      .attr("fill", "none").attr("stroke", "#a4a8ae").attr("stroke-opacity", 0.72)
      .attr("stroke-width", 1).attr("stroke-dasharray", "3 4")
      .attr("d", line("indexPrice", yIndex));
  }

  const hover = chart.append("g").style("pointer-events", "none");
  const bisect = d3.bisector((row) => row.ts).center;
  chart.append("rect")
    .attr("width", innerWidth).attr("height", innerHeight).attr("fill", "transparent")
    .on("mousemove", (event) => {
      hover.selectAll("*").remove();
      const [pointerX] = d3.pointer(event);
      const ts = x.invert(pointerX).getTime() / 1000;
      const row = rows[Math.max(0, Math.min(rows.length - 1, bisect(rows, ts)))];
      const xpos = x(row.date);
      hover.append("line")
        .attr("x1", xpos).attr("x2", xpos).attr("y2", innerHeight)
        .attr("stroke", "rgba(255,255,255,.20)");
      SERIES.forEach((series) => {
        hover.append("circle")
          .attr("cx", xpos).attr("cy", y(row[series.key])).attr("r", 3)
          .attr("fill", series.color).attr("stroke", "#090a0d");
      });
      if (yIndex) {
        hover.append("circle")
          .attr("cx", xpos).attr("cy", yIndex(row.indexPrice)).attr("r", 3)
          .attr("fill", "#a4a8ae").attr("stroke", "#090a0d");
      }
      const boxWidth = 204;
      const boxHeight = yIndex ? 188 : 169;
      const boxX = xpos > innerWidth - boxWidth - 12 ? xpos - boxWidth - 12 : xpos + 12;
      const box = hover.append("g").attr("transform", `translate(${boxX},12)`);
      box.append("rect")
        .attr("width", boxWidth).attr("height", boxHeight).attr("rx", 6)
        .attr("fill", "rgba(8,9,12,.96)").attr("stroke", "rgba(255,255,255,.12)");
      box.append("text")
        .attr("x", 11).attr("y", 20).attr("fill", "#d7dade")
        .style("font", `11px ${FONT}`).text(formatDate(row.date));
      SERIES.forEach((series, index) => {
        box.append("text")
          .attr("x", 11).attr("y", 42 + index * 19).attr("fill", series.color)
          .style("font", `11px ${FONT}`).text(`${series.label}: ${formatUsd(row[series.key])}`);
      });
      if (yIndex) {
        box.append("text")
          .attr("x", 11).attr("y", 42 + SERIES.length * 19).attr("fill", "#a4a8ae")
          .style("font", `11px ${FONT}`).text(`Index: ${formatIndex(row.indexPrice)}`);
      }
    })
    .on("mouseleave", () => hover.selectAll("*").remove());
}

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());
watch(() => [props.rows, props.showIndex], draw, { deep: true });

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
  <div class="greekPanel">
    <div class="greekHeader">
      <div>
        <h2>Cumulative Greek attribution</h2>
        <p>Daily contributions across the full backtest.</p>
      </div>
      <div class="overlayControl" role="group" aria-label="Chart overlays">
        <span>Overlay</span>
        <button
          type="button"
          :class="{ active: showIndex }"
          :aria-pressed="showIndex"
          @click="emit('update:showIndex', !showIndex)"
        >Index</button>
      </div>
    </div>
    <div ref="chartRef" class="greekChart"></div>
  </div>
</template>

<style scoped>
.greekPanel {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding: 2px 18px 10px;
}
.greekHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin: 18px 36px 0 64px;
}
.greekHeader h2 {
  margin: 0 0 4px;
  color: #fff;
  font-size: 18px;
  font-weight: 650;
}
.greekHeader p {
  margin: 0;
  color: #8f949c;
  font-size: 12px;
}
.overlayControl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.overlayControl > span {
  color: #8f949c;
  font-size: 11px;
}
.overlayControl button {
  height: 27px;
  padding: 0 11px;
  border: 1px solid rgba(255,255,255,.10);
  border-radius: 5px;
  background: rgba(255,255,255,.035);
  color: #9ba0a7;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.overlayControl button:hover,
.overlayControl button.active {
  border-color: rgba(255,255,255,.18);
  background: rgba(255,255,255,.09);
  color: #fff;
}
.greekChart {
  position: relative;
  flex: 1;
  min-height: 500px;
  min-width: 0;
}
.greekChart :deep(svg) {
  display: block;
}
</style>
