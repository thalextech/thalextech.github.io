<script setup>
import * as d3 from "d3";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import {
  MAX_WEEKLY_PNL,
  MIN_WEEKLY_PNL,
  formatSignedDollar,
} from "../lib/profitBoost.js";

const props = defineProps({
  outcome: {
    type: Object,
    required: true,
  },
});

const COLORS = Object.freeze({
  base: "#ffffff",
  twoX: "#7aa2ff",
  threeX: "#58c4df",
  background: "#000000",
  secondary: "#a6aebb",
  subdued: "#858e9d",
});
const SERIES = Object.freeze([
  {
    key: "base",
    label: "Base",
    metricLabel: "Base profit",
    color: COLORS.base,
  },
  { key: "twoX", label: "2×", metricLabel: "2× profit", color: COLORS.twoX },
  {
    key: "threeX",
    label: "3×",
    metricLabel: "3× profit",
    color: COLORS.threeX,
  },
]);
const PROFIT_DOMAIN = Object.freeze([
  MIN_WEEKLY_PNL,
  MAX_WEEKLY_PNL * 3 + 1_200,
]);
const PROFIT_TICKS = Object.freeze([
  0,
  MAX_WEEKLY_PNL,
  MAX_WEEKLY_PNL * 2,
  MAX_WEEKLY_PNL * 3,
]);
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const wrapperRef = ref(null);
const svgRef = ref(null);
const width = ref(1120);
const isNarrow = computed(() => width.value < 680);
const height = computed(() => (isNarrow.value ? 680 : 640));
const viewBox = computed(() => `0 0 ${width.value} ${height.value}`);
const chartDescription = computed(() => {
  const { profits } = props.outcome;
  return [
    `Weekly realized P&L before boost is ${formatSignedDollar(props.outcome.inputPnl)}.`,
    `Base profit is ${formatSignedDollar(profits.base)}.`,
    `2× profit is ${formatSignedDollar(profits.twoX)}.`,
    `3× profit is ${formatSignedDollar(profits.threeX)}.`,
  ].join(" ");
});

let resizeObserver = null;

function resolveLabelPositions(items, minY, maxY, minGap) {
  const placed = [...items]
    .sort((a, b) => a.endpointY - b.endpointY)
    .map((item) => ({
      ...item,
      labelY: Math.max(minY, Math.min(maxY, item.endpointY)),
    }));

  for (let index = 1; index < placed.length; index += 1) {
    placed[index].labelY = Math.max(
      placed[index].labelY,
      placed[index - 1].labelY + minGap,
    );
  }

  const overflow = placed.at(-1)?.labelY - maxY;
  if (overflow > 0) {
    placed.forEach((item) => {
      item.labelY -= overflow;
    });
  }

  for (let index = placed.length - 2; index >= 0; index -= 1) {
    placed[index].labelY = Math.min(
      placed[index].labelY,
      placed[index + 1].labelY - minGap,
    );
  }

  return placed;
}

function appendText(group, options = {}) {
  return group
    .append("text")
    .attr("class", options.className ?? null)
    .attr("x", options.x ?? 0)
    .attr("y", options.y ?? 0)
    .attr("fill", options.fill ?? COLORS.secondary)
    .attr("font-family", SVG_FONT_FAMILY)
    .attr("font-size", options.size ?? 12)
    .attr("font-weight", options.weight ?? 400)
    .attr("text-anchor", options.anchor ?? "start")
    .attr("letter-spacing", options.letterSpacing ?? null)
    .text(options.text ?? "");
}

