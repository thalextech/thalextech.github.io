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

  let nextDatums = Array.isArray(selectedDatums) ? selectedDatums : [];
  let nextRange = selectedRange || null;

  const isValid =
    nextDatums.length === 2 && nextDatums.every((d) => data.includes(d));
  if (isValid) {
    return { selectedDatums: nextDatums, selectedRange: nextRange };
  }

  if (!nextRange) {
    if (nextDatums.length) {
      nextDatums = nextDatums.filter((datum) => data.includes(datum));
      nextRange = updateSelectedRange(nextDatums, getTs);
    }
    return { selectedDatums: nextDatums, selectedRange: nextRange };
  }

  if (data.length >= 2) {
    const dataMinTs = getTs(data[0]);
    const dataMaxTs = getTs(data[data.length - 1]);
    if (
      Number.isFinite(dataMinTs) &&
      Number.isFinite(dataMaxTs) &&
      (nextRange.from < dataMinTs || nextRange.to > dataMaxTs)
    ) {
      nextDatums = [data[0], data[data.length - 1]];
      nextRange = updateSelectedRange(nextDatums, getTs);
      return { selectedDatums: nextDatums, selectedRange: nextRange };
    }
  }

  const first = findClosestDatumByTs(data, nextRange.from, getTs);
  let second = findClosestDatumByTs(data, nextRange.to, getTs);
  if (first && second && first === second) {
    second = findClosestDatumByTs(
      data.filter((datum) => datum !== first),
      nextRange.to,
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
