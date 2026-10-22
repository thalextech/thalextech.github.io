# Backtest app

## Data directories

- `source-data/thalex` contains the canonical, Git-tracked Parquet history.
- `public/runtime-data/thalex` contains generated JSON artifacts served to the browser.
- `dist/runtime-data/thalex` is disposable production-build output.

Run `npm run build:data` after adding or replacing source Parquet files. Both
`npm run dev` and `npm run build` also generate the runtime artifacts first.

## Covered call

Select **Covered call** under Instrument → Structure. Hold 1 BTC (or 1 ETH)
continuously from the first available index observation in the selected range to
the last, and sell calls against that unit using the strike-delta and roll settings.
The $100k sizing, long-option, and delta-hedging controls do not apply. Premiums
remain cash; they are not reinvested and the underlying is not resized at rolls.

Total P&L is option P&L plus final spot minus initial spot. Returns use the initial
unit's USD value. For cycle reporting, uncovered moves before a call are allocated
to that call's cycle; trailing moves after the last call belong to the last cycle.
Daily attribution records those moves on their actual timestamps. Holding-window
dates and prices are exported separately from the option entry and exit dates.
The existing hedge P&L and position fields carry the underlying exposure.

The distribution view remains a conditional benchmark of **call-active periods**,
including their underlying leg; it excludes uncovered gaps and compares observed
P&L over those same call periods. It is not a full buy-and-hold portfolio forecast.
This models cash-settled options and index-price exposure without financing,
custody, or trading costs. For other fixed-unit strategies, aggregate return also
uses the first cycle's investment, while per-cycle returns use that cycle's spot.

## Call and put spreads

Select **Call spread** or **Put spread** with **Near strike delta** and
**Wing strike delta** (default 25D / 10D, using absolute deltas for puts).
Short sells the near leg and buys the wing in equal quantities; Long reverses
both legs. Calls have a higher-strike wing; puts have a lower-strike wing.

At each entry, selection minimizes the sum of the two delta-target errors over
distinct, correctly ordered out-of-the-money strikes with the same expiry.
Ties use ascending near strike, then ascending wing strike. Entries without a
valid pair are skipped. Dollar width varies with available strikes and volatility;
sizing remains underlying notional, not spread premium or maximum loss.
The delta sweep varies the near target while holding the wing target fixed.

CLI example: `--structure call_spread --target-delta 0.25 --wing-delta 0.1`.

## Butterfly and condor

Select **Iron butterfly** or **Iron condor** under Instrument → Structure. Both use iron
structures with four same-expiry option legs. Short sells the inner options and
buys the outer wings in equal quantities; Long reverses all four legs.

- **Butterfly:** the inner call and put share the closest available ATM strike
  that has both wings. Wing strike delta selects the higher-strike call and
  lower-strike put (default 10D). An equally close ATM strike uses the lower strike.
- **Condor:** the inner put is below spot and the inner call is above spot.
  Near strike delta and Wing strike delta select each vertical spread jointly
  (default 25D / 10D), using the same deterministic matching as call/put spreads.

Entries without a complete structure are skipped. Wings need not have equal dollar
widths; deltas determine the strikes. Sizing uses underlying notional, not premium
or maximum loss. The delta sweep varies wing delta for butterflies and near delta
for condors, holding the condor wing target fixed.

CLI examples: `--structure butterfly --wing-delta 0.1` and
`--structure condor --target-delta 0.25 --wing-delta 0.1`.

## Collar

Select **Collar** to own 1 BTC (or 1 ETH), sell a call, and buy a put. The selected
absolute delta applies to both options, which share an expiry and roll together.
The collar uses the covered call's continuous underlying holding, initial-value
return basis, and gap accounting. Side, investment sizing, and delta hedging do
not apply; option premiums remain cash.

Total P&L includes both option legs and final spot minus initial spot. The
distribution view includes the underlying during option-active periods only and
excludes uncovered holding gaps, as it does for covered calls.

CLI example: `--structure collar --target-delta 0.25`.
