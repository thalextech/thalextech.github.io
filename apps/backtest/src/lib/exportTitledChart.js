import { exportChartToPng } from "../../../../lib/export-png.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const addText = (svg, { text, x, y, size, color, weight = 400 }) => {
  if (!text) return;
  const node = document.createElementNS(SVG_NS, "text");
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("text-anchor", "middle");
  node.setAttribute("fill", color);
  node.setAttribute("font-family", '"Helvetica Neue", Helvetica, -apple-system, sans-serif');
  node.setAttribute("font-size", String(size));
  node.setAttribute("font-weight", String(weight));
  node.textContent = text;
  svg.appendChild(node);
};

export function exportTitledChart({
  svgEl,
  title,
  subtitle,
  source,
  filename,
  scale = 3,
  padding = 24,
  background = "#0a0b0e",
} = {}) {
  if (!svgEl) return;

  const viewBox = (svgEl.getAttribute("viewBox") || "")
    .split(/\s+/)
    .map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return;

  const [minX, minY, width, height] = viewBox;
  const headerHeight = 76;
  const exportSvg = svgEl.cloneNode(true);
  const chartGroup = document.createElementNS(SVG_NS, "g");
  while (exportSvg.firstChild) chartGroup.appendChild(exportSvg.firstChild);
  chartGroup.setAttribute("transform", `translate(0,${headerHeight})`);
  exportSvg.appendChild(chartGroup);
  exportSvg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height + headerHeight}`);
  exportSvg.setAttribute("width", String(width));
  exportSvg.setAttribute("height", String(height + headerHeight));

  const centerX = minX + width / 2;
  addText(exportSvg, {
    text: title,
    x: centerX,
    y: minY + 21,
    size: 18,
    color: "#e8eaed",
    weight: 500,
  });
  addText(exportSvg, {
    text: subtitle,
    x: centerX,
    y: minY + 42,
    size: 13,
    color: "#9aa0a6",
  });
  addText(exportSvg, {
    text: source,
    x: centerX,
    y: minY + 60,
    size: 12,
    color: "#70767d",
  });

  exportChartToPng({
    element: exportSvg,
    filename,
    scale,
    padding,
    background,
  });
}
