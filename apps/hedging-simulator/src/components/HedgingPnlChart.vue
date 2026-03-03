<script setup lang="ts">
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";

type IndexPoint = {
  ts: number;
  date?: Date;
  index_price_close: number;
};

type HedgeBarPoint = {
  ts: number;
  date?: Date;
  gammaPnl: number;
  thetaPnl: number;
  totalPnl: number;
};

const props = defineProps<{
  indexData?: IndexPoint[];
  hedgeBars?: HedgeBarPoint[];
  title?: string;
  subtitle?: string;
  loading?: boolean;
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  width: 1200,
  headerHeight: 38,
  topPanelHeight: 300,
  bottomPanelHeight: 360,
  panelGap: 34,
  margin: { top: 14, right: 38, bottom: 54, left: 74 },
};

const BOTTOM_TOP_INSET = 36;
const LOWER_MODE_TOGGLE_X = 12;
const BOTTOM_MODE_OPTIONS = [
  { key: "standard", label: "Standard" },
  { key: "cumulative", label: "Cumulative" },
] as const;
let bottomMode: "standard" | "cumulative" = "standard";
const formatPnl = d3.format("$,.0f");
const formatPrice = d3.format(",.0f");
const formatDay = d3.utcFormat("%d %b");

const axisStyle = (axisG: d3.Selection<SVGGElement, unknown, null, undefined>) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-family", SVG_FONT_FAMILY);
};

const normalizeIndex = (rows: IndexPoint[]): Array<{ ts: number; date: Date; value: number }> =>
  (rows ?? [])
    .map((row) => {
      const ts = Number(row?.ts);
      const value = Number(row?.index_price_close);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      if (
        !Number.isFinite(ts) ||
        !Number.isFinite(value) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime())
      ) {
        return null;
      }
      return { ts, date, value };
    })
    .filter((row): row is { ts: number; date: Date; value: number } => !!row)
    .sort((a, b) => a.ts - b.ts);

const normalizeBars = (
  rows: HedgeBarPoint[],
): Array<{ ts: number; date: Date; gammaPnl: number; thetaPnl: number; totalPnl: number }> =>
  (rows ?? [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      const gammaPnl = Number(row?.gammaPnl);
      const thetaPnl = Number(row?.thetaPnl);
      const totalPnl = Number(row?.totalPnl);
      if (
        !Number.isFinite(ts) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime()) ||
        !Number.isFinite(gammaPnl) ||
        !Number.isFinite(thetaPnl) ||
        !Number.isFinite(totalPnl)
      ) {
        return null;
      }
      return { ts, date, gammaPnl, thetaPnl, totalPnl };
    })
    .filter(
      (
        row,
      ): row is {
        ts: number;
        date: Date;
        gammaPnl: number;
        thetaPnl: number;
        totalPnl: number;
      } => !!row,
    )
    .sort((a, b) => a.ts - b.ts);

const buildBarsForMode = (
  rows: Array<{ ts: number; date: Date; gammaPnl: number; thetaPnl: number; totalPnl: number }>,
): Array<{ ts: number; date: Date; gammaPnl: number; thetaPnl: number; totalPnl: number }> => {
  if (bottomMode === "standard") return rows;
  let gammaCumulative = 0;
  let thetaCumulative = 0;
  let totalCumulative = 0;
  return rows.map((row) => {
    gammaCumulative += row.gammaPnl;
    thetaCumulative += row.thetaPnl;
    totalCumulative += row.totalPnl;
    return {
      ...row,
      gammaPnl: gammaCumulative,
      thetaPnl: thetaCumulative,
      totalPnl: totalCumulative,
    };
  });
};

