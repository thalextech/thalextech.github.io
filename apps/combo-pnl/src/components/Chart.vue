<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";

const props = defineProps({
  indexData: { type: Array, default: () => [] },
  comboData: { type: Array, default: () => [] },
  optionInstrumentName: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  resolutionKey: { type: String, default: "900" },
  resolutionOptions: { type: Array, default: () => [] },
});
const emit = defineEmits(["update:resolutionKey"]);

const svgRef = ref(null);
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

let brushedDomain = null;
let hiddenDetailSeriesKeys = new Set();
let bottomMode = "greeks";
let resolutionMenuOpen = false;
let lastResolutionKey = null;

const layout = {
  width: 1200,
  headerHeight: 38,
  topPanelHeight: 300,
  bottomPanelHeight: 420,
  panelGap: 34,
  margin: { top: 14, right: 38, bottom: 54, left: 74 },
};

const BOTTOM_TOP_INSET = 36;
const RESOLUTION_TOGGLE_X = 8;
const RESOLUTION_TOGGLE_Y = 6;
const LOWER_MODE_TOGGLE_X = 12;
const BOTTOM_MODE_OPTIONS = [
  { key: "mark", label: "Mark" },
  { key: "greeks", label: "Greeks P&L" },
];

const DETAIL_SERIES_ORDER = [
  {
    key: "gammaTheta",
    label: "Gamma + Theta",
    strokeWidth: 0.8,
    areaOpacity: 0.04,
  },
  { key: "vega", label: "Vega", strokeWidth: 0.8, areaOpacity: 0.04 },
  { key: "total", label: "Total", strokeWidth: 0.8, areaOpacity: 0.04 },
  { key: "residual", label: "Residual", strokeWidth: 0.8, areaOpacity: 0.04 },
  { key: "delta", label: "Delta", strokeWidth: 0.8, areaOpacity: 0.04 },
];
const DETAIL_SERIES_COLOR_STEP = 1 / DETAIL_SERIES_ORDER.length;
const DETAIL_SERIES_COLOR_INDEX_OFFSET = 0.5;
const DETAIL_SERIES_CONFIG = DETAIL_SERIES_ORDER.map((series, index) => ({
  ...series,
  color: d3.interpolateRdBu(
    Math.min(
      1,
      (index + DETAIL_SERIES_COLOR_INDEX_OFFSET) * DETAIL_SERIES_COLOR_STEP,
    ),
  ),
}));

