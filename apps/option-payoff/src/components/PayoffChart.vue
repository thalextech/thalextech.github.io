<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";
import { fetchIndexHistory } from "../../../../lib/thalex.js";

const props = defineProps({
  selectedOptions: { type: Array, default: () => [] },
  optionMarks: { type: Map, default: () => new Map() },
  indexName: { type: String, default: "BTCUSD" },
  loading: { type: Boolean, default: false },
  spotRangeMin: { type: Number, default: null },
  spotRangeMax: { type: Number, default: null },
  showTotalLine: { type: Boolean, default: false },
});

const svgRef = ref(null);
const currentIndexPrice = ref(null);

const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  width: 900,
  height: 560,
  margin: { top: 60, right: 40, bottom: 60, left: 80 },
};

const TEXT_STYLES = {
  axisText: { fill: "#d6d7de" },
  axisLabel: { fill: "#d6d7de", size: "12px", weight: 700 },
  title: { fill: "#fff", size: "18px", weight: 650 },
  subtitle: { fill: "#c9c9cf", size: "13px" },
  legend: { fill: "#a9abb6", size: "11px", weight: 500 },
};

function applyTextStyle(node, styleKey) {
  const style = TEXT_STYLES[styleKey];
  if (!style) return node;
  node.style("font-family", SVG_FONT_FAMILY);
  if (style.fill) node.attr("fill", style.fill);
  if (style.size) node.style("font-size", style.size);
  if (style.weight != null) node.style("font-weight", style.weight);
  return node;
}

function axisStyle(axisG) {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  applyTextStyle(axisG.selectAll("text"), "axisText");
}

function calculateProfit(spot, strike, isCall, premium, position = "long") {
  let profit;
  if (isCall) {
    profit = Math.max(0, spot - strike) - premium;
  } else {
    profit = Math.max(0, strike - spot) - premium;
  }
  // For short positions, invert the profit
  return position === "short" ? -profit : profit;
}

const profitData = computed(() => {
  const DEFAULT_MIN_SPOT = 60000;
  const DEFAULT_MAX_SPOT = 150000;
  
  if (!props.selectedOptions.length) return [];
  const strikes = props.selectedOptions.map((o) => o.strike).filter((s) => s != null);
  if (!strikes.length) return [];
  
  let minSpot, maxSpot;
  if (props.spotRangeMin != null && props.spotRangeMax != null && props.spotRangeMin < props.spotRangeMax) {
    minSpot = Math.max(0, props.spotRangeMin);
    maxSpot = props.spotRangeMax;
  } else {
    minSpot = DEFAULT_MIN_SPOT;
    maxSpot = DEFAULT_MAX_SPOT;
  }
  
  const numPoints = 200;
  const step = (maxSpot - minSpot) / numPoints;
  const spots = [];
  for (let i = 0; i <= numPoints; i++) {
    const spot = minSpot + i * step;
    const individualProfits = props.selectedOptions.map((opt) => {
      const premium = props.optionMarks.get(opt.instrument_name) || 0;
      return {
        option: opt,
        profit: calculateProfit(spot, opt.strike, opt.isCall, premium, opt.position || "long"),
      };
    });
    const totalProfit = props.showTotalLine
      ? individualProfits.reduce((sum, p) => sum + p.profit, 0)
      : null;
    spots.push({
      spot,
      individualProfits,
      totalProfit,
    });
  }
  return spots;
});

const expiryFormat = d3.utcFormat("%b %d");

const colorScale = computed(() => {
  const colors = [
    "#94b3fd",
    "#ffb703",
    "#8ecae6",
    "#ff6b6b",
    "#7c7f8f",
    "#a78bfa",
    "#34d399",
    "#fbbf24",
  ];
  return (index) => colors[index % colors.length];
});

