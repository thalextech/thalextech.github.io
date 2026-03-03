<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";

const props = defineProps({
  indexData: { type: Array, default: () => [] },
  optionSeries: { type: Array, default: () => [] },
  optionType: { type: String, default: "call" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);

let brushedDomain = null;

const layout = {
  width: 1200,
  headerHeight: 38,
  topPanelHeight: 300,
  bottomPanelHeight: 420,
  panelGap: 34,
  margin: { top: 14, right: 38, bottom: 54, left: 74 },
};

const BOTTOM_TOP_INSET = 36;
const LABEL_VERTICAL_OFFSET = 6;
const LABEL_X_OFFSET = 18;
const TOP3_LINE_GAP = 20;
const TOP3_BOX_X = 20;
const TOP3_BOX_Y = 18;
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
const MATURITY_COLOR_START = "#3b82f6";
const MATURITY_COLOR_END = "#f59e0b";
const MAX_DELTA_FOR_LIGHTNESS = 0.6;
const MAX_LIGHTEN_WEIGHT = 0.5;

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#f4f4f5")
    .style("font-size", "10px")
    .style("font-family", SVG_FONT_FAMILY);
};

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatChange0 = d3.format(",.0f");
const formatRoiPct0 = d3.format(".0f");
const formatIndex0 = d3.format(",.0f");
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const getNearestSeriesPoint = (points, targetDate) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first?.date instanceof Date) || !(last?.date instanceof Date))
    return null;
  if (targetDate < first.date || targetDate > last.date) return null;
  const bisect = d3.bisector((point) => point.date).center;
  const index = bisect(points, targetDate);
  const point = points[index];
  if (!(point?.date instanceof Date) || !Number.isFinite(point?.mark))
    return null;
  return point;
};

