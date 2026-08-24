export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;
export const SECONDS_PER_YEAR = 365.25 * DAY_SECONDS;

const DATA_FILENAME = "prepared_iv_rv_1h.json";
const DATA_SCHEMA = "thalex-iv-rv";
const DATA_VERSION = 2;

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
  const decodeConstantMaturity = (values) => {
    if (!Array.isArray(values)) return null;
    const [
      iv,
      lowerExpiryTs,
      upperExpiryTs,
      weight,
      lowerIv,
      upperIv,
      lowerQuoteCount,
      upperQuoteCount,
    ] = values;
    return {
      iv: finite(iv),
      lowerExpiryTs: finite(lowerExpiryTs),
      upperExpiryTs: finite(upperExpiryTs),
      weight: finite(weight),
      lowerIv: finite(lowerIv),
      upperIv: finite(upperIv),
      lowerQuoteCount: finite(lowerQuoteCount),
      upperQuoteCount: finite(upperQuoteCount),
    };
  };
  return (payload.rows || []).map((values) => {
    const [ts, open, high, low, close, constantMaturity] = values;
    const constantMaturityByTenor = Object.fromEntries(tenors.map((tenor, index) => [
      tenor,
      decodeConstantMaturity(constantMaturity?.[index]),
    ]));
    return {
      ts: Number(ts),
      open: finite(open),
      high: finite(high),
      low: finite(low),
      close: finite(close),
      ivByTenor: Object.fromEntries(tenors.map((tenor) => [
        tenor,
        finite(constantMaturityByTenor[tenor]?.iv),
      ])),
      constantMaturityByTenor,
    };
  }).filter((row) => Number.isFinite(row.ts));
}

export async function loadIvRvHistory({ dataRoot = "runtime-data/thalex" } = {}) {
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
    rvTs: row.ts,
  }));
  if (alignForwardRv) {
    const shiftSeconds = Number(tenorDays) * DAY_SECONDS;
    const rvByTs = new Map(withRv.map((row) => [row.ts, row.rv]));
    withRv = withRv.map((row) => {
      const rvTs = row.ts + shiftSeconds;
      return {
        ...row,
        rv: finite(rvByTs.get(rvTs)),
        rvTs: rvByTs.has(rvTs) ? rvTs : null,
      };
    });
  }
  return resampleIvRvRows(withRv, resolutionHours)
    .filter((row) => Number.isFinite(row.iv) || Number.isFinite(row.rv))
    .map((row) => ({
      ...row,
      date: new Date(row.ts * 1000),
      ivDate: new Date(row.ts * 1000),
      rvDate: Number.isFinite(row.rvTs) ? new Date(row.rvTs * 1000) : null,
    }));
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

export function buildHourlyIvRows(rows = [], tenorDays = 7) {
  return rows.map((row) => {
    if (!Number.isFinite(row?.ts)) return null;
    const constantMaturity = row.constantMaturityByTenor?.[tenorDays] || null;
    const iv = finite(constantMaturity?.iv ?? row.ivByTenor?.[tenorDays]);
    if (!Number.isFinite(iv)) return null;
    return {
      ts: row.ts,
      date: new Date(row.ts * 1000),
      iv,
      lowerDteDays: Number.isFinite(constantMaturity?.lowerExpiryTs)
        ? (constantMaturity.lowerExpiryTs - row.ts) / DAY_SECONDS
        : null,
      upperDteDays: Number.isFinite(constantMaturity?.upperExpiryTs)
        ? (constantMaturity.upperExpiryTs - row.ts) / DAY_SECONDS
        : null,
      interpolationWeight: finite(constantMaturity?.weight),
      lowerQuoteCount: finite(constantMaturity?.lowerQuoteCount),
      upperQuoteCount: finite(constantMaturity?.upperQuoteCount),
    };
  }).filter(Boolean);
}

function buildHourlyWeekdayGroups(rows, valueKey) {
  const valuesByWeekday = new Map(WEEKDAYS.map(({ value }) => [value, []]));
  for (const row of rows) {
    const value = row?.[valueKey];
    if (!Number.isFinite(value) || !(row.date instanceof Date)) continue;
    valuesByWeekday.get(row.date.getUTCDay())?.push(value);
  }
  return WEEKDAYS.map(({ value, label }) => ({
    key: value,
    label,
    values: valuesByWeekday.get(value),
  }));
}

export function buildHourlyRvWeekdayGroups(rows = []) {
  return buildHourlyWeekdayGroups(rows, "rv");
}

export function buildHourlyIvWeekdayGroups(rows = []) {
  return buildHourlyWeekdayGroups(rows, "iv");
}

function buildWeekdayHourHeatmap(rows, valueForRow, dateForRow, metric = "average") {
  const valuesByCell = new Map();
  const observationsByCell = new Map();
  for (const row of rows) {
    const value = valueForRow(row);
    const date = dateForRow(row);
    if (!Number.isFinite(value) || !(date instanceof Date) || !Number.isFinite(date.getTime())) continue;
    const key = `${date.getUTCDay()}-${date.getUTCHours()}`;
    if (!valuesByCell.has(key)) valuesByCell.set(key, []);
    if (!observationsByCell.has(key)) observationsByCell.set(key, []);
    valuesByCell.get(key).push(value);
    observationsByCell.get(key).push(row);
  }
  return WEEKDAYS.flatMap(({ value: weekday, label }) =>
    Array.from({ length: 24 }, (_, hour) => {
      const values = valuesByCell.get(`${weekday}-${hour}`) || [];
      const sorted = values.slice().sort((a, b) => a - b);
      const mean = values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
      const median = quantileSorted(sorted, 0.5);
      return {
        key: `${weekday}-${hour}`,
        weekday,
        weekdayLabel: label,
        hour,
        values,
        observations: observationsByCell.get(`${weekday}-${hour}`) || [],
        mean,
        median,
        // `average` remains the chart's display-value contract for compatibility.
        average: metric === "median" ? median : mean,
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

export function buildHourlyRvHeatmap(
  rows = [],
  { winsorizeOutliers = false, metric = "average" } = {},
) {
  if (!winsorizeOutliers) {
    return buildWeekdayHourHeatmap(rows, (row) => row?.rv, (row) => row?.date, metric);
  }
  const values = rows.map((row) => row?.rv).filter(Number.isFinite).sort((a, b) => a - b);
  const lower = quantileSorted(values, 0.01);
  const upper = quantileSorted(values, 0.99);
  return buildWeekdayHourHeatmap(
    rows,
    (row) => Number.isFinite(row?.rv) ? Math.max(lower, Math.min(upper, row.rv)) : null,
    (row) => row?.date,
    metric,
  );
}

export function buildHourlyIvHeatmap(rows = [], { metric = "average" } = {}) {
  return buildWeekdayHourHeatmap(rows, (row) => row?.iv, (row) => row?.date, metric);
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
