import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [vue()],
  server: {
    proxy: {
      "/api/bitfinex": {
        target: "https://api-pub.bitfinex.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bitfinex/, ""),
      },
    },
  },
});
