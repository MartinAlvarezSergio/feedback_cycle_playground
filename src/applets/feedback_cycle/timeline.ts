import { sig } from "../../core/sciFormat";

/**
 * Story time (presentation seconds) mapped to the film: a galaxy, a zoom into one patch of its
 * disk, the simulated star formation–feedback cycle there, and a zoom back out. The simulation
 * runs at SIM_RATE Myr per story second from SIM_START.
 */

export type ChapterId = "galaxy" | "stars" | "dieyoung" | "feedback" | "cycle" | "without" | "regulated" | "winds" | "dwarfs";

export type Chapter = { id: ChapterId; short: string; title: string; caption: string[]; start: number; end: number };

export const CHAPTERS: Chapter[] = [
  {
    id: "galaxy",
    short: "Galaxy",
    title: "A galaxy of gas and stars",
    caption: [
      "Galaxies keep turning their gas into new stars, but surprisingly slowly:",
      "only about 1% of the dense gas becomes stars each free-fall time. Let's zoom into one patch of the disk."
    ],
    start: 0,
    end: 10
  },
  {
    id: "stars",
    short: "Star formation",
    title: "Dense gas forms stars",
    caption: [
      "Gravity gathers the gas into dense clumps. The denser the gas, the faster it collapses,",
      "so star formation scales with density as ρ / t_ff ∝ ρ^1.5: the Kennicutt–Schmidt relation."
    ],
    start: 10,
    end: 30
  },
  {
    id: "dieyoung",
    short: "Massive stars",
    title: "Massive stars live fast",
    caption: [
      "The brightest new stars blast out winds and radiation, and within 3 to 40 million years",
      "they explode as supernovae, each releasing 10⁵¹ erg."
    ],
    start: 30,
    end: 40
  },
  {
    id: "feedback",
    short: "Feedback",
    title: "Negative feedback",
    caption: [
      "Supernovae heat the gas and blow it apart into bubbles and shells.",
      "Hot, stirred-up gas cannot collapse, so star formation nearby halts."
    ],
    start: 40,
    end: 56
  },
  {
    id: "cycle",
    short: "The cycle",
    title: "A self-regulating cycle",
    caption: [
      "The hot gas cools and vents away, shells collide and become dense again, and new stars form.",
      "Star formation drives feedback, and feedback limits star formation: the rate settles where the two balance."
    ],
    start: 56,
    end: 76
  },
  {
    id: "without",
    short: "No feedback",
    title: "Without feedback?",
    caption: [
      "The same patch, with the supernovae switched off: the gas collapses into dense knots",
      "and turns into stars several times faster. Real galaxies would have used up their gas long ago."
    ],
    start: 76,
    end: 92
  },
  {
    id: "regulated",
    short: "Self-regulation",
    title: "Self-regulated galaxies",
    caption: [
      "Zooming out, every star-forming region in the disk flickers through the same cycle, each on its own clock:",
      "a burst of new stars, feedback, a lull, then a new burst."
    ],
    start: 92,
    end: 104
  },
  {
    id: "winds",
    short: "Winds",
    title: "Winds and fountains",
    caption: [
      "When many supernovae go off together, their bubbles merge and burst out of the disk:",
      "hot gas streams into the halo at hundreds of km/s, dragging cooler clouds along.",
      "Much of it cools and rains back as a galactic fountain, while fresh gas flows in from intergalactic space."
    ],
    start: 104,
    end: 122
  },
  {
    id: "dwarfs",
    short: "Small galaxies",
    title: "Small galaxies lose more",
    caption: [
      "In a small galaxy gravity is weak: winds escape for good,",
      "carrying off many times the mass that forms stars.",
      "That is why dwarf galaxies turn so little of their gas into stars.",
      "Because these balances set the outcome, simulations can",
      "model galaxies without resolving every star."
    ],
    start: 122,
    end: 138
  }
];

