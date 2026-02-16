<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  tracks: { type: Array, default: () => [] },
  indexData: { type: Array, default: () => [] },
  indexProjectedData: { type: Array, default: () => [] },
  spotPrice: { type: Number, default: null },
  spotTs: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  title: { type: String, default: "BTC Option Break-Even Forecast" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);

const layout = {
  width: 1800,
  height: 920,
  margin: { top: 96, right: 96, bottom: 82, left: 84 },
};

const formatPrice = d3.format(",.0f");
const formatProb = d3.format(".1%");
const RULER_LABEL_MIN_GAP = 12;
const RULER_LABEL_VERTICAL_OFFSET = 6;
const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;
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

const getNearestTrackPoint = (points, targetDate) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first?.date instanceof Date) || !(last?.date instanceof Date)) return null;
  if (targetDate < first.date || targetDate > last.date) return null;
  const bisect = d3.bisector((point) => point.date).center;
  const index = bisect(points, targetDate);
  const point = points[index];
  if (!(point?.date instanceof Date) || !Number.isFinite(point?.breakEven)) return null;
  return point;
};

const erfApprox = (x) => {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - tau);
};

const normalCdf = (x) => 0.5 * (1 + erfApprox(x / Math.SQRT2));

const calcNd2 = ({ spot, strike, iv, tauSeconds }) => {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tauSeconds)) return null;
  if (tauSeconds <= 0) {
    if (spot > strike) return 1;
    if (spot < strike) return 0;
    return 0.5;
  }
  const tau = tauSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d2 = (Math.log(spot / strike) - 0.5 * iv * iv * tau) / (iv * sqrtTau);
  if (!Number.isFinite(d2)) return null;
  return normalCdf(d2);
};

const calcOptionNd2 = ({ optionType, spot, strike, iv, tauSeconds }) => {
  const callNd2 = calcNd2({ spot, strike, iv, tauSeconds });
  if (!Number.isFinite(callNd2)) return null;
  return optionType === "put" ? 1 - callNd2 : callNd2;
};

const interpolateSeriesValue = (points, targetDate) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first?.date instanceof Date) || !(last?.date instanceof Date)) return null;
  if (targetDate <= first.date) return Number(first?.value);
  if (targetDate >= last.date) return Number(last?.value);
  const bisect = d3.bisector((point) => point.date).left;
  const index = bisect(points, targetDate);
  const left = points[Math.max(0, index - 1)];
  const right = points[Math.min(points.length - 1, index)];
  const leftValue = Number(left?.value);
  const rightValue = Number(right?.value);
  if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) return null;
  if (!Number.isFinite(leftValue)) return rightValue;
  if (!Number.isFinite(rightValue)) return leftValue;
  const t0 = left.date.getTime();
  const t1 = right.date.getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return leftValue;
  const ratio = (targetDate.getTime() - t0) / (t1 - t0);
  return leftValue + (rightValue - leftValue) * ratio;
};

const spreadLabelY = (labels, minY, maxY, gap) => {
  const sorted = labels
    .map((label) => ({ ...label }))
    .sort((a, b) => a.rawY - b.rawY);
  let cursor = minY;
  for (const label of sorted) {
    label.y = Math.max(label.rawY, cursor);
    cursor = label.y + gap;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1].y - maxY : 0;
  if (overflow > 0) {
    for (const label of sorted) {
      label.y -= overflow;
    }
  }
  for (const label of sorted) {
    if (label.y < minY) label.y = minY;
    if (label.y > maxY) label.y = maxY;
  }
  return sorted;
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

  const rulerLayer = g.append("g").attr("display", "none");
  const rulerLine = rulerLayer
    .append("line")
    .attr("stroke", "#d6d7de")
    .attr("stroke-width", 1.2)
    .attr("stroke-dasharray", "4,4")
    .attr("opacity", 0.9);
  const labelsLayer = rulerLayer.append("g");

  const renderRulerAtX = (xPx) => {
    const clampedX = clamp(xPx, 0, innerWidth);
    const hoverDate = x.invert(clampedX);
    const tauSeconds = Number.isFinite(props.expiryTs)
      ? props.expiryTs - hoverDate.getTime() / 1000
      : null;
    const interpolatedSpot = interpolateSeriesValue(indexCurvePoints, hoverDate);
    const spotAtHover = Number.isFinite(interpolatedSpot)
      ? interpolatedSpot
      : props.spotPrice;
    rulerLine
      .attr("x1", clampedX)
      .attr("x2", clampedX)
      .attr("y1", 0)
      .attr("y2", innerHeight);

    const labels = [];
    for (const track of tracks) {
      const nearest = getNearestTrackPoint(track.points, hoverDate);
      if (!nearest) continue;
      const iv = Number.isFinite(nearest?.iv) ? nearest.iv : track.referenceIv;
      const optionNd2 = calcOptionNd2({
        optionType: track.optionType,
        spot: spotAtHover,
        strike: track.strike,
        iv,
        tauSeconds,
      });
      const nd2Label = track.optionType === "put" ? "N(-d2)" : "N(d2)";
      const nd2Text = Number.isFinite(optionNd2) ? formatProb(optionNd2) : "n/a";
      const labelY = y(nearest.breakEven);
      if (!Number.isFinite(labelY)) continue;
      labels.push({
        id: `${track.optionType}:${track.strike}`,
        text: `${track.optionType === "call" ? "C" : "P"} ${formatPrice(track.strike)} ${nd2Label}=${nd2Text}`,
        color: track.color,
        rawY: labelY - RULER_LABEL_VERTICAL_OFFSET,
      });
    }
    if (Number.isFinite(spotAtHover)) {
      labels.push({
        id: "spot",
        text: `Spot ${formatPrice(spotAtHover)}`,
        color: "#ffffff",
        rawY: y(spotAtHover) - RULER_LABEL_VERTICAL_OFFSET,
      });
    }

    const spaced = spreadLabelY(labels, 8, innerHeight - 8, RULER_LABEL_MIN_GAP);
    const placeRight = clampedX < innerWidth * 0.75;
    const labelX = placeRight ? clampedX + 10 : clampedX - 10;
    const anchor = placeRight ? "start" : "end";

    labelsLayer
      .selectAll("text.rulerLabel")
      .data(spaced, (label) => label.id)
      .join(
        (enter) =>
          enter
            .append("text")
            .attr("class", "rulerLabel")
            .attr("fill", (label) => label.color)
            .style("font-size", "11px")
            .style("font-weight", 600)
            .style("font-family", "ui-sans-serif, system-ui")
            .attr("paint-order", "stroke")
            .attr("stroke", "#000")
            .attr("stroke-width", 3),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("text-anchor", anchor)
      .attr("x", labelX)
      .attr("y", (label) => label.y)
      .text((label) => label.text);
  };

  g.append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerWidth)
    .attr("height", innerHeight)
    .attr("fill", "transparent")
    .style("cursor", "crosshair")
    .on("mouseenter", function onEnter(event) {
      rulerLayer.attr("display", null);
      const [xPx] = d3.pointer(event, this);
      renderRulerAtX(xPx);
    })
    .on("mousemove", function onMove(event) {
      const [xPx] = d3.pointer(event, this);
      renderRulerAtX(xPx);
    })
    .on("mouseleave", () => {
      rulerLayer.attr("display", "none");
    });

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
