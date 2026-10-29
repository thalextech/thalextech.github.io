<script lang="ts" setup>
definePageMeta({ key: (route) => route.path });

const route = useRoute();
const path = route.path.replace(/\/$/, "");
const { data: article } = await useAsyncData(`research:${path}`, () =>
  queryCollection("research").path(path).first(),
);

if (!article.value) {
  throw createError({ statusCode: 404, statusMessage: "Research article not found" });
}

useSeoMeta({
  title: () => `${article.value?.title} | Thalex Research`,
  description: () => article.value?.description,
  ogTitle: () => article.value?.title,
  ogDescription: () => article.value?.description,
  ogType: "article",
});

const sections = computed(() => article.value?.body.toc?.links || []);
</script>

<template>
  <article v-if="article" class="research-article">
    <header class="research-heading">
      <NuxtLink to="/research/" class="text-sm text-neutral-400 hover:text-white">← All research</NuxtLink>
      <p class="section-eyebrow mt-8">{{ article.category || 'Research' }}</p>
      <h1 class="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{{ article.title }}</h1>
      <div class="mt-6 flex flex-wrap gap-2">
        <span v-for="tag in article.tags" :key="tag" class="research-tag">{{ tag }}</span>
      </div>
    </header>
    <div class="research-layout">
      <aside v-if="sections.length" class="research-contents" aria-label="Article contents">
        <details class="research-contents-mobile">
          <summary>On this page</summary>
          <nav aria-label="Article sections">
            <a v-for="section in sections" :key="section.id" :href="`#${section.id}`">{{ section.text }}</a>
          </nav>
        </details>
        <nav class="research-contents-desktop" aria-label="Article sections">
          <p class="section-eyebrow mb-4">On this page</p>
          <a v-for="section in sections" :key="section.id" :href="`#${section.id}`">{{ section.text }}</a>
        </nav>
      </aside>
      <ContentRenderer :value="article" :prose="false" class="research-prose" />
    </div>
  </article>
</template>
