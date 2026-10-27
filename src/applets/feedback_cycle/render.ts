import { setLogicalTransform } from "../../core/canvasScale";
import { drawBloom, drawGrain, drawVignette, layersFor } from "../../core/cinematicPost";
import { drawGlow, ring } from "../../core/glowSprites";
import { drawGalaxy, drawKnots, GalaxyView, PATCH_CENTER } from "./galaxy";
import { BOX_X, BOX_Y, N, NX, NY } from "./hydro";
import type { SimStore } from "./simStore";
import { dequantise, SIGMA_LOG_MAX, SIGMA_LOG_MIN, Snapshot, TEMP_LOG_MAX, TEMP_LOG_MIN } from "./snapshots";
import { CHAPTERS, FilmState, filmAt, formatMyr, formatSfr, SIM_END_MYR, SNAPSHOT_EVERY, STORY_DURATION } from "./timeline";
import { drawBudgetPanel, drawEtaPanel, drawGalacticScene, DWARF_STELLAR_MASS, etaOf, MW_STELLAR_MASS, WindsLabel } from "./winds";

/** Typical whole-galaxy numbers for a Milky Way-like galaxy, shown once the camera is out of the patch. */
const GALAXY_SFR = 1.5;

export const SCENE_W = 1920;
export const SCENE_H = 1080;

export type SceneOptions = {
  captions: boolean;
  clock: boolean;
  labels: boolean;
  graphs: boolean;
  timeline: boolean;
  gentle: boolean;
  /** Cinematic mode: nothing over the film except time and the star formation rate. */
  minimal: boolean;
};

const TEXT = "rgba(236, 233, 224, 0.95)";
const TEXT_MUTED = "rgba(214, 208, 196, 0.72)";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const MAIN_COLOR = "#7cc8ff";
const TWIN_COLOR = "#ff6b6b";

/** Field of view (pc) with the patch filling the frame, and with the whole galaxy in view. */
const PATCH_VIEW_W = (BOX_Y * SCENE_W) / SCENE_H;
const GALAXY_VIEW_W = 40000;

type Frame = { a: Snapshot; b: Snapshot; f: number };

// ---------- Camera ----------

function camera(film: FilmState): GalaxyView {
  const w = GALAXY_VIEW_W * (PATCH_VIEW_W / GALAXY_VIEW_W) ** film.patch;
  // The centre glides from the galaxy's middle to the patch as the view narrows.
  const towardsPatch = (GALAXY_VIEW_W - w) / (GALAXY_VIEW_W - PATCH_VIEW_W);
  return {
    k: SCENE_W / w,
    camX: PATCH_CENTER[0] * towardsPatch,
    camY: PATCH_CENTER[1] * towardsPatch,
    w: SCENE_W,
    h: SCENE_H
  };
}

/** Screen position of a point in patch coordinates (pc, origin at the patch's corner). */
function patchToScreen(view: GalaxyView, x: number, y: number): [number, number] {
  const gx = PATCH_CENTER[0] - BOX_X / 2 + x;
  const gy = PATCH_CENTER[1] - BOX_Y / 2 + y;
  return [view.w / 2 + (gx - view.camX) * view.k, view.h / 2 + (gy - view.camY) * view.k];
}

// ---------- Gas field ----------

