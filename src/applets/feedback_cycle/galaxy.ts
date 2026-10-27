import { drawGlow } from "../../core/glowSprites";

/**
 * An illustrative face-on spiral galaxy (not simulated): exponential disk and bulge, two
 * logarithmic arms of blue gas with pink star-forming knots on their leading edges and dark dust
 * lanes on the inner side. It is drawn once into a texture; star-forming knots are redrawn live so
 * they can flicker on and off through the cycle in the closing shot.
 */

export const GALAXY_RADIUS_PC = 16000;
const TEX = 2400;
const TEX_SPAN_PC = 2 * GALAXY_RADIUS_PC;
const PX_PER_PC = TEX / TEX_SPAN_PC;
const PITCH = Math.tan((17 * Math.PI) / 180);
const ARM_START_PC = 1800;

function hash(i: number, salt: number): number {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function gauss(i: number, salt: number): number {
  const u1 = Math.max(1e-9, hash(i, salt));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * hash(i, salt + 0.5));
}

/** A point on arm `arm` (0 or 1) at radius r (pc): logarithmic spiral. */
function armAngle(arm: number, r: number): number {
  return arm * Math.PI + Math.log(r / ARM_START_PC) / PITCH;
}

/** The simulated patch sits on arm 0, about 8 kpc out. */
export const PATCH_RADIUS_PC = 8000;
export const PATCH_CENTER: [number, number] = [
  PATCH_RADIUS_PC * Math.cos(armAngle(0, PATCH_RADIUS_PC)),
  PATCH_RADIUS_PC * Math.sin(armAngle(0, PATCH_RADIUS_PC))
];

type Knot = { x: number; y: number; size: number; phase: number; rate: number };
let knots: Knot[] | null = null;
let texture: HTMLCanvasElement | null = null;

function armPoint(arm: number, r: number, scatter: number, i: number, salt: number): [number, number] {
  const a = armAngle(arm, r) + (scatter * gauss(i, salt)) / r;
  const rr = r + scatter * 0.5 * gauss(i, salt + 3);
  return [rr * Math.cos(a), rr * Math.sin(a)];
}

export function starFormingKnots(): Knot[] {
  if (!knots) {
    knots = [];
    for (let i = 0; i < 700; i += 1) {
      const arm = i % 2;
      const r = ARM_START_PC + (GALAXY_RADIUS_PC * 0.85 - ARM_START_PC) * Math.sqrt(hash(i, 1));
      const [x, y] = armPoint(arm, r * 1.03, 620, i, 2);
      knots.push({ x, y, size: 50 + 140 * hash(i, 4) ** 2, phase: hash(i, 5) * Math.PI * 2, rate: 0.6 + 0.8 * hash(i, 6) });
    }
  }
  return knots;
}

