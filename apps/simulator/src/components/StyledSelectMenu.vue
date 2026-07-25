<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

type SelectValue = string | number;
type SelectOption = {
  label: string;
  value: SelectValue;
};

const props = withDefaults(
  defineProps<{
    modelValue: SelectValue;
    label: string;
    options: SelectOption[];
    embedded?: boolean;
  }>(),
  {
    embedded: false,
  },
);

const emit = defineEmits<{
  (event: "update:modelValue", value: SelectValue): void;
}>();

const open = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const selectedIndex = computed(() =>
  props.options.findIndex(
    (option) => String(option.value) === String(props.modelValue),
  ),
);

const selectedLabel = computed(
  () => props.options[selectedIndex.value]?.label ?? String(props.modelValue),
);

const close = (): void => {
  open.value = false;
};

const focusOption = async (index: number): Promise<void> => {
  open.value = true;
  await nextTick();
  const buttons = menuRef.value?.querySelectorAll<HTMLButtonElement>(
    '[role="option"]',
  );
  buttons?.[Math.max(0, Math.min(props.options.length - 1, index))]?.focus();
};

const openAtSelection = (): void => {
  void focusOption(Math.max(0, selectedIndex.value));
};

const selectOption = (option: SelectOption): void => {
  emit("update:modelValue", option.value);
  close();
};

const handleFocusout = (event: FocusEvent): void => {
  const nextTarget = event.relatedTarget;
  if (!(nextTarget instanceof Node) || !event.currentTarget) {
    close();
    return;
  }
  if (!(event.currentTarget as HTMLElement).contains(nextTarget)) close();
};
</script>

<template>
  <div
    class="styled-select"
    :class="{ 'is-embedded': embedded }"
    @focusout="handleFocusout"
    @keydown.esc.stop="close"
  >
    <button
      class="styled-select-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      @click="open ? close() : openAtSelection()"
      @keydown.down.prevent="openAtSelection"
      @keydown.up.prevent="openAtSelection"
    >
      <span>{{ selectedLabel }}</span>
    </button>

    <div
      v-if="open"
      ref="menuRef"
      class="styled-select-menu"
      role="listbox"
      :aria-label="label"
    >
      <button
        v-for="(option, index) in options"
        :key="String(option.value)"
        type="button"
        role="option"
        :aria-selected="index === selectedIndex"
        :class="{ active: index === selectedIndex }"
        @click="selectOption(option)"
        @keydown.down.prevent="focusOption((index + 1) % options.length)"
        @keydown.up.prevent="
          focusOption((index - 1 + options.length) % options.length)
        "
        @keydown.home.prevent="focusOption(0)"
        @keydown.end.prevent="focusOption(options.length - 1)"
      >
        <span>{{ option.label }}</span>
        <span
          v-if="index === selectedIndex"
          class="styled-select-check"
          aria-hidden="true"
        >✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.styled-select {
  position: relative;
  z-index: 6;
  min-width: 0;
}

.styled-select:focus-within {
  z-index: 20;
}

.styled-select-trigger {
  width: 100%;
  height: var(--control-height, 28px);
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  background: #0a0b0e;
  color: #d8dadd;
  font: inherit;
  white-space: nowrap;
}

.styled-select-trigger:hover,
.styled-select-trigger:focus-visible {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.055);
  color: #f2f3f5;
  outline: none;
}

.is-embedded .styled-select-trigger {
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
}

.is-embedded .styled-select-trigger:hover,
.is-embedded .styled-select-trigger:focus-visible {
  border: 0;
  background: transparent;
}

.styled-select-menu {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 30;
  min-width: max(100%, 126px);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 6px;
  background: #14161a;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}

.styled-select-menu button {
  width: 100%;
  height: 27px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #9ba0a7;
  font-family: inherit;
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  text-align: left;
  white-space: nowrap;
}

.styled-select-menu button:hover,
.styled-select-menu button:focus-visible {
  background: rgba(255, 255, 255, 0.07);
  color: #f2f3f5;
  outline: none;
}

.styled-select-menu button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f3f5;
}

.styled-select-check {
  color: #d8dadd;
  font-size: 11px;
}
</style>
