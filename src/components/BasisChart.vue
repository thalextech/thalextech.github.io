<script setup>
import * as d3 from "d3";
import { computed, onMounted, reactive, ref, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  detailData: { type: Array, default: () => [] },
  detailRange: { type: Object, default: null },
  mainTitle: { type: String, default: "" },
  mainSubtitle: { type: String, default: "" },
  detailTitle: { type: String, default: "" },
  detailSubtitle: { type: String, default: "" },
  instrumentName: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(["brush"]);

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

const layout = {
  mainWidth: 1200,
  panelHeight: 650,
  margin: { top: 74, right: 38, bottom: 54, left: 74 },
  panelGap: 90,
};

const chartState = {
  svg: null,
  mainGroup: null,
  xAxisGroup: null,
  yAxisGroup: null,
  pointsGroup: null,
  detailGroup: null,
  detailLayer: null,
  detailTitleText: null,
  detailSubtitleText: null,
  detailBrush: null,
  brushGroup: null,
  gradient: null,
  legendMinText: null,
  legendMaxText: null,
  noDataText: null,
  currentXScale: null,
  detailSource: null,
  detailDomainFull: null,
};

const subtitle = computed(() => {
  if (props.mainSubtitle) {
    return props.mainSubtitle;
  }
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const data = props.data || [];
  if (!data.length) return "";
  const dateFromData = data[0]?.date;
  const dateToData = data[data.length - 1]?.date;
  if (dateFromData && dateToData) {
    return `${fmt(dateFromData)} — ${fmt(dateToData)}`;
  }
  return "";
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
    const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
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
  const detailData = props.detailData || [];
  tooltip.visible = false;
  tooltip.datum = null;

  const panelHeight = layout.panelHeight;
  const margin = layout.margin;
  const detailActive =
    typeof props.detailRange?.from === "number" &&
    typeof props.detailRange?.to === "number";
  const mainWidth = layout.mainWidth;
  const innerWidth = mainWidth - margin.left - margin.right;
  const innerHeight = panelHeight - margin.top - margin.bottom;
  const scatterInnerWidth = innerHeight;
  const panelGap = detailActive ? layout.panelGap : 0;
  const scatterWidth = detailActive
    ? scatterInnerWidth + margin.left + margin.right
    : 0;
  const width = mainWidth + panelGap + scatterWidth;
  const height = panelHeight;
  const scatterOffsetX = mainWidth + panelGap;

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
    .attr("x", mainWidth / 2)
    .attr("y", 30)
    .attr("fill", "#fff")
    .attr("text-anchor", "middle")
    .style("font-size", "18px")
    .style("font-weight", 650)
    .style("font-family", SVG_FONT_FAMILY)
    .text(props.mainTitle || `${props.instrumentName || "Instrument"} Basis`);

  svg
    .append("text")
    .attr("x", mainWidth / 2)
    .attr("y", 54)
    .attr("fill", "#c9c9cf")
    .attr("text-anchor", "middle")
    .style("font-size", "13px")
    .style("font-family", SVG_FONT_FAMILY)
    .text(subtitle.value);

  const detailTitle = props.detailTitle || "Basis vs Price";
  const detailSubtitle = props.detailSubtitle || "";

  if (detailActive) {
    svg
      .append("text")
      .attr("x", scatterOffsetX + scatterWidth / 2)
      .attr("y", 30)
      .attr("fill", "#fff")
      .attr("text-anchor", "middle")
      .style("font-size", "16px")
      .style("font-weight", 600)
      .style("font-family", SVG_FONT_FAMILY)
      .text(detailTitle);

    svg
      .append("text")
      .attr("x", scatterOffsetX + scatterWidth / 2)
      .attr("y", 54)
      .attr("fill", "#c9c9cf")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("font-family", SVG_FONT_FAMILY)
      .text(detailSubtitle);
  }

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

  const basisValues = [...data, ...detailData]
    .map((d) => d?.basis_pct)
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
    .attr("stroke", "whitesmoke")
    .attr("stroke-width", 0.2)
    .attr("opacity", 0.9);

  const detailG = detailActive
    ? svg
        .append("g")
        .attr(
          "transform",
          `translate(${scatterOffsetX + margin.left},${margin.top})`,
        )
    : null;

  const detailLayer = detailG ? detailG.append("g") : null;
  const detailBaseY = margin.top;
  const detailSource = detailData.length ? detailData : data;
  const detailDomainFull = d3.extent(detailSource, (d) => d.date);

  const renderDetail = (domain) => {
    if (!detailLayer) return;
    detailLayer.selectAll("*").remove();
    tooltip.visible = false;
    tooltip.datum = null;

    if (!detailSource.length || !detailDomainFull[0] || !detailDomainFull[1]) {
      detailLayer
        .append("text")
        .attr("x", scatterInnerWidth / 2)
        .attr("y", innerHeight / 2)
        .attr("fill", "#c9c9cf")
        .attr("text-anchor", "middle")
        .style("font-size", "13px")
        .style("font-family", SVG_FONT_FAMILY)
        .text("No detail data available.");
      return;
    }

    if (
      !Array.isArray(domain) ||
      domain.length !== 2 ||
      !(domain[0] instanceof Date) ||
      !(domain[1] instanceof Date) ||
      domain[0] > domain[1]
    ) {
      return;
    }

    const [domainStart, domainEnd] = domain;
    const detailView = detailSource.filter(
      (d) => d.date >= domainStart && d.date <= domainEnd,
    );
    const detailPoints = detailView.filter(
      (d) =>
        Number.isFinite(d.mark_price_close) && Number.isFinite(d.basis_pct),
    );
    if (!detailPoints.length) {
      detailLayer
        .append("text")
        .attr("x", scatterInnerWidth / 2)
        .attr("y", innerHeight / 2)
        .attr("fill", "#c9c9cf")
        .attr("text-anchor", "middle")
        .style("font-size", "13px")
        .style("font-family", SVG_FONT_FAMILY)
        .text("No basis data available.");
      return;
    }

    const detailXDomain = d3.extent(detailPoints, (d) => d.mark_price_close);
    const detailYDomain = d3.extent(detailPoints, (d) => d.basis_pct);

    const detailX = d3
      .scaleLinear()
      .domain(detailXDomain)
      .nice()
      .range([0, scatterInnerWidth]);
    const detailY = d3
      .scaleLinear()
      .domain(detailYDomain)
      .nice()
      .range([innerHeight, 0]);
    const detailXAxis = d3
      .axisBottom(detailX)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat(d3.format(","));
    const detailYAxis = d3
      .axisLeft(detailY)
      .ticks(6)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat(d3.format(".2%"));

    detailLayer
      .append("g")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(detailXAxis)
      .call(axisStyle);

    detailLayer.append("g").call(detailYAxis).call(axisStyle);

    detailLayer
      .append("text")
      .attr("x", scatterInnerWidth / 2)
      .attr("y", innerHeight + 42 + axisTitlePadding)
      .attr("fill", "#d6d7de")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("font-weight", 700)
      .style("font-family", SVG_FONT_FAMILY)
      .text("Mark Price (Close)");

    detailLayer
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -52 - axisTitlePadding)
      .attr("fill", "#d6d7de")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("font-weight", 700)
      .style("font-family", SVG_FONT_FAMILY)
      .text("Annualized Basis");

    detailLayer
      .append("g")
      .selectAll("circle")
      .data(detailPoints)
      .join("circle")
      .attr("cx", (d) => detailX(d.mark_price_close))
      .attr("cy", (d) => detailY(d.basis_pct))
      .attr("r", 3.6)
      .attr("fill", (d) => colorForBasis(d.basis_pct))
      .attr("stroke", "black")
      .attr("stroke-width", 0.2)
      .attr("opacity", 0.7);

    const detailFocus = detailLayer
      .append("circle")
      .attr("r", 7)
      .attr("stroke", "#fff")
      .attr("stroke-width", 2)
      .attr("fill", "rgba(8, 9, 16, 0.8)")
      .attr("opacity", 0)
      .attr("pointer-events", "none");

    detailLayer
      .append("rect")
      .attr("width", scatterInnerWidth)
      .attr("height", innerHeight)
      .attr("fill", "transparent")
      .attr("pointer-events", "all")
      .on("pointerleave", () => {
        detailFocus.attr("opacity", 0);
        tooltip.visible = false;
        tooltip.datum = null;
    })
      .on("pointermove", (event) => {
        const [mx] = d3.pointer(event);
        const x0 = detailX.invert(mx);
        const selection = detailPoints.reduce((best, candidate) => {
          if (!best) return candidate;
          return Math.abs(candidate.mark_price_close - x0) <
            Math.abs(best.mark_price_close - x0)
            ? candidate
            : best;
        }, null);
        if (!selection) {
          detailFocus.attr("opacity", 0);
          tooltip.visible = false;
          tooltip.datum = null;
          return;
        }

        detailFocus
          .attr("cx", detailX(selection.mark_price_close))
          .attr("cy", detailY(selection.basis_pct))
          .attr("opacity", 1);

        tooltip.visible = true;
        tooltip.left =
          scatterOffsetX + margin.left + detailX(selection.mark_price_close);
        tooltip.top = detailBaseY + detailY(selection.basis_pct);
        tooltip.datum = selection;
      });
  };

  const BRUSH_THROTTLE_MS = 40;
  let brushPendingDomain = null;
  let brushTimer = null;
  let lastBrushTime = 0;

  const getNow = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const runBrushUpdate = () => {
    brushTimer = null;
    lastBrushTime = getNow();
    const domain = brushPendingDomain;
    brushPendingDomain = null;
    renderDetail(domain);
  };

  const scheduleBrushUpdate = (domain) => {
    brushPendingDomain = domain;
    const now = getNow();
    const elapsed = now - lastBrushTime;
    if (elapsed >= BRUSH_THROTTLE_MS && !brushTimer) {
      runBrushUpdate();
      return;
    }
    const delay = Math.max(0, BRUSH_THROTTLE_MS - elapsed);
    if (brushTimer) {
      clearTimeout(brushTimer);
    }
    brushTimer = setTimeout(runBrushUpdate, delay);
  };

  const flushBrushUpdate = () => {
    if (brushTimer) {
      clearTimeout(brushTimer);
      brushTimer = null;
    }
    if (brushPendingDomain !== null) {
      runBrushUpdate();
    }
  };

  const initialDomain = props.detailRange?.from
    ? [
      new Date(props.detailRange.from * 1000),
      new Date(props.detailRange.to * 1000),
    ]
    : null;
  renderDetail(initialDomain);
  const handleBrush = (event) => {
    const selection = event.selection;
    const domain = selection ? selection.map(x.invert) : null;
    scheduleBrushUpdate(domain);
  };

  const handleBrushEnd = (event) => {
    handleBrush(event);
    flushBrushUpdate();
    if (!event.sourceEvent) return;
    const selection = event.selection;
    if (!selection) {
      emit("brush", null);
      return;
    }
    const [from, to] = selection.map(x.invert);
    emit("brush", {
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(to.getTime() / 1000),
    });
  };

  const brush = d3
    .brushX()
    .extent([
      [0, 0],
      [innerWidth, innerHeight],
    ])
    .filter((event) => !event.ctrlKey && !event.button && event.detail < 2)
    .on("brush", handleBrush)
    .on("end", handleBrushEnd);

  const brushGroup = g.append("g").attr("class", "brush").call(brush);
  if (props.detailRange?.from != null && props.detailRange?.to != null) {
    brushGroup.call(brush.move, [
      x(new Date(props.detailRange.from * 1000)),
      x(new Date(props.detailRange.to * 1000)),
    ]);
  }

  const clearBrush = (event) => {
    event?.preventDefault?.();
    brushGroup.call(brush.move, null);
    emit("brush", null);
  };

  const overlay = brushGroup.selectAll(".overlay");

  brushGroup.on("dblclick", clearBrush);
  brushGroup.selectAll(".selection,.handle").on("dblclick", clearBrush);
  overlay.on("dblclick", clearBrush);
  overlay.on("click", (event) => {
    if (!event?.defaultPrevented) {
      clearBrush(event);
    }
  });

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
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
  () => [
    props.data,
    props.detailData,
    props.detailRange,
    props.mainTitle,
    props.mainSubtitle,
    props.detailTitle,
    props.detailSubtitle,
    props.instrumentName,
  ],
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
