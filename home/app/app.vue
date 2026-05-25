<script lang="ts" setup>
const APP_ORDER = [
  "Simulator",
  "Combo PnL",
  "Straddle",
  "Combo Greeks",
  "Greeks",
  "Option PnL",
  "Break Even",
  "Roll PnL",
  "Basis",
  "Subjective Valuation",
];

const { data: apps } = await useAsyncData(() => queryCollection("apps").all(), {
  transform: (rows) =>
    [...rows].sort((a, b) => {
      const ai = APP_ORDER.indexOf(a.title);
      const bi = APP_ORDER.indexOf(b.title);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.title.localeCompare(b.title);
    }),
});

useHead({
  htmlAttrs: { class: "dark text-default bg-black" },
});
</script>

<template>
  <UContainer class="py-20">
    <UPageGrid>
      <UPageCard
        v-for="app in apps"
        :key="app.id"
        :title="app.title"
        :description="app.description"
        :to="app.path"
        target="_blank"
        variant="subtle"
        :ui="{ root: 'bg-neutral-950 ring-neutral-900', container: 'lg:flex' }"
      >
        <div
          v-if="app.image"
          class="mt-4 flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black"
        >
          <img
            :src="app.image"
            :alt="`${app.title} preview`"
            class="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        </div>
      </UPageCard>
    </UPageGrid>
  </UContainer>
</template>
