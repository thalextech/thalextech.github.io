import {defineContentConfig, defineCollection} from '@nuxt/content';
import { z } from 'zod'
import {resolve} from "path";

export default defineContentConfig({
  collections: {
    apps: defineCollection({
      type: 'page',
      source: {
        cwd: resolve("../apps"),
        include: '**/index.yml',
      },
      schema: z.object({
        image: z.string().optional(),
      })
    })
  }
})