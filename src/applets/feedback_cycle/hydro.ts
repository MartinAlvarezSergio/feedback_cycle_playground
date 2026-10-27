import { createRng, gaussian, nextRandom, poisson, Rng } from "../../core/seededRng";
import { fft2d } from "./fft";

/**
 * A 2D patch of a galactic gas disk (periodic, 2 × 1 kpc on a 128 × 64 grid) with:
 * - compressible gas dynamics (second-order finite volume, Rusanov fluxes, RK2 in time);
 * - self-gravity of a thin disk (FFT Poisson solve, softened by the disk thickness);
 * - radiative cooling towards a warm floor (denser gas cools faster);
 * - star formation in dense, cool gas at ρ̇* = ε_ff ρ / t_ff, so Σ̇* ∝ Σ^1.5 (the Kennicutt–Schmidt law);
 * - star clusters whose massive stars explode as supernovae 3–40 Myr after birth, each injecting
 *   heat and outward momentum into the surrounding gas (negative feedback).
 *
 * Units: parsec, km/s, solar mass; the time unit pc/(km/s) is 0.978 Myr. The public API speaks Myr.
 */

export const NX = 128;
export const NY = 64;
export const N = NX * NY;
export const BOX_X = 2000;
export const BOX_Y = 1000;
export const DX = BOX_X / NX;
const AREA = DX * DX;
const GAMMA = 5 / 3;
const G = 4.30091e-3;
const MYR = 1 / 0.9778;
/** Temperature [K] per sound speed squared [(km/s)²] for ionised gas (μ ≈ 0.6). */
export const K_PER_C2 = 43.6;

export const PARAMS = {
  sigma0: 22,
  cFloor: 5,
  turbulence: 7,
  perturbation: 0.25,
  /** Disk scale height (pc): sets ρ = Σ / 2h for the free-fall time and softens gravity. */
  scaleHeight: 50,
  /** Star formation efficiency per free-fall time (observed: ~1–3%). */
  epsFF: 0.02,
  sigmaSF: 60,
  tempSF: 1e4,
  clusterMass: 1e4,
  snPerMsun: 1 / 100,
  snDelayMin: 3,
  snDelayMax: 40,
  /** Energy per supernova (10⁵¹ erg in M☉ (km/s)²) and its share kept as heat. */
  eSN: 5.03e7,
  thermalShare: 0.35,
  /** Terminal momentum per supernova (M☉ km/s). */
  pSN: 3e5,
  coolTime: 1.5,
  /** Early feedback (winds, radiation) before the first supernova, as a share of the SN momentum budget. */
  earlyShare: 0.6,
  tMax: 2e6,
  vMax: 250,
  sigmaFloor: 0.05
};

export type Cluster = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  born: number;
  snLeft: number;
};

export type SnEvent = { x: number; y: number; t: number };

export type Run = {
  t: number;
  feedback: number;
  rng: Rng;
  r: Float64Array;
  mx: Float64Array;
  my: Float64Array;
  e: Float64Array;
  gx: Float64Array;
  gy: Float64Array;
  reservoir: Float64Array;
  clusters: Cluster[];
  nextId: number;
  /** Supernovae in the last ~1.5 Myr, for the flashes. */
  sn: SnEvent[];
  /** Stellar mass formed per 1-Myr bin since t = 0. */
  sfrBins: number[];
  /** Per region (8 × 4 regions of 250 pc) and 1-Myr bin: mass formed in the last 10 bins (ring). */
  regionBins: Float64Array;
  snCount: number;
};

export const REGIONS_X = 8;
export const REGIONS_Y = 4;
const REGION_BINS = 10;

const idx = (i: number, j: number): number => ((j + NY) % NY) * NX + ((i + NX) % NX);

