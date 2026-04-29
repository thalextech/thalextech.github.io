<script lang="ts" setup>
const {data: apps} = await useAsyncData(() => queryCollection('apps').all());

useHead({
  htmlAttrs: { class: "dark text-default bg-default" },
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
          :ui="{ container: 'lg:flex'}"
      >
        <NuxtPicture
            v-if="app.image"
            :src="app.image"
            width="536"
            height="302"
            class="aspect-video"
            :img-attrs="{ class: 'rounded-lg' }"
        />
      </UPageCard>
    </UPageGrid>
  </UContainer>
</template>
