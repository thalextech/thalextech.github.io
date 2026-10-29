<script lang="ts" setup>
const { data: articles } = await useAsyncData("research-index", () =>
  queryCollection("research")
    .select("id", "path", "title", "description", "date", "category", "image", "tags")
    .order("date", "DESC")
    .all(),
);

const formatDate = (value: string) => new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
}).format(new Date(value));

useSeoMeta({
  title: "Research | Thalex Tech",
  description: "Research on crypto options, volatility and market structure.",
});
</script>

<template>
  <section aria-labelledby="research-title">
    <div class="mb-10 max-w-2xl">
      <p class="section-eyebrow">Ideas in context</p>
      <h1 id="research-title" class="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Research</h1>
      <p class="mt-4 text-lg leading-relaxed text-neutral-400">
        Exploring crypto options, volatility and the trades behind a market view.
      </p>
    </div>
    <UPageGrid v-if="articles?.length">
      <UPageCard
        v-for="article in articles"
        :key="article.id"
        :title="article.title"
        :description="article.description"
        :to="article.path"
        variant="subtle"
        :ui="{ root: 'bg-neutral-950 ring-neutral-900', container: 'lg:flex' }"
      >
        <template #header>
          <div class="flex items-center gap-3 text-xs text-neutral-400">
            <span class="text-blue-300">{{ article.category || 'Research' }}</span>
            <time :datetime="article.date">{{ formatDate(article.date) }}</time>
          </div>
        </template>
        <img
          v-if="article.image"
          :src="article.image"
          :alt="`${article.title} preview`"
          class="mt-4 aspect-video w-full rounded-lg object-cover"
          loading="lazy"
          decoding="async"
        />
        <div class="mt-3 flex flex-wrap gap-2">
          <span v-for="tag in article.tags" :key="tag" class="research-tag">{{ tag }}</span>
        </div>
        <p class="mt-5 text-sm font-medium text-blue-300" aria-hidden="true">Read research <span class="ml-1">→</span></p>
      </UPageCard>
    </UPageGrid>
    <p v-else class="rounded-xl border border-neutral-900 bg-neutral-950 p-8 text-neutral-400">
      Research articles will appear here as they are published.
    </p>
  </section>
</template>
