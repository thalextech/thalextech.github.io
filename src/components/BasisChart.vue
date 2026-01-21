<script setup>
import * as d3 from "d3";
import { computed, onMounted, reactive, ref, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  instrumentName: { type: String, default: "" },
  range: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const tooltip = reactive({
  visible: false,
  left: 0,
  top: 0,
  datum: null,
});

const tooltipStyles = computed(() => ({
  left: `${tooltip.left}px`,
  top: `${tooltip.top}px`,
  opacity: tooltip.visible ? 1 : 0,
  visibility: tooltip.visible ? "visible" : "hidden",
}));

const formatTooltipDate = d3.utcFormat("%Y-%m-%d %H:%M");
const formatMarkValue = (value) =>
  Number.isFinite(value) ? value.toFixed(2) : "n/a";
const formatBasisValue = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const subtitle = computed(() => {
  const from = props.range?.from ? new Date(props.range.from * 1000) : null;
  const to = props.range?.to ? new Date(props.range.to * 1000) : null;
  if (!from || !to) return "";
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  return `${fmt(from)} — ${fmt(to)}`;
});

function exportPng({
  filename = "basis-chart.png",
  scale = 2,
  padding = 16,
} = {}) {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const viewBox = svgEl.getAttribute("viewBox");
  let width = 1200;
  let height = 650;
  if (viewBox) {
    const [, , vbWidth, vbHeight] = viewBox.split(" ").map(Number);
    if (Number.isFinite(vbWidth) && Number.isFinite(vbHeight)) {
      width = vbWidth;
      height = vbHeight;
    }
  }

  const svgClone = svgEl.cloneNode(true);
  if (!svgClone.getAttribute("xmlns")) {
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  svgClone.setAttribute("width", String(width));
  svgClone.setAttribute("height", String(height));

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgClone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const image = new Image();
  image.onload = () => {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safePadding =
      Number.isFinite(padding) && padding >= 0 ? padding : 0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((width + safePadding * 2) * safeScale);
    canvas.height = Math.round((height + safePadding * 2) * safeScale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.scale(safeScale, safeScale);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
    ctx.drawImage(image, safePadding, safePadding, width, height);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        URL.revokeObjectURL(url);
        return;
      }
      const downloadUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.src = url;
}

defineExpose({ exportPng });

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const data = props.data || [];
  tooltip.visible = false;
  tooltip.datum = null;

  const width = 1200;
  const height = 650;
  const margin = { top: 74, right: 38, bottom: 54, left: 74 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .style("font-family", SVG_FONT_FAMILY);

  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#000");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 30)
    .attr("fill", "#fff")
    .attr("text-anchor", "middle")
    .style("font-size", "18px")
    .style("font-weight", 650)
    .style("font-family", SVG_FONT_FAMILY)
    .text(`${props.instrumentName || "Instrument"} Basis`);

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 54)
    .attr("fill", "#c9c9cf")
    .attr("text-anchor", "middle")
    .style("font-size", "13px")
    .style("font-family", SVG_FONT_FAMILY)
    .text(subtitle.value);

  if (!data.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("fill", "#c9c9cf")
      .attr("text-anchor", "middle")
      .style("font-size", "14px")
      .style("font-family", SVG_FONT_FAMILY)
      .text("No data for this range.");
    return;
  }

  const xDomain = d3.extent(data, (d) => d.date);
  const yDomain = d3.extent(data, (d) => d.mark_price_close);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain(yDomain).nice().range([innerHeight, 0]);
  const bisectDate = d3.bisector((d) => d.date).left;

  const basisValues = data
    .map((d) => d.basis_pct)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const [extentMin, extentMax] = d3.extent(basisValues);
  const hasValidExtent =
    Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent ? extentMin : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";

  const colorForBasis = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) {
      return fallbackColor;
    }
    if (!hasSpread) {
      return d3.interpolateRdBu(0.5);
    }
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    return d3.interpolateRdBu(1 - clamped);
  };

  const formatBasisPct = (value) =>
    Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";

  const defs = svg.append("defs");
  const gradient = defs
    .append("linearGradient")
    .attr("id", "basis-gradient")
    .attr("x1", "0%")
    .attr("x2", "100%")
    .attr("y1", "0%")
    .attr("y2", "0%");

  const midBasis = domainMin + domainSpan / 2;
  const gradientStops = hasValidExtent
    ? [
        { offset: "0%", value: domainMin },
        { offset: "50%", value: midBasis },
        { offset: "100%", value: domainMax },
      ]
    : [
        { offset: "0%", value: 0 },
        { offset: "100%", value: 0 },
      ];

  gradientStops.forEach(({ offset, value }) => {
    gradient
      .append("stop")
      .attr("offset", offset)
      .attr("stop-color", colorForBasis(value));
  });

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(10);
  const yAxis = d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10);

  const axisStyle = (axisG) => {
    axisG.selectAll("line").remove();
    axisG.selectAll("path").remove();
    axisG
      .selectAll("text")
      .attr("fill", "#d6d7de")
      .style("font-family", SVG_FONT_FAMILY);
  };

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis)
    .call(axisStyle);

  g.append("g").call(yAxis).call(axisStyle);

  const axisTitlePadding = 10;

  g.append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding)
    .attr("fill", "#d6d7de")
    .attr("text-anchor", "middle")
    .style("font-size", "12px")
    .style("font-weight", 700)
    .style("font-family", SVG_FONT_FAMILY)
    .text("Date (UTC)");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding)
    .attr("fill", "#d6d7de")
    .attr("text-anchor", "middle")
    .style("font-size", "12px")
    .style("font-weight", 700)
    .style("font-family", SVG_FONT_FAMILY)
    .text("Mark Price (Close)");

  g.append("g")
    .selectAll("circle")
    .data(data)
    .join("circle")
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.mark_price_close))
    .attr("r", 4.4)
    .attr("fill", (d) => colorForBasis(d.basis_pct))
    .attr("stroke", "royalblue")
    .attr("stroke-width", 0.3)
    .attr("opacity", 0.9);

  const focusCircle = g
    .append("circle")
    .attr("r", 7)
    .attr("stroke", "#fff")
    .attr("stroke-width", 2)
    .attr("fill", "rgba(8, 9, 16, 0.8)")
    .attr("opacity", 0)
    .attr("pointer-events", "none");

  const interactionRect = g
    .append("rect")
    .attr("width", innerWidth)
    .attr("height", innerHeight)
    .attr("fill", "transparent")
    .attr("pointer-events", "all")
    .on("pointerleave", () => {
      focusCircle.attr("opacity", 0);
      tooltip.visible = false;
      tooltip.datum = null;
    })
    .on("pointermove", (event) => {
      const [mx] = d3.pointer(event);
      const x0 = x.invert(mx);
      let index = bisectDate(data, x0);
      if (index >= data.length) index = data.length - 1;
      const candidate = data[index];
      const previous = data[index - 1];
      let selection = candidate ?? previous;
      if (previous && candidate) {
        selection =
          Math.abs(x0 - previous.date) <= Math.abs(x0 - candidate.date)
            ? previous
            : candidate;
      }
      if (!selection) {
        focusCircle.attr("opacity", 0);
        tooltip.value.visible = false;
        return;
      }

      focusCircle
        .attr("cx", x(selection.date))
        .attr("cy", y(selection.mark_price_close))
        .attr("opacity", 1);

      tooltip.visible = true;
      tooltip.left = margin.left + x(selection.date);
      tooltip.top = margin.top + y(selection.mark_price_close);
      tooltip.datum = selection;
    });

  focusCircle.raise();

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = width - margin.right - legendWidth;
  const legendY = margin.top - 52;

  const legend = svg
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  legend
    .append("text")
    .attr("x", 0)
    .attr("y", -6)
    .attr("fill", "#d6d7de")
    .style("font-size", "12px")
    .style("font-family", SVG_FONT_FAMILY)
    .text("Annualized basis");

  legend
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", "url(#basis-gradient)")
    .attr("stroke", "#2e3040");

  legend
    .append("text")
    .attr("x", 0)
    .attr("y", legendHeight + 18)
    .attr("fill", "#a9abb6")
    .style("font-size", "11px")
    .style("font-family", SVG_FONT_FAMILY)
    .text(formatBasisPct(extentMin));

  legend
    .append("text")
    .attr("x", legendWidth)
    .attr("y", legendHeight + 18)
    .attr("fill", "#a9abb6")
    .attr("text-anchor", "end")
    .style("font-size", "11px")
    .style("font-family", SVG_FONT_FAMILY)
    .text(formatBasisPct(extentMax));
}

