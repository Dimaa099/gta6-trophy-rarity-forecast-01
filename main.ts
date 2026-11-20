// gta6-trophy-rarity-forecast-01: a principled per-trophy forecaster (Node 22, standard library only).
//
// What the program forecasts: for each of GTA VI's 55 PlayStation 5 trophies, five quantiles of its
// earn rate on Exophase at the case's target, from the house's reads of the trophy page before the
// case's checkpoint. Score is mean pinball loss on the logit scale; a prize needs a loss strictly
// below the best house entry (persistence, a fitted-curve baseline, and a house model forecast).
//
// The model, per trophy:
//   1. Work on the logit scale, logit(p) = ln(p / (100 - p)) with the rate p in percent, clamped to
//      [0.01, 99.99] exactly as the scorer clamps. The logit scale is the scored scale, so a miss
//      from 1% to 2% costs about what a miss from 33% to 50% does, and rare trophies count as much
//      as common ones.
//   2. Fit, by least squares, logit(rate) = a + b * ln(1 + hours since release) over the case's
//      reads (last 48 hours of them; the final's history is only ~60 hours, the practice's ~3).
//      Log-time is the natural clock for a launch: players pour in and progress fast at first,
//      then the curve bends over, so a line in log-time extrapolates far more sanely than a line
//      in raw time. The house curve baseline fits the same line over the last 24 hours; this one
//      uses more history and pools the slope across trophies of the same tier (below).
//   3. Shrink the fitted slope toward the tier's median slope, with the weight set by how much
//      log-time the trophy's reads actually span: a trophy whose reads span the whole history
//      keeps its own slope; a trophy with only a few hours of flat reads (the practice cases)
//      borrows the tier's. This keeps flat launch-night series from pretending they know a slope,
//      and keeps a genuinely flat trophy (a late-game trophy nobody has reached) flat.
//      Slopes are clamped to [-0.5, 3]: a week-one trophy's log-time slope lives in that band,
//      and the clamp stops a noisy short series from exploding the forecast.
//   4. The median at the target is the shrunk line read at ln(1 + hours to target), through the
//      data's centroid, clamped to [0.01, 99.9].
//   5. The spread (logit sigma) is honest, built from four parts that add in quadrature:
//      - the random-walk term the house baseline uses, 0.5 * sqrt(horizon in days);
//      - the fit's residual standard deviation (how wobbly this trophy's reads were);
//      - the slope's standard error times the leverage to the target (how far the line is
//        extrapolated past the data);
//      - a fixed 0.35 refresh allowance: Exophase refreshes its counts on its own schedule, and
//        a refresh dilutes every rate at once (launch night's first refresh took the average rate
//        down ~25%, about 0.3-0.45 logit, worse for rare trophies). The answer is the rate as of
//        Exophase's last refresh before the target, so one refresh worth of dilution is always
//        in play. Sigma is floored at 0.35 and capped at 2.5.
//   6. Quantiles are the median's logit plus z_tau * sigma at the standard normal's quantiles,
//      mapped back to percent and rounded to 4 decimals.
//
// Two things this deliberately does NOT do:
//   - It does not chase the practice cases' refresh: their histories are perfectly flat, so any
//     fitted line is flat and the median is the last rate. The practice rewards a wide-enough
//     spread to cover the refresh dip, which the refresh allowance provides; biasing the median
//     down for a 90-minute practice horizon would be the wrong forecast for the final's 4.5-day
//     horizon, where four days of story progression dominate one refresh.
//   - It does not model players-tracked or earners separately: with two days of data the
//     rate's own log-time line is the most robust summary, and the spread carries the dilution
//     risk instead of pretending the refresh schedule is known.
//
// Edge cases: a trophy at 100% in the last read stays ~100% (nobody un-earns a trophy); a
// trophy with no usable read falls back to its tier's median rate and slope with a wide spread;
// a printed 0.00% read is censored, not a level, and carries no fitting information;
// an empty history falls back to a 1% median with a wide spread. The program is deterministic
// (pure arithmetic, no randomness) and fast (55 trophies, a few hundred reads).
//
// Run locally: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The spread of a rate's move, in logit units per square-root day (the house baseline's). */
const RW_SIGMA = 0.5;
/** One Exophase refresh's dilution, in logit units (launch night's first refresh: ~0.3-0.45). */
const REFRESH_SIGMA = 0.35;
/** Floor and cap for the total logit spread. */
const SIGMA_MIN = 0.35;
const SIGMA_MAX = 2.5;
/** How many hours of reads the fit uses (the final's history is ~60h; the practice's ~3h). */
const FIT_WINDOW_HOURS = 48;
/** Slope clamp, in logit per unit of ln(1 + hours). */
const SLOPE_MIN = -0.5;
const SLOPE_MAX = 3.0;
/** GTA VI's release: 2026-11-19T00:00:00Z, the clock the log-time line runs on. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');

interface Trophy {
  id: number;
  tier: string;
}
interface Read {
  at: string;
  rates: Array<number | null>;
}
interface Case {
  levels: number[];
  horizon_minutes: number;
  at: string;
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Hours from release to an ISO timestamp, floored so ln(1 + h) stays defined. */
const hoursSinceRelease = (iso: string): number =>
  Math.max(-0.99, (Date.parse(iso) - RELEASE_MS) / 3_600_000);
/** Median of a non-empty number array. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Fit {
  /** Intercept and slope of the shrunk logit line. */
  a: number;
  b: number;
  /** Mean log-time of the reads used, and sum of squared deviations (for the slope's SE). */
  xbar: number;
  sxx: number;
  /** Residual standard deviation around the shrunk line. */
  resid: number;
  /** Number of reads used. */
  n: number;
}

