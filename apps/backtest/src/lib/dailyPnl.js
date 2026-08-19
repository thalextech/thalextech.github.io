const DAY_SECONDS = 86_400;

const utcDayTs = (value) => {
  const timestamp = value instanceof Date
    ? value.getTime() / 1_000
    : Number(value);
  return Number.isFinite(timestamp)
    ? Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS
    : Number.NaN;
};

export const buildDailyPnlRows = ({ rows = [], start, end } = {}) => {
  const timeline = rows
    .map((row) => ({
      ts: Number(row?.ts),
      cumulativePnlUsd: Number(row?.cumulativeTotalPnlUsd),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.ts) && Number.isFinite(row.cumulativePnlUsd),
    )
    .sort((first, second) => first.ts - second.ts);
  if (!timeline.length) return [];

  const firstDayTs = Number.isFinite(utcDayTs(start))
    ? utcDayTs(start)
    : utcDayTs(timeline[0].ts);
  const lastDayTs = Number.isFinite(utcDayTs(end))
    ? utcDayTs(end)
    : utcDayTs(timeline.at(-1).ts);
  if (lastDayTs < firstDayTs) return [];

  const pnlByDay = new Map();
  let previousCumulativePnlUsd = 0;
  for (const point of timeline) {
    const dayTs = utcDayTs(point.ts);
    const intervalPnlUsd = point.cumulativePnlUsd - previousCumulativePnlUsd;
    previousCumulativePnlUsd = point.cumulativePnlUsd;
    if (dayTs < firstDayTs || dayTs > lastDayTs) continue;
    pnlByDay.set(dayTs, (pnlByDay.get(dayTs) || 0) + intervalPnlUsd);
  }

  const output = [];
  let endingEquityUsd = 0;
  for (let dayTs = firstDayTs; dayTs <= lastDayTs; dayTs += DAY_SECONDS) {
    const dailyPnlUsd = pnlByDay.get(dayTs) || 0;
    endingEquityUsd += dailyPnlUsd;
    output.push({
      dayTs,
      entryTime: new Date(dayTs * 1_000),
      dailyPnlUsd,
      cyclePnlUsd: dailyPnlUsd,
      endingEquityUsd,
    });
  }
  return output;
};
