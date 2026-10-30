<script setup>
const appUrl = "https://thalextech.github.io/term-structure/";
const frameVersion = ref(0);
</script>

<template>
  <figure class="app-frame">
    <header>
      <span>Term Structure · published app</span>
      <div>
        <button type="button" @click="frameVersion++">Reload app</button>
        <a :href="appUrl" target="_blank" rel="noopener">Open full app ↗</a>
      </div>
    </header>
    <iframe
      :key="frameVersion"
      :src="appUrl"
      title="Thalex Term Structure — full interactive app"
      loading="lazy"
      allowfullscreen
    ></iframe>
    <figcaption>
      The full published app, with its own controls and live market data. Its values
      can differ from the dated figures in this article. Reload app loads the
      currently published version.
    </figcaption>
  </figure>
</template>

<style scoped>
.app-frame { margin: 2rem 0; overflow: hidden; border: 1px solid #23232a; border-radius: .85rem; background: #0a0b0e; }
header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .75rem; padding: 1rem; border-bottom: 1px solid #23232a; font-size: .75rem; line-height: 1.5; }
header > span { color: #a3a3a3; }
header > div { display: flex; align-items: center; gap: 1rem; }
button { cursor: pointer; color: #a3a3a3; }
button:hover { color: white; }
button:focus-visible { outline: 2px solid #85a5ff; outline-offset: 4px; }
header a { text-decoration: none; }
iframe { display: block; width: 100%; height: 880px; border: 0; background: #0a0b0e; }
figcaption { padding: 1rem; border-top: 1px solid #23232a; color: #858a92; font-size: .7rem; line-height: 1.6; }
</style>
