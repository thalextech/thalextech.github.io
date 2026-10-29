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
  css: ['katex/dist/katex.min.css', '~/assets/css/main.css'],
  content: {
    build: {
      markdown: {
        remarkPlugins: {
          'remark-math': { options: { singleDollarTextMath: false } },
        },
        rehypePlugins: {
          'rehype-katex': {},
        },
      },
    },
  },
  nitro: {
    prerender: {
      routes: ["/", "/research/"],
      crawlLinks: true,
      // Second-screen apps are built separately by build_apps.sh.
      ignore: [(route) => !(
        ["/", "/200.html", "/404.html", "/_payload.json"].includes(route)
        || route === "/research"
        || route.startsWith("/research/")
        || route.startsWith("/__nuxt_content/")
      )],
    }
  }
})
