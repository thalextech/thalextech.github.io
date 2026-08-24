# Backtest app

## Data directories

- `source-data/thalex` contains the canonical, Git-tracked Parquet history.
- `public/runtime-data/thalex` contains generated JSON artifacts served to the browser.
- `dist/runtime-data/thalex` is disposable production-build output.

Run `npm run build:data` after adding or replacing source Parquet files. Both
`npm run dev` and `npm run build` also generate the runtime artifacts first.
