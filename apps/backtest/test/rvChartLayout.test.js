import test from "node:test";
import assert from "node:assert/strict";
import {
  RV_PLOT_MAX_WIDTH,
  RV_TERM_STRUCTURE_MAX_WIDTH,
  calculateRvPlotLayout,
} from "../src/lib/rvChartLayout.js";

test("RV charts share one centered plot column at wide and narrow widths", () => {
  assert.deepEqual(calculateRvPlotLayout(1800), {
    plotLeft: 307,
    plotWidth: RV_PLOT_MAX_WIDTH,
  });
  assert.deepEqual(calculateRvPlotLayout(760), {
    plotLeft: 84,
    plotWidth: 558,
  });

  assert.deepEqual(calculateRvPlotLayout(1800, RV_TERM_STRUCTURE_MAX_WIDTH), {
    plotLeft: 243,
    plotWidth: RV_TERM_STRUCTURE_MAX_WIDTH,
  });
});
