<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  indexRows: { type: Array, default: () => [] },
  gridRows: { type: Array, default: () => [] },
  spot: { type: Number, default: null },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
let resizeObserver = null;
let renderSequence = 0;

const layout = {
  fallbackWidth: 1800,
  fallbackHeight: 980,
  margin: { top: 78, right: 62, bottom: 72, left: 78 },
  gap: 46,
};

const fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

function exportPng({ filename = "option-grid.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const compactPrice = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const strikeFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const axisStyle = (axisG, color = "#d783ad") => {
  axisG.selectAll("line").attr("stroke", "rgba(238, 101, 161, 0.18)");
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", color)
    .style("font-size", "12px")
    .style("font-family", fontFamily)
    .style("font-weight", 650);
};

function getIndexPoints() {
  return (props.indexRows || [])
    .map((row) => {
      const ts = toFiniteNumber(row?.ts);
      const price = toFiniteNumber(row?.index_price_close);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return null;
      return { date: new Date(ts * 1000), price };
    })
    .filter(Boolean);
}

function getGridPoints() {
  return (props.gridRows || [])
    .map((row) => {
      const expiryTs = toFiniteNumber(row?.expiryTs);
      const strike = toFiniteNumber(row?.strike);
      const markPrice = toFiniteNumber(row?.markPrice);
      const oneTouchMultiplier = toFiniteNumber(row?.oneTouchMultiplier);
      if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return null;
      return {
        ...row,
        expiryTs,
        strike,
        markPrice,
        oneTouchMultiplier,
        expiryLabel: row.expiryLabel || "",
        optionType: row.optionType === "put" ? "put" : "call",
      };
    })
    .filter(Boolean);
}

function renderBackground(svg, width, height) {
  const defs = svg.append("defs");
  const bgGradient = defs
    .append("linearGradient")
    .attr("id", "grid-bg")
    .attr("x1", "0%")
    .attr("x2", "100%")
    .attr("y1", "0%")
    .attr("y2", "100%");

  bgGradient.append("stop").attr("offset", "0%").attr("stop-color", "#2a101b");
  bgGradient.append("stop").attr("offset", "48%").attr("stop-color", "#17080f");
  bgGradient.append("stop").attr("offset", "100%").attr("stop-color", "#060405");

  const glow = defs
    .append("radialGradient")
    .attr("id", "tile-glow")
    .attr("cx", "50%")
    .attr("cy", "50%")
    .attr("r", "72%");
  glow.append("stop").attr("offset", "0%").attr("stop-color", "#ffff72");
  glow.append("stop").attr("offset", "72%").attr("stop-color", "#edf042");
  glow.append("stop").attr("offset", "100%").attr("stop-color", "#d4d23a");

  const filter = defs
    .append("filter")
    .attr("id", "soft-glow")
    .attr("x", "-60%")
    .attr("y", "-60%")
    .attr("width", "220%")
    .attr("height", "220%");
  filter.append("feGaussianBlur").attr("stdDeviation", "5").attr("result", "blur");
  const merge = filter.append("feMerge");
  merge.append("feMergeNode").attr("in", "blur");
  merge.append("feMergeNode").attr("in", "SourceGraphic");

  svg.append("rect").attr("width", width).attr("height", height).attr("fill", "url(#grid-bg)");
}

function formatMultiplier(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return `${d3.format(",.0f")(value)}X`;
  if (value >= 100) return `${d3.format(".0f")(value)}X`;
  if (value >= 10) return `${d3.format(".1f")(value)}X`;
  return `${d3.format(".2f")(value)}X`;
}

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const renderId = ++renderSequence;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const wrap = svgEl.parentElement;
  const width = Math.max(720, Math.round(wrap?.clientWidth || layout.fallbackWidth));
  const height = Math.max(520, Math.round(wrap?.clientHeight || layout.fallbackHeight));
  const { margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const leftWidth = Math.round(innerWidth * 0.37);
  const rightWidth = innerWidth - leftWidth - layout.gap;
  const leftX = margin.left;
  const rightX = margin.left + leftWidth + layout.gap;
  const chartY = margin.top;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "none");
  renderBackground(svg, width, height);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", margin.left)
      .attr("y", 42)
      .attr("fill", "#f7b1d1")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .style("font-weight", 700)
      .text(props.subtitle);
  }

  const indexPoints = getIndexPoints();
  const gridPoints = getGridPoints();

  if (!indexPoints.length && !gridPoints.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#f6c6db")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.loading ? "Loading..." : "No option grid data.");
    return;
  }

  const allPrices = [
    ...indexPoints.map((point) => point.price),
    ...gridPoints.map((point) => point.strike),
    props.spot,
  ].filter(Number.isFinite);
  const yDomain = d3.extent(allPrices);
  const yPadding = Math.max(1, (yDomain[1] - yDomain[0]) * 0.08);
  const y = d3
    .scaleLinear()
    .domain([yDomain[0] - yPadding, yDomain[1] + yPadding])
    .nice()
    .range([innerHeight, 0]);

  const leftG = svg.append("g").attr("transform", `translate(${leftX},${chartY})`);
  const rightG = svg.append("g").attr("transform", `translate(${rightX},${chartY})`);

  leftG
    .append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(7)
        .tickSize(-leftWidth)
        .tickPadding(12)
        .tickFormat((value) => compactPrice.format(value)),
    )
    .call(axisStyle);

  if (indexPoints.length) {
    const x = d3.scaleUtc().domain(d3.extent(indexPoints, (d) => d.date)).range([0, leftWidth]);
    const clipId = `index-clip-${renderId}`;

    svg
      .append("clipPath")
      .attr("id", clipId)
      .append("rect")
      .attr("x", leftX)
      .attr("y", chartY)
      .attr("width", 0)
      .attr("height", innerHeight)
      .transition()
      .duration(900)
      .ease(d3.easeCubicOut)
      .attr("width", leftWidth);

    leftG
      .append("g")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(16))
      .call(axisStyle);

    const line = d3
      .line()
      .x((d) => x(d.date))
      .y((d) => y(d.price))
      .curve(d3.curveCatmullRom.alpha(0.5));

    leftG
      .append("path")
      .datum(indexPoints)
      .attr("clip-path", `url(#${clipId})`)
      .attr("fill", "none")
      .attr("stroke", "#ff79b4")
      .attr("stroke-width", 1.3)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("filter", "url(#soft-glow)")
      .attr("d", line);

    const last = indexPoints[indexPoints.length - 1];
    leftG
      .append("circle")
      .attr("cx", x(last.date))
      .attr("cy", y(last.price))
      .attr("r", 8)
      .attr("fill", "#fff7fb")
      .attr("filter", "url(#soft-glow)");
  }

  const expiryKeys = Array.from(new Set(gridPoints.map((point) => point.expiryTs))).sort(
    (a, b) => a - b,
  );
  const expiryLabels = new Map(
    gridPoints.map((point) => [point.expiryTs, point.expiryLabel]),
  );
  const xGrid = d3.scalePoint().domain(expiryKeys).range([0, rightWidth]).padding(0.5);
  const xStep = expiryKeys.length > 1 ? xGrid(expiryKeys[1]) - xGrid(expiryKeys[0]) : rightWidth;
  const sortedStrikes = Array.from(new Set(gridPoints.map((point) => point.strike))).sort(
    (a, b) => a - b,
  );
  const dotRadius = Math.max(3, Math.min(4.6, xStep * 0.032, innerHeight * 0.007));

  rightG
    .append("g")
    .call(
      d3
        .axisRight(y)
        .ticks(8)
        .tickSize(rightWidth)
        .tickPadding(12)
        .tickFormat((value) => compactPrice.format(value)),
    )
    .call(axisStyle);

  rightG.selectAll(".domain").remove();

  rightG
    .append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(
      d3
        .axisBottom(xGrid)
        .tickSize(0)
        .tickPadding(16)
        .tickFormat((value) => expiryLabels.get(value) || ""),
    )
    .call(axisStyle);

  rightG
    .selectAll(".expiry-line")
    .data(expiryKeys)
    .join("line")
    .attr("class", "expiry-line")
    .attr("x1", (d) => xGrid(d))
    .attr("x2", (d) => xGrid(d))
    .attr("y1", 0)
    .attr("y2", innerHeight)
    .attr("stroke", "rgba(238, 101, 161, 0.22)")
    .attr("stroke-width", 1.3);

  rightG
    .selectAll(".strike-line")
    .data(sortedStrikes)
    .join("line")
    .attr("class", "strike-line")
    .attr("x1", 0)
    .attr("x2", rightWidth)
    .attr("y1", (d) => y(d))
    .attr("y2", (d) => y(d))
    .attr("stroke", "rgba(238, 101, 161, 0.16)")
    .attr("stroke-width", 1.2);

  if (Number.isFinite(props.spot)) {
    const spotY = y(props.spot);
    svg
      .append("line")
      .attr("x1", leftX)
      .attr("x2", rightX + rightWidth)
      .attr("y1", chartY + spotY)
      .attr("y2", chartY + spotY)
      .attr("stroke", "#fff7fb")
      .attr("stroke-width", 1.4)
      .attr("stroke-dasharray", "6 8")
      .attr("opacity", 0.75);

    svg
      .append("text")
      .attr("x", rightX + rightWidth + 8)
      .attr("y", chartY + spotY + 4)
      .attr("fill", "#fff7fb")
      .style("font-size", "12px")
      .style("font-family", fontFamily)
      .style("font-weight", 800)
      .text(strikeFormat.format(props.spot));
  }

  const dots = rightG
    .selectAll(".dot")
    .data(gridPoints, (d) => d.instrumentName)
    .join("g")
    .attr("class", "dot")
    .attr("transform", (d) => `translate(${xGrid(d.expiryTs)},${y(d.strike)})`)
    .attr("opacity", 0);

  dots
    .transition()
    .delay((_, index) => 180 + index * 8)
    .duration(260)
    .attr("opacity", 1);

  dots
    .append("circle")
    .attr("r", dotRadius * 1.9)
    .attr("fill", (d) =>
      d.optionType === "call"
        ? "rgba(244, 246, 77, 0.18)"
        : "rgba(255, 121, 180, 0.18)",
    )
    .attr("filter", "url(#soft-glow)");

  dots
    .append("circle")
    .attr("r", dotRadius)
    .attr("fill", (d) => (d.optionType === "call" ? "#f3f64d" : "#ff79b4"))
    .attr("stroke", "#fff7fb")
    .attr("stroke-width", 1.2);

  dots
    .append("text")
    .attr("x", dotRadius + 7)
    .attr("y", 4)
    .attr("text-anchor", "start")
    .attr("fill", "#f7b1d1")
    .attr("stroke", "#17080f")
    .attr("stroke-width", 3)
    .attr("paint-order", "stroke")
    .style("font-size", "14px")
    .style("font-weight", 850)
    .style("font-family", fontFamily)
    .text((d) => formatMultiplier(d.oneTouchMultiplier));
}

watch(
  () => [props.indexRows, props.gridRows, props.spot, props.subtitle, props.loading],
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
  border: 1px solid rgba(244, 126, 181, 0.2);
  background: #12080d;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.025);
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
  background: rgba(18, 8, 13, 0.48);
  color: #f7d7e6;
  font-size: 14px;
  font-weight: 700;
  pointer-events: none;
}
</style>