const fieldCanvases = new Map<string, { canvas: HTMLCanvasElement; image: ImageData }>();
const formingSmooth = new Float32Array(N);

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/** Cold gas glows blue (brighter where denser), supernova-hot gas orange, star-forming gas pink. */
function paintField(key: string, frame: Frame, feather: number): HTMLCanvasElement {
  let entry = fieldCanvases.get(key);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = NX;
    canvas.height = NY;
    const g = canvas.getContext("2d") as CanvasRenderingContext2D;
    entry = { canvas, image: g.createImageData(NX, NY) };
    fieldCanvases.set(key, entry);
  }
  const { a, b, f } = frame;
  const data = entry.image.data;
  // Star-forming gas, smoothed over neighbouring cells so it reads as glowing regions, not pixels.
  for (let n = 0; n < N; n += 1) {
    const i = n % NX;
    const j = Math.floor(n / NX);
    let sum = 0;
    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        sum += a.forming[((j + dj + NY) % NY) * NX + ((i + di + NX) % NX)];
      }
    }
    formingSmooth[n] = sum / 9 / 255;
  }
  for (let n = 0; n < N; n += 1) {
    const ls = dequantise(a.sigma[n] + (b.sigma[n] - a.sigma[n]) * f, SIGMA_LOG_MIN, SIGMA_LOG_MAX);
    const lt = dequantise(a.temp[n] + (b.temp[n] - a.temp[n]) * f, TEMP_LOG_MIN, TEMP_LOG_MAX);
    const dens = Math.min(1, Math.max(0, (ls + 0.6) / 3.4));
    const hot = smoothstep(4.8, 6.2, lt);
    const forming = Math.min(1, formingSmooth[n] * 2.2);
    // Blue ramp: deep navy → blue → cyan-white for the densest gas.
    let r = 6 + 40 * dens ** 2 + 190 * dens ** 6;
    let g = 12 + 110 * dens ** 1.5 + 120 * dens ** 5;
    let bl = 40 + 200 * dens ** 0.9 + 15 * dens ** 4;
    // Hot gas: orange glow, strongest where it is hottest (it is thin, so it would be dark blue).
    r += 250 * hot;
    g += 120 * hot;
    bl -= 40 * hot;
    // Star-forming gas: pink, like H II regions.
    r += 120 * forming;
    g += 25 * forming;
    bl += 45 * forming;
    const k = n * 4;
    data[k] = Math.min(255, r);
    data[k + 1] = Math.min(255, g);
    data[k + 2] = Math.min(255, Math.max(0, bl));
    // Inside the galaxy the patch fades out at its edges like an ellipse, so it never looks like a box.
    const ex = ((n % NX) + 0.5 - NX / 2) / (NX / 2);
    const ey = (Math.floor(n / NX) + 0.5 - NY / 2) / (NY / 2);
    const mask = 1 - smoothstep(0.25, 1, ex * ex + ey * ey);
    data[k + 3] = Math.round(255 * (1 - feather + feather * mask));
  }
  const g2 = entry.canvas.getContext("2d") as CanvasRenderingContext2D;
  g2.putImageData(entry.image, 0, 0);
  return entry.canvas;
}

/** Offsets at which to draw the (periodic) patch: once in the galaxy, tiled when it fills the frame. */
function tiles(film: FilmState): [number, number][] {
  if (film.patch < 0.97) {
    return [[0, 0]];
  }
  const out: [number, number][] = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      out.push([dx * BOX_X, dy * BOX_Y]);
    }
  }
  return out;
}

function drawField(ctx: CanvasRenderingContext2D, view: GalaxyView, film: FilmState, frame: Frame, key: string, alpha: number): void {
  const tiled = film.patch >= 0.97;
  const canvas = paintField(key, frame, tiled ? 0 : 1 - smoothstep(0.8, 0.97, film.patch));
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const [ox, oy] of tiles(film)) {
    const [x0, y0] = patchToScreen(view, ox, oy);
    const [x1, y1] = patchToScreen(view, ox + BOX_X, oy + BOX_Y);
    if (x1 < 0 || x0 > SCENE_W || y1 < 0 || y0 > SCENE_H) {
      continue;
    }
    ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0);
  }
  ctx.globalAlpha = 1;
}

