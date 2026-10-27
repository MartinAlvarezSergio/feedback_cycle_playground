/// <reference lib="webworker" />
import { createRun, stepRun, totalGasMass } from "./hydro";
import { snapshotBuffers, takeSnapshot } from "./snapshots";

/**
 * Runs the simulation off the main thread: the run with feedback and its twin without, side by
 * side, posting a snapshot of each every `every` Myr until `until`. Deterministic for a given seed.
 */
export type WorkerRequest = { seed: number; feedback: number; until: number; every: number };

const TICK = 0.05;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { seed, feedback, until, every } = event.data;
  const runs = { main: createRun(seed, feedback), twin: createRun(seed, 0) };
  const gas0 = totalGasMass(runs.main);
  const ticksPerSnap = Math.round(every / TICK);
  const post = (name: "main" | "twin", index: number): void => {
    const snap = takeSnapshot(runs[name], gas0);
    (self as unknown as Worker).postMessage({ type: "snap", run: name, index, snap }, snapshotBuffers(snap));
  };
  post("main", 0);
  post("twin", 0);
  const total = Math.ceil(until / every);
  for (let index = 1; index <= total; index += 1) {
    for (let k = 0; k < ticksPerSnap; k += 1) {
      stepRun(runs.main, TICK);
      stepRun(runs.twin, TICK);
    }
    post("main", index);
    post("twin", index);
  }
  (self as unknown as Worker).postMessage({ type: "done" });
};
