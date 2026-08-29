<script setup>
import { computed, ref } from "vue";
import ProfitBoostChart from "./components/ProfitBoostChart.vue";
import {
  DEFAULT_WEEKLY_PNL,
  MAX_WEEKLY_PNL,
  MIN_WEEKLY_PNL,
  WEEKLY_PNL_STEP,
  calculateProfitBoost,
  formatSignedDollar,
} from "./lib/profitBoost.js";

const weeklyPnl = ref(DEFAULT_WEEKLY_PNL);
const chartRef = ref(null);

const outcome = computed(() => calculateProfitBoost(weeklyPnl.value));
const sliderProgress = computed(
  () =>
    ((weeklyPnl.value - MIN_WEEKLY_PNL) /
      (MAX_WEEKLY_PNL - MIN_WEEKLY_PNL)) *
    100,
);
function savePng() {
  chartRef.value?.exportPng({ filename: "profit-boost.png" });
}
</script>

<template>
  <main class="app profitBoostApp">
    <h1 class="visuallyHidden">Profit Boost</h1>

    <section class="controlPanel" aria-labelledby="weekly-pnl-label">
      <div class="controlCopy">
        <label id="weekly-pnl-label" for="weekly-pnl">
          Weekly realized P&amp;L
        </label>
        <span id="weekly-pnl-help">Net realized before the boost</span>
      </div>

      <output class="controlValue" for="weekly-pnl">
        {{ formatSignedDollar(weeklyPnl) }}
      </output>

      <div class="sliderField">
        <div class="sliderTrack" aria-hidden="true">
          <span
            class="sliderProgress"
            :style="{
              left: '0',
              width: `${sliderProgress}%`,
            }"
          />
        </div>
        <input
          id="weekly-pnl"
          v-model.number="weeklyPnl"
          class="pnlSlider"
          type="range"
          :min="MIN_WEEKLY_PNL"
          :max="MAX_WEEKLY_PNL"
          :step="WEEKLY_PNL_STEP"
          aria-describedby="weekly-pnl-help"
          :aria-valuetext="formatSignedDollar(weeklyPnl)"
        />
        <div class="sliderLabels" aria-hidden="true">
          <span>{{ formatSignedDollar(MIN_WEEKLY_PNL) }}</span>
          <span>{{ formatSignedDollar(MAX_WEEKLY_PNL) }}</span>
        </div>
      </div>

      <button class="saveButton" type="button" @click="savePng">
        Save PNG
      </button>
    </section>

    <ProfitBoostChart ref="chartRef" :outcome="outcome" />
  </main>
</template>

<style scoped>
.profitBoostApp {
  max-width: 1280px;
  padding-top: 24px;
}

.visuallyHidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.controlPanel {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) auto minmax(360px, 1.8fr) auto;
  align-items: center;
  gap: 22px;
  padding: 16px 18px 18px;
  margin-bottom: 14px;
  background: #080a0f;
  border: 1px solid #1c2029;
  border-radius: 12px;
}

.controlCopy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.controlCopy label {
  color: #f5f7fb;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.controlCopy span {
  color: #9aa2b0;
  font-size: 12px;
}

.controlValue {
  min-width: 88px;
  color: #ffffff;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  text-align: right;
}

.sliderField {
  --slider-thumb-size: 18px;
  position: relative;
  min-width: 0;
  padding: 0 0 22px;
}

.sliderTrack {
  position: absolute;
  top: 21px;
  right: calc(var(--slider-thumb-size) / 2);
  left: calc(var(--slider-thumb-size) / 2);
  height: 3px;
  overflow: hidden;
  background: #242936;
  border-radius: 999px;
  pointer-events: none;
}

.sliderProgress {
  position: absolute;
  display: block;
  height: 100%;
  background: #7aa2ff;
}

.pnlSlider {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: 44px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
  touch-action: pan-y;
}

.pnlSlider:focus-visible {
  outline: none;
}

.pnlSlider::-webkit-slider-runnable-track {
  height: 3px;
  background: transparent;
}

.pnlSlider::-webkit-slider-thumb {
  width: var(--slider-thumb-size);
  height: var(--slider-thumb-size);
  margin-top: -7.5px;
  box-sizing: border-box;
  appearance: none;
  background: #ffffff;
  border: 3px solid #7aa2ff;
  border-radius: 50%;
  box-shadow: 0 0 0 3px #080a0f;
}

.pnlSlider:focus-visible::-webkit-slider-thumb {
  box-shadow:
    0 0 0 3px #080a0f,
    0 0 0 5px rgb(122 162 255 / 45%);
}

.pnlSlider::-moz-range-track {
  height: 3px;
  background: transparent;
}

.pnlSlider::-moz-range-thumb {
  width: var(--slider-thumb-size);
  height: var(--slider-thumb-size);
  box-sizing: border-box;
  background: #ffffff;
  border: 3px solid #7aa2ff;
  border-radius: 50%;
  box-shadow: 0 0 0 3px #080a0f;
}

.pnlSlider:focus-visible::-moz-range-thumb {
  box-shadow:
    0 0 0 3px #080a0f,
    0 0 0 5px rgb(122 162 255 / 45%);
}

.sliderLabels {
  position: absolute;
  right: calc(var(--slider-thumb-size) / 2);
  bottom: 0;
  left: calc(var(--slider-thumb-size) / 2);
  display: flex;
  justify-content: space-between;
  color: #939caa;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.saveButton {
  flex: 0 0 auto;
  min-width: 94px;
}

@media (max-width: 860px) {
  .controlPanel {
    grid-template-columns: 1fr auto;
    gap: 14px 18px;
  }

  .controlValue {
    grid-column: 2;
    grid-row: 1;
  }

  .sliderField {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .saveButton {
    grid-column: 1 / -1;
    grid-row: 3;
    width: 100%;
  }
}

@media (max-width: 480px) {
  .profitBoostApp {
    padding: 14px 10px 28px;
  }

  .controlPanel {
    padding: 14px 14px 16px;
  }

  .controlCopy span {
    font-size: 11px;
  }
}
</style>
