import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  se: process.env.VITE_BASE_PATH || "/","
plugins: [vue()],
});