export const STORY_DURATION = CHAPTERS[CHAPTERS.length - 1].end;
export const SIM_START = CHAPTERS[1].start;
/** Simulated Myr per story second. */
export const SIM_RATE = 2;
/** The patch is simulated until the camera has left it (end of the "regulated" chapter). */
const SIM_STOP = CHAPTERS.find((c) => c.id === "regulated")?.end ?? STORY_DURATION;
/** Simulated time covered (Myr), with a little margin. */
export const SIM_END_MYR = (SIM_STOP - SIM_START) * SIM_RATE + 2;
/** After the simulation, the clock runs faster through the galaxy-scale chapters (Myr per story second). */
const LATE_RATE = 25;
/** Snapshot spacing (Myr). */
export const SNAPSHOT_EVERY = 0.25;

export function chapterIndexAt(story: number): number {
  for (let i = CHAPTERS.length - 1; i >= 0; i -= 1) {
    if (story >= CHAPTERS[i].start) {
      return i;
    }
  }
  return 0;
}

export function simTimeAt(story: number): number {
  return Math.min(SIM_END_MYR - 0.5, Math.max(0, (story - SIM_START) * SIM_RATE));
}

/** Time shown on the clock: the simulation's, then faster through the galaxy-scale chapters. */
export function clockTimeAt(story: number): number {
  const atStop = (SIM_STOP - SIM_START) * SIM_RATE;
  return story <= SIM_STOP ? Math.max(0, (story - SIM_START) * SIM_RATE) : atStop + (story - SIM_STOP) * LATE_RATE;
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

export type FilmState = {
  story: number;
  chapterIndex: number;
  /** Simulated time (Myr since the patch started). */
  tMyr: number;
  /** 0 = whole galaxy on screen, 1 = the simulated patch fills the screen. */
  patch: number;
  /** 0 → 1: the screen splits to show the run without feedback alongside. */
  split: number;
  /** Visibility of the graphs and the cycle diagram. */
  graphs: number;
  cycle: number;
  /** Galaxy-scale chapters: 0 = face-on, 1 = edge-on. */
  tilt: number;
  /** Outflows (winds and fountain) and inflow from intergalactic space. */
  outflow: number;
  inflow: number;
  /** 0 → 1: the screen splits to compare a Milky Way-like galaxy with a dwarf. */
  dwarf: number;
  /** The clock's time (Myr). */
  clockMyr: number;
};

export function filmAt(story: number): FilmState {
  const s = Math.min(STORY_DURATION, Math.max(0, story));
  const without = CHAPTERS.find((c) => c.id === "without") as Chapter;
  const cycle = CHAPTERS.find((c) => c.id === "cycle") as Chapter;
  const regulated = CHAPTERS.find((c) => c.id === "regulated") as Chapter;
  const winds = CHAPTERS.find((c) => c.id === "winds") as Chapter;
  const dwarfs = CHAPTERS.find((c) => c.id === "dwarfs") as Chapter;
  return {
    story: s,
    chapterIndex: chapterIndexAt(s),
    tMyr: simTimeAt(s),
    patch: smoothstep(4, 11, s) * (1 - smoothstep(regulated.start + 1, regulated.start + 8, s)),
    split: smoothstep(without.start + 0.5, without.start + 3, s) * (1 - smoothstep(without.end - 1, without.end + 1.5, s)),
    graphs: smoothstep(SIM_START + 3, SIM_START + 5, s) * (1 - smoothstep(regulated.start, regulated.start + 2, s)),
    cycle: smoothstep(cycle.start + 0.5, cycle.start + 2, s) * (1 - smoothstep(cycle.end - 1, cycle.end, s)),
    tilt: smoothstep(winds.start, winds.start + 4.5, s),
    outflow: smoothstep(winds.start + 3, winds.start + 7, s),
    inflow: smoothstep(winds.start + 9, winds.start + 12, s),
    dwarf: smoothstep(dwarfs.start + 0.3, dwarfs.start + 3, s),
    clockMyr: clockTimeAt(s)
  };
}

export function formatMyr(t: number): string {
  return t < 1 ? "0 Myr" : `${Math.round(t)} million years`;
}

export function formatSfr(msunPerYr: number): string {
  if (msunPerYr <= 0) {
    return "0";
  }
  return `${sig(msunPerYr, 2)} M☉ per year`;
}