function renderHeader(svg, narrow, chartWidth) {
  const left = narrow ? 18 : 30;
  const right = narrow ? 18 : 30;

  appendText(svg, {
    x: left,
    y: 34,
    fill: "#ffffff",
    size: narrow ? 20 : 22,
    weight: 650,
    text: "Profit Boost",
  });
  appendText(svg, {
    x: left,
    y: 61,
    fill: "#d9dde6",
    size: narrow ? 11.5 : 13,
    weight: 550,
    text: `Weekly realized P&L before boost: ${formatSignedDollar(props.outcome.inputPnl)}`,
  });

  const metricsTop = narrow ? 91 : 94;
  const metricsWidth = chartWidth - left - right;
  const metricWidth = metricsWidth / SERIES.length;

  SERIES.forEach((series, index) => {
    const centerX = left + metricWidth * (index + 0.5);
    const group = svg
      .append("g")
      .attr("class", `outcomeMetric outcomeMetric-${series.key}`);

    appendText(group, {
      x: centerX,
      y: metricsTop + 4,
      fill: series.color,
      size: narrow ? 10 : 11,
      weight: 650,
      anchor: "middle",
      text: series.metricLabel,
    });
    appendText(group, {
      className: "outcomeProfit",
      x: centerX,
      y: metricsTop + (narrow ? 30 : 34),
      fill: series.color,
      size: narrow ? 15 : 18,
      weight: 700,
      anchor: "middle",
      text: formatSignedDollar(props.outcome.profits[series.key]),
    });
  });

}

function renderSeries(svg, layout, yScale) {
  const {
    axisX,
    chartBottom,
    chartTop,
    endpointX,
    narrow,
    startX,
  } = layout;
  const profits = props.outcome.profits;
  const coincident = props.outcome.inputPnl <= 0;
  const line = d3
    .line()
    .x((point) => point.x)
    .y((point) => point.y);

  const drawOrder = coincident ? [...SERIES].reverse() : SERIES;
  const coincidenceWidths = { base: 2.5, twoX: 6, threeX: 9 };

  drawOrder.forEach((series) => {
    const endpointY = yScale(profits[series.key]);
    svg
      .append("path")
      .attr("class", `profitPath profitPath-${series.key}`)
      .datum([
        { x: startX, y: yScale(0) },
        { x: endpointX, y: endpointY },
      ])
      .attr("d", line)
      .attr("fill", "none")
      .attr("stroke", series.color)
      .attr(
        "stroke-width",
        coincident ? coincidenceWidths[series.key] : narrow ? 2.2 : 2.6,
      )
      .attr("stroke-linecap", "round")
      .attr("opacity", coincident && series.key !== "base" ? 0.8 : 0.96);

    svg
      .append("circle")
      .attr("cx", endpointX)
      .attr("cy", endpointY)
      .attr("r", coincident ? coincidenceWidths[series.key] / 2 + 1 : 4)
      .attr("fill", series.color);
  });

  svg
    .append("circle")
    .attr("cx", startX)
    .attr("cy", yScale(0))
    .attr("r", 4)
    .attr("fill", "#ffffff")
    .attr("stroke", "#000000")
    .attr("stroke-width", 1.5);

  const labelX = endpointX + (narrow ? 6 : 10);
  if (coincident) {
    const endpointY = yScale(profits.base);
    const labelHeight = narrow ? 26 : 30;
    const labelY = Math.max(
      chartTop + labelHeight / 2,
      Math.min(chartBottom - labelHeight / 2, endpointY),
    );

    svg
      .append("line")
      .attr("x1", endpointX + 3)
      .attr("y1", endpointY)
      .attr("x2", labelX)
      .attr("y2", labelY)
      .attr("stroke", COLORS.secondary)
      .attr("stroke-width", 1)
      .attr("opacity", 0.7);

    const group = svg.append("g").attr("class", "endpointLabel endpointLabel-all");
    appendText(group, {
      x: labelX + 3,
      y: labelY + 4,
      fill: "#f2f4f8",
      size: narrow ? 9.5 : 11,
      weight: 650,
      text: `All  ${formatSignedDollar(profits.base)}`,
    });
    return;
  }

  const labelHeight = narrow ? 25 : 29;
  const positioned = resolveLabelPositions(
    SERIES.map((series) => ({
      ...series,
      endpointY: yScale(profits[series.key]),
    })),
    chartTop + labelHeight / 2,
    chartBottom - labelHeight / 2,
    labelHeight + (narrow ? 5 : 7),
  );

  positioned.forEach((series) => {
    svg
      .append("line")
      .attr("x1", endpointX + 3)
      .attr("y1", series.endpointY)
      .attr("x2", labelX)
      .attr("y2", series.labelY)
      .attr("stroke", series.color)
      .attr("stroke-width", 1)
      .attr("opacity", 0.65);

    const group = svg
      .append("g")
      .attr("class", `endpointLabel endpointLabel-${series.key}`);
    appendText(group, {
      x: labelX + 3,
      y: series.labelY + 4,
      fill: series.color,
      size: narrow ? 9.5 : 11,
      weight: 650,
      text: `${series.label} ${formatSignedDollar(profits[series.key])}`,
    });
  });
}

