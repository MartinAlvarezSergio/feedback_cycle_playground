import { drawGlow } from "../../core/glowSprites";
import { GALAXY_RADIUS_PC, galaxyTexture, starFormingKnots } from "./galaxy";
import type { FilmState } from "./timeline";

/**
 * Galaxy-scale regulation (illustrative, not simulated): the galaxy turns edge-on; clustered
 * supernovae drive hot winds and cooler clouds out of the disk; most of the gas arcs back down as a
 * galactic fountain (cooling from orange to blue as it falls) while some escapes; fresh gas streams
 * in from intergalactic space. A dwarf galaxy, with weaker gravity, loses most of its outflow.
 *
 * Particles are pure functions of story time, so scrubbing and export stay exact.
 */

const W = 1920;
const H = 1080;
const INCLINATION_MAX = (86 * Math.PI) / 180;

function hash(i: number, salt: number): number {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

type Galaxy = {
  cx: number;
  cy: number;
  /** Pixels per kpc. */
  k: number;
  /** cos(inclination): 1 face-on, ~0 edge-on. */
  squash: number;
};

/** The face-on galaxy texture, squashed vertically as it turns, plus a dust lane and round bulge edge-on. */
function drawTiltedGalaxy(ctx: CanvasRenderingContext2D, light: CanvasRenderingContext2D, g: Galaxy, edgeOn: number, story: number, alpha: number): void {
  const size = ((2 * GALAXY_RADIUS_PC) / 1000) * g.k;
  const R = (GALAXY_RADIUS_PC / 1000) * g.k;
  ctx.save();
  // Seen edge-on, the arms would squash into rings: the texture gives way to a glowing band.
  ctx.globalAlpha = alpha * (1 - 0.85 * edgeOn);
  ctx.translate(g.cx, g.cy);
  ctx.scale(1, g.squash);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(galaxyTexture(), -size / 2, -size / 2, size, size);
  ctx.restore();
  // Star-forming knots, projected.
  for (const knot of starFormingKnots()) {
    const x = g.cx + (knot.x / 1000) * g.k;
    const y = g.cy + (knot.y / 1000) * g.k * g.squash;
    const on = 0.5 + 0.5 * Math.sin(story * 0.9 * knot.rate + knot.phase);
    drawGlow(light, "#ff5fa8", x, y, Math.max(2, (knot.size / 1000) * g.k * 1.4), alpha * 0.4 * (0.4 + 0.6 * on * on), 0.45);
  }
  if (edgeOn > 0) {
    for (const [scale, flat, color, strength] of [
      [1, 0.07, "#7f9cff", 0.55],
      [0.6, 0.06, "#cfdcff", 0.5],
      [0.3, 0.1, "#fff0d8", 0.6]
    ] as [number, number, string, number][]) {
      light.save();
      light.translate(g.cx, g.cy);
      light.scale(1, flat);
      drawGlow(light, color, 0, 0, R * scale, alpha * edgeOn * strength, 0.55);
      light.restore();
    }
    // Edge-on: the stars' bulge stays round, and dust darkens the disk's mid-plane.
    drawGlow(light, "#ffe2b0", g.cx, g.cy, 3.2 * g.k, alpha * edgeOn * 0.6, 0.35);
    ctx.save();
    ctx.globalAlpha = alpha * edgeOn * 0.7;
    ctx.fillStyle = "rgba(14, 8, 6, 1)";
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy, 0.82 * (GALAXY_RADIUS_PC / 1000) * g.k, Math.max(1.5, 0.12 * g.k), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

type FlowStyle = {
  /** Share of launched gas that escapes instead of falling back. */
  escape: number;
  /** Radius (kpc) over which outflows are launched, and their heights (kpc). */
  launchRadius: number;
  fountainHeight: number;
  windReach: number;
  particles: number;
  seed: number;
};

/**
 * Outflow particles. Fountain gas rises and falls back on a parabola (cooling from orange to blue
 * on the way down); wind gas keeps going and fades into the halo. Pink dots are cooler clouds
 * dragged along by the hot wind.
 */
function drawOutflow(light: CanvasRenderingContext2D, g: Galaxy, style: FlowStyle, story: number, onset: number, strength: number): void {
  if (strength <= 0) {
    return;
  }
  for (let i = 0; i < style.particles; i += 1) {
    const s = style.seed + i;
    const up = i % 2 === 0 ? -1 : 1;
    const escapes = hash(s, 1) < style.escape;
    // Winds blow out of the busiest, central star-forming region; fountains rise all across the disk.
    const spread = escapes ? 0.35 : 1;
    const x0 = (hash(s, 2) < 0.5 ? -1 : 1) * style.launchRadius * spread * hash(s, 3) ** 0.8;
    const peak = style.fountainHeight * (0.45 + 0.75 * hash(s, 4));
    const period = escapes ? 7 + 3 * hash(s, 5) : 5 + 3 * hash(s, 5);
    const age = (((story + hash(s, 6) * period) % period) + period) % period;
    const launched = story - age;
    if (launched < onset) {
      continue;
    }
    const f = age / period;
    let z: number;
    let fade: number;
    let cooled = 0;
    if (escapes) {
      z = style.windReach * f * (0.8 + 0.4 * hash(s, 7));
      fade = Math.min(1, f * 6) * (1 - f) ** 1.2;
    } else {
      // Parabola: up to the peak at half the period, back down by its end.
      z = 4 * peak * f * (1 - f);
      fade = Math.min(1, f * 6) * Math.min(1, (1 - f) * 6);
      cooled = smoothstep(0.45, 0.8, f);
    }
    // Winds widen into a cone; fountain gas arcs outward and lands further out in the disk.
    const x = escapes ? x0 * (1 + 0.2 * z) + (hash(s, 8) - 0.5) * 0.7 * z : x0 + Math.sign(x0) * style.fountainHeight * 0.5 * f;
    const px = g.cx + x * g.k;
    const py = g.cy + up * z * g.k;
    const a = strength * fade;
    const hot = escapes ? "#ffb04a" : cooled > 0.5 ? "#8fb2ff" : "#ff8a3c";
    const puff = Math.min(60, (0.45 + 0.05 * z) * g.k * (0.7 + 0.6 * hash(s, 9)));
    drawGlow(light, hot, px, py, puff, a * (escapes ? 0.22 : 0.12), 0.5);
    if (i % 3 === 0) {
      drawGlow(light, cooled > 0.5 ? "#b9ccff" : "#ff5fa0", px, py, Math.min(7, Math.max(2.5, 0.12 * g.k)), a * 0.75, 0.45);
    }
  }
}

/** Fresh gas falling in along filaments of the cosmic web, towards the disk's outskirts. */
function drawInflow(light: CanvasRenderingContext2D, g: Galaxy, story: number, strength: number): void {
  if (strength <= 0) {
    return;
  }
  const R = (GALAXY_RADIUS_PC / 1000) * g.k;
  const streams: [number, number, number, number, number, number][] = [
    [-W * 0.08, -H * 0.15, -R * 0.4, -H * 0.35, -R * 0.95, 0],
    [W * 1.08, H * 0.05, R * 0.6, -H * 0.25, R * 0.92, 0],
    [W * 0.95, H * 1.15, R * 0.2, H * 0.4, R * 0.7, 0]
  ];
  streams.forEach(([sx, sy, mx, my, ex, ey], k) => {
    const p0 = [sx, sy];
    const p1 = [g.cx + mx, g.cy + my];
    const p2 = [g.cx + ex, g.cy + ey];
    const at = (u: number): [number, number] => [
      (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * p1[0] + u * u * p2[0],
      (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * p1[1] + u * u * p2[1]
    ];
    for (let q = 0; q < 26; q += 1) {
      const u = q / 25;
      const [x, y] = at(u);
      drawGlow(light, "#7f9cd8", x, y, 60, strength * 0.05, 0.5);
    }
    for (let q = 0; q < 40; q += 1) {
      const s = k * 100 + q;
      const u = (((story * 0.08 * (0.8 + 0.4 * hash(s, 21)) + hash(s, 22)) % 1) + 1) % 1;
      const [x, y] = at(u);
      drawGlow(light, "#dce7ff", x + (hash(s, 23) - 0.5) * 30, y + (hash(s, 24) - 0.5) * 30, 5, strength * 0.7 * Math.min(1, (1 - u) * 5), 0.45);
    }
  });
}

/** A small, irregular, gas-rich dwarf galaxy, edge-on. */
function drawDwarf(ctx: CanvasRenderingContext2D, light: CanvasRenderingContext2D, g: Galaxy, story: number, alpha: number): void {
  for (let i = 0; i < 70; i += 1) {
    const x = (hash(i, 31) - 0.5) * 5 * g.k;
    const y = (hash(i, 32) - 0.5) * 1.1 * g.k * (1 - Math.abs(hash(i, 31) - 0.5));
    drawGlow(light, i % 4 === 0 ? "#ff5fa8" : "#7fa6ff", g.cx + x, g.cy + y, (0.3 + 0.5 * hash(i, 33)) * g.k, alpha * (i % 4 === 0 ? 0.35 * (0.5 + 0.5 * Math.sin(story + i)) : 0.12), 0.5);
  }
  ctx.save();
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = "rgba(14, 8, 6, 1)";
  ctx.beginPath();
  ctx.ellipse(g.cx, g.cy, 1.8 * g.k, Math.max(1, 0.07 * g.k), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function scaleBar(ctx: CanvasRenderingContext2D, x: number, y: number, kpc: number, k: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + kpc * k, y);
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y + 6);
  ctx.moveTo(x + kpc * k, y - 6);
  ctx.lineTo(x + kpc * k, y + 6);
  ctx.stroke();
  ctx.font = "500 18px system-ui, sans-serif";
  ctx.fillStyle = "rgba(236, 233, 224, 0.9)";
  ctx.textAlign = "center";
  ctx.fillText(`${kpc} kpc`, x + (kpc * k) / 2, y - 12);
  ctx.globalAlpha = 1;
}

export type WindsLabel = { text: string; x: number; y: number; alpha: number; color?: string };

/**
 * Draws the galaxy-scale chapters (main ctx for dust, light layer for glow) and returns labels.
 * `k0` is the face-on scale (px per pc) at the end of the zoom-out, for a seamless start.
 */
export function drawGalacticScene(
  ctx: CanvasRenderingContext2D,
  light: CanvasRenderingContext2D,
  film: FilmState,
  k0: number,
  windsStart: number,
  story: number
): WindsLabel[] {
  const labels: WindsLabel[] = [];
  const squash = Math.cos(INCLINATION_MAX * film.tilt);
  const edgeOn = smoothstep(0.6, 1, film.tilt);
  // The Milky Way-like galaxy: centred, then sliding into the left half for the comparison.
  const kMw = k0 * 1000 * (1 - 0.45 * film.dwarf);
  const mw: Galaxy = { cx: W / 2 - (W / 4) * film.dwarf, cy: H / 2 + 20 * film.tilt, k: kMw, squash };
  drawTiltedGalaxy(ctx, light, mw, edgeOn, story, 1);
  const onset = windsStart + 3;
  drawOutflow(
    light,
    mw,
    { escape: 0.3, launchRadius: 11, fountainHeight: 5, windReach: 16, particles: 360, seed: 0 },
    story,
    onset,
    film.outflow
  );
  drawInflow(light, mw, story, film.inflow * (1 - film.dwarf));
  if (film.outflow > 0.3 && film.dwarf < 0.2) {
    const a = smoothstep(0.3, 0.7, film.outflow) * (1 - film.dwarf * 5);
    labels.push({ text: "hot wind", x: mw.cx + 40, y: mw.cy - 8 * mw.k, alpha: a, color: "#ffc28a" });
    labels.push({ text: "fountain: cooled gas rains back", x: mw.cx - 10 * mw.k, y: mw.cy - 5.5 * mw.k, alpha: a, color: "#b9ccff" });
  }
  if (film.inflow > 0.3 && film.dwarf < 0.2) {
    labels.push({ text: "inflow from intergalactic space", x: W * 0.82, y: H * 0.16, alpha: film.inflow * (1 - film.dwarf * 5) });
  }
  if (film.dwarf > 0) {
    // The dwarf, in the right half, drawn at a larger scale (see the scale bars).
    const dwarf: Galaxy = { cx: (W * 3) / 4, cy: H / 2 - 110, k: kMw * 2.4, squash: 0.08 };
    ctx.save();
    light.save();
    for (const target of [ctx, light]) {
      target.beginPath();
      target.rect(W / 2, 0, W / 2, H);
      target.clip();
    }
    ctx.globalAlpha = film.dwarf;
    ctx.fillStyle = "#03040a";
    ctx.fillRect(W / 2, 0, W / 2, H);
    light.globalCompositeOperation = "destination-out";
    light.globalAlpha = film.dwarf;
    light.fillStyle = "#000";
    light.fillRect(W / 2, 0, W / 2, H);
    light.globalCompositeOperation = "lighter";
    drawDwarf(ctx, light, dwarf, story, film.dwarf);
    drawOutflow(
      light,
      dwarf,
      { escape: 0.85, launchRadius: 2.4, fountainHeight: 1.6, windReach: 7, particles: 200, seed: 5000 },
      story,
      windsStart,
      film.dwarf
    );
    ctx.restore();
    light.restore();
    ctx.globalAlpha = film.dwarf;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(W / 2 - 1.5, 0, 3, H);
    ctx.globalAlpha = 1;
    scaleBar(ctx, mw.cx - 5 * mw.k, mw.cy + 6.5 * mw.k, 10, mw.k, film.dwarf);
    scaleBar(ctx, dwarf.cx - 2 * dwarf.k - 140, dwarf.cy + 30, 1, dwarf.k, film.dwarf);
    labels.push({ text: "Milky Way-like: most of the outflow falls back", x: W / 4, y: 190, alpha: film.dwarf, color: "#9fd2ff" });
    labels.push({ text: "dwarf galaxy: the wind escapes", x: (W * 3) / 4, y: 190, alpha: film.dwarf, color: "#ffc28a" });
  }
  return labels;
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  ctx.globalAlpha = alpha * 0.62;
  ctx.fillStyle = "rgba(6, 8, 16, 1)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.globalAlpha = alpha;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left"): void {
  ctx.font = `${font} system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(s, x, y);
}

/** The galaxy's gas budget: the "bathtub" balance between inflow, star formation and outflow. */
export function drawBudgetPanel(ctx: CanvasRenderingContext2D, alpha: number): void {
  if (alpha <= 0) {
    return;
  }
  const w = 520;
  const h = 210;
  const x = W - 48 - w;
  const y = 200;
  panel(ctx, x, y, w, h, alpha);
  text(ctx, "THE GALAXY'S GAS BUDGET", x + 20, y + 32, "600 16px", "rgba(214, 208, 196, 0.8)");
  text(ctx, "star formation ≈ inflow / (1 + η)", x + 20, y + 80, "600 30px", "rgba(236, 233, 224, 0.95)");
  text(ctx, "η = outflow ÷ star formation (the mass loading)", x + 20, y + 118, "400 20px", "rgba(214, 208, 196, 0.85)");
  text(ctx, "A Milky Way-like galaxy: about 1–2 M☉ of new stars", x + 20, y + 156, "400 20px", "rgba(214, 208, 196, 0.85)");
  text(ctx, "per year, with η of order 1.", x + 20, y + 182, "400 20px", "rgba(214, 208, 196, 0.85)");
  ctx.globalAlpha = 1;
}

/** η against stellar mass from the FIRE simulations (Muratov et al. 2015): η ≈ 3.6 (M* / 10¹⁰ M☉)^−0.35. */
export function etaOf(stellarMass: number): number {
  return 3.6 * (stellarMass / 1e10) ** -0.35;
}

export const MW_STELLAR_MASS = 6e10;
export const DWARF_STELLAR_MASS = 1e8;

export function drawEtaPanel(ctx: CanvasRenderingContext2D, alpha: number): void {
  if (alpha <= 0) {
    return;
  }
  const w = 460;
  const h = 270;
  const x = W - 48 - w;
  const y = H - 48 - h;
  panel(ctx, x, y, w, h, alpha);
  text(ctx, "MASS LOADING", x + 20, y + 30, "600 16px", "rgba(214, 208, 196, 0.8)");
  text(ctx, "Muratov et al. (2015), FIRE", x + w - 20, y + 30, "400 15px", "rgba(214, 208, 196, 0.7)", "right");
  const left = x + 70;
  const right = x + w - 24;
  const top = y + 50;
  const bottom = y + h - 46;
  const X0 = 7;
  const X1 = 11.5;
  const Y0 = -0.5;
  const Y1 = 1.7;
  const px = (lm: number): number => left + ((lm - X0) / (X1 - X0)) * (right - left);
  const py = (le: number): number => bottom - ((le - Y0) / (Y1 - Y0)) * (bottom - top);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let lm = X0; lm <= X1 + 1e-9; lm += 0.1) {
    const le = Math.log10(etaOf(10 ** lm));
    if (lm === X0) {
      ctx.moveTo(px(lm), py(le));
    } else {
      ctx.lineTo(px(lm), py(le));
    }
  }
  ctx.stroke();
  for (const [v, label] of [
    [0, "1"],
    [1, "10"]
  ] as [number, string][]) {
    text(ctx, label, left - 10, py(v) + 5, "400 15px", "rgba(214, 208, 196, 0.75)", "right");
  }
  for (const lm of [8, 9, 10, 11]) {
    text(ctx, `10${["⁸", "⁹", "¹⁰", "¹¹"][lm - 8]}`, px(lm), bottom + 22, "400 15px", "rgba(214, 208, 196, 0.75)", "center");
  }
  text(ctx, "stars in the galaxy (M☉)", (left + right) / 2, bottom + 40, "400 15px", "rgba(214, 208, 196, 0.75)", "center");
  ctx.save();
  ctx.translate(x + 22, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  text(ctx, "η (outflow ÷ SFR)", 0, 0, "400 15px", "rgba(214, 208, 196, 0.75)", "center");
  ctx.restore();
  for (const [mass, label, color] of [
    [DWARF_STELLAR_MASS, "dwarf", "#ffc28a"],
    [MW_STELLAR_MASS, "Milky Way-like", "#9fd2ff"]
  ] as [number, string, string][]) {
    const lm = Math.log10(mass);
    const le = Math.log10(etaOf(mass));
    drawGlow(ctx, color, px(lm), py(le), 12, alpha, 0.5);
    text(ctx, `${label}: η ≈ ${Math.round(etaOf(mass))}`, px(lm) + (lm < 9 ? 16 : -16), py(le) - 14, "600 16px", color, lm < 9 ? "left" : "right");
  }
  ctx.globalAlpha = 1;
}
