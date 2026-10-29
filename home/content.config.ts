import {defineContentConfig, defineCollection} from '@nuxt/content';
import { z } from 'zod'
import {resolve} from "path";

export default defineContentConfig({
  collections: {
    research: defineCollection({
      type: 'page',
      source: 'research/**/*.md',
      schema: z.object({
        date: z.string(),
        category: z.string().optional(),
        image: z.string().optional(),
        tags: z.array(z.string()).default([]),
      }),
    }),
    apps: defineCollection({
      type: 'page',
      source: {
        cwd: resolve("../apps"),
        include: '**/index.yml',
        exclude: [
          '**/node_modules/**',
          '**/dist/**',
          '**/.vite/**',
        ],
      },
      schema: z.object({
        image: z.string().optional(),
      })
    })
  }
})
