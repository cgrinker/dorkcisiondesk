/**
 * Small statistical toolkit. No dependencies — everything runs inside the
 * Worker isolate. All random draws go through a seeded PRNG so a model run
 * is reproducible given its run id.
 */

/** mulberry32 — fast seeded PRNG, plenty good for Monte Carlo. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Standard normal via Box-Muller. */
export function normal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Student-t draw with `df` degrees of freedom, scaled so its standard
 * deviation equals `sd`. Fat tails are the point: polling errors are not
 * Gaussian, and t(5) is the classic Silver-model choice.
 */
export function studentT(rng: () => number, df: number, sd = 1): number {
  const z = normal(rng);
  let chi2 = 0;
  for (let i = 0; i < df; i++) {
    const n = normal(rng);
    chi2 += n * n;
  }
  const t = z / Math.sqrt(chi2 / df);
  // Var of t(df) is df/(df-2); rescale so the draw has sd = `sd`.
  return (t * sd) / Math.sqrt(df / (df - 2));
}

/** Abramowitz & Stegun approximation of the standard normal CDF. */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export interface WeightedPoint {
  value: number;
  weight: number;
}

export function weightedMean(points: WeightedPoint[]): number {
  let sw = 0;
  let sv = 0;
  for (const p of points) {
    sw += p.weight;
    sv += p.value * p.weight;
  }
  return sw > 0 ? sv / sw : NaN;
}

/** Sum of weights — used as an "effective evidence" measure for blending. */
export function totalWeight(points: WeightedPoint[]): number {
  return points.reduce((s, p) => s + p.weight, 0);
}
