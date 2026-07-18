export const RV_AXIS_COLOR = "#9ba0a7";
export const RV_AXIS_FONT_SIZE = 10;
export const RV_CHART_TITLE_FONT_SIZE = 12;
export const RV_CHART_DESCRIPTION_FONT_SIZE = 10.5;
export const RV_PLOT_MAX_WIDTH = 1152;
export const RV_TERM_STRUCTURE_MAX_WIDTH = 1280;
export const RV_PLOT_GUTTERS = Object.freeze({ left: 84, right: 118 });

export function calculateRvPlotLayout(width, maxWidth = RV_PLOT_MAX_WIDTH) {
  const availableWidth = Math.max(
    0,
    width - RV_PLOT_GUTTERS.left - RV_PLOT_GUTTERS.right,
  );
  const plotWidth = Math.min(maxWidth, availableWidth);
  return {
    plotLeft: RV_PLOT_GUTTERS.left + (availableWidth - plotWidth) / 2,
    plotWidth,
  };
}
