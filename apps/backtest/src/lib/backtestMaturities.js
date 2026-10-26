export const MATURITY_OPTIONS = [
  { value: 1, label: "1D", minDteDays: 0.25, maxDteDays: 1.5 },
  { value: 2, label: "2D", minDteDays: 1.5, maxDteDays: 2.5 },
  { value: 7, label: "7D", minDteDays: 4, maxDteDays: 10 },
  { value: 14, label: "14D", minDteDays: 7, maxDteDays: 28 },
  { value: 30, label: "30D", minDteDays: 14, maxDteDays: 60 },
  { value: 60, label: "60D", minDteDays: 45, maxDteDays: 75 },
  { value: 90, label: "90D", minDteDays: 75, maxDteDays: 135 },
  { value: 180, label: "180D", minDteDays: 135, maxDteDays: 240 },
];

export const CALENDAR_MATURITY_OPTIONS = [
  {
    value: "7-14",
    label: "7–14D",
    nearDays: 7,
    farDays: 14,
    minDteDays: 5,
    maxDteDays: 10,
  },
  {
    value: "7-30",
    label: "7–30D",
    nearDays: 7,
    farDays: 30,
    minDteDays: 5,
    maxDteDays: 10,
  },
  {
    value: "14-30",
    label: "14–30D",
    nearDays: 14,
    farDays: 30,
    minDteDays: 7,
    maxDteDays: 28,
  },
  {
    value: "30-60",
    label: "30–60D",
    nearDays: 30,
    farDays: 60,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "30-90",
    label: "30–90D",
    nearDays: 30,
    farDays: 90,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "30-180",
    label: "30–180D",
    nearDays: 30,
    farDays: 180,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "60-90",
    label: "60–90D",
    nearDays: 60,
    farDays: 90,
    minDteDays: 45,
    maxDteDays: 75,
  },
  {
    value: "60-180",
    label: "60–180D",
    nearDays: 60,
    farDays: 180,
    minDteDays: 45,
    maxDteDays: 75,
  },
  {
    value: "90-180",
    label: "90–180D",
    nearDays: 90,
    farDays: 180,
    minDteDays: 75,
    maxDteDays: 135,
  },
];

export const maturityConfigOverrides = (maturity) => ({
  targetDteDays: maturity.nearDays ?? maturity.value,
  farTargetDteDays: maturity.farDays,
  minWeeklyDteDays: maturity.minDteDays,
  maxWeeklyDteDays: maturity.maxDteDays,
});