/** Neighbour indices (periodic), precomputed for the inner loops. */
const XM = new Int32Array(N);
const XP = new Int32Array(N);
const YM = new Int32Array(N);
const YP = new Int32Array(N);
for (let j = 0; j < NY; j += 1) {
  for (let i = 0; i < NX; i += 1) {
    const n = j * NX + i;
    XM[n] = idx(i - 1, j);
    XP[n] = idx(i + 1, j);
    YM[n] = idx(i, j - 1);
    YP[n] = idx(i, j + 1);
  }
}

// ---------- Construction ----------

/** Random field with power between `kMin` and `kMax` (wavenumbers in rad/pc), unit variance. */
function randomField(rng: Rng, kMin: number, kMax: number): Float64Array {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let j = 0; j < NY; j += 1) {
    for (let i = 0; i < NX; i += 1) {
      const kx = ((i < NX / 2 ? i : i - NX) * 2 * Math.PI) / BOX_X;
      const ky = ((j < NY / 2 ? j : j - NY) * 2 * Math.PI) / BOX_Y;
      const k = Math.hypot(kx, ky);
      const amp = k >= kMin && k <= kMax ? k ** -1.5 : 0;
      re[j * NX + i] = amp * gaussian(rng);
      im[j * NX + i] = amp * gaussian(rng);
    }
  }
  fft2d(re, im, NX, NY, true);
  let mean = 0;
  for (let n = 0; n < N; n += 1) {
    mean += re[n];
  }
  mean /= N;
  let v = 0;
  for (let n = 0; n < N; n += 1) {
    re[n] -= mean;
    v += re[n] * re[n];
  }
  const sd = Math.sqrt(v / N) || 1;
  for (let n = 0; n < N; n += 1) {
    re[n] /= sd;
  }
  return re;
}

export function createRun(seed: number, feedback: number): Run {
  const rng = createRng(seed);
  const delta = randomField(rng, (2 * Math.PI) / 700, (2 * Math.PI) / 120);
  const vx = randomField(rng, (2 * Math.PI) / 1000, (2 * Math.PI) / 150);
  const vy = randomField(rng, (2 * Math.PI) / 1000, (2 * Math.PI) / 150);
  const run: Run = {
    t: 0,
    feedback,
    rng,
    r: new Float64Array(N),
    mx: new Float64Array(N),
    my: new Float64Array(N),
    e: new Float64Array(N),
    gx: new Float64Array(N),
    gy: new Float64Array(N),
    reservoir: new Float64Array(N),
    clusters: [],
    nextId: 1,
    sn: [],
    sfrBins: [],
    regionBins: new Float64Array(REGIONS_X * REGIONS_Y * REGION_BINS),
    snCount: 0
  };
  const P = PARAMS;
  for (let n = 0; n < N; n += 1) {
    const sigma = P.sigma0 * Math.exp(P.perturbation * delta[n] - (P.perturbation * P.perturbation) / 2);
    const u = P.turbulence * vx[n];
    const w = P.turbulence * vy[n];
    run.r[n] = sigma;
    run.mx[n] = sigma * u;
    run.my[n] = sigma * w;
    const p = (sigma * P.cFloor * P.cFloor) / GAMMA;
    run.e[n] = p / (GAMMA - 1) + 0.5 * sigma * (u * u + w * w);
  }
  solveGravity(run);
  return run;
}

export function cloneRun(run: Run): Run {
  return {
    ...run,
    rng: { ...run.rng },
    r: run.r.slice(),
    mx: run.mx.slice(),
    my: run.my.slice(),
    e: run.e.slice(),
    gx: run.gx.slice(),
    gy: run.gy.slice(),
    reservoir: run.reservoir.slice(),
    clusters: run.clusters.map((c) => ({ ...c })),
    sn: run.sn.map((s) => ({ ...s })),
    sfrBins: run.sfrBins.slice(),
    regionBins: run.regionBins.slice()
  };
}

// ---------- Gravity ----------

const fRe = new Float64Array(N);
const fIm = new Float64Array(N);

