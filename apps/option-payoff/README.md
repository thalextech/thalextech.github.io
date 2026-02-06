# Option Profit Diagram

Visualize the profit profile of one or more selected options at different spot price levels.

## Features

- **Select multiple options**: Choose from currently tradable options (BTCUSD or ETHUSD)
- **Filter by expiry and type**: Filter options by expiration date and call/put type
- **Custom spot range**: Optionally set custom min/max spot prices for the chart
- **Real-time mark prices**: Uses current option mark prices for accurate profit calculation
- **Profit visualization**: 
  - X-axis: Spot price (underlying price)
  - Y-axis: Profit (profit/loss)
  - Shows individual option profit lines
- **Current price indicator**: Vertical dashed line shows current index price

## How it works

1. Select an index (BTCUSD or ETHUSD)
2. Optionally filter by expiry date and/or option type (call/put)
3. Browse available options grouped by expiry date
4. Click on options to add them to your selection
5. Optionally set a custom spot price range for the chart
6. The chart displays:
   - Individual profit lines for each selected option (colored)
   - Zero profit reference line (horizontal dashed)
   - Current spot price indicator (vertical dashed)

## Profit Calculation

For each option (assumed long position):
- **Call**: `max(0, spot - strike) - premium`
- **Put**: `max(0, strike - spot) - premium`

The premium is the current mark price of the option fetched from Thalex API.
