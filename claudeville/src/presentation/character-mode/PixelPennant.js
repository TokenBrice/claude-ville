// 6.5 — pixel pennants and flags. Every pennant and flag in the village (the
// occupancy pennant, the Harbor mast pennants, the ships' repo flags and
// pennons, the dock mini-pennants, the 6.7 Harbor bunting) is a blit of one
// authored strip, `sprites/overlays/pennant.strip.png`: 4 frames of 24×16,
// five indexed tones (rim, accent, shade, pole, finial), frame 1 the calm
// rest pose. A recolour per accent is cached (bounded); no path, no
// anti-aliased polygon, every texel on the art grid.
//
// Motion: stepped at 4 fps on the one clock, driven by the C-W3 wind — the
// cloth flies downwind (mirrored when the wind blows toward screen left, so
// pennants agree with smoke, rain and cloud drift) and hangs still on its rest
// frame when the air is calm (fog) and under reduced motion. Truth (V3): the
// flutter reads only the village's own weather, never agent state.

import { baseWindX } from './Wind.js';

export const PENNANT_STRIP_URL = 'assets/sprites/overlays/pennant.strip.png';
export const PENNANT_FRAME_W = 24;
export const PENNANT_FRAME_H = 16;
export const PENNANT_FRAMES = 4;
export const PENNANT_REST_FRAME = 1;
export const PENNANT_FPS = 4;
// Below this knot wind the cloth hangs on its rest frame (fog is 0.1).
export const PENNANT_CALM_WIND = 0.15;
// The pole's left column in an unmirrored frame; mirrored, the pole sits at
// PENNANT_FRAME_W - 1 - (this + 1).
const POLE_X = 1;
// Authored index tones.
const KEY = Object.freeze({
    rim: [0x3a, 0x26, 0x14],
    accent: [0xd6, 0xa9, 0x51],
    shade: [0x8f, 0x6a, 0x2e],
    pole: [0x4a, 0x33, 0x22],
    finial: [0xe8, 0xc8, 0x76],
});
const CACHE_LIMIT = 48;

let strip = null;
let stripPixels = null;
const cache = new Map();

function loadStrip() {
    if (strip || typeof Image === 'undefined') return;
    strip = new Image();
    strip.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = strip.width;
        canvas.height = strip.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(strip, 0, 0);
        stripPixels = ctx.getImageData(0, 0, strip.width, strip.height);
    };
    strip.src = PENNANT_STRIP_URL;
}

function parseHex(value) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) {
        const n = Number.parseInt(text.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const hsl = text.match(/^hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i);
    if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
    const rgb = text.match(/^rgba?\(([^)]+)\)/i);
    if (rgb) return rgb[1].split(',').slice(0, 3).map((part) => Math.round(Number.parseFloat(part)));
    return null;
}

function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}

function scaled(rgb, k) {
    return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
}

function same(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Tones of a pennant: `{ accent, shade?, rim?, grade? }` as CSS colours. The
 * shade and rim default to the accent stepped down (0.62 / 0.3). `grade(css)`
 * (optional) maps every tone, pole and finial included, through the frame's
 * C2 grade for the ungraded resident overlay.
 */
function tonesFor({ accent, shade = null, rim = null, grade = null }) {
    const base = parseHex(accent) || KEY.accent;
    const tones = {
        accent: base,
        shade: parseHex(shade) || scaled(base, 0.62),
        rim: parseHex(rim) || scaled(base, 0.3),
        pole: KEY.pole,
        finial: KEY.finial,
    };
    if (typeof grade !== 'function') return tones;
    for (const name of Object.keys(tones)) {
        tones[name] = parseHex(grade(`#${tones[name].map((c) => c.toString(16).padStart(2, '0')).join('')}`)) || tones[name];
    }
    return tones;
}

// The recoloured strip for one set of tones, mirrored or not: a canvas of
// PENNANT_FRAMES frames. Null until the strip has loaded.
function recoloured(tones, mirror) {
    loadStrip();
    if (!stripPixels) return null;
    const key = `${tones.accent}|${tones.shade}|${tones.rim}|${tones.pole}|${tones.finial}|${mirror ? 1 : 0}`;
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    const { width, height, data } = stripPixels;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (!data[i + 3]) continue;
            const frame = Math.floor(x / PENNANT_FRAME_W);
            const local = x - frame * PENNANT_FRAME_W;
            const dx = mirror ? frame * PENNANT_FRAME_W + (PENNANT_FRAME_W - 1 - local) : x;
            const o = (y * width + dx) * 4;
            const src = [data[i], data[i + 1], data[i + 2]];
            const tone = same(src, KEY.accent) ? tones.accent
                : same(src, KEY.shade) ? tones.shade
                    : same(src, KEY.rim) ? tones.rim
                        : same(src, KEY.pole) ? tones.pole
                            : same(src, KEY.finial) ? tones.finial
                                : src;
            out.data[o] = tone[0];
            out.data[o + 1] = tone[1];
            out.data[o + 2] = tone[2];
            out.data[o + 3] = data[i + 3];
        }
    }
    ctx.putImageData(out, 0, 0);
    cache.set(key, canvas);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return canvas;
}