const normalizeComboPoints = (rows) =>
  (rows || [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      if (
        !Number.isFinite(ts) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime())
      ) {
        return null;
      }
      return {
        ts,
        date,
        mark_price_close: Number(row?.mark_price_close),
        PL: Number(row?.PL),
        delta_PL: Number(row?.delta_PL),
        gamma_theta_PL: Number(row?.gamma_theta_PL),
        vega_PL: Number(row?.vega_PL),
        residual_PL: Number(row?.residual_PL),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

const normalizeSeriesPoints = (rows, valueKey = "value") =>
  (rows || [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      const value = Number(row?.[valueKey]);
      if (
        !Number.isFinite(ts) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime()) ||
        !Number.isFinite(value)
      ) {
        return null;
      }
      return { ts, date, value };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatPnl = d3.format("$,.0f");
const formatMarkAxis = d3.format(",.0f");
const formatVol = d3.format(".1%");

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#d6d7de")
    .style("font-size", "10px")
    .style("font-family", SVG_FONT_FAMILY);
};

const isHiddenSeries = (key) => hiddenDetailSeriesKeys.has(key);

const toggleDetailSeries = (key) => {
  if (!key) return;
  if (hiddenDetailSeriesKeys.has(key)) {
    hiddenDetailSeriesKeys.delete(key);
  } else {
    hiddenDetailSeriesKeys.add(key);
  }
  render();
};

const getResolutionLabel = () => {
  const options = Array.isArray(props.resolutionOptions)
    ? props.resolutionOptions
    : [];
  const match = options.find(
    (option) => String(option?.key) === String(props.resolutionKey),
  );
  return match?.label ?? String(props.resolutionKey ?? "");
};

const drawResolutionControl = (svg) => {
  const options = Array.isArray(props.resolutionOptions)
    ? props.resolutionOptions
    : [];
  if (!options.length) return;

  const label = `Resolution ${getResolutionLabel()}`;
  const buttonHeight = 24;
  const buttonWidth = Math.max(112, Math.round(24 + label.length * 6.3));

  const trigger = svg
    .append("g")
    .attr(
      "transform",
      `translate(${RESOLUTION_TOGGLE_X},${RESOLUTION_TOGGLE_Y})`,
    )
    .style("cursor", "pointer")
    .on("click", (event) => {
      event.stopPropagation();
      resolutionMenuOpen = !resolutionMenuOpen;
      render();
    });

  trigger
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", buttonWidth)
    .attr("height", buttonHeight)
    .attr("rx", 12)
    .attr("fill", "#12161e")
    .attr("stroke", "#2a2f3b")
    .attr("stroke-width", 1);

  trigger
    .append("text")
    .attr("x", buttonWidth / 2)
    .attr("y", buttonHeight / 2 + 0.5)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("fill", "#a9abb6")
    .style("font-size", "10px")
    .style("font-weight", 600)
    .text(label);

  if (!resolutionMenuOpen) return;

  const rowHeight = 24;
  const menuWidth = Math.max(buttonWidth, 96);
  const menuY = buttonHeight + 6;
  const menuHeight = options.length * rowHeight;

  const menu = svg
    .append("g")
    .attr(
      "transform",
      `translate(${RESOLUTION_TOGGLE_X},${RESOLUTION_TOGGLE_Y + menuY})`,
    );

  menu
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", menuWidth)
    .attr("height", menuHeight)
    .attr("rx", 6)
    .attr("fill", "#0a0d12")
    .attr("stroke", "#2a2f3b")
    .attr("stroke-width", 1);

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const row = menu
      .append("g")
      .attr("transform", `translate(0,${i * rowHeight})`)
      .style("cursor", "pointer")
      .on("mouseenter", function () {
        d3.select(this)
          .select("text")
          .attr("fill", "#f2f4ff")
          .style("font-weight", 700);
      })
      .on("mouseleave", function () {
        d3.select(this)
          .select("text")
          .attr("fill", "#a9abb6")
          .style("font-weight", 600);
      })
      .on("click", (event) => {
        event.stopPropagation();
        resolutionMenuOpen = false;
        const nextKey = String(option?.key ?? "");
        if (nextKey && nextKey !== String(props.resolutionKey)) {
          brushedDomain = null;
          emit("update:resolutionKey", nextKey);
          return;
        }
        render();
      });

    row
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", menuWidth)
      .attr("height", rowHeight)
      .attr("fill", "#0f131b");

    row
      .append("text")
      .attr("x", menuWidth / 2)
      .attr("y", rowHeight / 2 + 0.5)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "#a9abb6")
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(option?.label ?? "");
  }
};

