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
