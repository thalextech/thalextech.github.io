import * as d3 from "d3";

const numericOrNegativeInfinity = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NEGATIVE_INFINITY;
};

export function sweepDistributionSortValue(row, sortBy) {
  if (sortBy === "sharpe") return numericOrNegativeInfinity(row.sharpe);
  if (sortBy === "median") {
    return row.weeks?.length
      ? numericOrNegativeInfinity(d3.median(row.weeks))
      : Number.NEGATIVE_INFINITY;
  }
  return numericOrNegativeInfinity(row.total);
}

export function orderSweepDistributionRows(
  rows,
  { view = "clock", sortBy = "total", dimension = "entry_hour" } = {},
) {
  const sourceOrder = new Map(rows.map((row, index) => [row.key, index]));
  const ranked = [...rows].sort((first, second) =>
    sweepDistributionSortValue(second, sortBy)
      - sweepDistributionSortValue(first, sortBy)
      || sourceOrder.get(first.key) - sourceOrder.get(second.key)
  );
  const rankByKey = new Map(ranked.map((row, index) => [row.key, index + 1]));
  const sequenceValue = (row) => {
    const configuredValue = dimension === "entry_hour"
      ? Number(row.config?.entryHourUtc)
      : dimension === "entry_weekday"
        ? Number(row.config?.entryWeekday)
        : Number.NaN;
    return Number.isFinite(configuredValue)
      ? configuredValue
      : sourceOrder.get(row.key);
  };
  const ordered = view === "ranked"
    ? ranked
    : [...rows].sort((first, second) => {
        const firstSequence = sequenceValue(first);
        const secondSequence = sequenceValue(second);
        return firstSequence - secondSequence;
      });

  return ordered.map((row) => ({
    ...row,
    distributionRank: rankByKey.get(row.key),
  }));
}

export function calendarWeekKey(value, fallback = "") {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}
