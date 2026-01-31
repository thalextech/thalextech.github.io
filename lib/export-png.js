export function exportChartToPng({
  element,
  filename = "chart.png",
  scale = 2,
  padding = 16,
  width,
  height,
  background = "#000",
  drawBefore,
  drawAfter,
} = {}) {
  if (!element) return;
  const baseOptions = { filename, scale, padding, width, height, background };

  const tagName = element?.tagName?.toLowerCase?.();
  const isCanvas = tagName === "canvas";
  const isSvg = tagName === "svg";

  if (!isCanvas && !isSvg) {
    throw new Error("Export failed: Element must be <svg> or <canvas>.");
  }

  if (isCanvas) {
    exportCanvasToPng({
      canvasEl: element,
      ...baseOptions,
      drawBeforeCanvas: drawBefore,
      drawAfterCanvas: drawAfter,
    });
    return;
  }

  exportSvgToPng({
    svgEl: element,
    ...baseOptions,
    drawBeforeSvg: drawBefore,
    drawAfterSvg: drawAfter,
  });
}

export function exportSvgToPng({
  svgEl,
  filename = "chart.png",
  scale = 2,
  padding = 16,
  width: fallbackWidth,
  height: fallbackHeight,
  background = "#000",
  drawBeforeSvg,
  drawAfterSvg,
} = {}) {
  if (!svgEl) return;

  let width = Number.isFinite(fallbackWidth) ? fallbackWidth : 0;
  let height = Number.isFinite(fallbackHeight) ? fallbackHeight : 0;

  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(" ").map(Number);
    if (parts.length === 4) {
      const vbWidth = parts[2];
      const vbHeight = parts[3];
      if (Number.isFinite(vbWidth) && Number.isFinite(vbHeight)) {
        width = vbWidth;
        height = vbHeight;
      }
    }
  }

  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    const attrWidth = Number.parseFloat(svgEl.getAttribute("width"));
    const attrHeight = Number.parseFloat(svgEl.getAttribute("height"));
    if (Number.isFinite(attrWidth) && attrWidth > 0) width = attrWidth;
    if (Number.isFinite(attrHeight) && attrHeight > 0) height = attrHeight;
  }

  if (
    (!Number.isFinite(width) || width <= 0) &&
    typeof svgEl.getBoundingClientRect === "function"
  ) {
    const rect = svgEl.getBoundingClientRect();
    if (Number.isFinite(rect.width) && rect.width > 0) width = rect.width;
    if (Number.isFinite(rect.height) && rect.height > 0) height = rect.height;
  }

  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return;
  }

  const svgClone = svgEl.cloneNode(true);
  if (!svgClone.getAttribute("xmlns")) {
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  svgClone.setAttribute("width", String(width));
  svgClone.setAttribute("height", String(height));

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgClone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const image = new Image();
  image.onload = () => {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((width + safePadding * 2) * safeScale);
    canvas.height = Math.round((height + safePadding * 2) * safeScale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }

    ctx.scale(safeScale, safeScale);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
    }

    if (typeof drawBeforeSvg === "function") {
      drawBeforeSvg({
        ctx,
        width,
        height,
        padding: safePadding,
        scale: safeScale,
      });
    }

    ctx.drawImage(image, safePadding, safePadding, width, height);

    if (typeof drawAfterSvg === "function") {
      drawAfterSvg({
        ctx,
        width,
        height,
        padding: safePadding,
        scale: safeScale,
      });
    }

    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        URL.revokeObjectURL(url);
        return;
      }
      const downloadUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

function exportCanvasToPng({
  canvasEl,
  filename,
  scale,
  padding,
  width: fallbackWidth,
  height: fallbackHeight,
  background,
  drawBeforeCanvas,
  drawAfterCanvas,
} = {}) {
  if (!canvasEl) return;

  let width = Number.isFinite(canvasEl.width) ? canvasEl.width : 0;
  let height = Number.isFinite(canvasEl.height) ? canvasEl.height : 0;

  if (
    (!Number.isFinite(width) || width <= 0) &&
    Number.isFinite(fallbackWidth) &&
    fallbackWidth > 0
  ) {
    width = fallbackWidth;
  }
  if (
    (!Number.isFinite(height) || height <= 0) &&
    Number.isFinite(fallbackHeight) &&
    fallbackHeight > 0
  ) {
    height = fallbackHeight;
  }

  if (
    (!Number.isFinite(width) || width <= 0) &&
    typeof canvasEl.getBoundingClientRect === "function"
  ) {
    const rect = canvasEl.getBoundingClientRect();
    if (Number.isFinite(rect.width) && rect.width > 0) width = rect.width;
    if (Number.isFinite(rect.height) && rect.height > 0) height = rect.height;
  }

  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return;
  }

  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
  const output = document.createElement("canvas");
  output.width = Math.round((width + safePadding * 2) * safeScale);
  output.height = Math.round((height + safePadding * 2) * safeScale);
  const ctx = output.getContext("2d");
  if (!ctx) return;

  ctx.scale(safeScale, safeScale);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
  }

  if (typeof drawBeforeCanvas === "function") {
    drawBeforeCanvas({
      ctx,
      width,
      height,
      padding: safePadding,
      scale: safeScale,
    });
  }

  ctx.drawImage(canvasEl, safePadding, safePadding, width, height);

  if (typeof drawAfterCanvas === "function") {
    drawAfterCanvas({
      ctx,
      width,
      height,
      padding: safePadding,
      scale: safeScale,
    });
  }

  output.toBlob((pngBlob) => {
    if (!pngBlob) return;
    const downloadUrl = URL.createObjectURL(pngBlob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = filename || "chart.png";
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }, "image/png");
}