/** Thin-disk Poisson solve: Φ_k = −2πG Σ_k / |k| · e^(−|k| h); the mean density is dropped. */
function solveGravity(run: Run): void {
  for (let n = 0; n < N; n += 1) {
    fRe[n] = run.r[n];
    fIm[n] = 0;
  }
  fft2d(fRe, fIm, NX, NY, false);
  const h = PARAMS.scaleHeight;
  for (let j = 0; j < NY; j += 1) {
    for (let i = 0; i < NX; i += 1) {
      const kx = ((i < NX / 2 ? i : i - NX) * 2 * Math.PI) / BOX_X;
      const ky = ((j < NY / 2 ? j : j - NY) * 2 * Math.PI) / BOX_Y;
      const k = Math.hypot(kx, ky);
      const n = j * NX + i;
      const kernel = k === 0 ? 0 : ((-2 * Math.PI * G) / k) * Math.exp(-k * h);
      fRe[n] *= kernel;
      fIm[n] *= kernel;
    }
  }
  fft2d(fRe, fIm, NX, NY, true);
  for (let j = 0; j < NY; j += 1) {
    for (let i = 0; i < NX; i += 1) {
      const n = j * NX + i;
      run.gx[n] = -(fRe[XP[n]] - fRe[XM[n]]) / (2 * DX);
      run.gy[n] = -(fRe[YP[n]] - fRe[YM[n]]) / (2 * DX);
    }
  }
}

// ---------- Hydrodynamics ----------

const pr = new Float64Array(N);
const pu = new Float64Array(N);
const pv = new Float64Array(N);
const pp = new Float64Array(N);
const dR = new Float64Array(N);
const dMx = new Float64Array(N);
const dMy = new Float64Array(N);
const dE = new Float64Array(N);
const sR = new Float64Array(N);
const sU = new Float64Array(N);
const sV = new Float64Array(N);
const sP = new Float64Array(N);
const k1R = new Float64Array(N);
const k1Mx = new Float64Array(N);
const k1My = new Float64Array(N);
const k1E = new Float64Array(N);

function minmod(a: number, b: number): number {
  if (a * b <= 0) {
    return 0;
  }
  return Math.abs(a) < Math.abs(b) ? a : b;
}

function toPrimitive(r: Float64Array, mx: Float64Array, my: Float64Array, e: Float64Array): void {
  const floor = PARAMS.sigmaFloor;
  for (let n = 0; n < N; n += 1) {
    const rho = Math.max(floor, r[n]);
    const u = mx[n] / rho;
    const v = my[n] / rho;
    pr[n] = rho;
    pu[n] = u;
    pv[n] = v;
    pp[n] = Math.max(1e-6 * rho, (GAMMA - 1) * (e[n] - 0.5 * rho * (u * u + v * v)));
  }
}