const drawLowerModeToggle = (group) => {
  const toggleGroup = group
    .append("g")
    .attr("transform", `translate(${LOWER_MODE_TOGGLE_X},6)`);

  let xOffset = 0;
  for (const option of BOTTOM_MODE_OPTIONS) {
    const isActive = bottomMode === option.key;
    const width = option.key === "mark" ? 56 : 106;
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

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const currentResolutionKey = String(props.resolutionKey ?? "");
  if (lastResolutionKey != null && currentResolutionKey !== lastResolutionKey) {
    brushedDomain = null;
  }
  lastResolutionKey = currentResolutionKey;

  const index = normalizeSeriesPoints(props.indexData, "index_price_close");
  const combo = normalizeComboPoints(props.comboData);

  const innerWidth = layout.width - layout.margin.left - layout.margin.right;
  const topInnerHeight =
    layout.topPanelHeight - layout.margin.top - layout.margin.bottom;
  const bottomInnerHeight =
    layout.bottomPanelHeight - layout.margin.top - layout.margin.bottom;
  const totalHeight =
    layout.headerHeight +
    layout.topPanelHeight +
    layout.panelGap +
    layout.bottomPanelHeight;

  const topPanelY = layout.headerHeight;
  const bottomPanelY =
    layout.headerHeight + layout.topPanelHeight + layout.panelGap;

  const svg = d3
    .select(svgRef.value)
    .attr("viewBox", `0 0 ${layout.width} ${totalHeight}`)
    .attr("width", "100%")
    .attr("height", "auto")
    .style("display", "block")
    .style("font-family", SVG_FONT_FAMILY)
    .attr("role", "img");

  svg.selectAll("*").remove();
  svg.on("click.resolution-menu", () => {
    if (!resolutionMenuOpen) return;
    resolutionMenuOpen = false;
    render();
  });

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

  const titleText = props.optionInstrumentName || "Options";
  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 16)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "10px")
    .style("font-weight", 650)
    .text(titleText);

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 30)
    .attr("text-anchor", "middle")
    .attr("fill", "#c9c9cf")
    .style("font-size", "10px")
    .text(props.subtitle || "");

  const xDomain = d3.extent(index, (point) => point.date);
  const yDomain = d3.extent(index, (point) => point.value);

  const xTop = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const yTop = d3
    .scaleLinear()
    .domain(yDomain)
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
        .ticks(5)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(d3.format(",.0f")),
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
    .line()
    .x((point) => xTop(point.date))
    .y((point) => yTop(point.value))
    .curve(d3.curveBasis);

  topGroup
    .append("path")
    .datum(index)
    .attr("fill", "none")
    .attr("stroke", "mistyrose")
    .attr("stroke-width", 1.5)
    .attr("d", topLine);

  const bottomPanelGroup = svg
    .append("g")
    .attr("transform", `translate(0,${bottomPanelY})`);

  const drawBottom = (domain = null) => {
    bottomPanelGroup.selectAll("*").remove();
    drawLowerModeToggle(bottomPanelGroup);

    const domainStart = domain?.[0] ?? xDomain?.[0];
    const domainEnd = domain?.[1] ?? xDomain?.[1];

    const comboFiltered = combo
      .filter((point) => point.date >= domainStart && point.date <= domainEnd)
      .sort((a, b) => a.date - b.date);

    const plotGroup = bottomPanelGroup
      .append("g")
      .attr(
        "transform",
        `translate(${layout.margin.left},${layout.margin.top})`,
      );

    if (!comboFiltered.length) {
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#c9c9cf")
        .style("font-size", "10px")
        .text(
          bottomMode === "mark"
            ? "No mark data in selected range"
            : "No Greeks P&L data in selected range",
        );
      return;
    }

    const titleDateFrom = comboFiltered[0]?.date;
    const titleDateTo = comboFiltered[comboFiltered.length - 1]?.date;
    let subtitle = "";
    if (titleDateFrom instanceof Date && titleDateTo instanceof Date) {
      const msPerDay = 24 * 60 * 60 * 1000;
      const days = (titleDateTo - titleDateFrom) / msPerDay;
      subtitle = `${formatDate(titleDateFrom)} - ${formatDate(titleDateTo)} (${days.toFixed(1)} days)`;
    }

    if (bottomMode === "mark") {
      const markPoints = comboFiltered.filter((point) =>
        Number.isFinite(point.mark_price_close),
      );

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 24)
        .attr("text-anchor", "middle")
        .attr("fill", "#fff")
        .style("font-size", "14px")
        .style("font-weight", 600)
        .text("Combination Mark Price");

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 44)
        .attr("text-anchor", "middle")
        .attr("fill", "#a9abb6")
        .style("font-size", "12px")
        .text(subtitle);

      if (!markPoints.length) {
        plotGroup
          .append("text")
          .attr("x", innerWidth / 2)
          .attr("y", bottomInnerHeight / 2)
          .attr("text-anchor", "middle")
          .attr("fill", "#c9c9cf")
          .style("font-size", "10px")
          .text("No mark data in selected range");
        return;
      }

      const xBottom = d3
        .scaleUtc()
        .domain(d3.extent(markPoints, (point) => point.date))
        .range([0, innerWidth]);
      const [minMark, maxMark] = d3.extent(
        markPoints,
        (point) => point.mark_price_close,
      );
      let yMin = Number.isFinite(minMark) ? minMark : 0;
      let yMax = Number.isFinite(maxMark) ? maxMark : 0;
      if (yMin === yMax) {
        const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.05;
        yMin -= pad;
        yMax += pad;
      }
      const yPad = Math.max((yMax - yMin) * 0.08, 1);
      const yBottom = d3
        .scaleLinear()
        .domain([yMin - yPad, yMax + yPad])
        .nice()
        .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

      const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
      const yAxis = d3
        .axisLeft(yBottom)
        .ticks(5)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(formatMarkAxis);

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
        .text("Mark Price");

      const area = d3
        .area()
        .x((point) => xBottom(point.date))
        .y0(yBottom(yBottom.domain()[0]))
        .y1((point) => yBottom(point.mark_price_close))
        .curve(d3.curveMonotoneX)
        .defined((point) => Number.isFinite(point.mark_price_close));

      const line = d3
        .line()
        .x((point) => xBottom(point.date))
        .y((point) => yBottom(point.mark_price_close))
        .curve(d3.curveMonotoneX)
        .defined((point) => Number.isFinite(point.mark_price_close));

      plotGroup
        .append("path")
        .datum(markPoints)
        .attr("fill", "#94b3fd")
        .attr("fill-opacity", 0.15)
        .attr("stroke", "none")
        .attr("d", area);

      plotGroup
        .append("path")
        .datum(markPoints)
        .attr("fill", "none")
        .attr("stroke", "#94b3fd")
        .attr("stroke-width", 1.7)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", line);

      return;
    }

    const cumulative = {
      total: 0,
      delta: 0,
      gammaTheta: 0,
      vega: 0,
      residual: 0,
    };
    const seriesByKey = {
      total: [],
      delta: [],
      gammaTheta: [],
      vega: [],
      residual: [],
    };

    comboFiltered.forEach((point, indexPoint) => {
      const date = point.date;
      if (indexPoint === 0) {
        seriesByKey.total.push({ date, value: 0 });
        seriesByKey.delta.push({ date, value: 0 });
        seriesByKey.gammaTheta.push({ date, value: 0 });
        seriesByKey.vega.push({ date, value: 0 });
        seriesByKey.residual.push({ date, value: 0 });
        return;
      }

      const deltaPL = Number.isFinite(point.delta_PL) ? point.delta_PL : 0;
      const gammaThetaPL = Number.isFinite(point.gamma_theta_PL)
        ? point.gamma_theta_PL
        : 0;
      const vegaPL = Number.isFinite(point.vega_PL) ? point.vega_PL : 0;
      const residualPL = Number.isFinite(point.residual_PL)
        ? point.residual_PL
        : 0;
      const totalPL = Number.isFinite(point.PL)
        ? point.PL
        : deltaPL + gammaThetaPL + vegaPL + residualPL;

      cumulative.delta += deltaPL;
      cumulative.gammaTheta += gammaThetaPL;
      cumulative.vega += vegaPL;
      cumulative.residual += residualPL;
      cumulative.total += totalPL;

      seriesByKey.total.push({ date, value: cumulative.total });
      seriesByKey.delta.push({ date, value: cumulative.delta });
      seriesByKey.gammaTheta.push({ date, value: cumulative.gammaTheta });
      seriesByKey.vega.push({ date, value: cumulative.vega });
      seriesByKey.residual.push({ date, value: cumulative.residual });
    });

    const seriesList = DETAIL_SERIES_CONFIG.map((series) => ({
      ...series,
      values: seriesByKey[series.key] || [],
    }));

    const allDates = [];
    const allValues = [];
    for (const series of seriesList) {
      for (const d of series.values) {
        allDates.push(d.date);
        allValues.push(d.value);
      }
    }

    if (!allDates.length || !allValues.length) {
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#c9c9cf")
        .style("font-size", "10px")
        .text("No Greeks P&L data in selected range");
      return;
    }

    const xBottom = d3
      .scaleUtc()
      .domain(d3.extent(allDates))
      .range([0, innerWidth]);

    const [rawMin, rawMax] = d3.extent(allValues);
    let yMin = rawMin ?? 0;
    let yMax = rawMax ?? 0;
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
    if (yMin === yMax) {
      const pad = yMin === 0 ? 0.0001 : Math.abs(yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    }

    const yBottom = d3
      .scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

    const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
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
      .text("Cumulative P&L ($)");

    const line = d3
      .line()
      .x((d) => xBottom(d.date))
      .y((d) => yBottom(d.value))
      .curve(d3.curveMonotoneX);

    const area = d3
      .area()
      .x((d) => xBottom(d.date))
      .y0(yBottom(0))
      .y1((d) => yBottom(d.value))
      .curve(d3.curveMonotoneX);

    plotGroup
      .append("g")
      .selectAll("path.detail-area")
      .data(seriesList)
      .join("path")
      .attr("class", "detail-area")
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", (d) => d.areaOpacity ?? 0.12)
      .attr("stroke", "none")
      .attr("d", (d) => area(d.values))
      .attr("display", (d) =>
        d.values.length && !isHiddenSeries(d.key) ? null : "none",
      );

    plotGroup
      .append("g")
      .selectAll("path.detail-line")
      .data(seriesList)
      .join("path")
      .attr("class", "detail-line")
      .attr("fill", "none")
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", (d) => d.strokeWidth || 1.6)
      .attr("stroke-linecap", "round")
      .attr("d", (d) => line(d.values))
      .attr("display", (d) =>
        d.values.length && !isHiddenSeries(d.key) ? null : "none",
      )
      .attr("stroke-opacity", (d) => (d.key === "total" ? 0.92 : 0.78));

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 24)
      .attr("text-anchor", "middle")
      .attr("fill", "#fff")
      .style("font-size", "14px")
      .style("font-weight", 600)
      .text("Greeks P&L");

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 44)
      .attr("text-anchor", "middle")
      .attr("fill", "#a9abb6")
      .style("font-size", "12px")
      .text(subtitle);

    const initialMark = Number(comboFiltered[0]?.mark_price_close);
    const totalLabel = Number.isFinite(cumulative.total)
      ? formatPnl(cumulative.total)
      : "n/a";
    let metricText = `Total P&L: ${totalLabel}`;
    if (
      Number.isFinite(cumulative.total) &&
      Number.isFinite(initialMark) &&
      initialMark !== 0
    ) {
      metricText += `    ROI: ${formatVol(cumulative.total / initialMark)}`;
    }

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 64)
      .attr("text-anchor", "middle")
      .attr("fill", "#a9abb6")
      .style("font-size", "12px")
      .style("font-weight", 400)
      .text(metricText);

    const legendLineLength = 18;
    const legendLabelOffset = 6;
    const legendRowGap = 20;
    const legendColGap = 130;
    const legendCols = 3;

    const legendGroup = bottomPanelGroup
      .append("g")
      .attr("transform", `translate(${layout.margin.left},84)`);

    const legendItems = legendGroup
      .selectAll("g.detail-legend-item")
      .data(seriesList)
      .join((enter) => {
        const item = enter.append("g").attr("class", "detail-legend-item");
        item.append("line").attr("stroke-linecap", "round");
        item.append("text");
        return item;
      });

    legendItems.attr("transform", (_d, i) => {
      const col = i % legendCols;
      const row = Math.floor(i / legendCols);
      return `translate(${col * legendColGap},${row * legendRowGap})`;
    });

    legendItems
      .select("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", legendLineLength)
      .attr("y2", 0)
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", (d) => d.strokeWidth || 1.6)
      .attr("stroke-opacity", (d) => (isHiddenSeries(d.key) ? 0.28 : 1));

    legendItems
      .select("text")
      .attr("x", legendLineLength + legendLabelOffset)
      .attr("y", 3)
      .attr("fill", "#a9abb6")
      .style("font-size", "11px")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-weight", 500)
      .text((d) => d.label)
      .attr("fill-opacity", (d) => (isHiddenSeries(d.key) ? 0.45 : 1));

    legendItems
      .attr("role", "button")
      .style("cursor", "pointer")
      .attr("opacity", (d) => (isHiddenSeries(d.key) ? 0.6 : 1))
      .on("click", (event, d) => {
        event.stopPropagation();
        toggleDetailSeries(d.key);
      });
  };

  const brush = d3
    .brushX()
    .extent([
      [0, 0],
      [innerWidth, topInnerHeight],
    ])
    .filter((event) => !event.ctrlKey && !event.button && event.detail < 2)
    .on("brush", (event) => {
      if (!event.selection) {
        drawBottom(null);
        return;
      }
      const [from, to] = event.selection.map(xTop.invert);
      const domain = from <= to ? [from, to] : [to, from];
      drawBottom(domain);
    })
    .on("end", (event) => {
      if (!event.selection) {
        brushedDomain = null;
        drawBottom(null);
        return;
      }
      const [from, to] = event.selection.map(xTop.invert);
      brushedDomain = from <= to ? [from, to] : [to, from];
      drawBottom(brushedDomain);
    });

  const brushGroup = topGroup.append("g").attr("class", "brush");
  brushGroup.call(brush);

  if (Array.isArray(brushedDomain) && brushedDomain.length === 2) {
    brushGroup.call(brush.move, [
      xTop(brushedDomain[0]),
      xTop(brushedDomain[1]),
    ]);
  }

  drawBottom(brushedDomain);
  drawResolutionControl(svg);
};

watch(
  () => [
    props.indexData,
    props.comboData,
    props.optionInstrumentName,
    props.subtitle,
    props.loading,
    props.resolutionKey,
    props.resolutionOptions,
  ],
  () => {
    render();
  },
  { deep: true },
);

onMounted(() => {
  render();
});
</script>

<template>
  <div class="chartContainer">
    <svg ref="svgRef" class="chartSvg" />
  </div>
</template>

<style scoped>
.chartContainer {
  width: 100%;
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