async function loadCurrentIndexPrice() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = await fetchIndexHistory({
      index_name: props.indexName,
      resolution: "1d",
      from: now - 86400,
      to: now,
    });
    if (rows && rows.length > 0) {
      const latest = rows[rows.length - 1];
      currentIndexPrice.value = latest.index_price_close || null;
    }
  } catch (e) {
    console.error("Failed to load index price", e);
  }
}

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");

  const bg = svg.append("rect").attr("fill", "#000").attr("width", width).attr("height", height);

  if (!profitData.value.length) {
    const noData = svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .text(props.loading ? "Loading…" : "Select options to see profit diagram");
    applyTextStyle(noData, "subtitle");
    return;
  }

  const mainGroup = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const spots = profitData.value.map((d) => d.spot);
  const allProfits = profitData.value.flatMap((d) => d.individualProfits.map((p) => p.profit));
  const totalProfits = props.showTotalLine
    ? profitData.value.map((d) => d.totalProfit).filter((p) => p != null)
    : [];
  const xDomain = d3.extent(spots);
  const yDomain = d3.extent([...allProfits, ...totalProfits, 0]);
  const yPad = (yDomain[1] - yDomain[0]) * 0.1 || 1;

  const x = d3.scaleLinear().domain(xDomain).range([0, innerWidth]);
  const y = d3.scaleLinear().domain([yDomain[0] - yPad, yDomain[1] + yPad]).range([innerHeight, 0]);

  const xAxis = d3.axisBottom(x).ticks(8);
  const yAxis = d3.axisLeft(y).ticks(6);

  const xAxisGroup = mainGroup.append("g").attr("transform", `translate(0,${innerHeight})`).call(xAxis);
  axisStyle(xAxisGroup);

  const yAxisGroup = mainGroup.append("g").call(yAxis);
  axisStyle(yAxisGroup);

  const xAxisLabel = mainGroup
    .append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 45)
    .attr("text-anchor", "middle")
    .text("Spot Price");
  applyTextStyle(xAxisLabel, "axisLabel");

  const yAxisLabel = mainGroup
    .append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -55)
    .attr("text-anchor", "middle")
    .text("Profit");
  applyTextStyle(yAxisLabel, "axisLabel");

  const title = svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 35)
    .attr("text-anchor", "middle")
    .text("Option Profit Diagram");
  applyTextStyle(title, "title");

  const subtitle = svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 55)
    .attr("text-anchor", "middle")
    .text(`${props.selectedOptions.length} option${props.selectedOptions.length !== 1 ? "s" : ""} selected`);
  applyTextStyle(subtitle, "subtitle");

  const zeroLine = mainGroup
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", y(0))
    .attr("y2", y(0))
    .attr("stroke", "#444")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "4,4");

  if (currentIndexPrice.value) {
    const currentLine = mainGroup
      .append("line")
      .attr("x1", x(currentIndexPrice.value))
      .attr("x2", x(currentIndexPrice.value))
      .attr("y1", 0)
      .attr("y2", innerHeight)
      .attr("stroke", "#666")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "2,2");
    const currentLabel = mainGroup
      .append("text")
      .attr("x", x(currentIndexPrice.value))
      .attr("y", -8)
      .attr("text-anchor", "middle")
      .text("Current");
    applyTextStyle(currentLabel, "legend");
  }

  const seriesGroup = mainGroup.append("g");

  for (let i = 0; i < props.selectedOptions.length; i++) {
    const opt = props.selectedOptions[i];
    const line = d3
      .line()
      .x((d) => x(d.spot))
      .y((d) => {
        const profitEntry = d.individualProfits.find((p) => p.option.instrument_name === opt.instrument_name);
        return y(profitEntry ? profitEntry.profit : 0);
      })
      .curve(d3.curveLinear);
    const pathData = profitData.value;
    seriesGroup
      .append("path")
      .attr("d", line(pathData))
      .attr("fill", "none")
      .attr("stroke", colorScale.value(i))
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.6);
  }

  if (props.showTotalLine) {
    const totalLine = d3
      .line()
      .x((d) => x(d.spot))
      .y((d) => y(d.totalProfit != null ? d.totalProfit : 0))
      .curve(d3.curveLinear);
    seriesGroup
      .append("path")
      .attr("d", totalLine(profitData.value))
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 2.5);
  }

  const legendGroup = svg.append("g").attr("transform", `translate(${width - 200},${margin.top + 20})`);
  let legendY = 0;
  for (let i = 0; i < props.selectedOptions.length; i++) {
    const opt = props.selectedOptions[i];
    const expiryLabel =
      opt.expiryTs != null && Number.isFinite(opt.expiryTs)
        ? expiryFormat(new Date(opt.expiryTs * 1000))
        : "";
    const g = legendGroup.append("g").attr("transform", `translate(0,${legendY})`);
    g.append("line")
      .attr("x1", 0)
      .attr("x2", 16)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", colorScale.value(i))
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.6);
    const positionLabel = opt.position === "short" ? " Short" : "";
    const label = g
      .append("text")
      .attr("x", 20)
      .attr("y", 4)
      .text(
        `${opt.isCall ? "Call" : "Put"} ${d3.format("$,.0f")(opt.strike)}${positionLabel}${
          expiryLabel ? ` (${expiryLabel})` : ""
        }`
      );
    applyTextStyle(label, "legend");
    legendY += 18;
  }

  if (props.showTotalLine) {
    const totalLegend = legendGroup.append("g").attr("transform", `translate(0,${legendY + 4})`);
    totalLegend
      .append("line")
      .attr("x1", 0)
      .attr("x2", 16)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", "#fff")
      .attr("stroke-width", 2.5);
    const totalLabel = totalLegend.append("text").attr("x", 20).attr("y", 4).text("Total");
    applyTextStyle(totalLabel, "legend");
    totalLabel.style("font-weight", "600");
  }

  const logoWidth = 184;
  const logoHeight = 46;
  const logoScale = 1.25;
  const scaledWidth = logoWidth * logoScale;
  const scaledHeight = logoHeight * logoScale;
  const logoPadding = 12;
  
  const watermark = svg
    .append("image")
    .attr("href", "/LOGO_THALEX_WHITE.svg")
    .attr("x", width - margin.right - scaledWidth - logoPadding)
    .attr("y", height - margin.bottom - scaledHeight - logoPadding)
    .attr("width", scaledWidth)
    .attr("height", scaledHeight)
    .attr("opacity", 0.2)
    .style("pointer-events", "none");
}

watch(
  () => [props.selectedOptions, props.optionMarks, props.indexName, props.spotRangeMin, props.spotRangeMax, props.showTotalLine],
  () => {
    if (props.selectedOptions.length && !currentIndexPrice.value) {
      loadCurrentIndexPrice();
    } else {
      render();
    }
  },
  { deep: true }
);

watch(() => currentIndexPrice.value, render);

onMounted(() => {
  loadCurrentIndexPrice();
  render();
});
</script>

<template>
  <div>
    <svg ref="svgRef" />
  </div>
</template>

<style scoped>
svg {
  display: block;
  width: 100%;
  height: auto;
}
</style>
