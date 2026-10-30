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
  vite: {
    define: {
      // Nuxt's BASE_URL is its asset directory, not the standalone app's base.
      'import.meta.env.VITE_THALEX_API_BASE': JSON.stringify(process.env.VITE_THALEX_API_BASE || (process.env.NODE_ENV === 'development' ? '/thalex-api' : 'https://thalex.com/api/v2/public')),
      'import.meta.env.VITE_THALEX_WS_URL': JSON.stringify(process.env.VITE_THALEX_WS_URL || (!process.env.VITE_THALEX_API_BASE ? 'wss://thalex.com/ws/api/v2' : '')),
    },
    // Research embeds reuse Vue/D3 components owned by the standalone apps.
    resolve: { dedupe: ['vue', 'd3'] },
  },
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
    devProxy: {
      '/thalex-api': { target: 'https://thalex.com/api/v2/public', changeOrigin: true },
    },
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
