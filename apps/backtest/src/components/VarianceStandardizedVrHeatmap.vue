<script setup>
import { computed, ref } from "vue";
import WeekdayHourHeatmap from "./WeekdayHourHeatmap.vue";

const props = defineProps({
  cells: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  showDataLabels: { type: Boolean, default: false },
});
const emit = defineEmits(["select"]);
const chartRef = ref(null);

defineExpose({
  exportPng(options = {}) {
    chartRef.value?.exportPng(options);
  },
});

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const heatmapCells = computed(() => (props.cells || []).map((cell) => ({
  ...cell,
  key: `${cell.weekday}-${cell.hour}`,
  weekdayLabel: weekdayLabels[cell.weekday],
  average: cell.ratio,
})));

function tooltipFormatter(row) {
  const distance = (row.ratio - 1) * 100;
  const direction = distance < 0 ? "below" : "above";
  return [
    `${row.weekdayLabel} ${String(row.hour).padStart(2, "0")}:00 UTC`,
    `Equal-risk VR(24)  ${row.ratio.toFixed(2)}`,
    `${Math.abs(distance).toFixed(1)}% ${direction} random walk`,
    `Complete 24h blocks  ${row.windowCount.toLocaleString()}`,
  ].join("\n");
}
</script>

<template>
  <WeekdayHourHeatmap
    ref="chartRef"
    :cells="heatmapCells"
    :loading="loading"
    color-mode="diverging"
    :diverging-center="1"
    value-format="decimal"
    legend-label="VR(24)"
    :legend-decimals="1"
    :value-decimals="2"
    :show-data-labels="showDataLabels"
    :show-positive-sign="false"
    :tooltip-formatter="tooltipFormatter"
    loading-message="Calculating equal-risk VR(24)…"
    empty-message="No complete 24-hour return blocks."
    aria-label="Variance-standardized 24-hour variance ratio by weekday and UTC start hour"
    gradient-id="variance-standardized-vr24-gradient"
    chart-title="EQUAL-RISK VR(24) · WEEKDAY × START HOUR"
    methodology="Method: scale 1h returns by the smoothed weekday/hour volatility profile, then calculate forward VR(24); 1.00 = random walk."
    interactive
    @select="emit('select', $event)"
  />
</template>
