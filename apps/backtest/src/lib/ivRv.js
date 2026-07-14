export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;
export const SECONDS_PER_YEAR = 365.25 * DAY_SECONDS;

const DATA_FILENAME = "prepared_iv_rv_1h.json";
const DATA_SCHEMA = "thalex-iv-rv";
const DATA_VERSION = 1;

const finite = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function decodeIvRvArtifact(payload) {
  if (payload?.schema !== DATA_SCHEMA || payload?.version !== DATA_VERSION) {
    throw new Error("Unsupported IV/RV data; rebuild the backtest artifacts");
  }

  const tenors = (payload.tenors || []).map(Number);
  return (payload.rows || []).map((values) => {
    const [ts, open, high, low, close, ...ivs] = values;
    return {
      ts: Number(ts),
      open: finite(open),
      high: finite(high),
      low: finite(low),
      close: finite(close),
      ivByTenor: Object.fromEntries(tenors.map((tenor, index) => [tenor, finite(ivs[index])])),
    };
  }).filter((row) => Number.isFinite(row.ts));
}

export async function loadIvRvHistory({ dataRoot = "data/thalex" } = {}) {
  const baseUrl = import.meta.env?.BASE_URL || "/";
  const response = await fetch(`${baseUrl}${dataRoot}/${DATA_FILENAME}`);
  if (!response.ok) throw new Error("Missing prepared IV/RV data");
  return decodeIvRvArtifact(await response.json());
}

export function addTrailingParkinsonRv(rows, tenorDays) {
  const sorted = (rows || []).slice().sort((a, b) => a.ts - b.ts);
  const windowSize = Math.max(1, Math.round(Number(tenorDays) * 24));
  const annualization = SECONDS_PER_YEAR / HOUR_SECONDS / windowSize;
  const queue = [];
  let rollingSum = 0;

  return sorted.map((row) => {
    const variance = Number.isFinite(row.high) && Number.isFinite(row.low) && row.high > 0 && row.low > 0
      ? Math.log(row.high / row.low) ** 2 / (4 * Math.log(2))
      : null;
    queue.push(variance);
    if (Number.isFinite(variance)) rollingSum += variance;
    if (queue.length > windowSize) {
      const removed = queue.shift();
      if (Number.isFinite(removed)) rollingSum -= removed;
    }
    const complete = queue.length === windowSize && queue.every(Number.isFinite);
    return { ...row, rv: complete ? Math.sqrt(rollingSum * annualization) : null };
  });
}

