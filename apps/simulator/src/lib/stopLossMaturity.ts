import type { AtmOptionExpiryQuote } from "./atmOptionChain";

const SECONDS_PER_DAY = 24 * 60 * 60;

export type StopLossDirection = "up" | "down";

export type MaturityOption = {
  label: string;
  value: number;
};

export const selectableExpiryQuotes = (
  expiryQuotes: AtmOptionExpiryQuote[],
  valuationTs: number,
  horizonDays: number,
  direction: StopLossDirection,
): AtmOptionExpiryQuote[] => {
  const minimumExpiry = valuationTs + horizonDays * SECONDS_PER_DAY;
  return expiryQuotes
    .filter(
      (quote) =>
        quote.expirationTs >= minimumExpiry &&
        (direction === "up" || quote.putInstrumentName != null),
    )
    .sort((first, second) => first.expirationTs - second.expirationTs);
};

export const maturityOptionsForQuotes = (
  quotes: AtmOptionExpiryQuote[],
  valuationTs: number,
): MaturityOption[] =>
  quotes.map((quote) => ({
    label: `${Math.max(
      1,
      Math.ceil((quote.expirationTs - valuationTs) / SECONDS_PER_DAY),
    )}d`,
    value: quote.expirationTs,
  }));

export const closestExpirationTs = (
  quotes: AtmOptionExpiryQuote[],
  targetExpirationTs: number,
): number | null => {
  if (!quotes.length) return null;
  return quotes.reduce((closest, quote) =>
    Math.abs(quote.expirationTs - targetExpirationTs) <
    Math.abs(closest.expirationTs - targetExpirationTs)
      ? quote
      : closest,
  ).expirationTs;
};
