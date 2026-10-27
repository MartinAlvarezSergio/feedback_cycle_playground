import type { Snapshot } from "./snapshots";
import { SIM_END_MYR, SNAPSHOT_EVERY } from "./timeline";
import type { WorkerRequest } from "./simWorker";

/**
 * Holds the snapshots of both runs as the worker produces them. The film reads frames from here;
 * until a frame exists, it shows the latest available one (and the UI shows progress).
 */
export type SimStore = {
  readonly feedback: number;
  frame(run: "main" | "twin", tMyr: number): { a: Snapshot; b: Snapshot; f: number } | null;
  /** Simulated Myr available for both runs. */
  ready(): number;
  done(): boolean;
  dispose(): void;
};

export function createSimStore(seed: number, feedback: number, onProgress: () => void): SimStore {
  const main: Snapshot[] = [];
  const twin: Snapshot[] = [];
  /** Snapshots arrive in order, so the number available is a running count. */
  const counts = { main: 0, twin: 0 };
  let finished = false;
  const worker = new Worker(new URL("./simWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { type: "snap"; run: "main" | "twin"; index: number; snap: Snapshot } | { type: "done" };
    if (msg.type === "done") {
      finished = true;
    } else {
      const list = msg.run === "main" ? main : twin;
      list[msg.index] = msg.snap;
      while (list[counts[msg.run]]) {
        counts[msg.run] += 1;
      }
    }
    onProgress();
  };
  const request: WorkerRequest = { seed, feedback, until: SIM_END_MYR, every: SNAPSHOT_EVERY };
  worker.postMessage(request);

  return {
    feedback,
    frame(run, tMyr) {
      const list = run === "main" ? main : twin;
      const available = counts[run];
      if (available === 0) {
        return null;
      }
      const x = Math.min(tMyr / SNAPSHOT_EVERY, available - 1);
      const i = Math.floor(x);
      const j = Math.min(available - 1, i + 1);
      return { a: list[i], b: list[j], f: x - i };
    },
    ready() {
      return (Math.min(counts.main, counts.twin) - 1) * SNAPSHOT_EVERY;
    },
    done: () => finished,
    dispose() {
      worker.terminate();
    }
  };
}
