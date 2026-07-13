const DEFAULT_DATA_ROOT = "data/thalex";
const preparedFilename = (hour) =>
  `prepared_1h_h${String(hour).padStart(2, "0")}utc.json`;

const asNumber = (v) => (typeof v === "bigint" ? Number(v) : Number.isFinite(Number(v)) ? Number(v) : NaN);

export async function loadThalexHistory({
  start,
  end,
  hourlyOffset = 8,
  hourlyOffsets,
  dataRoot = DEFAULT_DATA_ROOT,
  onProgress,
}) {
  const hours = [...new Set((hourlyOffsets || [hourlyOffset]).map(Number))].sort((a, b) => a - b);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  const indexRows = [];
  const markRows = [];

  for (const [i, h] of hours.entries()) {
    onProgress?.({ phase: "prepared", current: i + 1, total: hours.length, file: `h${h}` });
    const res = await fetch(`${import.meta.env.BASE_URL}${dataRoot}/${preparedFilename(h)}`);
    if (!res.ok) throw new Error(`Missing prepared data for hour ${h}`);
    const p = await res.json();
    for (const [ts, price] of p.index || []) {
      const t = asNumber(ts);
      if (t >= startTs && t <= endTs) indexRows.push({ ts: t, indexPrice: asNumber(price) });
    }
    for (const [ts, name, mp, iv] of p.marks || []) {
      const t = asNumber(ts);
      if (t >= startTs && t <= endTs) markRows.push({ ts: t, instrumentName: String(name || ""), markPrice: asNumber(mp), iv: asNumber(iv) });
    }
  }
  return { indexRows, markRows };
}
