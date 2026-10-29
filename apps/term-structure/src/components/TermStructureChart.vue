<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
const props = defineProps({
  current: Array,
  expiries: { type: Array, default: () => [] },
  history: Array,
  asset: String,
  sliceLabel: String,
  sourceLabel: String,
  view: { type: String, default: "iv" },
  snapshotTime: Number,
  loading: Boolean,
  realized: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  realizedLabel: { type: String, default: "" },
  fitContainer: { type: Boolean, default: false },
  highlightExpiry: { type: Number, default: null },
});
const emit = defineEmits(["inspect"]);
const svgRef = ref(null);
const containerRef = ref(null);
const containerWidth = ref(1280);
let resizeObserver;
const margin = { top: 114, right: 44, bottom: 82, left: 78 };
const date = d3.utcFormat("%d %b %y"),
  stamp = d3.utcFormat("%d %b %Y %H:%M UTC");
function draw() {
  if (!svgRef.value) return;
  const W = props.fitContainer ? Math.max(760, containerWidth.value) : 1280;
  const H = props.fitContainer ? 480 : 600;
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  svg.style("width", props.fitContainer ? `${W}px` : null);
  svg
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr(
      "font-family",
      '"Helvetica Neue", Helvetica, -apple-system, sans-serif',
    );
  svg.append("rect").attr("width", W).attr("height", H).attr("fill", "#0a0b0e");
  svg
    .append("text")
    .attr("x", W / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .attr("font-size", 18)
    .attr("font-weight", 650)
    .text(
      `${props.asset} / ${props.sliceLabel} ${props.view === "forward" ? "forward volatility" : "volatility term structure"}`,
    );
  svg
    .append("text")
    .attr("x", W / 2)
    .attr("y", 62)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 12)
    .text(
      props.subtitle || `${props.snapshotTime ? stamp(new Date(props.snapshotTime * 1000)) : "Awaiting live quotes"} · Solid white: ${props.view === "forward" ? "forward vol from " : ""}${props.sourceLabel.toLowerCase()} · History: ${props.view === "forward" ? "hourly forwards" : "hourly marks"}`,
    );
  if (props.history.length) {
    const [oldest, newest] = d3.extent(props.history, (p) => p.ts);
    svg
      .append("text")
      .attr("x", W / 2)
      .attr("y", 82)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(
        `Dots: hourly ${props.view === "forward" ? "forward vol" : "IV"} · Horizontal jitter only · ${stamp(new Date(oldest * 1000))} — ${stamp(new Date(newest * 1000))}`,
      );
  }
  if (
    !props.current.length &&
    !props.history.length &&
    !props.realized.some((p) => p.iv != null)
  ) {
    svg
      .append("text")
      .attr("x", W / 2)
      .attr("y", H / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .attr("font-size", 16)
      .text(
        props.loading
          ? "Fetching live term structure…"
          : props.view === "forward"
            ? "No forward vol available. Both adjacent expiries and nonnegative forward variance are required."
            : "No interpolated IV available. Try ATM, Live marks or refresh.",
      );
    return;
  }
  const expiries = props.expiries.length
    ? props.expiries
    : [
        ...new Set([...props.current, ...props.history].map((p) => p.expiry)),
      ].sort((a, b) => a - b);
  const positions = new Map(expiries.map((expiry, index) => [expiry, index]));
  const shortDate = d3.utcFormat("%d %b");
  const periodLabel = (expiry) => {
    const index = positions.get(expiry);
    return props.view === "forward"
      ? `${index ? shortDate(new Date(expiries[index - 1] * 1000)) : "Now"} → ${date(new Date(expiry * 1000))}`
      : date(new Date(expiry * 1000));
  };
  const x = d3
    .scalePoint(expiries, [margin.left, W - margin.right])
    .padding(0.48);
  const [lo, hi] = d3.extent(
    [
      ...props.current,
      ...props.history,
      ...props.realized.filter((p) => p.iv != null),
    ],
    (p) => p.iv,
  );
  const pad = Math.max((hi - lo) * 0.14, 0.015);
  const y = d3
    .scaleLinear(
      [Math.max(0, lo - pad), hi + pad],
      [H - margin.bottom, margin.top],
    )
    .nice(6);
  const grid = svg
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickFormat(d3.format(".0%"))
        .tickSize(-(W - margin.left - margin.right))
        .tickPadding(16),
    );
  grid.select(".domain").remove();
  grid.selectAll("line").attr("stroke", "#23232a").attr("stroke-opacity", 0.7);
  grid.selectAll("text").attr("fill", "#70767d").attr("font-size", 12);
  const axis = svg
    .append("g")
    .attr("transform", `translate(0,${H - margin.bottom + 10})`)
    .call(d3.axisBottom(x).tickFormat(periodLabel).tickSize(0).tickPadding(13));
  axis.select(".domain").remove();
  axis.selectAll("text").attr("fill", "#70767d").attr("font-size", 12);
  if (props.fitContainer && props.view === "forward") {
    axis.selectAll(".tick text").each(function () {
      const text = d3.select(this);
      const [start, end] = text.text().split(" → ");
      text.text("");
      text.append("tspan").attr("x", 0).text(`${start} →`);
      text.append("tspan").attr("x", 0).attr("dy", "1.3em").text(end);
    });
  }
  svg
    .append("text")
    .attr("x", margin.left)
    .attr("y", margin.top - 14)
    .attr("fill", "#70767d")
    .attr("font-size", 11)
    .text("ANNUALIZED VOLATILITY");
  svg
    .append("text")
    .attr("x", (W + margin.left - margin.right) / 2)
    .attr("y", H - 20)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 11)
    .text(
      props.view === "forward"
        ? "EXPIRY INTERVAL · UTC"
        : "LISTED EXPIRY · UTC",
    );

  const historyLayer = svg.append("g");
  const jitterWidth = Math.min(x.step() * 0.14, 20);
  // Stable decorative jitter: timestamps never change vertical observations.
  const jitter = (p) =>
    ((Math.sin(p.ts * 0.013 + p.expiry * 0.007) * 43758.5453) % 1) *
    jitterWidth;
  historyLayer
    .selectAll("circle")
    .data(props.history)
    .join("circle")
    .attr("cx", (p) => x(p.expiry) + jitter(p))
    .attr("cy", (p) => y(p.iv))
    .attr("r", 2.4)
    .attr("fill", "#ffffff")
    .attr("fill-opacity", 0.18)
    .append("title")
    .text(
      (p) =>
        `${periodLabel(p.expiry)} · ${(p.iv * 100).toFixed(2)}%\nHourly close: ${stamp(new Date(p.ts * 1000))}${p.clamped ? "\nNearest-strike ATM fallback in an IV input" : ""}`,
    );
  const line = d3
    .line()
    .defined((p) => p != null)
    .x((p) => x(p.expiry))
    .y((p) => y(p.iv))
    .curve(d3.curveMonotoneX);
  if (props.realized.length) {
    const rvLine = d3
      .line()
      .defined((p) => p.iv != null)
      .x((p) => x(p.expiry))
      .y((p) => y(p.iv))
      .curve(d3.curveMonotoneX);
    svg
      .append("path")
      .datum(props.realized)
      .attr("d", rvLine)
      .attr("fill", "none")
      .attr("stroke", "#0a0b0e")
      .attr("stroke-width", 5)
      .attr("stroke-dasharray", "6 5");
    svg
      .append("path")
      .datum(props.realized)
      .attr("d", rvLine)
      .attr("fill", "none")
      .attr("stroke", "#e8eaed")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "6 5");
    svg
      .append("g")
      .selectAll("circle")
      .data(props.realized.filter((p) => p.iv != null))
      .join("circle")
      .attr("cx", (p) => x(p.expiry))
      .attr("cy", (p) => y(p.iv))
      .attr("r", 4)
      .attr("fill", "#0a0b0e")
      .attr("stroke", "#e8eaed")
      .attr("stroke-width", 1.5)
      .append("title")
      .text(
        (p) =>
          p.tooltip || `${periodLabel(p.expiry)} · RV ${(p.iv * 100).toFixed(2)}%\nGarman–Klass · ${p.count}/${p.hours} hourly bars (${(p.coverage * 100).toFixed(2)}%)${p.partial ? "\nEstimated from available bars; missing hours skipped" : ""}\n${stamp(new Date(p.start * 1000))} — ${stamp(new Date(p.end * 1000))}`,
      );
    svg
      .append("text")
      .attr("data-export-label", props.realizedLabel || "Dashed: realized volatility")
      .attr("x", margin.left)
      .attr("y", H - 20)
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(
        props.realizedLabel || `Dashed: ${props.view === "forward" ? "duration-matched trailing" : "matched-window"} RV · ${props.realized.filter((p) => p.iv != null).length}/${props.realized.length} ${props.view === "forward" ? "intervals" : "expiries"}`,
      );
  }
  const currentByExpiry = new Map(props.current.map((p) => [p.expiry, p]));
  const currentPath = expiries.map((expiry) => currentByExpiry.get(expiry));
  svg
    .append("path")
    .datum(currentPath)
    .attr("d", line)
    .attr("fill", "none")
    .attr("stroke", "#0a0b0e")
    .attr("stroke-width", 7);
  svg
    .append("path")
    .datum(currentPath)
    .attr("d", line)
    .attr("fill", "none")
    .attr("stroke", "#f5f5f7")
    .attr("stroke-width", 2.5);
  const pointTooltip = (p) => p.tooltip || `${periodLabel(p.expiry)} · Live ${(p.iv * 100).toFixed(2)}%\n${p.count} historical observations · ${p.rank == null ? "No rank" : p.rank.toFixed(1) + " percentile"}${p.clamped ? "\nNearest-strike ATM fallback in an IV input" : ""}`;
  const current = svg.append("g").selectAll("g").data(props.current).join("g")
    .attr("tabindex", props.fitContainer ? 0 : null)
    .attr("role", props.fitContainer ? "img" : null)
    .attr("aria-label", props.fitContainer ? pointTooltip : null)
    .on("pointerenter", (_, p) => emit("inspect", p.expiry))
    .on("click", (_, p) => emit("inspect", p.expiry))
    .on("focus", (_, p) => emit("inspect", p.expiry));
  current
    .append("circle")
    .attr("cx", (p) => x(p.expiry))
    .attr("cy", (p) => y(p.iv))
    .attr("r", 14)
    .attr("fill", "transparent");
  current
    .append("circle")
    .attr("data-current-point", "")
    .attr("cx", (p) => x(p.expiry))
    .attr("cy", (p) => y(p.iv))
    .attr("r", (p) => p.expiry === props.highlightExpiry ? 7 : 5)
    .attr("fill", (p) => p.expiry === props.highlightExpiry ? "#85a5ff" : "#fff")
    .attr("stroke", "#0a0b0e")
    .attr("stroke-width", 2);
  current
    .append("text")
    .attr("x", (p) => x(p.expiry))
    .attr("y", (p) => y(p.iv) - 18)
    .attr("fill", "#f5f5f7")
    .attr("font-size", 13)
    .attr("font-weight", 600)
    .attr("text-anchor", "middle")
    .attr("stroke", "#0a0b0e")
    .attr("stroke-width", 4)
    .attr("paint-order", "stroke")
    .text((p) => `${(p.iv * 100).toFixed(1)}%`);
  current
    .append("title")
    .text(pointTooltip);
  if (!props.history.length)
    svg
      .append("text")
      .attr("data-export-omit", "")
      .attr("x", W - margin.right)
      .attr("y", H - 20)
      .attr("text-anchor", "end")
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(props.loading ? "History loading…" : "No history available");
}
onMounted(() => {
  draw();
  if (props.fitContainer && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(([entry]) => {
      containerWidth.value = Math.round(entry.contentRect.width);
    });
    resizeObserver.observe(containerRef.value);
  }
});
onBeforeUnmount(() => resizeObserver?.disconnect());
watch(
  () => [
    props.current,
    props.expiries,
    props.history,
    props.view,
    props.asset,
    props.sliceLabel,
    props.sourceLabel,
    props.subtitle,
    props.snapshotTime,
    props.realizedLabel,
    props.fitContainer,
    containerWidth.value,
    props.loading,
    props.realized,
  ],
  draw,
);
watch(() => props.highlightExpiry, () => {
  d3.select(svgRef.value).selectAll("[data-current-point]")
    .attr("r", (p) => p.expiry === props.highlightExpiry ? 7 : 5)
    .attr("fill", (p) => p.expiry === props.highlightExpiry ? "#85a5ff" : "#fff");
});
defineExpose({
  exportPng: () =>
    exportChartToPng({
      element: svgRef.value,
      filename: `${props.asset}-${props.sliceLabel.replaceAll(/[^a-z0-9]/gi, "-")}-term-structure-${props.view}-scatter.png`,
      background: "#0a0b0e",
      scale: 3,
      // Export only the SVG; page controls, details and data-status footnotes stay outside it.
      prepareSvgClone: (clone) => {
        clone
          .querySelectorAll("[data-export-omit], title")
          .forEach((node) => node.remove());
        clone.querySelectorAll("[data-export-label]").forEach((node) => {
          node.textContent = node.getAttribute("data-export-label");
        });
      },
    }),
});
</script>
<template>
  <div ref="containerRef" class="chart-scroll">
    <svg
      ref="svgRef"
      :role="fitContainer ? 'group' : 'img'"
      :aria-label="`${asset} ${sliceLabel} ${view === 'forward' ? 'forward volatility' : 'IV'} term structure${history?.length ? ' with historical dot clouds' : ''}`"
    ></svg>
  </div>
</template>
