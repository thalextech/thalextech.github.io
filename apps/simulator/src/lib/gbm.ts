export type GBMParams = {
  s0: number;
  mu: number;
  vol: number;
  T: number;
  dt: number;
  rows: number;
};

export type GBMSim = {
  paths: Float64Array[];
  finalPrices: Float64Array;
  steps: number;
};

type Rng = () => number;
type Randn = () => number;

const mulberry32 = (seed: number): Rng => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const makeRandn = (rng: Rng): Randn => {
  let spare: number | null = null;

  return () => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }

    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();

    const magnitude = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };
};

export const generateGBM = (params: GBMParams, seed = 1): GBMSim => {
  const steps = Math.max(1, Math.floor(params.T / params.dt));
  const paths: Float64Array[] = new Array(params.rows);
  const finalPrices = new Float64Array(params.rows);

  const drift = (params.mu - 0.5 * params.vol * params.vol) * params.dt;
  const volStep = params.vol * Math.sqrt(params.dt);
  const rng = mulberry32(seed);
  const randn = makeRandn(rng);

  for (let r = 0; r < params.rows; r += 1) {
    const path = new Float64Array(steps);
    let s = params.s0;
    for (let c = 0; c < steps; c += 1) {
      const z = randn();
      s *= Math.exp(drift + volStep * z);
      path[c] = s;
    }
    paths[r] = path;
    finalPrices[r] = s;
  }

  return { paths, finalPrices, steps };
};