/** Fluxes along one axis (dir 0 = x, 1 = y) added into the d* arrays. */
function sweep(dir: 0 | 1): void {
  const minus = dir === 0 ? XM : YM;
  const plus = dir === 0 ? XP : YP;
  // Slopes of the primitives (minmod-limited).
  for (let n = 0; n < N; n += 1) {
    const m = minus[n];
    const q = plus[n];
    sR[n] = minmod(pr[n] - pr[m], pr[q] - pr[n]);
    sU[n] = minmod(pu[n] - pu[m], pu[q] - pu[n]);
    sV[n] = minmod(pv[n] - pv[m], pv[q] - pv[n]);
    sP[n] = minmod(pp[n] - pp[m], pp[q] - pp[n]);
  }
  const inv = 1 / DX;
  const g1 = 1 / (GAMMA - 1);
  for (let L = 0; L < N; L += 1) {
    const R = plus[L];
    // Face between L and R.
    const rL = Math.max(1e-6, pr[L] + 0.5 * sR[L]);
    const rR = Math.max(1e-6, pr[R] - 0.5 * sR[R]);
    const pL = Math.max(1e-9, pp[L] + 0.5 * sP[L]);
    const pRr = Math.max(1e-9, pp[R] - 0.5 * sP[R]);
    const uL0 = pu[L] + 0.5 * sU[L];
    const uR0 = pu[R] - 0.5 * sU[R];
    const vL0 = pv[L] + 0.5 * sV[L];
    const vR0 = pv[R] - 0.5 * sV[R];
    // Normal (n) and tangential (t) velocity for this axis.
    const unL = dir === 0 ? uL0 : vL0;
    const utL = dir === 0 ? vL0 : uL0;
    const unR = dir === 0 ? uR0 : vR0;
    const utR = dir === 0 ? vR0 : uR0;
    const EL = pL * g1 + 0.5 * rL * (unL * unL + utL * utL);
    const ER = pRr * g1 + 0.5 * rR * (unR * unR + utR * utR);
    const cL = Math.sqrt((GAMMA * pL) / rL);
    const cR = Math.sqrt((GAMMA * pRr) / rR);
    const a = Math.max(Math.abs(unL) + cL, Math.abs(unR) + cR);
    const fR = 0.5 * (rL * unL + rR * unR) - 0.5 * a * (rR - rL);
    const fN = 0.5 * (rL * unL * unL + pL + rR * unR * unR + pRr) - 0.5 * a * (rR * unR - rL * unL);
    const fT = 0.5 * (rL * unL * utL + rR * unR * utR) - 0.5 * a * (rR * utR - rL * utL);
    const fE = 0.5 * (unL * (EL + pL) + unR * (ER + pRr)) - 0.5 * a * (ER - EL);
    const fMx = dir === 0 ? fN : fT;
    const fMy = dir === 0 ? fT : fN;
    dR[L] -= fR * inv;
    dR[R] += fR * inv;
    dMx[L] -= fMx * inv;
    dMx[R] += fMx * inv;
    dMy[L] -= fMy * inv;
    dMy[R] += fMy * inv;
    dE[L] -= fE * inv;
    dE[R] += fE * inv;
  }
}

function rates(r: Float64Array, mx: Float64Array, my: Float64Array, e: Float64Array): void {
  toPrimitive(r, mx, my, e);
  dR.fill(0);
  dMx.fill(0);
  dMy.fill(0);
  dE.fill(0);
  sweep(0);
  sweep(1);
}

function maxSignalSpeed(run: Run): number {
  toPrimitive(run.r, run.mx, run.my, run.e);
  let a = 1;
  for (let n = 0; n < N; n += 1) {
    const c = Math.sqrt((GAMMA * pp[n]) / pr[n]);
    a = Math.max(a, Math.abs(pu[n]) + c, Math.abs(pv[n]) + c);
  }
  return a;
}

/** Floors, caps on temperature and speed (keeps the explicit scheme stable and on screen). */
function enforceLimits(run: Run): void {
  const P = PARAMS;
  const c2Floor = P.cFloor * P.cFloor;
  const c2Max = P.tMax / K_PER_C2;
  for (let n = 0; n < N; n += 1) {
    let rho = run.r[n];
    if (rho < P.sigmaFloor) {
      rho = P.sigmaFloor;
      run.r[n] = rho;
    }
    let u = run.mx[n] / rho;
    let v = run.my[n] / rho;
    const speed = Math.hypot(u, v);
    if (speed > P.vMax) {
      u *= P.vMax / speed;
      v *= P.vMax / speed;
      run.mx[n] = rho * u;
      run.my[n] = rho * v;
    }
    const kin = 0.5 * rho * (u * u + v * v);
    let p = (GAMMA - 1) * (run.e[n] - kin);
    const c2 = (GAMMA * p) / rho;
    if (!(c2 >= c2Floor)) {
      p = (rho * c2Floor) / GAMMA;
    } else if (c2 > c2Max) {
      p = (rho * c2Max) / GAMMA;
    }
    run.e[n] = p / (GAMMA - 1) + kin;
  }
}