const normalizeIndexPoints = (rows) =>
  (rows || [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      const value = Number(row?.index_price_close ?? row?.value);
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
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

const normalizeOptionSeries = (rows) =>
  (rows || [])
    .map((series) => {
      if (!series || typeof series !== "object") return null;
      const points = (series.points || [])
        .map((point) => {
          const ts = Number(point?.ts);
          const date =
            point?.date instanceof Date
              ? point.date
              : new Date(Number(point?.ts) * 1000);
          const mark = Number(point?.mark);
          const deltaAbs = Number(point?.delta_abs);
          const indexPrice = Number(point?.index_price);
          if (
            !Number.isFinite(ts) ||
            !Number.isFinite(mark) ||
            mark <= 0 ||
            !(date instanceof Date) ||
            Number.isNaN(date.getTime())
          ) {
            return null;
          }
          return {
            ts,
            date,
            mark,
            indexPrice: Number.isFinite(indexPrice) ? indexPrice : null,
            deltaAbs: Number.isFinite(deltaAbs) ? deltaAbs : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

      if (points.length < 2) return null;

      return {
        instrumentName: series.instrument_name || "",
        strike: Number(series.strike),
        expirationTs: Number(series.expiration_timestamp),
        expiryDate: series.expiry_date || "",
        optionType: String(series.option_type || "").toLowerCase(),
        points,
      };
    })
    .filter(Boolean);

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const index = normalizeIndexPoints(props.indexData);
  const optionSeries = normalizeOptionSeries(props.optionSeries).filter(
    (series) =>
      series.optionType === String(props.optionType || "").toLowerCase(),
  );

  svg.attr(
    "viewBox",
    `0 0 ${layout.width} ${layout.headerHeight + layout.topPanelHeight + layout.panelGap + layout.bottomPanelHeight}`,
  );
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  if (!index.length) {
    svg
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 220)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "14px")
      .style("font-family", SVG_FONT_FAMILY)
      .text(
        props.loading ? "Loading index history..." : "No index data available.",
      );
    return;
  }

  const topPanelY = layout.headerHeight;
  const bottomPanelY = topPanelY + layout.topPanelHeight + layout.panelGap;
  const innerWidth = layout.width - layout.margin.left - layout.margin.right;
  const topInnerHeight =
    layout.topPanelHeight - layout.margin.top - layout.margin.bottom;
  const bottomInnerHeight =
    layout.bottomPanelHeight - layout.margin.top - layout.margin.bottom;

  const modeLabel = props.optionType === "put" ? "Puts" : "Calls";

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 16)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .style("font-family", SVG_FONT_FAMILY)
    .text("BTCUSD");

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#c9c9cf")
    .style("font-size", "12px")
    .style("font-family", SVG_FONT_FAMILY)
    .text(props.subtitle || "");

  const xDomain = d3.extent(index, (point) => point.date);
  let [yMinTop, yMaxTop] = d3.extent(index, (point) => point.value);
  if (yMinTop === yMaxTop) {
    const pad = yMinTop === 0 ? 1 : Math.abs(yMinTop) * 0.01;
    yMinTop -= pad;
    yMaxTop += pad;
  }

  const xTop = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const yTop = d3
    .scaleLinear()
    .domain([yMinTop, yMaxTop])
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
    .style("font-family", SVG_FONT_FAMILY)
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
    .style("font-family", SVG_FONT_FAMILY)
    .text("Index Price (Close)");

  const topLine = d3
    .line()
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

  const drawBottom = (domain = null) => {
    bottomPanelGroup.selectAll("*").remove();

    const domainStart = domain?.[0] ?? xDomain?.[0];
    const domainEnd = domain?.[1] ?? xDomain?.[1];

    const plotGroup = bottomPanelGroup
      .append("g")
      .attr(
        "transform",
        `translate(${layout.margin.left},${layout.margin.top})`,
      );

    if (!(domainStart instanceof Date) || !(domainEnd instanceof Date)) {
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#c9c9cf")
        .style("font-size", "10px")
        .style("font-family", SVG_FONT_FAMILY)
        .text("No data in selected range");
      return;
    }

    const eligibleSeries = [];

    for (const series of optionSeries) {
      const inRange = series.points.filter(
        (point) => point.date >= domainStart && point.date <= domainEnd,
      );
      if (inRange.length < 2) continue;

      const startPoint = inRange.find((point) => Number.isFinite(point.mark));
      if (
        !startPoint ||
        !Number.isFinite(startPoint.mark) ||
        startPoint.mark <= 0
      ) {
        continue;
      }
      if (!Number.isFinite(startPoint.deltaAbs) || startPoint.deltaAbs > 0.6) {
        continue;
      }

      const normalized = inRange
        .map((point) => ({
          date: point.date,
          mark: point.mark,
          indexPrice: point.indexPrice,
          value: (point.mark / startPoint.mark) * 100,
        }))
        .filter(
          (point) =>
            point?.date instanceof Date &&
            !Number.isNaN(point.date.getTime()) &&
            Number.isFinite(point.mark) &&
            Number.isFinite(point.value),
        );

      if (normalized.length < 2) continue;
      const lastPoint = normalized[normalized.length - 1];
      const lastValue = lastPoint?.value;
      if (!Number.isFinite(lastValue)) continue;
      const endMark = Number.isFinite(lastPoint?.mark)
        ? lastPoint.mark
        : startPoint.mark * (lastValue / 100);
      const roiPct =
        Number.isFinite(endMark) && startPoint.mark > 0
          ? (endMark / startPoint.mark - 1) * 100
          : lastValue - 100;

      eligibleSeries.push({
        ...series,
        rangePoints: inRange,
        startMark: startPoint.mark,
        startDeltaAbs: Number.isFinite(startPoint.deltaAbs)
          ? Math.abs(startPoint.deltaAbs)
          : null,
        normalized,
        perf: lastValue - 100,
        lastValue,
        roiPct,
        maxIndexedIncrease:
          d3.max(normalized, (point) => point.value - 100) ?? lastValue - 100,
      });
    }

    eligibleSeries.sort((a, b) => {
      const roiDiff = (b.roiPct ?? -Infinity) - (a.roiPct ?? -Infinity);
      if (Number.isFinite(roiDiff) && roiDiff !== 0) return roiDiff;
      return (b.perf ?? -Infinity) - (a.perf ?? -Infinity);
    });
    const top3 = eligibleSeries.slice(0, 3);
    const topRankByName = new Map(
      top3.map((series, indexSeries) => [series.instrumentName, indexSeries]),
    );
    const maturitySorted = [...eligibleSeries].sort((a, b) => {
      const expiryA = Number(a?.expirationTs);
      const expiryB = Number(b?.expirationTs);
      if (Number.isFinite(expiryA) && Number.isFinite(expiryB)) {
        return expiryA - expiryB;
      }
      if (Number.isFinite(expiryA)) return -1;
      if (Number.isFinite(expiryB)) return 1;
      if (String(a?.expiryDate || "") !== String(b?.expiryDate || "")) {
        return String(a?.expiryDate || "").localeCompare(
          String(b?.expiryDate || ""),
        );
      }
      return String(a?.instrumentName || "").localeCompare(
        String(b?.instrumentName || ""),
      );
    });
    const maturityColorScale = d3
      .scaleLinear()
      .domain([0, Math.max(1, maturitySorted.length - 1)])
      .range([MATURITY_COLOR_START, MATURITY_COLOR_END])
      .interpolate(d3.interpolateRgb);
    const maturityColorByName = new Map(
      maturitySorted.map((series, idx) => {
        const baseColor = maturityColorScale(idx);
        const deltaAbs = Number.isFinite(series?.startDeltaAbs)
          ? Math.abs(series.startDeltaAbs)
          : MAX_DELTA_FOR_LIGHTNESS;
        const normalizedDelta = clamp(deltaAbs / MAX_DELTA_FOR_LIGHTNESS, 0, 1);
        const lightenWeight = (1 - normalizedDelta) * MAX_LIGHTEN_WEIGHT;
        const lineColor = d3.interpolateRgb(
          baseColor,
          "#ffffff",
        )(lightenWeight);
        return [series.instrumentName, lineColor];
      }),
    );
    const lowerTitle = `${modeLabel} Horse Race (|Δ| ≤ 0.60 at range start)`;
    const rangeSubtitle = `${formatDate(domainStart)} - ${formatDate(domainEnd)} (${((domainEnd - domainStart) / (24 * 60 * 60 * 1000)).toFixed(1)} days)`;

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 24)
      .attr("text-anchor", "middle")
      .attr("fill", "#fff")
      .style("font-size", "14px")
      .style("font-weight", 600)
      .style("font-family", SVG_FONT_FAMILY)
      .text(lowerTitle);

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 44)
      .attr("text-anchor", "middle")
      .attr("fill", "#a9abb6")
      .style("font-size", "12px")
      .style("font-family", SVG_FONT_FAMILY)
      .text(rangeSubtitle);

    if (!eligibleSeries.length) {
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#c9c9cf")
        .style("font-size", "10px")
        .style("font-family", SVG_FONT_FAMILY)
        .text("No instrument matched |Δ| <= 0.60 in this range");
      return;
    }

    const xBottom = d3
      .scaleUtc()
      .domain([domainStart, domainEnd])
      .range([0, innerWidth]);

    const allValues = eligibleSeries.flatMap((series) =>
      series.normalized.map((point) => point.value),
    );
    let yMin = Math.min(100, ...allValues);
    let yMax = Math.max(100, ...allValues);
    if (yMin === yMax) {
      const pad = yMin === 0 ? 0.1 : Math.abs(yMin) * 0.03;
      yMin -= pad;
      yMax += pad;
    }
    const pad = Math.max((yMax - yMin) * 0.08, 0.8);
    const yBottom = d3
      .scaleLinear()
      .domain([yMin - pad, yMax + pad])
      .nice()
      .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

    const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
    const yAxis = d3
      .axisLeft(yBottom)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat((value) => `${d3.format(".0f")(value)}`);

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
      .style("font-family", SVG_FONT_FAMILY)
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
      .style("font-family", SVG_FONT_FAMILY)
      .text("Indexed Mark (Start = 100)");

    plotGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", yBottom(100))
      .attr("y2", yBottom(100))
      .attr("stroke", "#5f6677")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "3 3")
      .attr("opacity", 0.65);

    const blurId = `horse-race-blur-${Math.random().toString(36).slice(2, 9)}`;
    const defs = bottomPanelGroup.append("defs");
    defs
      .append("filter")
      .attr("id", blurId)
      .append("feGaussianBlur")
      .attr("stdDeviation", 0.6);

    const line = d3
      .line()
      .x((point) => xBottom(point.date))
      .y((point) => yBottom(point.value))
      .curve(d3.curveMonotoneX);

    const seriesForDraw = [
      ...eligibleSeries.filter(
        (series) => !topRankByName.has(series.instrumentName),
      ),
      ...eligibleSeries.filter((series) =>
        topRankByName.has(series.instrumentName),
      ),
    ];

    plotGroup
      .append("g")
      .selectAll("path.horse-race-line")
      .data(seriesForDraw)
      .join("path")
      .attr("class", "horse-race-line")
      .attr("fill", "none")
      .attr(
        "stroke",
        (series) => maturityColorByName.get(series.instrumentName) || "#94a3b8",
      )
      .attr("stroke-width", (series) =>
        topRankByName.has(series.instrumentName) ? 1.2 : 0.6,
      )
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("stroke-opacity", (series) =>
        topRankByName.has(series.instrumentName) ? 0.9 : 0.45,
      )
      .attr("filter", (series) =>
        topRankByName.has(series.instrumentName) ? null : `url(#${blurId})`,
      )
      .attr("d", (series) => line(series.normalized));

    function buildLabelData(series, mark = null) {
      if (!Number.isFinite(series?.startMark) || series.startMark <= 0)
        return null;
      let effectiveMark = Number(mark);
      if (
        !Number.isFinite(effectiveMark) &&
        Number.isFinite(series?.lastValue)
      ) {
        effectiveMark = series.startMark * (series.lastValue / 100);
      }
      if (!Number.isFinite(effectiveMark)) return null;
      const absChange = effectiveMark - series.startMark;
      const pctChange = (effectiveMark / series.startMark - 1) * 100;
      const absPrefix = absChange >= 0 ? "+" : "";
      const pctPrefix = pctChange >= 0 ? "+" : "";
      return {
        id: series.instrumentName,
        prefix: "",
        instrumentName: series.instrumentName,
        suffix: `   -   $${absPrefix}${formatChange0(absChange)} [ROI ${pctPrefix}${formatRoiPct0(pctChange)}%]`,
      };
    }

    const rankingLayer = plotGroup.append("g").attr("class", "horse-top3-list");
    rankingLayer
      .append("text")
      .attr("x", TOP3_BOX_X)
      .attr("y", BOTTOM_TOP_INSET + TOP3_BOX_Y)
      .attr("fill", "#ffffff")
      .style("font-size", "11px")
      .style("font-family", "Arial, sans-serif")
      .style("font-weight", 700)
      .attr("paint-order", "stroke")
      .attr("stroke", "#000")
      .attr("stroke-width", 3)
      .text("Top 3 (ROI)");

    top3.forEach((series, idx) => {
      const last = series.normalized[series.normalized.length - 1];
      const label = buildLabelData(series, last?.mark);
      if (!label) return;
      const rowY = BOTTOM_TOP_INSET + TOP3_BOX_Y + 18 + idx * TOP3_LINE_GAP;
      const rowText = rankingLayer
        .append("text")
        .attr("x", TOP3_BOX_X)
        .attr("y", rowY)
        .attr("fill", "#ffffff")
        .style("font-size", "11px")
        .style("font-family", "Arial, sans-serif")
        .style("font-weight", 400)
        .attr("paint-order", "stroke")
        .attr("stroke", "#000")
        .attr("stroke-width", 3);
      rowText
        .append("tspan")
        .attr("font-weight", 400)
        .text(`${idx + 1}. `);
      rowText
        .append("tspan")
        .attr("font-weight", 400)
        .text(label.instrumentName || "");
      rowText
        .append("tspan")
        .attr("font-weight", 400)
        .text(label.suffix || "");
    });

    const hoverLayer = plotGroup.append("g").attr("display", "none");
    const hoverPoint = hoverLayer
      .append("circle")
      .attr("r", 2.6)
      .attr("stroke", "#0b0f17")
      .attr("stroke-width", 0.8);
    const hoverBox = hoverLayer
      .append("rect")
      .attr("fill", "#000000")
      .attr("stroke", "whitesmoke")
      .attr("stroke-width", 0.75)
      .attr("rx", 4)
      .attr("ry", 4);
    const hoverLabel = hoverLayer
      .append("text")
      .attr("fill", "#ffffff")
      .style("font-size", "10.5px")
      .style("font-weight", 400)
      .style("font-family", "Arial, sans-serif")
      .style("pointer-events", "none");

    const hideHover = () => {
      hoverLayer.attr("display", "none");
    };

    const buildHoverDetails = (series, point) => {
      if (!Number.isFinite(series?.startMark) || series.startMark <= 0)
        return null;
      if (!Number.isFinite(point?.mark)) return null;
      const absChange = point.mark - series.startMark;
      const pctChange = (point.mark / series.startMark - 1) * 100;
      const absPrefix = absChange >= 0 ? "+" : "";
      const pctPrefix = pctChange >= 0 ? "+" : "";
      const timestamp = point?.date instanceof Date ? point.date : null;
      const dateText = timestamp ? `${formatDate(timestamp)} UTC` : "Date n/a";
      const indexText = Number.isFinite(point?.indexPrice)
        ? `Index ${formatIndex0(point.indexPrice)}`
        : "Index n/a";
      return {
        line1: `${series.instrumentName}:`,
        line2: `$${absPrefix}${formatChange0(absChange)}  ROI ${pctPrefix}${formatRoiPct0(pctChange)}%`,
        line3: `${dateText}  |  ${indexText}`,
      };
    };

    const showHoverAt = (series, hoverDate) => {
      const nearest = getNearestSeriesPoint(series.normalized, hoverDate);
      if (
        !nearest ||
        !Number.isFinite(nearest.value) ||
        !Number.isFinite(nearest.mark)
      ) {
        hideHover();
        return;
      }
      const x = xBottom(nearest.date);
      const y = yBottom(nearest.value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        hideHover();
        return;
      }
      const details = buildHoverDetails(series, nearest);
      if (!details) {
        hideHover();
        return;
      }

      const placeLeft = x > innerWidth * 0.62;
      const labelX = placeLeft ? x - LABEL_X_OFFSET : x + LABEL_X_OFFSET;
      const anchor = placeLeft ? "end" : "start";
      const lineHeight = 14;

      hoverPoint
        .attr("cx", x)
        .attr("cy", y)
        .attr(
          "fill",
          maturityColorByName.get(series.instrumentName) || "#ffffff",
        );

      hoverLabel.selectAll("tspan").remove();
      hoverLabel.attr("x", labelX).attr("y", y - LABEL_VERTICAL_OFFSET);
      hoverLabel.attr("text-anchor", anchor);
      hoverLabel
        .append("tspan")
        .attr("x", labelX)
        .attr("dy", 0)
        .text(details.line1);
      hoverLabel
        .append("tspan")
        .attr("x", labelX)
        .attr("dy", lineHeight)
        .text(details.line2);
      hoverLabel
        .append("tspan")
        .attr("x", labelX)
        .attr("dy", lineHeight)
        .text(details.line3);

      const textBox = hoverLabel.node()?.getBBox?.();
      if (textBox) {
        const padX = 8;
        const padY = 6;
        hoverBox
          .attr("x", textBox.x - padX)
          .attr("y", textBox.y - padY)
          .attr("width", Math.max(1, textBox.width + padX * 2))
          .attr("height", Math.max(1, textBox.height + padY * 2));
      }
      hoverLayer.attr("display", null);
    };

    plotGroup
      .append("g")
      .selectAll("path.horse-race-hit")
      .data(seriesForDraw)
      .join("path")
      .attr("class", "horse-race-hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12)
      .style("pointer-events", "stroke")
      .attr("d", (series) => line(series.normalized))
      .on("mouseenter", function onEnter(event, series) {
        const [xPx] = d3.pointer(event, this);
        const hoverDate = xBottom.invert(clamp(xPx, 0, innerWidth));
        showHoverAt(series, hoverDate);
      })
      .on("mousemove", function onMove(event, series) {
        const [xPx] = d3.pointer(event, this);
        const hoverDate = xBottom.invert(clamp(xPx, 0, innerWidth));
        showHoverAt(series, hoverDate);
      })
      .on("mouseleave", () => {
        hideHover();
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
        brushedDomain = null;
        drawBottom(null);
        return;
      }
      const [from, to] = event.selection.map(xTop.invert);
      brushedDomain = from <= to ? [from, to] : [to, from];
      drawBottom(brushedDomain);
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
  brushGroup.selectAll(".selection").attr("fill-opacity", 0.2);

  if (Array.isArray(brushedDomain) && brushedDomain.length === 2) {
    brushGroup.call(brush.move, [
      xTop(brushedDomain[0]),
      xTop(brushedDomain[1]),
    ]);
  }

  drawBottom(brushedDomain);
};

watch(
  () => [
    props.indexData,
    props.optionSeries,
    props.optionType,
    props.subtitle,
    props.loading,
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
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg"></svg>
  </div>
</template>

<style scoped>
.chartWrap {
  width: min(100%, 1200px);
}

.chartSvg {
  width: 100%;
  height: auto;
  display: block;
}
</style>
