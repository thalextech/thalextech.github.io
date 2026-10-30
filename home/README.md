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

### Published app frame (current article trial)

The first article now uses a frame of the full published app:

```markdown
::term-structure-app
::
```

This loads `https://thalextech.github.io/term-structure/` directly, including its
own controls and data loading. Reload app reloads the published page. The frame
has a fixed height and the full app retains its own scrolling. The source-based
chart block below remains available as an alternative for comparison.

### Source-based term structure embed

Insert the shared term structure chart between paragraphs with an MDC block:

```markdown
::research-term-structure{snapshot="btc-options-2026-10-29" focus-expiry="2026-11-06"}
::
```

Embeds now open in live mode, load fresh Thalex ATM quotes, and refresh every
60 seconds while visible. Refresh requests a new snapshot immediately. BTC/ETH
switches cancel the previous request; failed refreshes retain the last successful
curve with an error message and its timestamp. Choose Article snapshot to return
to the publication values. Use `mode="snapshot"` to open in the dated view instead.

The optional `view="forward"` opens in forward-volatility mode. `focus-expiry`
selects the initially highlighted maturity; Reset restores the author's view.
Readers can inspect curve points with a pointer or keyboard, switch IV/forward
views, toggle the historical-RV reference and save a PNG. The live app opens
separately so it does not replace the article's dated inputs.

Named snapshots live in `app/research/term-structure/*.json`. Each specifies an
asset, ISO UTC valuation time, source note, and points with ISO UTC expiry and
decimal `iv`/`rv` values. The first snapshot is transcribed from the article table,
with approximate RV and no original hourly history. The dated mode makes no market-data requests. Forward IV uses the standalone app's total-variance calculation;
forward RV is omitted because it cannot be reconstructed from that table.

`ResearchTermStructure.vue` owns the article controls and snapshot mapping. It
reuses `apps/term-structure`'s chart and forward-volatility calculation, without
importing the app screen or its global CSS. The Vite dedupe setting makes these
cross-project imports use the home project's Vue and D3 dependencies.

`npm run generate` pre-renders both collections and follows article links so that
direct article URLs work on GitHub Pages. The chart mounts in the browser; the
article's original table remains available before JavaScript loads.

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
