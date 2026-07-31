<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import {
  buildVolPnlBarRows,
  VOLATILITY_METRICS,
} from "../lib/volPnlBar.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
});
const emit = defineEmits(["select"]);

const chartRef = ref(null);
const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatPercent = d3.format(".1%");
const formatUsd = d3.format("$,.0f");
const formatDate = d3.utcFormat("%d %b %Y");
const xMetric = ref(VOLATILITY_METRICS.RV);
const yMetric = ref("premium-return");

const X_METRIC_OPTIONS = [
  {
    value: VOLATILITY_METRICS.IV,
    label: "MINIMUM ENTRY IV",
    tooltipLabel: "Minimum entry IV",
  },
  {
    value: VOLATILITY_METRICS.RV,
    label: "TRAILING 7-DAY REALIZED VOL",
    tooltipLabel: "Trailing 7-day RV",
  },
  {
    value: VOLATILITY_METRICS.IV_MINUS_RV,
    label: "ENTRY IV − TRAILING 7-DAY RV",
    tooltipLabel: "Entry IV − trailing 7-day RV",
  },
];

const Y_METRIC_OPTIONS = [
  {
    value: "premium-return",
    key: "pnlOnPremium",
    label: "PNL / ENTRY PREMIUM",
    tooltipLabel: "PnL / entry premium",
    format: formatPercent,
    minimumPadding: 0.01,
  },
  {
    value: "usd",
    key: "pnlUsd",
    label: "PNL (USD)",
    tooltipLabel: "PnL",
    format: formatUsd,
    minimumPadding: 1,
  },
];

const selectedOption = (options, value) =>
  options.find((option) => option.value === value) || options[0];
const currentXMetric = () => selectedOption(X_METRIC_OPTIONS, xMetric.value);
const currentYMetric = () => selectedOption(Y_METRIC_OPTIONS, yMetric.value);

const cycleMetric = (options, currentValue, setValue) => {
  const currentIndex = options.findIndex((option) => option.value === currentValue);
  setValue(options[(currentIndex + 1) % options.length].value);
  draw();
};
const cycleXMetric = () => cycleMetric(
  X_METRIC_OPTIONS,
  xMetric.value,
  (value) => { xMetric.value = value; },
);
const cycleYMetric = () => cycleMetric(
  Y_METRIC_OPTIONS,
  yMetric.value,
  (value) => { yMetric.value = value; },
);

const cycleDate = (row) => new Date(row.cycle.entryTime);

function paddedDomain(values, minimumPadding) {
  let [minimum = 0, maximum = 1] = d3.extent([...values, 0]);
  const span = maximum - minimum;
  const padding = span > 0
    ? span * 0.08
    : Math.max(Math.abs(maximum) * 0.05, minimumPadding);
  return [minimum - padding, maximum + padding];
}

