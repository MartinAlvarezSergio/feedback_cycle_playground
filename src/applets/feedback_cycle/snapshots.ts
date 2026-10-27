import { BOX_X, BOX_Y, N, PARAMS, regionStats, Run, starFormationRate, temperatureAt, totalGasMass } from "./hydro";

/**
 * Compact frames of a simulation run, taken every SNAPSHOT_EVERY Myr: gas surface density and
 * temperature (log-quantised to bytes), where stars are forming, the clusters, recent
 * supernovae and the diagnostics the graphs need. About 25 kB each.
 */
export type Snapshot = {
  t: number;
  sigma: Uint8Array;
  temp: Uint8Array;
  forming: Uint8Array;
  /** x, y (pc), age (Myr), mass (M☉) per cluster. */
  clusters: Float32Array;
  /** x, y (pc), age (Myr) per supernova in the last 1.5 Myr. */
  sn: Float32Array;
  /** Star formation rate (M☉/yr, last 5 Myr), gas left (fraction of the start), supernovae so far. */
  sfr: number;
  gas: number;
  snCount: number;
  /** Per region: log Σ_gas, log Σ_SFR (0 if none) — 8 × 4 regions. */
  regions: Float32Array;
};

export const SIGMA_LOG_MIN = -1.4;
export const SIGMA_LOG_MAX = 3.6;
export const TEMP_LOG_MIN = 3;
export const TEMP_LOG_MAX = 6.4;

function quantise(value: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(255, Math.round(((value - lo) / (hi - lo)) * 255)));
}

export function dequantise(byte: number, lo: number, hi: number): number {
  return lo + (byte / 255) * (hi - lo);
}

export function takeSnapshot(run: Run, gas0: number): Snapshot {
  const sigma = new Uint8Array(N);
  const temp = new Uint8Array(N);
  const forming = new Uint8Array(N);
  for (let n = 0; n < N; n += 1) {
    sigma[n] = quantise(Math.log10(Math.max(1e-3, run.r[n])), SIGMA_LOG_MIN, SIGMA_LOG_MAX);
    temp[n] = quantise(Math.log10(Math.max(1, temperatureAt(run, n))), TEMP_LOG_MIN, TEMP_LOG_MAX);
    forming[n] = Math.min(255, Math.round((run.reservoir[n] / PARAMS.clusterMass) * 255));
  }
  const clusters = new Float32Array(run.clusters.length * 4);
  run.clusters.forEach((c, i) => {
    clusters[i * 4] = c.x;
    clusters[i * 4 + 1] = c.y;
    clusters[i * 4 + 2] = run.t - c.born;
    clusters[i * 4 + 3] = c.mass;
  });
  const sn = new Float32Array(run.sn.length * 3);
  run.sn.forEach((e, i) => {
    sn[i * 3] = e.x;
    sn[i * 3 + 1] = e.y;
    sn[i * 3 + 2] = run.t - e.t;
  });
  const regions = new Float32Array(64);
  regionStats(run).forEach((r, i) => {
    regions[i * 2] = Math.log10(Math.max(1e-3, r.sigmaGas));
    regions[i * 2 + 1] = r.sigmaSfr > 0 ? Math.log10(r.sigmaSfr) : 0;
  });
  return {
    t: run.t,
    sigma,
    temp,
    forming,
    clusters,
    sn,
    sfr: starFormationRate(run, 5),
    gas: totalGasMass(run) / gas0,
    snCount: run.snCount,
    regions
  };
}

/** Buffers to transfer when posting a snapshot from the worker. */
export function snapshotBuffers(s: Snapshot): ArrayBuffer[] {
  return [s.sigma.buffer, s.temp.buffer, s.forming.buffer, s.clusters.buffer, s.sn.buffer, s.regions.buffer] as ArrayBuffer[];
}

export { BOX_X, BOX_Y };
