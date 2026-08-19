export const UNDERLYING_OPTIONS = Object.freeze([
  Object.freeze({ value: "BTC", label: "BTC", dataRoot: "data/thalex" }),
  Object.freeze({ value: "ETH", label: "ETH", dataRoot: "data/thalex/eth" }),
]);

export const getUnderlying = (value) =>
  UNDERLYING_OPTIONS.find((option) => option.value === value) ||
  UNDERLYING_OPTIONS[0];
