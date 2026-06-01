<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  indexRows: { type: Array, default: () => [] },
  gridRows: { type: Array, default: () => [] },
  spot: { type: Number, default: null },
  loading: { type: Boolean, default: false },
  underlying: { type: String, default: "" },
  metric: { type: String, default: "omega" },
});

const emit = defineEmits(["select-option"]);

const svgRef = ref(null);
let resizeObserver = null;
let renderSequence = 0;
let hasAnimatedIndex = false;
let hasAnimatedDots = false;
let lastIndexRows = null;
let lastWidth = null;
let lastHeight = null;
let lastYDomainKey = "";

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

const axisStyle = (axisG, color = "#a1a1a1") => {
  axisG.selectAll("line").attr("stroke", "rgba(250, 250, 250, 0.08)");
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", color)
    .style("font-size", "12px")
    .style("font-family", fontFamily)
    .style("font-weight", 600);
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
      const omega = toFiniteNumber(row?.omega);
      if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return null;
      return {
        ...row,
        expiryTs,
        strike,
        markPrice,
        oneTouchMultiplier,
        omega,
        expiryLabel: row.expiryLabel || "",
        optionType: row.optionType === "put" ? "put" : "call",
      };
    })
    .filter(Boolean);
}

function getMetricValue(point) {
  return props.metric === "touch" ? point.oneTouchMultiplier : point.omega;
}

function formatMultiplier(value) {
  if (!Number.isFinite(value)) return "-";
  if (value > 1000) return ">1000X";
  if (value >= 100) return `${d3.format(".0f")(value)}X`;
  if (value >= 10) return `${d3.format(".1f")(value)}X`;
  return `${d3.format(".2f")(value)}X`;
}