function hydroStep(run: Run, dt: number): void {
  // SSP-RK2: U1 = U + dt L(U); U ← ½U + ½(U1 + dt L(U1)).
  rates(run.r, run.mx, run.my, run.e);
  for (let n = 0; n < N; n += 1) {
    k1R[n] = run.r[n] + dt * dR[n];
    k1Mx[n] = run.mx[n] + dt * dMx[n];
    k1My[n] = run.my[n] + dt * dMy[n];
    k1E[n] = run.e[n] + dt * dE[n];
    if (k1R[n] < PARAMS.sigmaFloor) {
      k1R[n] = PARAMS.sigmaFloor;
    }
  }
  rates(k1R, k1Mx, k1My, k1E);
  for (let n = 0; n < N; n += 1) {
    run.r[n] = 0.5 * run.r[n] + 0.5 * (k1R[n] + dt * dR[n]);
    run.mx[n] = 0.5 * run.mx[n] + 0.5 * (k1Mx[n] + dt * dMx[n]);
    run.my[n] = 0.5 * run.my[n] + 0.5 * (k1My[n] + dt * dMy[n]);
    run.e[n] = 0.5 * run.e[n] + 0.5 * (k1E[n] + dt * dE[n]);
  }
  enforceLimits(run);
}

// ---------- Source terms ----------

export function temperatureAt(run: Run, n: number): number {
  const rho = Math.max(PARAMS.sigmaFloor, run.r[n]);
  const u = run.mx[n] / rho;
  const v = run.my[n] / rho;
  const p = (GAMMA - 1) * (run.e[n] - 0.5 * rho * (u * u + v * v));
  return (K_PER_C2 * GAMMA * p) / rho;
}

function setTemperature(run: Run, n: number, tempK: number): void {
  const rho = run.r[n];
  const u = run.mx[n] / rho;
  const v = run.my[n] / rho;
  const p = (rho * tempK) / (K_PER_C2 * GAMMA);
  run.e[n] = p / (GAMMA - 1) + 0.5 * rho * (u * u + v * v);
}

function applyGravity(run: Run, dt: number): void {
  for (let n = 0; n < N; n += 1) {
    const rho = run.r[n];
    run.e[n] += dt * (run.mx[n] * run.gx[n] + run.my[n] * run.gy[n]);
    run.mx[n] += dt * rho * run.gx[n];
    run.my[n] += dt * rho * run.gy[n];
  }
}

/**
 * Implicit relaxation towards the floor: dense gas cools fast, thin hot gas lingers. Hot gas
 * also vents out of the disk plane (which a 2D sheet cannot show): above 10⁵ K its heat escapes
 * on the time it takes to cross the disk's thickness, 2h / c_s.
 */
function cool(run: Run, dtMyr: number): void {
  const P = PARAMS;
  const tFloor = K_PER_C2 * P.cFloor * P.cFloor;
  for (let n = 0; n < N; n += 1) {
    const t = temperatureAt(run, n);
    if (t <= tFloor * 1.0001) {
      continue;
    }
    const density = Math.max(P.sigmaFloor, run.r[n]) / P.sigma0;
    let rate = 1 / ((t > 1e4 ? P.coolTime * Math.sqrt(t / 1e6) : 0.3) / density);
    if (t > 1e5) {
      const cs = Math.sqrt(t / K_PER_C2);
      rate += cs / (2 * P.scaleHeight) / 0.9778;
    }
    setTemperature(run, n, tFloor + (t - tFloor) * Math.exp(-dtMyr * rate));
  }
}

function regionOf(x: number, y: number): number {
  const rx = Math.min(REGIONS_X - 1, Math.floor((x / BOX_X) * REGIONS_X));
  const ry = Math.min(REGIONS_Y - 1, Math.floor((y / BOX_Y) * REGIONS_Y));
  return ry * REGIONS_X + rx;
}

