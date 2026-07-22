export const mean = (values) => {
  if (!values.length) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const sampleStdDev = (values) => {
  if (values.length < 2) return Number.NaN;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
};

export const varianceContribution = (componentValues, totalValues) => {
  const pairs = componentValues
    .map((component, index) => [Number(component), Number(totalValues[index])])
    .filter(([component, total]) => Number.isFinite(component) && Number.isFinite(total));
  if (pairs.length < 2) return Number.NaN;
  const componentMean = mean(pairs.map(([component]) => component));
  const totalMean = mean(pairs.map(([, total]) => total));
  let covarianceNumerator = 0;
  let varianceNumerator = 0;
  for (const [component, total] of pairs) {
    covarianceNumerator += (component - componentMean) * (total - totalMean);
    varianceNumerator += (total - totalMean) ** 2;
  }
  return varianceNumerator > 1e-12
    ? covarianceNumerator / varianceNumerator
    : Number.NaN;
};

export const normCdf = (value) =>
  0.5 * (1 + erf(Number(value) / Math.SQRT2));

const erf = (x) => {
  const sign = Math.sign(x) || 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-abs * abs));
  return sign * y;
};
