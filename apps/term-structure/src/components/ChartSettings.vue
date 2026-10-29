<script setup>
import { onMounted, onBeforeUnmount, ref } from "vue";
defineProps({ showRealized: Boolean, forward: Boolean });
const emit = defineEmits(["update:showRealized"]);
const open = ref(false),
  root = ref(null),
  button = ref(null);
function outside(event) {
  if (!open.value || !(event.target instanceof Node)) return;
  if (root.value?.contains(event.target)) return;
  open.value = false;
}
function escape(event) {
  if (event.key === "Escape" && open.value) {
    open.value = false;
    button.value?.focus();
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("keydown", escape);
});
</script>
<template>
  <div ref="root" class="settingsWrap settingsWrap--chart">
    <button
      ref="button"
      class="settingsButton settingsButton--icon"
      type="button"
      title="Chart settings"
      aria-label="Chart settings"
      aria-haspopup="true"
      :aria-expanded="open"
      aria-controls="chart-settings"
      @click="open = !open"
    ></button>
    <div v-if="open" id="chart-settings" class="settingsDropdown">
      <div class="settingsTitle">Chart settings</div>
      <label class="settingsConeToggle">
        <span>Realized volatility</span>
        <input
          type="checkbox"
          role="switch"
          :checked="showRealized"
          @change="emit('update:showRealized', $event.target.checked)"
        />
      </label>
      <div class="settingsHint">
        Hourly OHLC · Garman–Klass ·
        {{
          forward
            ? "lookbacks use the most recent history matching each forward interval’s duration."
            : "lookback matched to each expiry’s current time to maturity."
        }}
      </div>
    </div>
  </div>
</template>