/** Least-squares line of logit(rate) on ln(1 + hours), with tier-slope shrinkage. */
function fitTrophy(
  points: Array<{ x: number; y: number }>,
  tierSlope: number,
): Fit | null {
  const n = points.length;
  if (n === 0) return null;
  const xbar = points.reduce((s, p) => s + p.x, 0) / n;
  const ybar = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - xbar) * (p.x - xbar);
    sxy += (p.x - xbar) * (p.y - ybar);
  }
  // No time spread (all reads at one moment, or a single read): flat at the mean rate.
  if (sxx < 1e-9) return { a: ybar, b: 0, xbar, sxx, resid: 0, n };
  const bRaw = sxy / sxx;
  // Weight by how much log-time the reads span: a 3-hour flat practice history borrows
  // the tier's slope almost entirely; a 60-hour final history keeps its own.
  const w = sxx / (sxx + 0.5);
  const b = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, w * bRaw + (1 - w) * tierSlope));
  // Refit the intercept through the centroid at the shrunk slope.
  const a = ybar - b * xbar;
  let ss = 0;
  for (const p of points) ss += (p.y - (a + b * p.x)) ** 2;
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { a, b, xbar, sxx, resid, n };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const horizonDays = c.horizon_minutes / 1440;
  const checkpointMs = Date.parse(c.at);
  const xTarget = Math.log(1 + Math.max(-0.99, (Date.parse(c.at) + c.horizon_minutes * 60_000 - RELEASE_MS) / 3_600_000));
  const rw = RW_SIGMA * Math.sqrt(horizonDays);

  // First pass: raw per-trophy slopes, to get each tier's median slope.
  const rawSlopesByTier = new Map<string, number[]>();
  const series: Array<Array<{ x: number; y: number }>> = c.trophies.map((_, i) => {
    const pts: Array<{ x: number; y: number }> = [];
    for (const h of c.history) {
      if (checkpointMs - Date.parse(h.at) > FIT_WINDOW_HOURS * 3_600_000) continue;
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      // A printed 0.00% is censored ("fewer than 1 in 20,000 players"), not a level:
      // the scorer's 0.01 clamp would read it as logit -9.21 and wreck the line, so a
      // 0 read carries no fitting information. (No 0.00% appears in the practice cases.)
      if (r === 0) continue;
      pts.push({ x: Math.log(1 + hoursSinceRelease(h.at)), y: logit(r) });
    }
    return pts;
  });
  c.trophies.forEach((t, i) => {
    const pts = series[i];
    if (pts.length < 2) return;
    const xbar = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const ybar = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.x - xbar) * (p.x - xbar);
      sxy += (p.x - xbar) * (p.y - ybar);
    }
    if (sxx < 1e-9) return;
    const b = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, sxy / sxx));
    const arr = rawSlopesByTier.get(t.tier) ?? [];
    arr.push(b);
    rawSlopesByTier.set(t.tier, arr);
  });
  const allRaw = [...rawSlopesByTier.values()].flat();
  const tierSlope = new Map<string, number>();
  for (const [tier, bs] of rawSlopesByTier) tierSlope.set(tier, median(bs));
  const globalSlope = allRaw.length > 0 ? median(allRaw) : 0;

  // Tier median of last rates, for trophies with no usable read.
  const lastRates = c.trophies.map((_, i) => {
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (r !== null && r !== undefined) return r;
    }
    return null;
  });
  const tierLastRate = new Map<string, number>();
  const byTier = new Map<string, number[]>();
  c.trophies.forEach((t, i) => {
    if (lastRates[i] === null) return;
    const arr = byTier.get(t.tier) ?? [];
    arr.push(lastRates[i] as number);
    byTier.set(t.tier, arr);
  });
  for (const [tier, rs] of byTier) tierLastRate.set(tier, median(rs));
  const globalLastRate = lastRates.filter((r): r is number => r !== null);
  const fallbackRate = globalLastRate.length > 0 ? median(globalLastRate) : 1;

  return c.trophies.map((t, i) => {
    const last = lastRates[i];
    // A trophy everyone already holds stays ~100%: nobody un-earns a trophy.
    if (last !== null && last >= 99.99) {
      return { id: t.id, q: [99.9, 99.95, 99.99, 99.995, 100] };
    }
    const slope = tierSlope.get(t.tier) ?? globalSlope;
    const fit = fitTrophy(series[i], slope);
    let mLogit: number;
    let sigma: number;
    if (fit === null) {
      // No usable read for this trophy: tier median rate, tier slope, wide spread.
      mLogit = logit(tierLastRate.get(t.tier) ?? fallbackRate);
      sigma = SIGMA_MAX;
    } else {
      mLogit = fit.a + fit.b * xTarget;
      const seB = fit.sxx > 1e-9 && fit.n > 2 ? fit.resid / Math.sqrt(fit.sxx) : 0.3;
      const slopeUnc = Math.min(1, seB * Math.abs(xTarget - fit.xbar));
      sigma = Math.sqrt(rw * rw + fit.resid * fit.resid + slopeUnc * slopeUnc + REFRESH_SIGMA * REFRESH_SIGMA);
      sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sigma));
    }
    mLogit = Math.min(logit(99.9), Math.max(logit(0.01), mLogit));
    const q = Z.map((z) => round4(Math.min(100, Math.max(0.01, invLogitPct(mLogit + z * sigma)))));
    // Guard the ordering against rounding (equal values are fine).
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