/**
 * The flutter frame at motion-clock `tMs` for knot wind `windX`: the rest
 * frame when calm or when motion is off, else a 4 fps step through the strip
 * (`phase` offsets neighbours so a row of pennants never beats in unison).
 */
export function pennantFrame(tMs, windX, { motion = true, phase = 0 } = {}) {
    if (!motion || !(Math.abs(Number(windX) || 0) >= PENNANT_CALM_WIND)) return PENNANT_REST_FRAME;
    const step = Math.floor((Number(tMs) || 0) * PENNANT_FPS / 1000) + Math.round(phase);
    return ((step % PENNANT_FRAMES) + PENNANT_FRAMES) % PENNANT_FRAMES;
}

/** Knot wind of `weather` (an AtmosphereState weather or snapshot). */
export function pennantWind(weather) {
    return baseWindX(weather);
}
/**
 * Blits one pennant with its pole foot at the art-grid point (x, y). The
 * cloth flies toward +x when `windX >= 0` and mirrors toward -x otherwise;
 * the pole stays on (x, y) either way. `withPole: false` draws the cloth
 * alone (bunting on a line, flags on a mast). Returns false until the strip
 * has loaded.
 */
export function drawPennant(ctx, x, y, { accent, shade = null, rim = null, grade = null, frame = PENNANT_REST_FRAME, windX = 1, withPole = true } = {}) {
    const mirror = Number(windX) < 0;
    const canvas = recoloured(tonesFor({ accent, shade, rim, grade }), mirror);
    if (!canvas) return false;
    const poleLeft = mirror ? PENNANT_FRAME_W - 2 - POLE_X : POLE_X;
    const dx = Math.round(x) - poleLeft;
    const dy = Math.round(y) - PENNANT_FRAME_H;
    const sx = frame * PENNANT_FRAME_W;
    if (withPole) {
        ctx.drawImage(canvas, sx, 0, PENNANT_FRAME_W, PENNANT_FRAME_H, dx, dy, PENNANT_FRAME_W, PENNANT_FRAME_H);
        return true;
    }
    // Cloth only (bunting on a line, flags on a mast): skip the pole columns.
    const clothLeft = mirror ? 0 : POLE_X + 2;
    const clothWidth = PENNANT_FRAME_W - (POLE_X + 2);
    ctx.drawImage(canvas, sx + clothLeft, 0, clothWidth, PENNANT_FRAME_H, dx + clothLeft, dy, clothWidth, PENNANT_FRAME_H);
    return true;
}

// The frame's knot wind and motion-clock time, published once per update by
// the renderer so every pennant drawer (buildings, ships, docks) steps the
// same frame from the same wind without each owning the atmosphere.
const shared = { windX: baseWindX(null), tMs: 0 };

export function setPennantWeather(weather, tMs) {
    shared.windX = baseWindX(weather);
    shared.tMs = Number(tMs) || 0;
}

export function currentPennantWind() {
    return shared.windX;
}

export function currentPennantTime() {
    return shared.tMs;
}

// Tip lift of the small dock pennant per strip frame (texels).
const MINI_TIP = Object.freeze([-1, 1, 0, 2]);

/**
 * A small pennant (8×6 cloth on a 1-texel pole, pole foot at (x, y)) for
 * places the 24×16 strip does not fit — the dock plate poles. Same frame
 * clock and wind as the strip; every texel a whole-pixel rect.
 */
export function drawMiniPennant(ctx, x, y, { accent, shade = null, frame = PENNANT_REST_FRAME, windX = 1, pole = '#4a3322' } = {}) {
    const base = parseHex(accent) || KEY.accent;
    const cloth = `rgb(${base.join(', ')})`;
    const hem = shade || `rgb(${scaled(base, 0.62).join(', ')})`;
    const dir = Number(windX) < 0 ? -1 : 1;
    const px = Math.round(x);
    const py = Math.round(y);
    ctx.fillStyle = pole;
    ctx.fillRect(px, py - 11, 1, 11);
    const tip = MINI_TIP[frame] ?? 0;
    for (let i = 0; i < 8; i++) {
        const h = Math.max(1, Math.round(6 * (1 - i / 8)));
        const top = py - 11 + ((6 - h) >> 1) + Math.round(tip * i / 7);
        const cx = dir > 0 ? px + 1 + i : px - 1 - i;
        ctx.fillStyle = cloth;
        ctx.fillRect(cx, top, 1, Math.max(1, h - 1));
        ctx.fillStyle = hem;
        ctx.fillRect(cx, top + h - 1, 1, 1);
    }
}

