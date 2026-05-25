<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { buildBreakEvenSnapshot } from "../lib/breakEvenSnapshot.js";

const props = defineProps({
  tracks: { type: Array, default: () => [] },
  indexData: { type: Array, default: () => [] },
  indexProjectedData: { type: Array, default: () => [] },
  spotPrice: { type: Number, default: null },
  spotTs: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  currentTs: { type: Number, default: null },
  title: { type: String, default: "BTC Option Break-Even Forecast" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);

const layout = {
  width: 1800,
  height: 920,
  margin: { top: 96, right: 390, bottom: 82, left: 84 },
};

const formatPrice = d3.format(",.0f");
const formatProb = d3.format(".1%");
const RULER_LABEL_VERTICAL_OFFSET = 8;
const NOW_LABEL_BASELINE_OFFSET = 4;
const NOW_LABEL_MIN_SPACING = 15;
const NOW_LABEL_LEADER_THRESHOLD = 3;
const TOOLTIP_HIT_RADIUS = 28;
const Y_AXIS_LABEL_PADDING = 72;

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#c0c0c0")
    .style("font-size", "14px")
    .style("font-family", "ui-sans-serif, system-ui");
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getTrackColor = (optionType, index, total) => {
  if (optionType === "call") {
    const scale = d3
      .scaleLinear()
      .domain([0, Math.max(1, total - 1)])
      .range(["#34ffb4", "#00a85d"]);
    return scale(index);
  }

  const scale = d3
    .scaleLinear()
    .domain([0, Math.max(1, total - 1)])
    .range(["#ff5e8c", "#bf0033"]);
  return scale(index);
};

const getSnapshotRowText = (row) => {
  const nd2Text = Number.isFinite(row.nd2) ? formatProb(row.nd2) : "n/a";
  return `${row.optionType === "call" ? "C" : "P"} ${formatPrice(row.strike)} ${row.nd2Label}=${nd2Text} BE=${formatPrice(row.breakEven)}`;
};

const getSnapshotLabels = ({ snapshot, y }) => {
  const labels = [];
  for (const row of snapshot.rows) {
    const labelY = y(row.breakEven);
    if (!Number.isFinite(labelY)) continue;
    labels.push({
      id: row.id,
      text: getSnapshotRowText(row),
      color: "#ffffff",
      rawY: labelY - RULER_LABEL_VERTICAL_OFFSET,
    });
  }
  if (Number.isFinite(snapshot.spot)) {
    labels.push({
      id: "spot",
      text: `Spot ${formatPrice(snapshot.spot)}`,
      color: "#ffffff",
      rawY: y(snapshot.spot) - RULER_LABEL_VERTICAL_OFFSET,
    });
  }
  return labels;
};

// Two-pass push-apart so right-side labels don't overlap when break-evens cluster.
// Mutates each item by setting `.y` to a de-collided baseline.
const deCollideLabels = (items, minY, maxY, spacing) => {
  if (!items.length) return;
  const sorted = [...items].sort((a, b) => a.targetY - b.targetY);
  let prev = minY - spacing;
  for (const item of sorted) {
    item.y = Math.max(item.targetY, prev + spacing);
    prev = item.y;
  }
  let next = maxY + spacing;
  for (let i = sorted.length - 1; i >= 0; i--) {
    sorted[i].y = Math.min(sorted[i].y, next - spacing);
    next = sorted[i].y;
  }
};

function exportPng({ filename = "break-even.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "black");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "white")
    .style("font-size", "22px")
    .style("font-weight", 650)
    .style("font-family", "ui-sans-serif, system-ui")
    .text(props.title);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 62)
      .attr("text-anchor", "middle")
      .attr("fill", "#a0a0a0")
      .style("font-size", "18px")
      .style("font-family", "ui-sans-serif, system-ui")
      .text(props.subtitle);
  }

  const rawTracks = Array.isArray(props.tracks) ? props.tracks : [];
  const indexActual = (props.indexData || []).filter(
    (point) => point?.date instanceof Date && Number.isFinite(point?.value),
  );
  const indexProjected = (props.indexProjectedData || []).filter(
    (point) => point?.date instanceof Date && Number.isFinite(point?.value),
  );
  const indexCurvePoints = [...indexActual, ...indexProjected]
    .filter((point) => point?.date instanceof Date && Number.isFinite(point?.value))
    .sort((a, b) => a.date - b.date)
    .filter((point, index, points) => {
      if (index === 0) return true;
      return point.date.getTime() !== points[index - 1].date.getTime();
    });
  const callTracks = rawTracks.filter((track) => track.optionType === "call");
  const putTracks = rawTracks.filter((track) => track.optionType === "put");

  const tracks = [
    ...callTracks.map((track, index) => ({
      ...track,
      color: getTrackColor("call", index, callTracks.length),
    })),
    ...putTracks.map((track, index) => ({
      ...track,
      color: getTrackColor("put", index, putTracks.length),
    })),
  ].map((track) => ({
    ...track,
    points: (track.points || []).filter(
      (point) => point?.date instanceof Date && Number.isFinite(point?.breakEven),
    ),
  }));

  const allPoints = tracks.flatMap((track) =>
    track.points.map((point) => ({
      ...point,
      optionType: track.optionType,
      strike: track.strike,
      instrumentName: track.instrumentName,
      color: track.color,
    })),
  );

  if (!allPoints.length && !indexActual.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "14px")
      .style("font-family", "ui-sans-serif, system-ui")
      .text(props.loading ? "Loading..." : "No break-even projections available.");
    return;
  }

  const spotDate = Number.isFinite(props.spotTs)
    ? new Date(props.spotTs * 1000)
    : null;
  const expiryDate = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000)
    : null;

  const minPointDate = allPoints.length
    ? d3.min(allPoints, (point) => point.date)
    : null;
  const maxPointDate = allPoints.length
    ? d3.max(allPoints, (point) => point.date)
    : null;
  const minIndexDate = indexActual.length
    ? d3.min(indexActual, (point) => point.date)
    : null;
  const maxIndexDate = indexActual.length
    ? d3.max(indexActual, (point) => point.date)
    : null;
  const maxProjectedDate = indexProjected.length
    ? d3.max(indexProjected, (point) => point.date)
    : null;

  const domainStartCandidates = [minPointDate, minIndexDate, spotDate].filter(
    (value) => value instanceof Date,
  );
  const domainEndCandidates = [maxPointDate, maxIndexDate, maxProjectedDate, expiryDate].filter(
    (value) => value instanceof Date,
  );

  let domainStart = d3.min(domainStartCandidates);
  let domainEnd = d3.max(domainEndCandidates);
  if (!(domainStart instanceof Date) || !(domainEnd instanceof Date)) {
    domainStart = minPointDate || minIndexDate;
    domainEnd = maxPointDate || maxIndexDate || maxProjectedDate;
  }

  if (!(domainStart instanceof Date) || !(domainEnd instanceof Date)) return;

  if (+domainStart === +domainEnd) {
    domainEnd = new Date(domainEnd.getTime() + 60 * 60 * 1000);
  }

  const yValues = allPoints.map((point) => point.breakEven);
  for (const point of indexActual) {
    yValues.push(point.value);
  }
  for (const point of indexProjected) {
    yValues.push(point.value);
  }
  if (Number.isFinite(props.spotPrice)) {
    yValues.push(props.spotPrice);
  }

  const minValue = d3.min(yValues) ?? 0;
  const maxValue = d3.max(yValues) ?? 1;
  const range = Math.max(maxValue - minValue, Math.abs(maxValue) * 0.02, 1);
  const domainMin = minValue - range * 0.08;
  const domainMax = maxValue + range * 0.08;

  const x = d3.scaleUtc().domain([domainStart, domainEnd]).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain([domainMin, domainMax])
    .nice()
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(15))
    .call(axisStyle);

  g.append("g")
    .call(
      d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(15).tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  g.append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 58)
    .attr("text-anchor", "middle")
    .attr("fill", "#a0a0a0")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text("Date (UTC)");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -Y_AXIS_LABEL_PADDING)
    .attr("text-anchor", "middle")
    .attr("fill", "#a0a0a0")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text("Break-even level");

  const indexLine = d3
    .line()
    .x((point) => x(point.date))
    .y((point) => y(point.value))
    .curve(d3.curveBasis);

  if (indexActual.length >= 2) {
    g.append("path")
      .datum(indexActual)
      .attr("fill", "none")
      .attr("stroke", "mistyrose")
      .attr("stroke-width", 3)
      .attr("opacity", 0.95)
      .attr("d", indexLine);
  }

  if (indexProjected.length >= 2) {
    g.append("path")
      .datum(indexProjected)
      .attr("fill", "none")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "6,4")
      .attr("opacity", 0.9)
      .attr("d", indexLine);
  }

  const breakEvenLine = d3
    .line()
    .x((point) => x(point.date))
    .y((point) => y(point.breakEven))
    .curve(d3.curveMonotoneX);
  for (const track of tracks) {
    if (!Array.isArray(track.points) || track.points.length < 2) continue;
    g.append("path")
      .datum(track.points)
      .attr("fill", "none")
      .attr("stroke", track.color)
      .attr("stroke-width", 2.6)
      .attr("opacity", 0.95)
      .attr("d", breakEvenLine);
  }

  if (Number.isFinite(props.currentTs)) {
    const nowSnapshot = buildBreakEvenSnapshot({
      tracks,
      indexCurvePoints,
      targetDate: new Date(props.currentTs * 1000),
      expiryTs: props.expiryTs,
      spotPrice: props.spotPrice,
    });
    const nowLabels = getSnapshotLabels({ snapshot: nowSnapshot, y }).map((label) => {
      const anchorY = label.rawY + RULER_LABEL_VERTICAL_OFFSET;
      return {
        ...label,
        anchorY,
        targetY: anchorY + NOW_LABEL_BASELINE_OFFSET,
      };
    });
    deCollideLabels(nowLabels, 14, innerHeight - 6, NOW_LABEL_MIN_SPACING);
    const nowLabelX = innerWidth + 14;

    const displacedLabels = nowLabels.filter(
      (label) => Math.abs(label.y - label.targetY) > NOW_LABEL_LEADER_THRESHOLD,
    );

    g.append("g")
      .attr("class", "nowLabelLeaders")
      .selectAll("line.nowLabelLeader")
      .data(displacedLabels, (label) => label.id)
      .join("line")
      .attr("class", "nowLabelLeader")
      .attr("x1", innerWidth + 2)
      .attr("x2", nowLabelX - 3)
      .attr("y1", (label) => label.anchorY)
      .attr("y2", (label) => label.y - NOW_LABEL_BASELINE_OFFSET)
      .attr("stroke", (label) => label.color)
      .attr("stroke-width", 0.75)
      .attr("opacity", 0.55);

    g.append("g")
      .attr("class", "nowLabels")
      .selectAll("text.nowLabel")
      .data(nowLabels, (label) => label.id)
      .join("text")
      .attr("class", "nowLabel")
      .attr("x", nowLabelX)
      .attr("y", (label) => label.y)
      .attr("text-anchor", "start")
      .attr("fill", (label) => label.color)
      .style("font-size", "13px")
      .style("font-weight", 400)
      .style("font-family", "ui-sans-serif, system-ui")
      .attr("paint-order", "stroke")
      .attr("stroke", "#000")
      .attr("stroke-width", 3)
      .text((label) => label.text);
  }

  const tooltipLayer = g.append("g").attr("display", "none");
  const tooltipDot = tooltipLayer
    .append("circle")
    .attr("r", 4.5)
    .attr("fill", "#ffffff")
    .attr("stroke", "#000")
    .attr("stroke-width", 2);
  const tooltipBg = tooltipLayer
    .append("rect")
    .attr("rx", 4)
    .attr("ry", 4)
    .attr("fill", "rgba(0,0,0,0.86)")
    .attr("stroke", "rgba(255,255,255,0.55)")
    .attr("stroke-width", 1);
  const tooltipText = tooltipLayer
    .append("text")
    .attr("fill", "#ffffff")
    .style("font-size", "13px")
    .style("font-weight", 500)
    .style("font-family", "ui-sans-serif, system-ui");

  const hideTooltip = () => {
    tooltipLayer.attr("display", "none");
  };

  const renderTooltip = (xPx, yPx) => {
    const clampedX = clamp(xPx, 0, innerWidth);
    const hoverDate = x.invert(clampedX);
    const snapshot = buildBreakEvenSnapshot({
      tracks,
      indexCurvePoints,
      targetDate: hoverDate,
      expiryTs: props.expiryTs,
      spotPrice: props.spotPrice,
    });

    const candidates = snapshot.rows
      .map((row) => ({
        row,
        y: y(row.breakEven),
      }))
      .filter((candidate) => Number.isFinite(candidate.y));

    if (!candidates.length) {
      hideTooltip();
      return;
    }

    const nearest = candidates.reduce((best, candidate) => {
      const distance = Math.abs(candidate.y - yPx);
      if (!best || distance < best.distance) {
        return { ...candidate, distance };
      }
      return best;
    }, null);

    if (!nearest || nearest.distance > TOOLTIP_HIT_RADIUS) {
      hideTooltip();
      return;
    }

    const text = getSnapshotRowText(nearest.row);
    tooltipText.text(text);
    const bbox = tooltipText.node()?.getBBox();
    if (!bbox) {
      hideTooltip();
      return;
    }

    const paddingX = 10;
    const paddingY = 7;
    const tooltipWidth = bbox.width + paddingX * 2;
    const tooltipHeight = bbox.height + paddingY * 2;
    const preferredRight = clampedX + 14;
    const tooltipX =
      preferredRight + tooltipWidth <= innerWidth
        ? preferredRight
        : clampedX - tooltipWidth - 14;
    const tooltipY = clamp(
      nearest.y - tooltipHeight - 10,
      8,
      innerHeight - tooltipHeight - 8,
    );

    tooltipLayer.attr("display", null);
    tooltipDot
      .attr("cx", clampedX)
      .attr("cy", nearest.y)
      .attr("fill", nearest.row.color || "#ffffff");
    tooltipBg
      .attr("x", tooltipX)
      .attr("y", tooltipY)
      .attr("width", tooltipWidth)
      .attr("height", tooltipHeight);
    tooltipText
      .attr("x", tooltipX + paddingX)
      .attr("y", tooltipY + paddingY - bbox.y);
  };

  g.append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerWidth)
    .attr("height", innerHeight)
    .attr("fill", "transparent")
    .style("cursor", "crosshair")
    .on("mouseenter", function onEnter(event) {
      const [xPx, yPx] = d3.pointer(event, this);
      renderTooltip(xPx, yPx);
    })
    .on("mousemove", function onMove(event) {
      const [xPx, yPx] = d3.pointer(event, this);
      renderTooltip(xPx, yPx);
    })
    .on("mouseleave", hideTooltip);

  const legend = g.append("g").attr("transform", "translate(8,8)");
  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 0)
    .attr("y2", 0)
    .attr("stroke", "#7dffbe")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 4)
    .attr("fill", "#a8f6c9")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text(`Call break-even lines (${callTracks.length})`);

  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 24)
    .attr("y2", 24)
    .attr("stroke", "#ff8fa3")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 28)
    .attr("fill", "#ffc0cb")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text(`Put break-even lines (${putTracks.length})`);

  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 48)
    .attr("y2", 48)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 52)
    .attr("fill", "#b9b9c1")
    .style("font-size", "12px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text("Break-even paths are line projections");
}

watch(
  () => [
    props.tracks,
    props.indexData,
    props.indexProjectedData,
    props.spotPrice,
    props.spotTs,
    props.expiryTs,
    props.currentTs,
    props.title,
    props.subtitle,
    props.loading,
  ],
  () => render(),
  { deep: true },
);

onMounted(() => render());
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
  border-radius: 14px;
  overflow: hidden;
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
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
}
</style>