/** Star clusters (blue-white when young, yellowing with age) and supernova flashes, on the light layer. */
function drawStarsAndBlasts(ctx: CanvasRenderingContext2D, view: GalaxyView, film: FilmState, frame: Frame, alpha: number, gentle: boolean): void {
  const { a, f } = frame;
  const scale = Math.max(0.15, view.k * 1.4);
  const offsets = tiles(film);
  for (let i = 0; i < a.clusters.length; i += 4) {
    const age = a.clusters[i + 2] + f * SNAPSHOT_EVERY;
    const mass = a.clusters[i + 3];
    const young = 1 - smoothstep(3, 15, age);
    const fade = 1 - 0.85 * smoothstep(10, 50, age);
    const color = young > 0.5 ? "#cfe4ff" : age < 40 ? "#fff3dc" : "#ffd9a0";
    const size = (5 + 4 * young) * Math.min(1.6, Math.sqrt(mass / 1e4)) * scale;
    for (const [ox, oy] of offsets) {
      const [x, y] = patchToScreen(view, a.clusters[i] + ox, a.clusters[i + 1] + oy);
      if (x < -40 || x > SCENE_W + 40 || y < -40 || y > SCENE_H + 40) {
        continue;
      }
      drawGlow(ctx, color, x, y, size * (1 + 1.5 * young), alpha * (0.35 + 0.55 * young) * fade, 0.4);
    }
  }
  const intensity = gentle ? 0.5 : 1;
  for (let i = 0; i < a.sn.length; i += 3) {
    const age = a.sn[i + 2] + f * SNAPSHOT_EVERY;
    if (age > 1.4) {
      continue;
    }
    for (const [ox, oy] of offsets) {
      const [x, y] = patchToScreen(view, a.sn[i] + ox, a.sn[i + 1] + oy);
      if (x < -80 || x > SCENE_W + 80 || y < -80 || y > SCENE_H + 80) {
        continue;
      }
      const t = age / 1.4;
      if (age < 0.5) {
        drawGlow(ctx, "#fff3e0", x, y, (10 + 30 * age) * scale, alpha * intensity * (1 - age / 0.5), 0.3);
      }
      ring(ctx, "#ffb070", x, y, (8 + 60 * t) * scale, alpha * intensity * 0.5 * (1 - t), 1.6);
    }
  }
}

