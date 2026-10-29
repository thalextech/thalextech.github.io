# Thalex home

## Apps and Research

The home page (`/`) lists the second-screen apps. `/research/` lists research
articles newest first. Both views use the same header and navigation.

Add articles as Markdown files in `content/research/`. Their front matter supplies
the research card and article metadata:

```yaml
---
title: "Article title"
description: "A short description for the research card."
date: "2026-10-29"
category: "Options research"
tags: [BTC, Options]
---
```

The filename becomes the article URL, for example
`content/research/btc-options-three-trade-structures.md` becomes
`/research/btc-options-three-trade-structures`. An optional `image` field can point
to an image under `public/`.

Tables scroll horizontally on small screens. Articles use `$$expression$$` for
inline equations and `$$` on separate lines for display equations. Single-dollar
amounts remain ordinary text. Equations render at build time with KaTeX.

`npm run generate` pre-renders both collections and follows article links so that
direct article URLs work on GitHub Pages. Chart embeds are outside this initial
navigation and article-formatting change; the first article preserves its supplied
dated figures and sources.

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