const drawLowerModeToggle = (
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
): void => {
  const toggleGroup = group
    .append("g")
    .attr("transform", `translate(${LOWER_MODE_TOGGLE_X},6)`);

  let xOffset = 0;
  for (const option of BOTTOM_MODE_OPTIONS) {
    const isActive = bottomMode === option.key;
    const width = Math.max(56, Math.round(18 + String(option.label).length * 6.1));
    const height = 24;
    const item = toggleGroup
      .append("g")
      .attr("transform", `translate(${xOffset},0)`)
      .style("cursor", "pointer")
      .on("click", (event) => {
        event.stopPropagation();
        if (bottomMode === option.key) return;
        bottomMode = option.key;
        render();
      });

    item
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", width)
      .attr("height", height)
      .attr("rx", 12)
      .attr("fill", isActive ? "#2b2f38" : "#12161e")
      .attr("stroke", isActive ? "#3d4452" : "#2a2f3b")
      .attr("stroke-width", 1);

    item
      .append("text")
      .attr("x", width / 2)
      .attr("y", 12.5)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", isActive ? "#f2f4ff" : "#a9abb6")
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(option.label);

    xOffset += width + 8;
  }
};

const render = (): void => {
  if (!svgRef.value) return;

  const index = normalizeIndex(props.indexData ?? []);
  const bars = buildBarsForMode(normalizeBars(props.hedgeBars ?? []));
  const innerWidth = layout.width - layout.margin.left - layout.margin.right;
  const topInnerHeight = layout.topPanelHeight - layout.margin.top - layout.margin.bottom;
  const bottomInnerHeight =
    layout.bottomPanelHeight - layout.margin.top - layout.margin.bottom;
  const totalHeight =
    layout.headerHeight +
    layout.topPanelHeight +
    layout.panelGap +
    layout.bottomPanelHeight;
  const topPanelY = layout.headerHeight;
  const bottomPanelY = layout.headerHeight + layout.topPanelHeight + layout.panelGap;

  const svg = d3
    .select(svgRef.value)
    .attr("viewBox", `0 0 ${layout.width} ${totalHeight}`)
    .attr("width", "100%")
    .style("display", "block")
    .style("height", "auto")
    .style("font-family", SVG_FONT_FAMILY)
    .attr("role", "img");

  svg.selectAll("*").remove();

  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", layout.width)
    .attr("height", totalHeight)
    .attr("fill", "#000");

  if (!index.length) {
    svg
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", totalHeight / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "14px")
      .text(props.loading ? "Loading..." : "No data for this range.");
    return;
  }

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 16)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .text(props.title || "Simulated Index");

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#c9c9cf")
    .style("font-size", "12px")
    .text(props.subtitle || "");

  const xTopDomain = d3.extent(index, (point) => point.date);
  const yTopDomain = d3.extent(index, (point) => point.value);
  if (
    !(xTopDomain[0] instanceof Date) ||
    !(xTopDomain[1] instanceof Date) ||
    !Number.isFinite(yTopDomain[0]) ||
    !Number.isFinite(yTopDomain[1])
  ) {
    return;
  }
  const xTop = d3.scaleUtc().domain([xTopDomain[0], xTopDomain[1]]).range([0, innerWidth]);
  const yTop = d3
    .scaleLinear()
    .domain([yTopDomain[0], yTopDomain[1]])
    .nice()
    .range([topInnerHeight, 0]);

  const topGroup = svg
    .append("g")
    .attr(
      "transform",
      `translate(${layout.margin.left},${topPanelY + layout.margin.top})`,
    );

  topGroup
    .append("g")
    .attr("transform", `translate(0,${topInnerHeight})`)
    .call(d3.axisBottom(xTop).ticks(10).tickSize(0).tickPadding(10))
    .call(axisStyle);

  topGroup
    .append("g")
    .call(
      d3
        .axisLeft(yTop)
        .ticks(3)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(formatPrice),
    )
    .call(axisStyle);

  topGroup
    .append("text")
    .attr("x", innerWidth / 2)
    .attr("y", topInnerHeight + 42)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text("Date (UTC)");

  topGroup
    .append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -topInnerHeight / 2)
    .attr("y", -62)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text("Index Price (Close)");

  const topLine = d3
    .line<{ date: Date; value: number }>()
    .x((point) => xTop(point.date))
    .y((point) => yTop(point.value))
    .curve(d3.curveMonotoneX);

  topGroup
    .append("path")
    .datum(index)
    .attr("fill", "none")
    .attr("stroke", "mistyrose")
    .attr("stroke-width", 1.2)
    .attr("d", topLine);

  const bottomPanelGroup = svg
    .append("g")
    .attr("transform", `translate(0,${bottomPanelY})`);
  drawLowerModeToggle(bottomPanelGroup);

  bottomPanelGroup
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 24)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "14px")
    .style("font-weight", 600)
    .text(bottomMode === "cumulative" ? "Cumulative Hedge P&L" : "Daily Hedge P&L");

  bottomPanelGroup
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 44)
    .attr("text-anchor", "middle")
    .attr("fill", "#a9abb6")
    .style("font-size", "12px")
    .text("Gamma vs Theta vs Total");

  const plotGroup = bottomPanelGroup
    .append("g")
    .attr(
      "transform",
      `translate(${layout.margin.left},${layout.margin.top})`,
    );

  if (!bars.length) {
    plotGroup
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", bottomInnerHeight / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "10px")
      .text("No hedge P&L data in selected range");
    return;
  }

  const seriesConfig = [
    { key: "gammaPnl", label: "Gamma", color: "#34d399" },
    { key: "thetaPnl", label: "Theta", color: "#f59e0b" },
    { key: "total", label: "Total", color: "#f8fafc" },
  ] as const;

  const xBottom = d3
    .scaleBand<string>()
    .domain(bars.map((point) => String(point.ts)))
    .range([0, innerWidth])
    .paddingInner(0.2)
    .paddingOuter(0.06);

  const yValues = bars.flatMap((point) => [
    0,
    point.gammaPnl,
    point.thetaPnl,
    point.totalPnl,
  ]);
  let yMin = Math.min(0, ...yValues);
  let yMax = Math.max(0, ...yValues);
  if (yMin === yMax) {
    const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  const yBottom = d3
    .scaleLinear()
    .domain([yMin, yMax])
    .nice()
    .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

  const visibleTickTarget = Math.max(2, Math.floor(innerWidth / 90));
  const tickStep = Math.max(1, Math.ceil(bars.length / visibleTickTarget));
  const tickValues = bars
    .filter((_, idx) => idx % tickStep === 0 || idx === bars.length - 1)
    .map((point) => String(point.ts));

  const xAxis = d3
    .axisBottom(xBottom)
    .tickValues(tickValues)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat((value) => formatDay(new Date(Number(value) * 1000)));

  const yAxis = d3
    .axisLeft(yBottom)
    .ticks(5)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(formatPnl);

  plotGroup
    .append("g")
    .attr("transform", `translate(0,${bottomInnerHeight})`)
    .call(xAxis)
    .call(axisStyle);
  plotGroup.append("g").call(yAxis).call(axisStyle);

  plotGroup
    .append("text")
    .attr("x", innerWidth / 2)
    .attr("y", bottomInnerHeight + 42)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text("Date (UTC)");

  plotGroup
    .append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -bottomInnerHeight / 2)
    .attr("y", -62)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text(
      bottomMode === "cumulative"
        ? "Cumulative Hedge P&L ($)"
        : "Daily Hedge P&L ($)",
    );

  plotGroup
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", yBottom(0))
    .attr("y2", yBottom(0))
    .attr("stroke", "rgba(255,255,255,0.24)")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 3");

  const dayGroups = plotGroup
    .append("g")
    .selectAll("g.hedge-day-group")
    .data(bars)
    .join("g")
    .attr("class", "hedge-day-group")
    .attr("transform", (point) => `translate(${xBottom(String(point.ts)) ?? 0},0)`);

  const segmentDataForPoint = (point: {
    gammaPnl: number;
    thetaPnl: number;
    totalPnl: number;
  }): Array<{ key: "gammaPnl" | "thetaPnl"; color: string; from: number; to: number }> => [
    {
      key: "gammaPnl",
      color: "#34d399",
      from: 0,
      to: point.gammaPnl,
    },
    {
      key: "thetaPnl",
      color: "#f59e0b",
      from: 0,
      to: point.thetaPnl,
    },
  ];

  dayGroups
    .selectAll("rect.hedge-bar")
    .data((point) => segmentDataForPoint(point))
    .join("rect")
    .attr("class", "hedge-bar")
    .attr("x", 0)
    .attr("width", xBottom.bandwidth())
    .attr("y", (series) =>
      Math.min(yBottom(series.from), yBottom(series.to)),
    )
    .attr("height", (series) => Math.abs(yBottom(series.to) - yBottom(series.from)))
    .attr("fill", (series) => series.color)
    .attr("fill-opacity", 0.92);

  dayGroups
    .append("line")
    .attr("x1", 1)
    .attr("x2", Math.max(1, xBottom.bandwidth() - 1))
    .attr("y1", (point) => yBottom(point.totalPnl))
    .attr("y2", (point) => yBottom(point.totalPnl))
    .attr("stroke", "#f8fafc")
    .attr("stroke-width", 1.5)
    .attr("stroke-linecap", "round")
    .attr("opacity", 0.95);

  const legendSwatchSize = 8;
  const legendLabelOffset = 6;
  const legendColGap = 100;
  const legendTextMaxWidth = 76;
  const legendItemWidth = legendSwatchSize + legendLabelOffset + legendTextMaxWidth;
  const legendTotalWidth = (seriesConfig.length - 1) * legendColGap + legendItemWidth;
  const legendX = layout.width - layout.margin.right - legendTotalWidth;
  const legendY = 24;
  const legendGroup = bottomPanelGroup
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  const legendItems = legendGroup
    .selectAll("g.hedge-legend-item")
    .data(seriesConfig)
    .join("g")
    .attr("class", "hedge-legend-item")
    .attr("transform", (_series, index) => `translate(${index * legendColGap},0)`);

  legendItems
    .append("rect")
    .attr("x", 0)
    .attr("y", -legendSwatchSize / 2)
    .attr("width", legendSwatchSize)
    .attr("height", legendSwatchSize)
    .attr("rx", 1.5)
    .attr("fill", (series) => (series.key === "total" ? "transparent" : series.color))
    .attr("stroke", (series) => (series.key === "total" ? series.color : "none"))
    .attr("stroke-width", (series) => (series.key === "total" ? 1.5 : 0))
    .attr("fill-opacity", 0.95);

  legendItems
    .filter((series) => series.key === "total")
    .append("line")
    .attr("x1", 0)
    .attr("x2", legendSwatchSize)
    .attr("y1", 0)
    .attr("y2", 0)
    .attr("stroke", "#f8fafc")
    .attr("stroke-width", 1.5)
    .attr("stroke-linecap", "round");

  legendItems
    .append("text")
    .attr("x", legendSwatchSize + legendLabelOffset)
    .attr("y", 3)
    .attr("fill", "#a9abb6")
    .style("font-size", "11px")
    .style("font-family", SVG_FONT_FAMILY)
    .style("font-weight", 500)
    .text((series) => series.label);
};

watch(
  () => [props.indexData, props.hedgeBars, props.title, props.subtitle, props.loading],
  () => render(),
  { deep: true },
);

onMounted(() => render());
</script>

<template>
  <div class="chartContainer">
    <svg ref="svgRef" class="chartSvg" />
  </div>
</template>

<style scoped>
.chartContainer {
  width: 100%;
  margin: 0;
  border: 0;
  background: transparent;
  overflow: visible;
  position: relative;
}

.chartSvg {
  width: 100%;
  height: auto;
  display: block;
  background: #000;
}
</style>