function renderFooter(svg, layout) {
  const { chartBottom, endpointX, startX } = layout;

  appendText(svg, {
    x: startX,
    y: chartBottom + 31,
    fill: COLORS.subdued,
    size: 10,
    weight: 650,
    anchor: "middle",
    letterSpacing: "0.08em",
    text: "START",
  });
  appendText(svg, {
    x: endpointX,
    y: chartBottom + 31,
    fill: COLORS.subdued,
    size: 10,
    weight: 650,
    anchor: "middle",
    letterSpacing: "0.08em",
    text: "WEEK END",
  });

}

function render() {
  const svgElement = svgRef.value;
  if (!svgElement) return;

  const chartWidth = width.value;
  const chartHeight = height.value;
  const narrow = isNarrow.value;
  const chartTop = 164;
  const chartBottom = chartHeight - 52;
  const axisX = chartWidth - (narrow ? 70 : 88);
  const startX = narrow ? 20 : 40;
  const endpointX = axisX - (narrow ? 88 : 142);
  const yScale = d3
    .scaleLinear()
    .domain(PROFIT_DOMAIN)
    .range([chartBottom, chartTop]);

  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${chartWidth} ${chartHeight}`)
    .attr("width", chartWidth)
    .attr("height", chartHeight);

  svg.append("title").text("Profit Boost");
  svg.append("desc").text(chartDescription.value);
  svg
    .append("rect")
    .attr("width", chartWidth)
    .attr("height", chartHeight)
    .attr("fill", COLORS.background);

  renderHeader(svg, narrow, chartWidth);

  const axis = d3
    .axisRight(yScale)
    .tickValues(PROFIT_TICKS)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(formatSignedDollar);
  const axisGroup = svg
    .append("g")
    .attr("class", "profitAxis")
    .attr("transform", `translate(${axisX},0)`)
    .call(axis);

  axisGroup.select(".domain").remove();
  axisGroup.selectAll(".tick line").remove();
  axisGroup
    .selectAll(".tick text")
    .attr("fill", "#9aa3b0")
    .attr("font-family", SVG_FONT_FAMILY)
    .attr("font-size", narrow ? 9.5 : 10.5)
    .attr("font-variant-numeric", "tabular-nums");

  appendText(svg, {
    x: axisX + 10,
    y: chartTop - 3,
    fill: "#cbd1dc",
    size: 11,
    weight: 650,
    text: "Profit",
  });

  const layout = {
    axisX,
    chartBottom,
    chartTop,
    chartWidth,
    endpointX,
    narrow,
    startX,
  };
  renderSeries(svg, layout, yScale);
  renderFooter(svg, layout);
}

function updateWidth() {
  const measured = wrapperRef.value?.clientWidth;
  if (!Number.isFinite(measured) || measured <= 0) return;
  width.value = Math.max(300, Math.floor(measured));
}

onMounted(async () => {
  await nextTick();
  updateWidth();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(wrapperRef.value);
  }
  render();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

watch(
  () => [
    props.outcome.inputPnl,
    props.outcome.profits.base,
    props.outcome.profits.twoX,
    props.outcome.profits.threeX,
    width.value,
  ],
  render,
);

function exportPng({ filename = "profit-boost.png" } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale: 4,
    padding: 20,
    background: COLORS.background,
  });
}

defineExpose({ exportPng });
</script>

<template>
  <section ref="wrapperRef" class="chartWrap">
    <svg
      ref="svgRef"
      class="profitChart"
      :viewBox="viewBox"
      :aria-label="chartDescription"
      role="img"
    />
  </section>
</template>

<style scoped>
.chartWrap {
  width: 100%;
  overflow: hidden;
  background: #000000;
  border: 1px solid #171b23;
  border-radius: 12px;
}

.profitChart {
  display: block;
  width: 100%;
  height: auto;
  background: #000000;
}
</style>
