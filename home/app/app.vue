<script lang="ts" setup>
const router = useRouter();
const inResearch = computed(() => router.currentRoute.value.path.startsWith("/research"));

useHead({ htmlAttrs: { class: "dark text-default bg-black" } });
</script>

<template>
  <UApp>
    <UContainer class="py-10 sm:py-20">
      <a href="#main-content" class="skip-link">Skip to content</a>
      <header class="mb-10 flex flex-wrap items-center gap-x-10 gap-y-4">
        <a
          href="https://thalex.com/"
          target="_blank"
          rel="noopener"
          aria-label="Thalex"
          class="inline-flex items-center"
        >
          <img src="/images/LOGO_THALEX_WHITE.svg" alt="Thalex" class="h-9 w-auto" />
        </a>
        <a
          href="https://thalex.com/"
          target="_blank"
          rel="noopener"
          class="text-xl text-neutral-400 hover:text-white transition-colors"
        >
          thalex.com
        </a>
      </header>
      <nav aria-label="Main navigation" class="catalogue-nav mb-10">
        <NuxtLink to="/" :aria-current="!inResearch ? 'page' : undefined" :class="{ selected: !inResearch }">
          Apps
        </NuxtLink>
        <NuxtLink to="/research/" :aria-current="inResearch ? 'page' : undefined" :class="{ selected: inResearch }">
          Research
        </NuxtLink>
      </nav>
      <main id="main-content">
        <NuxtPage />
      </main>
    </UContainer>
  </UApp>
</template>