// ---------- Panels ----------

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  ctx.globalAlpha = alpha * 0.62;
  ctx.fillStyle = "rgba(6, 8, 16, 1)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.globalAlpha = alpha;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left"): void {
  ctx.font = `${font} ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(s, x, y);
}

const SFR_MAX = 0.32;

/** Star formation rate against time: the run shown, and (from the comparison on) the run without feedback. */
function drawSfrPanel(ctx: CanvasRenderingContext2D, store: SimStore, film: FilmState, x: number, y: number, w: number, h: number, alpha: number): void {
  panel(ctx, x, y, w, h, alpha);
  text(ctx, "STAR FORMATION RATE", x + 18, y + 30, "600 16px", TEXT_MUTED);
  const left = x + 58;
  const right = x + w - 18;
  const top = y + 48;
  const bottom = y + h - 34;
  const tx = (t: number): number => left + (t / SIM_END_MYR) * (right - left);
  const ty = (v: number): number => bottom - (Math.min(v, SFR_MAX) / SFR_MAX) * (bottom - top);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  for (const v of [0, 0.1, 0.2, 0.3]) {
    text(ctx, v === 0 ? "0" : v.toFixed(1), left - 8, ty(v) + 5, "400 14px", TEXT_MUTED, "right");
  }
  for (const t of [0, 50, 100, 150]) {
    text(ctx, `${t}`, tx(t), bottom + 20, "400 14px", TEXT_MUTED, "center");
  }
  text(ctx, "M☉ / yr", left + 6, top + 4, "400 13px", TEXT_MUTED);
  text(ctx, "million years", right, bottom + 20, "400 13px", TEXT_MUTED, "right");
  const curve = (run: "main" | "twin", color: string, dashed: boolean): number => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(dashed ? [7, 5] : []);
    ctx.beginPath();
    let last = 0;
    let started = false;
    for (let t = 0; t <= film.tMyr; t += 1) {
      const fr = store.frame(run, t);
      if (!fr) {
        break;
      }
      last = fr.a.sfr;
      if (!started) {
        ctx.moveTo(tx(t), ty(last));
        started = true;
      } else {
        ctx.lineTo(tx(t), ty(last));
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    return last;
  };
  const comparing = film.chapterIndex >= CHAPTERS.findIndex((c) => c.id === "without");
  if (comparing) {
    const last = curve("twin", TWIN_COLOR, true);
    text(ctx, "no feedback", tx(film.tMyr) - 6, ty(last) - 10, "600 14px", TWIN_COLOR, "right");
  }
  const lastMain = curve("main", MAIN_COLOR, false);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(tx(film.tMyr), ty(lastMain), 4.5, 0, Math.PI * 2);
  ctx.fill();
  if (comparing) {
    text(ctx, "with feedback", tx(film.tMyr) - 6, ty(lastMain) + 22, "600 14px", MAIN_COLOR, "right");
  }
  ctx.globalAlpha = 1;
}

/**
 * The Kennicutt–Schmidt diagram, in the style of Wyder et al. (2009): star formation per area
 * against gas per area, both logarithmic, with Kennicutt's (1998) fit and lines of constant
 * efficiency (1%, 10%, 100% of the gas into stars per 10⁸ years). Dots are 250-pc regions of the
 * patch, averaged over the last 10 Myr.
 */
function drawKsPanel(ctx: CanvasRenderingContext2D, store: SimStore, film: FilmState, x: number, y: number, w: number, h: number, alpha: number): void {
  panel(ctx, x, y, w, h, alpha);
  text(ctx, "KENNICUTT–SCHMIDT", x + 18, y + 30, "600 16px", TEXT_MUTED);
  text(ctx, "ρ̇* = ε ρ / t_ff ∝ ρ^1.5", x + w - 18, y + 30, "500 17px", TEXT, "right");
  const left = x + 64;
  const right = x + w - 20;
  const top = y + 48;
  const bottom = y + h - 44;
  const X0 = 0;
  const X1 = 3.5;
  const Y0 = -4;
  const Y1 = 1;
  const px = (lx: number): number => left + ((lx - X0) / (X1 - X0)) * (right - left);
  const py = (ly: number): number => bottom - ((ly - Y0) / (Y1 - Y0)) * (bottom - top);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  // Constant efficiency per 10⁸ yr: Σ_SFR = ε · Σ_gas · 10⁶ / 10⁸.
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.2;
  for (const eff of [1, 0.1, 0.01]) {
    ctx.beginPath();
    ctx.moveTo(px(X0), py(Math.log10(eff * 0.01) + X0));
    ctx.lineTo(px(X1), py(Math.log10(eff * 0.01) + X1));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Kennicutt (1998): Σ_SFR = 2.5 × 10⁻⁴ Σ_gas^1.4.
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px(X0), py(Math.log10(2.5e-4) + 1.4 * X0));
  ctx.lineTo(px(X1), py(Math.log10(2.5e-4) + 1.4 * X1));
  ctx.stroke();
  const dots = (run: "main" | "twin", color: string): void => {
    const fr = store.frame(run, film.tMyr);
    if (!fr) {
      return;
    }
    for (let i = 0; i < 32; i += 1) {
      const lg = fr.a.regions[i * 2];
      const ls = fr.a.regions[i * 2 + 1];
      if (ls === 0) {
        continue;
      }
      drawGlow(ctx, color, px(lg), py(ls), 9, 0.95, 0.5);
    }
  };
  const comparing = film.chapterIndex >= CHAPTERS.findIndex((c) => c.id === "without");
  if (comparing) {
    dots("twin", TWIN_COLOR);
  }
  dots("main", MAIN_COLOR);
  ctx.restore();
  ctx.globalAlpha = alpha;
  // Labels.
  for (const [eff, label] of [
    [1, "100%"],
    [0.1, "10%"],
    [0.01, "1%"]
  ] as [number, string][]) {
    const lx = 0.35;
    text(ctx, label, px(lx), py(Math.log10(eff * 0.01) + lx) - 6, "400 13px", TEXT_MUTED);
  }
  text(ctx, "Kennicutt (1998)", px(2.45), py(Math.log10(2.5e-4) + 1.4 * 2.45) + 22, "500 14px", TEXT, "center");
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  for (const v of [-4, -2, 0]) {
    text(ctx, `10${v === 0 ? "⁰" : v === -2 ? "⁻²" : "⁻⁴"}`, left - 8, py(v) + 5, "400 14px", TEXT_MUTED, "right");
  }
  for (const v of [0, 1, 2, 3]) {
    text(ctx, ["1", "10", "100", "1,000"][v], px(v), bottom + 20, "400 14px", TEXT_MUTED, "center");
  }
  text(ctx, "gas per area (M☉ / pc²)", (left + right) / 2, bottom + 38, "400 14px", TEXT_MUTED, "center");
  ctx.save();
  ctx.translate(x + 18, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  text(ctx, "stars per area per year", 0, 0, "400 14px", TEXT_MUTED, "center");
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** The loop from the slide: star formation up (blue), negative feedback down (red), joined by green turns. */
function drawCycle(ctx: CanvasRenderingContext2D, store: SimStore, film: FilmState, alpha: number): void {
  const now = store.frame("main", film.tMyr);
  const before = store.frame("main", Math.max(0, film.tMyr - 4));
  const rising = now && before ? now.a.sfr >= before.a.sfr : true;
  const x = 70;
  const y = 190;
  const w = 330;
  const h = 560;
  panel(ctx, x, y, w, h, alpha);
  const lx = x + 100;
  const rx = x + w - 100;
  const top = y + 110;
  const bottom = y + h - 110;
  const pulse = 0.75 + 0.25 * Math.sin(film.story * 4);
  const arrow = (ax: number, up: boolean, color: string, on: boolean, label: string): void => {
    ctx.globalAlpha = alpha * (on ? pulse : 0.35);
    ctx.fillStyle = color;
    const y0 = up ? bottom : top;
    const y1 = up ? top : bottom;
    const dir = up ? -1 : 1;
    ctx.fillRect(ax - 16, Math.min(y0, y1 - dir * 34), 32, Math.abs(y1 - y0) - 34);
    ctx.beginPath();
    ctx.moveTo(ax - 32, y1 - dir * 36);
    ctx.lineTo(ax + 32, y1 - dir * 36);
    ctx.lineTo(ax, y1);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.translate(ax + (up ? -48 : 48), (top + bottom) / 2);
    ctx.rotate(up ? -Math.PI / 2 : Math.PI / 2);
    ctx.globalAlpha = alpha * (on ? 1 : 0.5);
    text(ctx, label, 0, 8, "650 26px", color, "center");
    ctx.restore();
  };
  // Green turns.
  ctx.strokeStyle = "#3fbf5f";
  ctx.lineWidth = 18;
  ctx.globalAlpha = alpha * 0.85;
  ctx.beginPath();
  ctx.arc((lx + rx) / 2, top - 6, (rx - lx) / 2, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc((lx + rx) / 2, bottom + 6, (rx - lx) / 2, 0, Math.PI);
  ctx.stroke();
  arrow(lx, true, "#2f86d6", rising, "Star formation");
  arrow(rx, false, "#e04848", !rising, "Negative feedback");
  ctx.globalAlpha = alpha;
  text(ctx, rising ? "more stars forming…" : "…feedback pushes back", x + w / 2, y + h - 22, "500 20px", rising ? "#9fd2ff" : "#ff9c9c", "center");
  text(ctx, "SELF-REGULATION", x + w / 2, y + 40, "600 18px", TEXT_MUTED, "center");
  ctx.globalAlpha = 1;
}

// ---------- HUD ----------

function textShadow(ctx: CanvasRenderingContext2D, on: boolean): void {
  ctx.shadowColor = on ? "rgba(0, 0, 0, 0.8)" : "transparent";
  ctx.shadowBlur = on ? 10 : 0;
}

function scrim(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, `rgba(3, 4, 9, ${alpha})`);
  g.addColorStop(0.55, `rgba(3, 4, 9, ${alpha * 0.6})`);
  g.addColorStop(1, "rgba(3, 4, 9, 0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);
}

function drawClock(ctx: CanvasRenderingContext2D, store: SimStore, film: FilmState, minimal: boolean): void {
  const fr = store.frame("main", film.tMyr);
  const x = SCENE_W - (minimal ? 56 : 48);
  const galactic = film.tilt > 0;
  textShadow(ctx, true);
  text(ctx, `t ≈ ${formatMyr(film.clockMyr)}`, x, minimal ? 72 : 64, `600 ${minimal ? 46 : 44}px`, TEXT, "right");
  const sfrLine = galactic
    ? `whole galaxy: star formation ≈ ${formatSfr(GALAXY_SFR)}`
    : `star formation ≈ ${formatSfr(fr ? fr.a.sfr : 0)}`;
  text(ctx, sfrLine, x, minimal ? 116 : 106, `400 ${minimal ? 30 : 28}px`, "rgba(236, 233, 224, 0.9)", "right");
  if (!minimal && galactic) {
    const eta = etaOf(MW_STELLAR_MASS);
    const detail =
      film.dwarf > 0.5
        ? `mass loading η ≈ ${Math.round(eta)} here, ≈ ${Math.round(etaOf(DWARF_STELLAR_MASS))} in a dwarf`
        : `outflow ≈ ${formatSfr(GALAXY_SFR * eta)} (η ≈ ${Math.round(eta)})`;
    text(ctx, detail, x, 140, "400 22px", TEXT_MUTED, "right");
  } else if (!minimal && fr) {
    text(ctx, `gas left ≈ ${Math.round(fr.a.gas * 100)}% · supernovae so far: ${fr.a.snCount.toLocaleString("en-US")}`, x, 140, "400 22px", TEXT_MUTED, "right");
  }
  textShadow(ctx, false);
}

function drawCaption(ctx: CanvasRenderingContext2D, film: FilmState, aboveTimeline: boolean): void {
  const chapter = CHAPTERS[film.chapterIndex];
  const into = film.story - chapter.start;
  const left = chapter.end - film.story;
  const isLast = film.chapterIndex === CHAPTERS.length - 1;
  const alpha = Math.max(0, Math.min(1, into / 0.8, isLast ? 1 : left / 0.5));
  if (alpha <= 0) {
    return;
  }
  const x = 64;
  let y = SCENE_H - (aboveTimeline ? 96 : 52);
  ctx.globalAlpha = alpha;
  textShadow(ctx, true);
  for (let i = chapter.caption.length - 1; i >= 0; i -= 1) {
    text(ctx, chapter.caption[i], x, y, "400 25px", "rgba(236, 233, 224, 0.9)");
    y -= 33;
  }
  y -= 12;
  text(ctx, chapter.title, x, y, "650 50px", TEXT);
  text(ctx, `CHAPTER ${film.chapterIndex + 1} OF ${CHAPTERS.length}`, x, y - 52, "600 20px", TEXT_MUTED);
  textShadow(ctx, false);
  ctx.globalAlpha = 1;
}

function drawTimeline(ctx: CanvasRenderingContext2D, film: FilmState): void {
  const x0 = 64;
  const x1 = SCENE_W - 64;
  const y = SCENE_H - 34;
  const toX = (t: number): number => x0 + ((x1 - x0) * t) / STORY_DURATION;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(toX(film.story), y);
  ctx.stroke();
  CHAPTERS.forEach((c, i) => {
    const cx = toX(c.start);
    ctx.fillStyle = i <= film.chapterIndex ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.3)";
    ctx.fillRect(cx - 1, y - 7, 2, 14);
    text(ctx, c.short, cx + 6, y - 10, "500 15px", i === film.chapterIndex ? TEXT : TEXT_MUTED);
  });
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(toX(film.story), y, 5, 0, Math.PI * 2);
  ctx.fill();
}

function pill(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, alpha: number, color = TEXT): void {
  if (alpha <= 0.01) {
    return;
  }
  ctx.font = `500 22px ${FONT}`;
  const w = ctx.measureText(label).width + 24;
  const cx = Math.min(SCENE_W - w / 2 - 20, Math.max(w / 2 + 20, x));
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = "rgba(6, 8, 16, 1)";
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, y - 18, w, 36, 10);
  ctx.fill();
  ctx.globalAlpha = alpha;
  text(ctx, label, cx, y + 8, "500 22px", color, "center");
  ctx.globalAlpha = 1;
}

// ---------- Frame ----------

export function renderFeedbackScene(ctx: CanvasRenderingContext2D, store: SimStore, story: number, opts: SceneOptions): void {
  const film = filmAt(story);
  const view = camera(film);
  setLogicalTransform(ctx, SCENE_W);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#03040a";
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);

  const layers = layersFor(ctx.canvas);
  const light = layers.glow.getContext("2d") as CanvasRenderingContext2D;
  light.setTransform(1, 0, 0, 1, 0, 0);
  light.globalCompositeOperation = "source-over";
  light.clearRect(0, 0, layers.glow.width, layers.glow.height);
  setLogicalTransform(light, SCENE_W);
  light.globalCompositeOperation = "lighter";

  // The galaxy, fading as the patch fills the frame; after the patch chapters it turns edge-on.
  let windLabels: WindsLabel[] = [];
  if (film.tilt > 0) {
    const winds = CHAPTERS.find((c) => c.id === "winds");
    windLabels = drawGalacticScene(ctx, light, film, view.k, winds?.start ?? 0, story);
  } else {
    const galaxyAlpha = 1 - smoothstep(0.75, 0.97, film.patch);
    drawGalaxy(ctx, view, galaxyAlpha);
    const regulated = CHAPTERS.findIndex((c) => c.id === "regulated");
    const flicker = film.chapterIndex >= regulated ? 1 : 0.15;
    drawKnots(light, view, galaxyAlpha, flicker, story * 0.9);
  }

  const main = store.frame("main", film.tMyr);
  const twin = store.frame("twin", film.tMyr);
  const patchAlpha = smoothstep(0.05, 0.6, film.patch);
  if (main && patchAlpha > 0) {
    drawField(ctx, view, film, main, "main", patchAlpha);
    drawStarsAndBlasts(light, view, film, main, patchAlpha, opts.gentle);
  }
  // The comparison: the run without feedback slides in from the right.
  const divider = SCENE_W * (1 - 0.5 * film.split);
  if (twin && film.split > 0) {
    for (const target of [ctx, light]) {
      target.save();
      target.beginPath();
      target.rect(divider, 0, SCENE_W - divider, SCENE_H);
      target.clip();
      if (target === ctx) {
        ctx.fillStyle = "#03040a";
        ctx.fillRect(divider, 0, SCENE_W - divider, SCENE_H);
        drawField(ctx, view, film, twin, "twin", 1);
      } else {
        // Hide the main run's stars behind the divider, then draw the twin's.
        light.globalCompositeOperation = "destination-out";
        light.fillStyle = "#000";
        light.fillRect(divider, 0, SCENE_W - divider, SCENE_H);
        light.globalCompositeOperation = "lighter";
        drawStarsAndBlasts(light, view, film, twin, 1, opts.gentle);
      }
      target.restore();
    }
  }
  light.globalCompositeOperation = "source-over";
  light.globalAlpha = 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layers.glow, 0, 0);
  drawBloom(ctx, layers, opts.gentle);
  setLogicalTransform(ctx, SCENE_W);
  drawVignette(ctx, SCENE_W, SCENE_H, 0.45);
  if (!opts.gentle) {
    drawGrain(ctx, Math.round(story * 60), SCENE_W, SCENE_H);
  }
  if (film.split > 0) {
    ctx.globalAlpha = film.split;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(divider - 1.5, 0, 3, SCENE_H);
    ctx.globalAlpha = 1;
  }

  // Not computed yet: say so (the export waits until everything is ready, so it never shows this).
  if (store.ready() + SNAPSHOT_EVERY < film.tMyr && !store.done()) {
    pill(ctx, "simulating…", SCENE_W / 2, SCENE_H / 2, 1);
  }

  if (opts.minimal) {
    scrim(ctx, SCENE_W, 0, 560, 0.5);
    drawClock(ctx, store, film, true);
    return;
  }
  if (opts.clock) {
    scrim(ctx, SCENE_W, 0, 680, 0.6);
  }
  if (opts.captions) {
    scrim(ctx, 0, SCENE_H, 1250, 0.7);
  }
  if (film.split > 0) {
    pill(ctx, "with feedback", divider / 2, 200, film.split, MAIN_COLOR);
    pill(ctx, "without feedback", divider + (SCENE_W - divider) / 2, 200, film.split, TWIN_COLOR);
  }
  for (const l of windLabels) {
    // The comparison's two titles always show; the pointers follow the Labels toggle.
    const title = l.text.startsWith("Milky Way-like") || l.text.startsWith("dwarf");
    if (title || opts.labels) {
      pill(ctx, l.text, l.x, l.y, l.alpha, l.color);
    }
  }
  if (opts.graphs) {
    drawBudgetPanel(ctx, film.outflow * (1 - film.dwarf));
    drawEtaPanel(ctx, film.dwarf);
  }
  if (opts.graphs && film.graphs > 0) {
    const w = 500;
    const px = SCENE_W - 48 - w;
    // During the comparison the graph moves to the bottom right, clear of the two labels.
    const sfrY = 186 + (SCENE_H - 48 - 250 - 186) * smoothstep(0, 0.6, film.split);
    drawSfrPanel(ctx, store, film, px, sfrY, w, 250, film.graphs);
    if (film.split < 0.5) {
      drawKsPanel(ctx, store, film, px, 452, w, 360, film.graphs * (1 - film.split * 2));
    }
  }
  if (opts.graphs && film.cycle > 0) {
    drawCycle(ctx, store, film, film.cycle);
  }
  if (opts.clock) {
    drawClock(ctx, store, film, false);
  }
  if (opts.captions) {
    drawCaption(ctx, film, opts.timeline);
  }
  if (opts.timeline) {
    drawTimeline(ctx, film);
  }
}