function recordFormation(run: Run, n: number, mass: number): void {
  const bin = Math.floor(run.t);
  while (run.sfrBins.length <= bin) {
    run.sfrBins.push(0);
    // A new bin: clear that slot of the regional ring.
    const slot = (run.sfrBins.length - 1) % REGION_BINS;
    for (let r = 0; r < REGIONS_X * REGIONS_Y; r += 1) {
      run.regionBins[r * REGION_BINS + slot] = 0;
    }
  }
  run.sfrBins[bin] += mass;
  const i = n % NX;
  const j = Math.floor(n / NX);
  run.regionBins[regionOf((i + 0.5) * DX, (j + 0.5) * DX) * REGION_BINS + (bin % REGION_BINS)] += mass;
}

/** Σ̇* = ε_ff Σ / t_ff with t_ff = √(3π / 32Gρ), ρ = Σ / 2h: dense, cool gas only. */
function formStars(run: Run, dtMyr: number): void {
  const P = PARAMS;
  const dt = dtMyr * MYR;
  for (let n = 0; n < N; n += 1) {
    const sigma = run.r[n];
    if (sigma < P.sigmaSF || temperatureAt(run, n) > P.tempSF) {
      continue;
    }
    const rho = sigma / (2 * P.scaleHeight);
    const tff = Math.sqrt((3 * Math.PI) / (32 * G * rho));
    const dSigma = Math.min(0.5 * sigma, (P.epsFF * sigma * dt) / tff);
    const frac = dSigma / sigma;
    run.r[n] -= dSigma;
    run.mx[n] *= 1 - frac;
    run.my[n] *= 1 - frac;
    run.e[n] *= 1 - frac;
    run.reservoir[n] += dSigma * AREA;
    recordFormation(run, n, dSigma * AREA);
    if (run.reservoir[n] >= P.clusterMass) {
      const i = n % NX;
      const j = Math.floor(n / NX);
      const rho2 = Math.max(P.sigmaFloor, run.r[n]);
      run.clusters.push({
        id: run.nextId++,
        x: (i + 0.2 + 0.6 * nextRandom(run.rng)) * DX,
        y: (j + 0.2 + 0.6 * nextRandom(run.rng)) * DX,
        vx: run.mx[n] / rho2,
        vy: run.my[n] / rho2,
        mass: run.reservoir[n],
        born: run.t,
        snLeft: Math.round(run.reservoir[n] * P.snPerMsun)
      });
      run.reservoir[n] = 0;
    }
  }
}

/** Heat (M☉ (km/s)²) and outward momentum (M☉ km/s) into the 3 × 3 cells around a cluster. */
function inject(run: Run, c: Cluster, energy: number, momentum: number): void {
  const P = PARAMS;
  const ci = Math.floor(c.x / DX);
  const cj = Math.floor(c.y / DX);
  const heat = energy / 9 / AREA;
  const push = momentum / 8 / AREA;
  for (let dj = -1; dj <= 1; dj += 1) {
    for (let di = -1; di <= 1; di += 1) {
      const n = idx(ci + di, cj + dj);
      const rho = Math.max(P.sigmaFloor, run.r[n]);
      const keOld = (run.mx[n] * run.mx[n] + run.my[n] * run.my[n]) / (2 * rho);
      if (di !== 0 || dj !== 0) {
        const len = Math.hypot(di, dj);
        run.mx[n] += (push * di) / len;
        run.my[n] += (push * dj) / len;
      }
      const keNew = (run.mx[n] * run.mx[n] + run.my[n] * run.my[n]) / (2 * rho);
      run.e[n] += heat + (keNew - keOld);
    }
  }
}

/** One supernova: 10⁵¹ erg, part kept as heat, plus its terminal momentum. */
function explode(run: Run, c: Cluster): void {
  const P = PARAMS;
  const f = run.feedback;
  inject(run, c, P.eSN * P.thermalShare * f, P.pSN * f);
  run.sn.push({ x: c.x, y: c.y, t: run.t });
  run.snCount += 1;
}

