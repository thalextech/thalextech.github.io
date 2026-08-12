<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  trades: { type: Array, default: () => [] },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const pnlTooltip = ref({
  visible: false,
  left: 0,
  top: 0,
  timestamp: "",
  initialOptionMark: "",
  optionPnl: "",
  replicationPnl: "",
  difference: "",
});
let resizeObserver = null;

const layout = {
  fallbackWidth: 1800,
  fallbackHeight: 980,
  margin: { top: 74, right: 56, bottom: 64, left: 78 },
};

const fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const trackingWhite = "#f4f4f5";
const optionSalmon = "#d28a6f";
const replicationBlue = "#78b9e6";
const tooltipDateFormat = d3.utcFormat("%b %d, %Y %H:%M UTC");
const tooltipNumberFormat = d3.format(",.2f");

const formatUsd = (value, signed = false) => {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return `${sign}$${tooltipNumberFormat(Math.abs(value))}`;
};

function exportPng({ filename = "dfollow.png", scale = 4, padding = 24 } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

const axisStyle = (axisG) => {
  axisG.selectAll("line").attr("stroke", "rgba(255,255,255,0.09)");
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#aeb4c2")
    .style("font-size", "13px")
    .style("font-family", fontFamily);
};

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  pnlTooltip.value.visible = false;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const wrap = svgEl.parentElement;
  const width = Math.max(
    480,
    Math.round(wrap?.clientWidth || layout.fallbackWidth),
  );
  const height = Math.max(
    420,
    Math.round(wrap?.clientHeight || layout.fallbackHeight),
  );
  const { margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const panelGap = Math.min(58, Math.max(36, innerHeight * 0.07));
  const pnlHeight = Math.min(280, Math.max(160, innerHeight * 0.28));
  const priceHeight = innerHeight - pnlHeight - panelGap;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "none");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#020204");

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", margin.left)
      .attr("y", 38)
      .attr("fill", "#aeb4c2")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.subtitle);
  }

  const rows = (props.data || []).filter(
    (row) => row?.date instanceof Date && Number.isFinite(row?.hedgePrice),
  );

  if (!rows.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "15px")
      .style("font-family", fontFamily)
      .text(props.loading ? "Loading..." : "No mark-price data.");
    return;
  }

  const x = d3
    .scaleUtc()
    .domain(d3.extent(rows, (d) => d.date))
    .range([0, innerWidth]);

  const yValues = rows.map((d) => d.hedgePrice);
  for (const trade of props.trades || []) {
    if (Number.isFinite(trade?.hedgePrice)) yValues.push(trade.hedgePrice);
  }
  const priceExtent = d3.extent(yValues);
  const pricePad = Math.max(1, (priceExtent[1] - priceExtent[0]) * 0.08);
  const y = d3
    .scaleLinear()
    .domain([priceExtent[0] - pricePad, priceExtent[1] + pricePad])
    .nice()
    .range([priceHeight, 0]);

  const priceG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);
  const pnlG = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top + priceHeight + panelGap})`);

  priceG
    .append("g")
    .call(
      d3
        .axisLeft(y)
        .ticks(7)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  priceG
    .append("text")
    .attr("x", -66)
    .attr("y", priceHeight / 2)
    .attr("transform", `rotate(-90,-66,${priceHeight / 2})`)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text("Mark price");

  const priceLine = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.hedgePrice))
    .curve(d3.curveStepAfter);

  priceG
    .append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", "mistyrose")
    .attr("stroke-width", 2)
    .attr("d", priceLine);

  const tradeRows = (props.trades || []).filter(
    (trade) =>
      trade?.date instanceof Date &&
      Number.isFinite(trade?.hedgePrice) &&
      Number.isFinite(trade?.tradeAmount),
  );

  priceG
    .append("g")
    .selectAll("circle")
    .data(tradeRows)
    .join("circle")
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.hedgePrice))
    .attr("r", 6.5)
    .attr("fill", (d) => (d.tradeAmount >= 0 ? "#16a34a" : "#dc2626"))
    .attr("stroke", "#020204")
    .attr("stroke-width", 1.8);

  const legend = priceG
    .append("g")
    .attr("transform", `translate(${innerWidth - 220},${-36})`);
  const legendItems = [
    { label: "Buy", color: "#16a34a" },
    { label: "Sell", color: "#dc2626" },
  ];

  legend
    .selectAll("g")
    .data(legendItems)
    .join("g")
    .attr("transform", (_, i) => `translate(${i * 98},0)`)
    .call((item) => {
      item
        .append("circle")
        .attr("cx", 0)
        .attr("cy", 0)
        .attr("r", 6)
        .attr("fill", (d) => d.color);
      item
        .append("text")
        .attr("x", 14)
        .attr("y", 4)
        .attr("fill", "#cfd3dd")
        .style("font-size", "12px")
        .style("font-family", fontFamily)
        .text((d) => d.label);
    });

  const pnlRows = rows.filter(
    (row) =>
      Number.isFinite(row?.cumulativePnl) &&
      Number.isFinite(row?.optionPnl) &&
      Number.isFinite(row?.botPnl),
  );
  if (!pnlRows.length) return;

  const pnlSeries = [
    {
      label: "Tracking cost (Option - Replication)",
      key: "cumulativePnl",
      color: trackingWhite,
      dash: "5 4",
    },
    { label: "Option MTM", key: "optionPnl", color: optionSalmon },
    { label: "Replication MTM", key: "botPnl", color: replicationBlue },
  ];
  const pnlValues = pnlSeries.flatMap((series) =>
    pnlRows.map((row) => row[series.key]),
  );
  const pnlExtent = d3.extent([0, ...pnlValues]);
  const pnlPad = Math.max(1, (pnlExtent[1] - pnlExtent[0]) * 0.12);
  const yPnl = d3
    .scaleLinear()
    .domain([pnlExtent[0] - pnlPad, pnlExtent[1] + pnlPad])
    .nice()
    .range([pnlHeight, 0]);

  pnlG
    .append("g")
    .call(
      d3
        .axisLeft(yPnl)
        .ticks(5)
        .tickSize(-innerWidth)
        .tickPadding(12)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  pnlG
    .append("g")
    .attr("transform", `translate(0,${pnlHeight})`)
    .call(d3.axisBottom(x).ticks(9).tickSize(0).tickPadding(16))
    .call(axisStyle);

  pnlG
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", yPnl(0))
    .attr("y2", yPnl(0))
    .attr("stroke", "rgba(255,255,255,0.22)")
    .attr("stroke-width", 1);

  pnlG
    .append("text")
    .attr("x", -66)
    .attr("y", pnlHeight / 2)
    .attr("transform", `rotate(-90,-66,${pnlHeight / 2})`)
    .attr("text-anchor", "middle")
    .attr("fill", "#d6d7de")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", fontFamily)
    .text("Cumulative MTM / PnL");

  const pnlLine = (key) =>
    d3
      .line()
      .x((d) => x(d.date))
      .y((d) => yPnl(d[key]))
      .curve(d3.curveStepAfter);

  pnlG
    .append("g")
    .selectAll("path")
    .data(pnlSeries)
    .join("path")
    .attr("fill", "none")
    .attr("stroke", (d) => d.color)
    .attr("stroke-width", 1.5)
    .attr("stroke-dasharray", (d) => d.dash || null)
    .attr("d", (d) => pnlLine(d.key)(pnlRows));

  const replicationEdge = -pnlRows[pnlRows.length - 1].cumulativePnl;
  const replicationEdgeLabel = pnlG
    .append("text")
    .attr("x", innerWidth - 12)
    .attr("y", 22)
    .attr("text-anchor", "end")
    .attr("fill", "#aeb4c2")
    .style("font-size", "13px")
    .style("font-family", fontFamily);

  replicationEdgeLabel.append("tspan").text("Replication edge: ");
  replicationEdgeLabel
    .append("tspan")
    .attr("fill", trackingWhite)
    .style("font-weight", 700)
    .text(d3.format("+,.2f")(replicationEdge));

  const pnlLegend = pnlG
    .append("g")
    .attr("transform", `translate(${Math.max(0, innerWidth - 650)},${-28})`);

  pnlLegend
    .selectAll("g")
    .data(pnlSeries)
    .join("g")
    .attr("transform", (_, i) => `translate(${i * 220},0)`)
    .call((item) => {
      item
        .append("line")
        .attr("x1", 0)
        .attr("x2", 22)
        .attr("y1", 0)
        .attr("y2", 0)
        .attr("stroke", (d) => d.color)
        .attr("stroke-width", 3)
        .attr("stroke-dasharray", (d) => d.dash || null);
      item
        .append("text")
        .attr("x", 30)
        .attr("y", 4)
        .attr("fill", "#cfd3dd")
        .style("font-size", "12px")
        .style("font-family", fontFamily)
        .text((d) => d.label);
    });

  const hoverGuide = pnlG
    .append("line")
    .attr("y1", 0)
    .attr("y2", pnlHeight)
    .attr("stroke", "rgba(255,255,255,0.36)")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 3")
    .attr("pointer-events", "none")
    .style("display", "none");
  const nearestPnlRow = d3.bisector((row) => row.date).center;
  const initialOptionMark = pnlRows[0].targetPrice;

  pnlG
    .append("rect")
    .attr("width", innerWidth)
    .attr("height", pnlHeight)
    .attr("fill", "transparent")
    .style("cursor", "crosshair")
    .on("pointermove", (event) => {
      const [pointerX] = d3.pointer(event, pnlG.node());
      const hoveredDate = x.invert(
        Math.max(0, Math.min(innerWidth, pointerX)),
      );
      const row = pnlRows[nearestPnlRow(pnlRows, hoveredDate)];
      if (!row) return;

      hoverGuide.attr("x1", x(row.date)).attr("x2", x(row.date)).style("display", null);

      const wrapRect = wrap.getBoundingClientRect();
      const eventX = event.clientX - wrapRect.left;
      const eventY = event.clientY - wrapRect.top;
      const tooltipWidth = Math.min(280, Math.max(220, wrapRect.width - 16));
      const tooltipHeight = 164;
      const preferredLeft =
        eventX + tooltipWidth + 22 <= wrapRect.width
          ? eventX + 14
          : eventX - tooltipWidth - 14;

      pnlTooltip.value = {
        visible: true,
        left: Math.max(
          8,
          Math.min(wrapRect.width - tooltipWidth - 8, preferredLeft),
        ),
        top: Math.max(
          8,
          Math.min(wrapRect.height - tooltipHeight - 8, eventY - tooltipHeight / 2),
        ),
        timestamp: tooltipDateFormat(row.date),
        initialOptionMark: formatUsd(initialOptionMark),
        optionPnl: formatUsd(row.optionPnl, true),
        replicationPnl: formatUsd(row.botPnl, true),
        difference: formatUsd(row.cumulativePnl, true),
      };
    })
    .on("pointerleave", () => {
      hoverGuide.style("display", "none");
      pnlTooltip.value.visible = false;
    });
}

watch(
  () => [props.data, props.trades, props.subtitle, props.loading],
  () => render(),
  { deep: false },
);

onMounted(() => {
  render();
  const svgEl = svgRef.value;
  const wrap = svgEl?.parentElement;
  if (wrap && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => render());
    resizeObserver.observe(wrap);
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg" />
    <div
      v-show="pnlTooltip.visible"
      class="pnlTooltip"
      :style="{ left: `${pnlTooltip.left}px`, top: `${pnlTooltip.top}px` }"
    >
      <div class="pnlTooltipTime">{{ pnlTooltip.timestamp }}</div>
      <div class="pnlTooltipRow">
        <span>Initial option mark</span>
        <strong>{{ pnlTooltip.initialOptionMark }}</strong>
      </div>
      <div class="pnlTooltipRow">
        <span>Option MTM PnL</span>
        <strong>{{ pnlTooltip.optionPnl }}</strong>
      </div>
      <div class="pnlTooltipRow">
        <span>Replication PnL</span>
        <strong>{{ pnlTooltip.replicationPnl }}</strong>
      </div>
      <div class="pnlTooltipRow">
        <span>Difference (Option − Replication)</span>
        <strong>{{ pnlTooltip.difference }}</strong>
      </div>
    </div>
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #020204;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

.pnlTooltip {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  width: min(280px, calc(100% - 16px));
  padding: 11px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(10, 10, 14, 0.94);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: #e5e7eb;
  font-family: v-bind(fontFamily);
  font-size: 12px;
  pointer-events: none;
}

.pnlTooltipTime {
  margin-bottom: 8px;
  color: #aeb4c2;
  font-size: 11px;
}

.pnlTooltipRow {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  line-height: 1.55;
}

.pnlTooltipRow span {
  color: #aeb4c2;
}

.pnlTooltipRow strong {
  color: #f4f4f5;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  color: #d6d7de;
  font-size: 14px;
  pointer-events: none;
}
</style>