watch(
  () => [props.data, props.instrumentName, props.range],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" />
    <div v-if="loading" class="overlay">Loading…</div>
    <div
      class="tooltip"
      v-show="tooltip.visible && tooltip.datum"
      :style="tooltipStyles"
    >
      <div class="tooltip-time">
        {{ tooltip.datum?.date ? formatTooltipDate(tooltip.datum.date) : "" }}
      </div>
      <div class="tooltip-row">
        <span class="tooltip-label">Instrument</span>
        <span class="tooltip-value">
          {{ tooltip.datum?.instrument_name || "n/a" }}
        </span>
      </div>
      <div class="tooltip-row">
        <span class="tooltip-label">Mark Close</span>
        <span class="tooltip-value">
          {{ formatMarkValue(tooltip.datum?.mark_price_close) }}
        </span>
      </div>
      <div class="tooltip-row">
        <span class="tooltip-label">Basis</span>
        <span class="tooltip-value">
          {{ formatBasisValue(tooltip.datum?.basis_pct) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

svg {
  display: block;
  width: 100%;
  height: auto;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    "Apple Color Emoji",
    "Segoe UI Emoji";
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
}

.tooltip {
  position: absolute;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.3;
  background: rgba(5, 6, 10, 0.95);
  border: 1px solid #3c3f54;
  box-shadow: 0 12px 25px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  transform: translate(-50%, -110%);
  transition: opacity 0.15s ease;
  white-space: nowrap;
}

.tooltip-time {
  font-weight: 600;
  margin-bottom: 4px;
  color: #f5f7ff;
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.tooltip-label {
  color: #9ea1be;
}

.tooltip-value {
  font-weight: 700;
  color: #f5f7ff;
}
</style>