export function resampleIvRvRows(rows, hours = 1) {
  const seconds = Math.max(1, Number(hours) || 1) * HOUR_SECONDS;
  if (seconds === HOUR_SECONDS) return rows;
  const buckets = new Map();
  for (const row of rows || []) {
    const bucketTs = Math.floor(row.ts / seconds) * seconds;
    const previous = buckets.get(bucketTs);
    if (!previous || row.ts > previous.ts) buckets.set(bucketTs, row);
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export function buildIvRvChartRows({
  rows,
  tenorDays = 7,
  resolutionHours = 1,
  alignForwardRv = false,
} = {}) {
  let withRv = addTrailingParkinsonRv(rows, tenorDays).map((row) => ({
    ...row,
    iv: finite(row.ivByTenor?.[tenorDays]),
  }));
  if (alignForwardRv) {
    const shiftSeconds = Number(tenorDays) * DAY_SECONDS;
    const rvByTs = new Map(withRv.map((row) => [row.ts, row.rv]));
    withRv = withRv.map((row) => ({
      ...row,
      rv: finite(rvByTs.get(row.ts + shiftSeconds)),
    }));
  }
  return resampleIvRvRows(withRv, resolutionHours)
    .filter((row) => Number.isFinite(row.iv) || Number.isFinite(row.rv))
    .map((row) => ({ ...row, date: new Date(row.ts * 1000) }));
}

export function summarizeIvRvRows(rows = []) {
  const paired = rows.filter((row) => Number.isFinite(row?.iv) && Number.isFinite(row?.rv));
  if (!paired.length) return null;
  const totals = paired.reduce((sum, row) => ({
    iv: sum.iv + row.iv,
    rv: sum.rv + row.rv,
  }), { iv: 0, rv: 0 });
  const averageIv = totals.iv / paired.length;
  const averageRv = totals.rv / paired.length;
  return {
    averageIv,
    averageRv,
    difference: averageIv - averageRv,
    count: paired.length,
  };
}

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export function buildHourlyParkinsonRows(rows = []) {
  const annualization = SECONDS_PER_YEAR / HOUR_SECONDS;
  return rows.filter((row) =>
    Number.isFinite(row?.ts) &&
    Number.isFinite(row?.high) &&
    Number.isFinite(row?.low) &&
    row.high > 0 &&
    row.low > 0
  ).map((row) => {
    const variance = Math.log(row.high / row.low) ** 2 / (4 * Math.log(2));
    return {
      ts: row.ts,
      date: new Date(row.ts * 1000),
      rv: Math.sqrt(variance * annualization),
    };
  });
}

export function buildHourlyRvWeekdayGroups(rows = []) {
  const valuesByWeekday = new Map(WEEKDAYS.map(({ value }) => [value, []]));
  for (const row of rows) {
    if (!Number.isFinite(row?.rv) || !(row.date instanceof Date)) continue;
    valuesByWeekday.get(row.date.getUTCDay())?.push(row.rv);
  }
  return WEEKDAYS.map(({ value, label }) => ({
    key: value,
    label,
    values: valuesByWeekday.get(value),
  }));
}

function buildWeekdayHourHeatmap(rows, valueForRow, dateForRow) {
  const valuesByCell = new Map();
  for (const row of rows) {
    const value = valueForRow(row);
    const date = dateForRow(row);
    if (!Number.isFinite(value) || !(date instanceof Date) || !Number.isFinite(date.getTime())) continue;
    const key = `${date.getUTCDay()}-${date.getUTCHours()}`;
    if (!valuesByCell.has(key)) valuesByCell.set(key, []);
    valuesByCell.get(key).push(value);
  }
  return WEEKDAYS.flatMap(({ value: weekday, label }) =>
    Array.from({ length: 24 }, (_, hour) => {
      const values = valuesByCell.get(`${weekday}-${hour}`) || [];
      return {
        key: `${weekday}-${hour}`,
        weekday,
        weekdayLabel: label,
        hour,
        values,
        average: values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null,
      };
    }),
  );
}

function quantileSorted(values, probability) {
  if (!values.length) return null;
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const weight = index - lower;
  return values[lower] + (values[Math.min(lower + 1, values.length - 1)] - values[lower]) * weight;
}

export function buildHourlyRvHeatmap(rows = [], { winsorizeOutliers = false } = {}) {
  if (!winsorizeOutliers) {
    return buildWeekdayHourHeatmap(rows, (row) => row?.rv, (row) => row?.date);
  }
  const values = rows.map((row) => row?.rv).filter(Number.isFinite).sort((a, b) => a - b);
  const lower = quantileSorted(values, 0.01);
  const upper = quantileSorted(values, 0.99);
  return buildWeekdayHourHeatmap(
    rows,
    (row) => Number.isFinite(row?.rv) ? Math.max(lower, Math.min(upper, row.rv)) : null,
    (row) => row?.date,
  );
}

export function buildHourlyReturnHeatmap(rows = []) {
  return buildWeekdayHourHeatmap(
    rows,
    (row) => (
      Number.isFinite(row?.open) && Number.isFinite(row?.close) && row.open > 0 && row.close > 0
        ? row.close / row.open - 1
        : null
    ),
    (row) => Number.isFinite(row?.ts) ? new Date(row.ts * 1000) : null,
  );
}

export function summarizeRvWeekdayGroups(groups = []) {
  const ranked = groups.map((group) => {
    const values = (group.values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return { ...group, values, median };
  }).filter(Boolean);
  const values = ranked.flatMap((group) => group.values);
  if (!values.length) return null;
  const byMedian = ranked.slice().sort((a, b) => a.median - b.median);
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    lowest: byMedian[0],
    highest: byMedian.at(-1),
    count: values.length,
  };
}
