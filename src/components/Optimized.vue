<script setup>
import * as d3 from "d3";
import { computed, onMounted, reactive, ref, toRaw, watch } from "vue";

const props = defineProps({
  data: { type: Array, default: () => [] },
  detailData: { type: Array, default: () => [] },
  detailRange: { type: Object, default: null },
  instrumentName: { type: String, default: "" },
  detailResolution: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(["update:detailRange", "brush"]);

const svgRef = ref(null);
const canvasRef = ref(null);

// Interactive State
const tooltip = reactive({ visible: false, left: 0, top: 0, datum: null });
let cachedXScale = null; // Needed for brush inversion
let detailRafId = null; // For throttling

// Formatters
const fmtDate = d3.utcFormat("%Y-%m-%d %H:%M");
const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
const fmtPct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "n/a");
const SVG_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

// Static Layout
const MARGIN = { top: 70, right: 40, bottom: 50, left: 70 };
const PANEL_HEIGHT = 650;
const MAIN_WIDTH = 1200;
const PANEL_GAP = 90;

// --- Helper: Color Scale ---
function getColorScale(data) {
  const values = data.map((d) => d.basis_pct).filter(Number.isFinite);
  const [min, max] = d3.extent(values);
  const span = max - min;
  return (val) => {
    if (!Number.isFinite(val)) return "#7c7f8f";
    const t = span === 0 ? 0.5 : (val - min) / span;
    return d3.interpolateRdBu(1 - Math.max(0, Math.min(1, t)));
  };
}

// --- Helper: Canvas Dot ---
function drawDot(ctx, x, y, color, r = 4) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

// --- Main Render ---
function render() {
  const svgEl = svgRef.value;
  const canvasEl = canvasRef.value;
  if (!svgEl || !canvasEl) return;

  // 1. Prepare Data
  const rawData = toRaw(props.data) || [];
  const rawDetailData = toRaw(props.detailData) || [];
  const allData = rawDetailData.length ? rawDetailData : rawData;
  const detailActive = props.detailRange?.from && props.detailRange?.to;

  // 2. Calculate Layout
  const innerH = PANEL_HEIGHT - MARGIN.top - MARGIN.bottom;
  const innerW = MAIN_WIDTH - MARGIN.left - MARGIN.right;
  const scatterSize = innerH; // Square scatter plot
  const scatterOffset = MAIN_WIDTH + PANEL_GAP;
  const totalW =
    MAIN_WIDTH +
    (detailActive ? PANEL_GAP + scatterSize + MARGIN.left + MARGIN.right : 0);

  // 3. Reset DOM (Immediate Mode)
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvasEl.getContext("2d");

  // Resize Canvas
  canvasEl.width = totalW * dpr;
  canvasEl.height = PANEL_HEIGHT * dpr;
  canvasEl.style.width = `${totalW}px`;
  canvasEl.style.height = `${PANEL_HEIGHT}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, totalW, PANEL_HEIGHT);

  // Resize SVG & Wipe Content
  const svg = d3.select(svgEl);
  svg
    .attr("viewBox", `0 0 ${totalW} ${PANEL_HEIGHT}`)
    .style("font-family", SVG_FONT);
  svg.selectAll("*").remove(); // <--- SIMPLIFICATION: Wipe everything

  if (!rawData.length) {
    svg
      .append("text")
      .attr("x", totalW / 2)
      .attr("y", PANEL_HEIGHT / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#666")
      .text("No data");
    return;
  }

  // 4. Shared Scales
  const colorScale = getColorScale(allData);
  const x = d3
    .scaleUtc()
    .domain(d3.extent(rawData, (d) => d.date))
    .range([0, innerW]);
  const y = d3
    .scaleLinear()
    .domain(d3.extent(rawData, (d) => d.mark_price_close))
    .nice()
    .range([innerH, 0]);
  cachedXScale = x; // Save for brush

  // 5. Draw Main Chart (Canvas Points)
  ctx.save();
  ctx.translate(MARGIN.left, MARGIN.top);
  ctx.globalAlpha = 0.9;
  for (const d of rawData) {
    if (d.date && Number.isFinite(d.mark_price_close)) {
      drawDot(
        ctx,
        x(d.date),
        y(d.mark_price_close),
        colorScale(d.basis_pct),
        4.4,
      );
    }
  }
  ctx.restore();

  // 6. Draw Main Chart (SVG Axes/Labels)
  const mainG = svg
    .append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Axes
  const axisStyle = (g) =>
    g.attr("color", "#d6d7de").style("font-size", "10px");
  mainG
    .append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(10))
    .call(axisStyle);
  mainG
    .append("g")
    .call(d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(10))
    .call(axisStyle);

  // Titles
  svg
    .append("text")
    .attr("x", MAIN_WIDTH / 2)
    .attr("y", 30)
    .attr("fill", "#fff")
    .attr("text-anchor", "middle")
    .attr("font-weight", 600)
    .text(`${props.instrumentName} Basis`);

  // 7. Setup Brush
  const brush = d3
    .brushX()
    .extent([
      [0, 0],
      [innerW, innerH],
    ])
    .on("brush end", (e) => {
      if (e.sourceEvent && e.type === "end" && !e.selection) {
        emit("update:detailRange", null);
        emit("brush", null);
      } else if (e.sourceEvent || e.type === "brush") {
        // Throttled update using RAF
        if (detailRafId) cancelAnimationFrame(detailRafId);
        detailRafId = requestAnimationFrame(() => {
          const sel = e.selection || [0, innerW]; // Default to full if null (shouldn't happen in brush)
          const [d0, d1] = sel.map(x.invert);
          updateDetailView(
            ctx,
            svg,
            allData,
            d0,
            d1,
            scatterOffset,
            scatterSize,
            innerH,
            colorScale,
          );

          if (e.type === "end" && e.selection) {
            emit("update:detailRange", {
              from: d0.getTime() / 1000,
              to: d1.getTime() / 1000,
            });
            emit("brush", {
              from: d0.getTime() / 1000,
              to: d1.getTime() / 1000,
            });
          }
        });
      }
    });

  const brushG = mainG.append("g").call(brush);

  // Move brush if props exist
  if (detailActive) {
    brushG.call(brush.move, [
      x(new Date(props.detailRange.from * 1000)),
      x(new Date(props.detailRange.to * 1000)),
    ]);
  } else {
    // Initial Draw of empty detail view or clear
    updateDetailView(
      ctx,
      svg,
      allData,
      null,
      null,
      scatterOffset,
      scatterSize,
      innerH,
      colorScale,
    );
  }
}

// --- Detail Update (Optimized) ---
function updateDetailView(
  ctx,
  svg,
  data,
  d0,
  d1,
  offsetX,
  size,
  height,
  colorFn,
) {
  // Clear Detail Area Canvas
  const totalH = height + MARGIN.top + MARGIN.bottom;
  const clearW = size + MARGIN.left + MARGIN.right;
  // NOTE: clearRect uses logic coords, assume transform is identity (we reset it inside render, but need to be careful inside RAF)
  // To be safe, we rely on the specific translate inside render.
  // Actually, easiest to clear exact rect:
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset to pixels
  const dpr = window.devicePixelRatio || 1;
  ctx.scale(dpr, dpr);
  ctx.clearRect(offsetX, 0, clearW, totalH); // Clear right panel
  ctx.restore();

  // If no active selection, hide detail group
  let detailG = svg.select(".detail-group");
  if (detailG.empty()) {
    detailG = svg.append("g").attr("class", "detail-group");
  }
  detailG.html(""); // Wipe detail SVG elements

  if (!d0 || !d1) return;

  // Filter Data
  const filtered = data.filter((d) => d.date >= d0 && d.date <= d1);
  if (!filtered.length) return;

  // Scales
  const x = d3
    .scaleLinear()
    .domain(d3.extent(filtered, (d) => d.mark_price_close))
    .nice()
    .range([0, size]);
  const y = d3
    .scaleLinear()
    .domain(d3.extent(filtered, (d) => d.basis_pct))
    .nice()
    .range([height, 0]);

  // Canvas Points
  ctx.save();
  ctx.translate(offsetX + MARGIN.left, MARGIN.top);
  ctx.globalAlpha = 0.7;
  for (const d of filtered) {
    if (Number.isFinite(d.mark_price_close) && Number.isFinite(d.basis_pct)) {
      drawDot(
        ctx,
        x(d.mark_price_close),
        y(d.basis_pct),
        colorFn(d.basis_pct),
        3.6,
      );
    }
  }
  ctx.restore();

  // SVG Axes & Overlay
  const g = detailG.attr(
    "transform",
    `translate(${offsetX + MARGIN.left}, ${MARGIN.top})`,
  );
  const axisStyle = (s) =>
    s.attr("color", "#d6d7de").style("font-size", "10px");

  g.append("g")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(",")))
    .call(axisStyle);
  g.append("g")
    .call(d3.axisLeft(y).ticks(6).tickFormat(d3.format(".2%")))
    .call(axisStyle);

  g.append("text")
    .attr("x", size / 2)
    .attr("y", -20)
    .attr("fill", "#fff")
    .attr("text-anchor", "middle")
    .text("Zoom View");

  // Interaction Overlay
  const focus = g
    .append("circle")
    .attr("r", 6)
    .attr("fill", "none")
    .attr("stroke", "#fff")
    .attr("opacity", 0);

  g.append("rect")
    .attr("width", size)
    .attr("height", height)
    .attr("fill", "transparent")
    .on("mousemove", (e) => {
      const [mx] = d3.pointer(e);
      const val = x.invert(mx);
      // Linear scan closest
      let closest = null,
        minDist = Infinity;
      for (const d of filtered) {
        const diff = Math.abs(d.mark_price_close - val);
        if (diff < minDist) {
          minDist = diff;
          closest = d;
        }
      }

      if (closest) {
        tooltip.visible = true;
        tooltip.datum = closest;
        tooltip.left = offsetX + MARGIN.left + x(closest.mark_price_close);
        tooltip.top = MARGIN.top + y(closest.basis_pct);
        focus
          .attr("cx", x(closest.mark_price_close))
          .attr("cy", y(closest.basis_pct))
          .attr("opacity", 1);
      }
    })
    .on("mouseleave", () => {
      tooltip.visible = false;
      focus.attr("opacity", 0);
    });
}

watch(() => [props.data, props.detailRange], render, { deep: false });
onMounted(render);
</script>

<template>
  <div class="chartWrap">
    <canvas ref="canvasRef" />
    <svg ref="svgRef" />

    <div v-if="loading" class="overlay">Loading...</div>

    <div
      v-show="tooltip.visible"
      class="tooltip"
      :style="{ left: tooltip.left + 'px', top: tooltip.top + 'px' }"
    >
      <div class="tt-title">
        {{ tooltip.datum ? fmtDate(tooltip.datum.date) : "" }}
      </div>
      <div class="tt-row">
        <span>Price</span>
        <b>{{ tooltip.datum ? fmtNum(tooltip.datum.mark_price_close) : "" }}</b>
      </div>
      <div class="tt-row">
        <span>Basis</span>
        <b>{{ tooltip.datum ? fmtPct(tooltip.datum.basis_pct) : "" }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}
canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
svg {
  position: relative;
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
  color: #fff;
}

.tooltip {
  position: absolute;
  pointer-events: none;
  transform: translate(-50%, -110%);
  background: rgba(10, 10, 15, 0.95);
  border: 1px solid #333;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  color: #eee;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
.tt-title {
  color: #888;
  margin-bottom: 4px;
  font-weight: 600;
}
.tt-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
</style>
