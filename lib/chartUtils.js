export const getDatumTs = (datum) => {
  const ts = datum?.ts;
  if (Number.isFinite(ts)) return ts;
  const date = datum?.date;
  return date instanceof Date ? Math.round(date.getTime() / 1000) : null;
};

export const findClosestDatumByTs = (data, targetTs, getTs = getDatumTs) => {
  if (!Number.isFinite(targetTs)) return null;
  let closest = null;
  let bestDist = Infinity;
  for (const datum of data || []) {
    const datumTs = getTs(datum);
    if (!Number.isFinite(datumTs)) continue;
    const dist = Math.abs(datumTs - targetTs);
    if (dist < bestDist) {
      bestDist = dist;
      closest = datum;
    }
  }
  return closest;
};

export const updateSelectedRange = (
  selectedDatums,
  getTs = getDatumTs,
) => {
  if (selectedDatums?.length === 2) {
    const firstTs = getTs(selectedDatums[0]);
    const secondTs = getTs(selectedDatums[1]);
    if (Number.isFinite(firstTs) && Number.isFinite(secondTs)) {
      return { from: firstTs, to: secondTs };
    }
  }
  return null;
};

export const syncSelectionWithData = ({
  data,
  selectedDatums,
  selectedRange,
  getTs = getDatumTs,
} = {}) => {
  if (!Array.isArray(data) || !data.length) {
    return {
      selectedDatums: selectedDatums || [],
      selectedRange: selectedRange || null,
    };
  }

  let nextDatums = Array.isArray(selectedDatums)
    ? selectedDatums.filter((datum) => data.includes(datum))
    : [];
  let nextRange = selectedRange || null;

  if (nextDatums.length === 2) {
    nextRange = updateSelectedRange(nextDatums, getTs);
    return { selectedDatums: nextDatums, selectedRange: nextRange };
  }

  if (!nextRange) {
    nextRange = updateSelectedRange(nextDatums, getTs);
    return { selectedDatums: nextDatums, selectedRange: nextRange };
  }

  const rangeFrom = Number(nextRange?.from);
  const rangeTo = Number(nextRange?.to);
  if (!Number.isFinite(rangeFrom) || !Number.isFinite(rangeTo)) {
    return { selectedDatums: nextDatums, selectedRange: null };
  }
  const normalizedRange = {
    from: Math.min(rangeFrom, rangeTo),
    to: Math.max(rangeFrom, rangeTo),
  };

  let dataMinTs = Number.POSITIVE_INFINITY;
  let dataMaxTs = Number.NEGATIVE_INFINITY;
  for (const datum of data) {
    const ts = getTs(datum);
    if (!Number.isFinite(ts)) continue;
    if (ts < dataMinTs) dataMinTs = ts;
    if (ts > dataMaxTs) dataMaxTs = ts;
  }

  if (
    Number.isFinite(dataMinTs) &&
    Number.isFinite(dataMaxTs) &&
    (normalizedRange.from < dataMinTs || normalizedRange.to > dataMaxTs)
  ) {
    const dataFirst = findClosestDatumByTs(data, dataMinTs, getTs);
    const dataLast = findClosestDatumByTs(data, dataMaxTs, getTs);
    if (dataFirst && dataLast) {
      nextDatums = dataFirst === dataLast ? [dataFirst] : [dataFirst, dataLast];
      nextRange = updateSelectedRange(nextDatums, getTs);
      return { selectedDatums: nextDatums, selectedRange: nextRange };
    }
  }

  const first = findClosestDatumByTs(data, normalizedRange.from, getTs);
  let second = findClosestDatumByTs(data, normalizedRange.to, getTs);
  if (first && second && first === second) {
    second = findClosestDatumByTs(
      data.filter((datum) => datum !== first),
      normalizedRange.to,
      getTs,
    );
  }

  if (first && second) {
    nextDatums = [first, second];
    nextRange = updateSelectedRange(nextDatums, getTs);
  } else {
    nextDatums = [];
    nextRange = null;
  }

  return { selectedDatums: nextDatums, selectedRange: nextRange };
};