function ensureLayer(svg, className, sortKey) {
  let layer = svg.select(`.${className}`);
  if (layer.empty()) {
    layer = svg.append("g").attr("class", className).attr("data-sort", sortKey);
  }
  return layer;
}

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const renderId = ++renderSequence;

  const svg = d3.select(svgEl);

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

  const sizeChanged = lastWidth !== width || lastHeight !== height;
  if (sizeChanged) {
    svg.selectAll("*").remove();
    lastWidth = width;
    lastHeight = height;
    lastIndexRows = null;
    lastYDomainKey = "";
  }

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "none");

  let bg = svg.select(".bgRect");
  if (bg.empty()) {
    bg = svg.append("rect").attr("class", "bgRect");
  }
  bg.attr("width", width).attr("height", height).attr("fill", "#000");

  let defs = svg.select("defs");
  if (defs.empty()) defs = svg.append("defs");

  const indexLayer = ensureLayer(svg, "indexLayer", "20");
  const gridLayer = ensureLayer(svg, "gridLayer", "30");
  const overlayLayer = ensureLayer(svg, "overlayLayer", "40");

  overlayLayer.selectAll(".emptyState, .spotLine").remove();

  const indexPoints = getIndexPoints();
  const gridPoints = getGridPoints();

  if (!indexPoints.length && !gridPoints.length) {
    indexLayer.selectAll("*").remove();
    gridLayer.selectAll("*").remove();
    overlayLayer
      .append("text")
      .attr("class", "emptyState")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#a1a1a1")
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

  gridLayer.selectAll("*").remove();
  const leftG = indexLayer;
  const rightG = gridLayer.append("g").attr("transform", `translate(${rightX},${chartY})`);

  const yDomainKey = `${y.domain()[0]}|${y.domain()[1]}|${y.range()[0]}|${y.range()[1]}`;
  const yDomainChanged = yDomainKey !== lastYDomainKey;
  lastYDomainKey = yDomainKey;
  const indexChanged = props.indexRows !== lastIndexRows || yDomainChanged;
  if (indexChanged) {
    lastIndexRows = props.indexRows;
    leftG.selectAll("*").remove();
    defs.selectAll(".indexClip").remove();
    leftG.attr("transform", `translate(${leftX},${chartY})`);

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
      const x = d3
        .scaleUtc()
        .domain(d3.extent(indexPoints, (d) => d.date))
        .range([0, leftWidth]);
      const clipId = `index-clip-${renderId}`;

      const clipRect = defs
        .append("clipPath")
        .attr("class", "indexClip")
        .attr("id", clipId)
        .append("rect")
        .attr("x", leftX)
        .attr("y", chartY)
        .attr("height", innerHeight);

      if (hasAnimatedIndex) {
        clipRect.attr("width", leftWidth);
      } else {
        clipRect
          .attr("width", 0)
          .transition()
          .duration(900)
          .ease(d3.easeCubicOut)
          .attr("width", leftWidth)
          .on("end", () => {
            hasAnimatedIndex = true;
          });
      }

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
        .attr("stroke", "#fafafa")
        .attr("stroke-width", 1.3)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", line);

      const last = indexPoints[indexPoints.length - 1];
      leftG
        .append("circle")
        .attr("cx", x(last.date))
        .attr("cy", y(last.price))
        .attr("r", 2.5)
        .attr("fill", "#fafafa");

      leftG
        .append("text")
        .attr("x", x(last.date) + 8)
        .attr("y", y(last.price) + 4)
        .attr("text-anchor", "start")
        .attr("fill", "#fafafa")
        .attr("stroke", "#000")
        .attr("stroke-width", 3)
        .attr("paint-order", "stroke")
        .style("font-size", "12px")
        .style("font-family", fontFamily)
        .style("font-weight", 700)
        .text(strikeFormat.format(last.price));
    }
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
  const dotRadius = Math.max(2, Math.min(3, xStep * 0.022, innerHeight * 0.005));

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
    .attr("stroke", "rgba(250, 250, 250, 0.12)")
    .attr("stroke-width", 1);

  rightG
    .selectAll(".strike-line")
    .data(sortedStrikes)
    .join("line")
    .attr("class", "strike-line")
    .attr("x1", 0)
    .attr("x2", rightWidth)
    .attr("y1", (d) => y(d))
    .attr("y2", (d) => y(d))
    .attr("stroke", "rgba(250, 250, 250, 0.08)")
    .attr("stroke-width", 1);

  if (Number.isFinite(props.spot)) {
    const spotY = y(props.spot);
    overlayLayer
      .append("line")
      .attr("class", "spotLine")
      .attr("x1", leftX)
      .attr("x2", rightX + rightWidth)
      .attr("y1", chartY + spotY)
      .attr("y2", chartY + spotY)
      .attr("stroke", "#fafafa")
      .attr("stroke-width", 1.2)
      .attr("stroke-dasharray", "6 8")
      .attr("opacity", 0.55);
  }

  const dots = rightG
    .selectAll(".dot")
    .data(gridPoints, (d) => d.instrumentName)
    .join("g")
    .attr("class", "dot")
    .attr("transform", (d) => `translate(${xGrid(d.expiryTs)},${y(d.strike)})`)
    .attr("opacity", hasAnimatedDots ? 1 : 0)
    .style("cursor", "pointer")
    .on("click", (_, d) => emit("select-option", d));

  dots
    .append("title")
    .text((d) => `${d.instrumentName} — click for details`);

  dots
    .append("circle")
    .attr("class", "dot-hit")
    .attr("r", Math.max(dotRadius * 3, 12))
    .attr("fill", "transparent")
    .attr("pointer-events", "all");

  dots
    .append("circle")
    .attr("r", dotRadius)
    .attr("fill", (d) => (d.optionType === "call" ? "#fafafa" : "#000"))
    .attr("stroke", "#fafafa")
    .attr("stroke-width", 1.2);

  dots
    .append("text")
    .attr("class", "dot-label")
    .attr("x", dotRadius + 3)
    .attr("y", (d) => (d.optionType === "put" ? dotRadius + 13 : -(dotRadius + 3)))
    .attr("text-anchor", "start")
    .attr("fill", "#fafafa")
    .attr("stroke", "#000")
    .attr("stroke-width", 3)
    .attr("paint-order", "stroke")
    .style("font-size", "11px")
    .style("font-weight", 400)
    .style("font-family", fontFamily)
    .text((d) => formatMultiplier(getMetricValue(d)));

  if (!hasAnimatedDots && gridPoints.length) {
    dots
      .transition()
      .delay((_, index) => 180 + index * 8)
      .duration(260)
      .attr("opacity", 1);
    hasAnimatedDots = true;
  }
}

function updateMetricLabels() {
  if (!svgRef.value) return;
  d3.select(svgRef.value)
    .selectAll(".dot-label")
    .text((d) => formatMultiplier(getMetricValue(d)));
}

watch(
  () => [props.indexRows, props.gridRows, props.spot, props.loading],
  () => render(),
  { deep: false },
);

watch(() => props.metric, updateMetricLabels);

watch(
  () => props.underlying,
  () => {
    hasAnimatedIndex = false;
    hasAnimatedDots = false;
    lastIndexRows = null;
    lastYDomainKey = "";
  },
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
  border: 1px solid #262626;
  background: #000;
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
  background: rgba(0, 0, 0, 0.5);
  color: #fafafa;
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
}
</style>