export function galaxyTexture(): HTMLCanvasElement {
  if (texture) {
    return texture;
  }
  texture = document.createElement("canvas");
  texture.width = TEX;
  texture.height = TEX;
  const g = texture.getContext("2d") as CanvasRenderingContext2D;
  const c = TEX / 2;
  const toPx = (pc: number): number => c + pc * PX_PER_PC;
  // Old stars: an exponential disk and a bulge.
  const disk = g.createRadialGradient(c, c, 0, c, c, GALAXY_RADIUS_PC * PX_PER_PC);
  disk.addColorStop(0, "rgba(255, 236, 205, 0.55)");
  disk.addColorStop(0.25, "rgba(220, 205, 190, 0.22)");
  disk.addColorStop(0.6, "rgba(160, 170, 200, 0.07)");
  disk.addColorStop(1, "rgba(120, 140, 200, 0)");
  g.fillStyle = disk;
  g.fillRect(0, 0, TEX, TEX);
  g.globalCompositeOperation = "lighter";
  drawGlow(g, "#ffe2b0", c, c, 1600 * PX_PER_PC * 1.8, 0.5, 0.35);
  // Disk stars.
  for (let i = 0; i < 16000; i += 1) {
    const r = -3200 * Math.log(1 - 0.995 * hash(i, 11));
    const a = hash(i, 12) * Math.PI * 2;
    g.globalAlpha = 0.25 + 0.35 * hash(i, 13);
    g.fillStyle = hash(i, 14) < 0.5 ? "#fff1dc" : "#dfe6ff";
    g.fillRect(toPx(r * Math.cos(a)), toPx(r * Math.sin(a)), 1.2, 1.2);
  }
  // Gas between the arms: a faint blue haze over the whole disk.
  for (let i = 0; i < 2200; i += 1) {
    const r = -4500 * Math.log(1 - 0.97 * hash(i, 41));
    const a = hash(i, 42) * Math.PI * 2;
    drawGlow(g, "#4d6fd0", toPx(r * Math.cos(a)), toPx(r * Math.sin(a)), (400 + 700 * hash(i, 43)) * PX_PER_PC, 0.035, 0.5);
  }
  // Arms: broad lanes of blue gas, brightest along their crests.
  for (let i = 0; i < 6000; i += 1) {
    const arm = i % 2;
    const r = ARM_START_PC + (GALAXY_RADIUS_PC * 0.95 - ARM_START_PC) * Math.sqrt(hash(i, 21));
    const spread = i % 3 === 0 ? 1300 : 650;
    const [x, y] = armPoint(arm, r, spread, i, 22);
    drawGlow(g, hash(i, 24) < 0.7 ? "#5e8cff" : "#8fb2ff", toPx(x), toPx(y), (220 + 520 * hash(i, 23)) * PX_PER_PC, 0.08, 0.5);
  }
  // Dust lanes on the inner edge of each arm.
  g.globalCompositeOperation = "source-over";
  for (let i = 0; i < 1500; i += 1) {
    const arm = i % 2;
    const r = ARM_START_PC + (GALAXY_RADIUS_PC * 0.8 - ARM_START_PC) * Math.sqrt(hash(i, 31));
    const [x, y] = armPoint(arm, r * 0.93, 260, i, 32);
    const rad = (90 + 200 * hash(i, 33)) * PX_PER_PC;
    const dust = g.createRadialGradient(toPx(x), toPx(y), 0, toPx(x), toPx(y), rad);
    dust.addColorStop(0, "rgba(20, 12, 10, 0.35)");
    dust.addColorStop(1, "rgba(20, 12, 10, 0)");
    g.globalAlpha = 1;
    g.fillStyle = dust;
    g.fillRect(toPx(x) - rad, toPx(y) - rad, rad * 2, rad * 2);
  }
  g.globalAlpha = 1;
  return texture;
}

export type GalaxyView = { k: number; camX: number; camY: number; w: number; h: number };

/** Draw the galaxy texture for a camera (k = pixels per pc, centred on camX, camY in pc). */
export function drawGalaxy(ctx: CanvasRenderingContext2D, view: GalaxyView, alpha: number): void {
  if (alpha <= 0) {
    return;
  }
  const size = TEX_SPAN_PC * view.k;
  const x = view.w / 2 + (-GALAXY_RADIUS_PC - view.camX) * view.k;
  const y = view.h / 2 + (-GALAXY_RADIUS_PC - view.camY) * view.k;
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(galaxyTexture(), x, y, size, size);
  ctx.globalAlpha = 1;
}

/**
 * Pink H II regions along the arms. With `flicker` > 0 each one waxes and wanes on its own
 * rhythm: a burst of star formation, feedback switching it off, and a new burst.
 */
export function drawKnots(ctx: CanvasRenderingContext2D, view: GalaxyView, alpha: number, flicker: number, time: number): void {
  if (alpha <= 0) {
    return;
  }
  for (const k of starFormingKnots()) {
    const x = view.w / 2 + (k.x - view.camX) * view.k;
    const y = view.h / 2 + (k.y - view.camY) * view.k;
    const r = Math.max(1.5, k.size * view.k);
    if (x < -r || x > view.w + r || y < -r || y > view.h + r) {
      continue;
    }
    const cycle = 0.5 + 0.5 * Math.sin(time * k.rate + k.phase);
    const on = 1 - flicker + flicker * cycle ** 2;
    drawGlow(ctx, "#ff5fa8", x, y, r * 1.6, alpha * 0.55 * on, 0.45);
    drawGlow(ctx, "#a9d4ff", x + r * 0.2, y - r * 0.15, r * 0.7, alpha * 0.6 * on, 0.4);
  }
}
