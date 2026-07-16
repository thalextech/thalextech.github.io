<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  label: { type: String, required: true },
  options: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:modelValue"]);
const open = ref(false);
const selectedLabel = computed(() =>
  props.options.find((option) => String(option.value) === String(props.modelValue))?.label
  || String(props.modelValue)
);

const selectOption = (option) => {
  emit("update:modelValue", option.value);
  open.value = false;
};

const handleFocusout = (event) => {
  if (!event.currentTarget.contains(event.relatedTarget)) open.value = false;
};
</script>

<template>
  <div
    class="styledSelect"
    @focusout="handleFocusout"
    @keydown.esc="open = false"
  >
    <span class="styledSelectLabel">{{ label }}</span>
    <button
      class="styledSelectTrigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span>{{ selectedLabel }}</span>
      <span class="styledSelectChevron" aria-hidden="true"></span>
    </button>
    <div
      v-if="open"
      class="styledSelectMenu"
      role="listbox"
      :aria-label="label"
    >
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="String(modelValue) === String(option.value)"
        :class="{ active: String(modelValue) === String(option.value) }"
        @click="selectOption(option)"
      >
        <span>{{ option.label }}</span>
        <span
          v-if="String(modelValue) === String(option.value)"
          class="styledSelectCheck"
          aria-hidden="true"
        >✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.styledSelect {
  position: relative;
  z-index: 6;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-left: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 5px;
  background: rgba(10, 11, 14, 0.78);
  color: #777d84;
  font: 500 9px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  backdrop-filter: blur(6px);
}

.styledSelectLabel {
  white-space: nowrap;
}

.styledSelectTrigger {
  min-width: 76px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  border-radius: 4px;
  padding: 0 7px 0 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #d8dadd;
  font: inherit;
  cursor: pointer;
}

.styledSelectTrigger:hover,
.styledSelectTrigger:focus-visible {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.styledSelectChevron {
  width: 5px;
  height: 5px;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  transform: translateY(-1px) rotate(45deg);
}

.styledSelectMenu {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 12;
  min-width: max(100%, 126px);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 6px;
  background: #14161a;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}

.styledSelectMenu button {
  width: 100%;
  height: 27px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 0;
  border-radius: 4px;
  padding: 0 8px;
  background: transparent;
  color: #9ba0a7;
  font: 500 10px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.styledSelectMenu button:hover,
.styledSelectMenu button:focus-visible {
  background: rgba(255, 255, 255, 0.07);
  color: #f2f3f5;
  outline: none;
}

.styledSelectMenu button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.styledSelectCheck {
  color: #d8dadd;
  font-size: 11px;
}
</style>