function evolveClusters(run: Run, dtMyr: number): void {
  const P = PARAMS;
  const dt = dtMyr * MYR;
  const window = P.snDelayMax - P.snDelayMin;
  for (const c of run.clusters) {
    // Kick and drift in the gas's gravity.
    const n = idx(Math.floor(c.x / DX), Math.floor(c.y / DX));
    c.vx += run.gx[n] * dt;
    c.vy += run.gy[n] * dt;
    c.x = (((c.x + c.vx * dt) % BOX_X) + BOX_X) % BOX_X;
    c.y = (((c.y + c.vy * dt) % BOX_Y) + BOX_Y) % BOX_Y;
    const age = run.t - c.born;
    // Before the first supernova, stellar winds and radiation already push the gas around.
    if (run.feedback > 0 && age < P.snDelayMin) {
      const budget = c.mass * P.snPerMsun * P.pSN * P.earlyShare;
      inject(run, c, 0, (budget * run.feedback * dtMyr) / P.snDelayMin);
    }
    if (run.feedback > 0 && c.snLeft > 0 && age >= P.snDelayMin && age <= P.snDelayMax) {
      const total = c.mass * P.snPerMsun;
      const k = Math.min(c.snLeft, poisson(run.rng, (total * dtMyr) / window));
      for (let q = 0; q < k; q += 1) {
        explode(run, c);
      }
      c.snLeft -= k;
    }
  }
  run.sn = run.sn.filter((s) => run.t - s.t < 1.5);
}

/** Advance by one tick (Myr), subdivided into stable hydro sub-steps. */
export function stepRun(run: Run, dtMyr: number): void {
  const dtCode = dtMyr * MYR;
  const cfl = (0.4 * DX) / maxSignalSpeed(run);
  const sub = Math.max(1, Math.ceil(dtCode / cfl));
  const h = dtCode / sub;
  for (let s = 0; s < sub; s += 1) {
    hydroStep(run, h);
  }
  solveGravity(run);
  applyGravity(run, dtCode);
  cool(run, dtMyr);
  formStars(run, dtMyr);
  evolveClusters(run, dtMyr);
  enforceLimits(run);
  run.t += dtMyr;
}

// ---------- Diagnostics ----------

/** Star formation rate (M☉/yr) averaged over the last `windowMyr`. */
export function starFormationRate(run: Run, windowMyr = 5): number {
  const bins = run.sfrBins;
  const last = Math.floor(run.t);
  let mass = 0;
  let span = 0;
  for (let b = Math.max(0, last - windowMyr + 1); b <= last && b < bins.length; b += 1) {
    mass += bins[b];
    span += 1;
  }
  return span > 0 ? mass / (span * 1e6) : 0;
}

export function totalGasMass(run: Run): number {
  let m = 0;
  for (let n = 0; n < N; n += 1) {
    m += run.r[n];
  }
  return m * AREA;
}

/** Per region: mean gas surface density (M☉/pc²) and SFR surface density (M☉/yr/kpc², last 10 Myr). */
export function regionStats(run: Run): { sigmaGas: number; sigmaSfr: number }[] {
  const out: { sigmaGas: number; sigmaSfr: number }[] = [];
  const cellsX = NX / REGIONS_X;
  const cellsY = NY / REGIONS_Y;
  const areaKpc2 = ((cellsX * DX) / 1000) * ((cellsY * DX) / 1000);
  const span = Math.min(REGION_BINS, Math.max(1, run.sfrBins.length));
  for (let ry = 0; ry < REGIONS_Y; ry += 1) {
    for (let rx = 0; rx < REGIONS_X; rx += 1) {
      let gas = 0;
      for (let j = ry * cellsY; j < (ry + 1) * cellsY; j += 1) {
        for (let i = rx * cellsX; i < (rx + 1) * cellsX; i += 1) {
          gas += run.r[j * NX + i];
        }
      }
      let formed = 0;
      const r = ry * REGIONS_X + rx;
      for (let b = 0; b < REGION_BINS; b += 1) {
        formed += run.regionBins[r * REGION_BINS + b];
      }
      out.push({ sigmaGas: gas / (cellsX * cellsY), sigmaSfr: formed / (span * 1e6) / areaKpc2 });
    }
  }
  return out;
}