// W7.4 (D2: squad = shape) — the squad standard: a small swallowtail pennon
// (8×6 cloth on a 12-texel pole, about knee-to-hip on a villager) standing on
// the ground beside a squad leader's feet, its cloth in the leader's repo
// accent and carrying one of four devices that match the squad's tether
// pattern. Static: no flutter and no wind (the motion budget row is
// `static`); whole-texel fills only, so the ground cue recorder takes it on
// the resident path too.
export const SQUAD_DEVICES = Object.freeze([
    Object.freeze([[2, 2], [3, 2], [2, 3], [3, 3]]), // dot
    Object.freeze([[2, 1], [2, 2], [2, 3], [2, 4]]), // bar
    Object.freeze([[2, 2], [2, 3], [4, 2], [4, 3]]), // pair
    Object.freeze([[2, 1], [3, 2], [3, 3], [2, 4]]), // chevron
]);
// Row spans of the cloth, top to bottom: [first column, length]. Rows 2–3
// stop short, which cuts the swallowtail.
const SQUAD_CLOTH = Object.freeze([[0, 7], [0, 8], [0, 6], [0, 6], [0, 8], [0, 7]]);
const SQUAD_POLE_H = 12;

function squadClothHas(cx, cy) {
    const row = SQUAD_CLOTH[cy];
    return Boolean(row) && cx >= row[0] && cx < row[0] + row[1];
}

/**
 * Draws a squad pennon with its pole foot at the art-grid point (x, y). The
 * caller supplies graded colours: `accent` cloth, `shade` lower course,
 * `device` the squad's mark, `rim` the outline, `pole` the staff. `facing`
 * 1 flies the cloth to the right of the pole, -1 mirrors it to the left.
 */
export function drawSquadPennon(ctx, x, y, {
    accent,
    shade = null,
    device = '#efe6cf',
    rim = '#1c130d',
    pole = '#5a3d26',
    deviceIndex = 0,
    facing = 1,
} = {}) {
    if (!ctx || !accent) return;
    const px = Math.round(x);
    const py = Math.round(y);
    const dir = facing < 0 ? -1 : 1;
    const top = py - SQUAD_POLE_H + 1;
    const clothY = top + 1;
    // Cloth column `cx` (0 at the pole) to a world column, either way out.
    const col = (cx) => px + dir * (cx + 1);
    // Rim first: every texel next to the cloth or the pole that is neither.
    ctx.fillStyle = rim;
    ctx.fillRect(px - 1, top - 1, 3, SQUAD_POLE_H + 1);
    for (let cy = -1; cy <= SQUAD_CLOTH.length; cy++) {
        for (let cx = 0; cx <= 9; cx++) {
            if (squadClothHas(cx, cy)) continue;
            if (squadClothHas(cx - 1, cy) || squadClothHas(cx + 1, cy)
                || squadClothHas(cx, cy - 1) || squadClothHas(cx, cy + 1)) {
                ctx.fillRect(col(cx), clothY + cy, 1, 1);
            }
        }
    }
    ctx.fillStyle = pole;
    ctx.fillRect(px, top, 1, SQUAD_POLE_H);
    ctx.fillStyle = device;
    ctx.fillRect(px, top - 1, 1, 1);
    const shadeRgb = shade || (() => {
        const rgb = parseHex(accent);
        return rgb ? `rgb(${scaled(rgb, 0.62).join(',')})` : accent;
    })();
    SQUAD_CLOTH.forEach(([start, length], cy) => {
        ctx.fillStyle = cy >= SQUAD_CLOTH.length - 2 ? shadeRgb : accent;
        const a = col(start);
        const b = col(start + length - 1);
        ctx.fillRect(Math.min(a, b), clothY + cy, length, 1);
    });
    ctx.fillStyle = device;
    const cells = SQUAD_DEVICES[((deviceIndex % SQUAD_DEVICES.length) + SQUAD_DEVICES.length) % SQUAD_DEVICES.length];
    for (const [cx, cy] of cells) ctx.fillRect(col(cx), clothY + cy, 1, 1);
}