function appendInteractiveAxisLabel({
  svg,
  className,
  transform,
  width,
  label,
  ariaLabel,
  title,
  onCycle,
}) {
  const group = svg.append("g")
    .attr("class", className)
    .attr("transform", transform)
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", ariaLabel)
    .style("cursor", "pointer")
    .on("click", onCycle)
    .on("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onCycle();
    });
  group.append("rect")
    .attr("x", -width / 2)
    .attr("y", -13)
    .attr("width", width)
    .attr("height", 20)
    .attr("rx", 5)
    .attr("fill", "transparent");
  const text = group.append("text")
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(255,255,255,0.52)")
    .attr("font-size", 11)
    .attr("font-weight", 500);
  text.append("tspan").text(label);
  text.append("tspan")
    .attr("dx", 7)
    .attr("fill", "rgba(255,255,255,0.3)")
    .text("↻");
  group.append("title").text(title);
}

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";

  const rows = buildVolPnlBarRows(props.rows, xMetric.value)
    .map((row, index) => ({ ...row, key: String(index) }));
  const yOption = currentYMetric();
  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360);
  const height = Math.max(300, bounds.height || 470) * 0.95;
  const plot = {
    left: 76,
    right: width - 38,
    top: 22,
    bottom: height - 48,
  };

  const svg = d3.select(element)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("font-family", CHART_FONT_FAMILY)
    .attr("role", "img")
    .attr(
      "aria-label",
      `${currentYMetric().tooltipLabel} sorted by ${currentXMetric().tooltipLabel}`,
    );

  if (!rows.length) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.32)")
      .attr("font-size", 14)
      .text("No volatility and PnL observations");
    return;
  }

  const x = d3.scaleBand()
    .domain(rows.map((row) => row.key))
    .range([plot.left, plot.right])
    .paddingInner(0.12)
    .paddingOuter(0.04);
  const y = d3.scaleLinear()
    .domain(paddedDomain(
      rows.map((row) => row[yOption.key]),
      yOption.minimumPadding,
    ))
    .range([plot.bottom, plot.top])
    .nice(7);

  const tickCount = Math.min(9, rows.length);
  const tickKeys = [...new Set(Array.from(
    { length: tickCount },
    (_, index) => String(Math.round(
      index * (rows.length - 1) / Math.max(1, tickCount - 1),
    )),
  ))];
  let yTicks = y.ticks(7);
  if (y.domain()[0] <= 0 && y.domain()[1] >= 0 && !yTicks.includes(0)) {
    yTicks = [...yTicks, 0].sort((first, second) => first - second);
  }

  tickKeys.forEach((key) => {
    const center = x(key) + x.bandwidth() / 2;
    svg.append("line")
      .attr("x1", center)
      .attr("x2", center)
      .attr("y1", plot.top)
      .attr("y2", plot.bottom)
      .attr("stroke", "rgba(255,255,255,0.045)");
  });
  yTicks.forEach((tick) => svg.append("line")
    .attr("x1", plot.left)
    .attr("x2", plot.right)
    .attr("y1", y(tick))
    .attr("y2", y(tick))
    .attr("stroke", tick === 0
      ? "rgba(255,255,255,0.14)"
      : "rgba(255,255,255,0.055)"));

  const xAxis = svg.append("g")
    .attr("class", "volatility-axis")
    .attr("transform", `translate(0,${plot.bottom})`)
    .call(d3.axisBottom(x)
      .tickValues(tickKeys)
      .tickSize(0)
      .tickPadding(13)
      .tickFormat((key) => formatPercent(rows[Number(key)].xValue)));
  xAxis.select(".domain").remove();
  xAxis.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.32)")
    .attr("font-size", 12);

  const yAxis = svg.append("g")
    .attr("class", "pnl-axis")
    .attr("transform", `translate(${plot.left},0)`)
    .call(d3.axisLeft(y)
      .tickValues(yTicks)
      .tickSize(0)
      .tickPadding(13)
      .tickFormat(yOption.format));
  yAxis.select(".domain").remove();
  yAxis.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.32)")
    .attr("font-size", 12);

  appendInteractiveAxisLabel({
    svg,
    className: "interactive-axis-label interactive-x-label",
    transform: `translate(${(plot.left + plot.right) / 2},${height - 7})`,
    width: 300,
    label: currentXMetric().label,
    ariaLabel: `X-axis: ${currentXMetric().tooltipLabel}. Click to change metric`,
    title: "Click to cycle through IV, trailing 7-day RV, and IV minus RV",
    onCycle: cycleXMetric,
  });
  appendInteractiveAxisLabel({
    svg,
    className: "interactive-axis-label interactive-y-label",
    transform: `translate(15,${(plot.top + plot.bottom) / 2}) rotate(-90)`,
    width: 190,
    label: yOption.label,
    ariaLabel: `Y-axis: ${yOption.tooltipLabel}. Click to change metric`,
    title: "Click to toggle between PnL on entry premium and dollar PnL",
    onCycle: cycleYMetric,
  });

  const values = rows.map((row) => row[yOption.key]);
  const valueExtent = d3.extent(values);
  const valueMidpoint = d3.median(values) ?? 0;
  const barColor = valueExtent[0] === valueExtent[1]
    ? () => d3.interpolateRdBu(0.5)
    : d3.scaleDiverging((t) => d3.interpolateRdBu(0.12 + t * 0.76))
        .domain([valueExtent[0], valueMidpoint, valueExtent[1]])
        .clamp(true);
  const zeroY = y(0);

  const bars = svg.selectAll("rect.vol-pnl-bar")
    .data(rows)
    .join("rect")
    .attr("class", "vol-pnl-bar")
    .attr("x", (row) => x(row.key))
    .attr("y", (row) => Math.min(zeroY, y(row[yOption.key])))
    .attr("width", x.bandwidth())
    .attr("height", (row) => Math.max(1, Math.abs(y(row[yOption.key]) - zeroY)))
    .attr("fill", (row) => barColor(row[yOption.key]))
    .attr("stroke", "#000000")
    .attr("stroke-width", 0.15)
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (row) =>
      `${formatDate(cycleDate(row))}: ${currentXMetric().tooltipLabel} ${formatPercent(row.xValue)}, ${yOption.tooltipLabel} ${yOption.format(row[yOption.key])}. Open hourly detail`)
    .style("cursor", "pointer")
    .on("click", (_, row) => emit("select", row.cycle))
    .on("keydown", (event, row) => {
      if (event.key === "Enter" || event.key === " ") emit("select", row.cycle);
    });

  bars.append("title")
    .text((row) =>
      `${formatDate(cycleDate(row))}\n${currentXMetric().tooltipLabel}: ${formatPercent(row.xValue)}\n${yOption.tooltipLabel}: ${yOption.format(row[yOption.key])}\nClick for hourly detail`);
};

onMounted(() => {
  draw();
  window.addEventListener("resize", draw);
});

onUnmounted(() => {
  window.removeEventListener("resize", draw);
});

watch(() => props.rows, draw);

function exportPng({
  filename = "vol-sorted-pnl.png",
  scale = 4,
  padding = 24,
  title = "",
  subtitle = "",
  source = "",
} = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({
    svgEl,
    title,
    subtitle,
    source,
    filename,
    scale,
    padding,
    background: "#0a0b0e",
  });
}

defineExpose({ exportPng });
</script>

<template>
  <div ref="chartRef" class="chart"></div>
</template>

<style scoped>
.chart {
  flex: 1;
  min-height: 0;
  background: #0a0b0e;
  display: flex;
}

.chart :deep(svg) {
  display: block;
  width: 100%;
  height: 95%;
  margin-top: 2px;
}

.chart :deep(.vol-pnl-bar:focus) {
  outline: none;
  stroke: rgba(255, 255, 255, 0.9);
  stroke-width: 1.2;
}

.chart :deep(.interactive-axis-label:focus) {
  outline: none;
}

.chart :deep(.interactive-axis-label:focus rect) {
  fill: rgba(255, 255, 255, 0.06);
}
</style>
