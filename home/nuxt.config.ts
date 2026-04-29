// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: {enabled: true},
  modules: [
    "@nuxt/ui",
    '@nuxt/content',
    '@nuxt/image',
    '@nuxt/eslint',
    '@nuxt/fonts'
  ],
  css: ['~/assets/css/main.css'],
  nitro: {
    prerender: {
      routes: ["/"],
      crawlLinks: false
    }
  }
})