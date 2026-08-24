export const UNDERLYING_OPTIONS = Object.freeze([
  Object.freeze({ value: "BTC", label: "BTC", dataRoot: "runtime-data/thalex" }),
  Object.freeze({ value: "ETH", label: "ETH", dataRoot: "runtime-data/thalex/eth" }),
]);

export const getUnderlying = (value) =>
  UNDERLYING_OPTIONS.find((option) => option.value === value) ||
  UNDERLYING_OPTIONS[0];
