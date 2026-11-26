#!/usr/bin/env node
// Deterministic pixel-art baker for the v0.69 E2 Runic Tide-Terrace:
//   1. prop.quotaTerraceApron (.png, .material.png, .occluder.png) — 144x80
//      weathered isometric ashlar flagstone sundial terrace with 4 carved
//      plinth sockets and inset weathered bronze sundial ring.
//   2. prop.quotaPillar (.png, .emissive.png, .material.png, .occluder.png) —
//      32x68 isometric carved stone gauge pillar with stepped plinth, chamfered
//      ashlar shaft, recessed 5-course rune channel, and lantern-crown finial.
//   3. prop.quotaPillarStrip (.png, .emissive.png) — N-provider strip
//      (4 x (9 states + 15 spend shimmer cells) = 96 cells of 16x48) stamped
//      into each pillar's recess; `.emissive.png` gives lit crystal courses,
//      peak flash, and LIMIT seal a low-alpha night glow (l0 & unknown dark).
//
// Zero anti-aliasing, zero semi-alpha pixels, <= 48 unique colours per prop,
// <= 5% Tier-A share, 100% #060402 warm-ink silhouette outline.
//
// Usage:
//   node scripts/sprites/bake-quota-terrace.mjs            write all PNGs
//   node scripts/sprites/bake-quota-terrace.mjs --check    verify byte-exact match

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';
import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';
import { QUOTA_TERRACE_PROVIDERS, QUOTA_TERRACE_SLOTS } from '../../claudeville/src/config/scenery.js';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    QUOTA_PILLAR_LEVELS,
    QUOTA_PILLAR_STATES,
    QUOTA_PILLAR_STREAM_PHASES,
    QUOTA_PILLAR_STRIP_FRAME,
    QUOTA_PILLAR_STRIP_ORIGIN,
    quotaPillarStateCell,
    quotaPillarStreamCell,
    quotaPillarStripCellCount,
} from '../../claudeville/src/presentation/character-mode/QuotaTerrace.js';
import { encodeSurface, SURFACE_FACE } from './bake-surface-channel.mjs';

const PROPS_DIR = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

const INK = Object.freeze([0x06, 0x04, 0x02]);
const ASHLAR = ART_RAMPS.ashlar.map(hex);
const PLAZA = ART_RAMPS.plaza.map(hex);
const PLAZA_COOL = ART_RAMPS.plazaCool.map(hex);
const SLATE = ART_RAMPS.slate.map(hex);
const FOLIAGE = ART_RAMPS.foliage.map(hex);
const CLOTH_OCHRE = ART_RAMPS.clothOchre.map(hex);
const TRIM_GOLD = ART_RAMPS.trimGold.map(hex);
const EMISSIVE = ART_RAMPS.emissive.map(hex);
const PEAK = hex(EFFECT_COLORS.peak);
const PEAK_EDGE = hex('#d9c88a');

// Muted rate-limit orchid-crimson / berry-rose wax seal for LIMIT (clearly
// distinct from Claude's lavender-plum courses and Tier-A errored/rate_limited:
// OKLab C <= 0.104, dE >= 0.095 from every STATUS_VISUALS hue).
const SEAL = Object.freeze({
    shade: hex('#59273f'),
    mid: hex('#803d5a'),
    body: hex('#a35978'),
    glint: hex('#c2829c'),
});

// Tier-B provider house ramps (every stop held strictly below Tier-A:
// OKLab chroma <= 0.105, OKLab dE >= 0.07 from every STATUS_VISUALS hue,
// luminance <= 0.70, HSV saturation <= 0.65; unified with theme.js PROVIDER_HUES).
export const PROVIDER_PALETTES = Object.freeze({
    claude: Object.freeze({
        shadow: hex('#4e3b69'),
        body: hex('#765c96'),
        light: hex('#977bb5'),
        glint: hex('#b69dcf'),
    }),
    codex: Object.freeze({
        shadow: hex('#20444d'),
        body: hex('#366e75'),
        light: hex('#529992'),
        glint: hex('#78b3aa'),
    }),
    glm: Object.freeze({
        shadow: hex('#572c25'),
        body: hex('#824638'),
        light: hex('#a45e4a'),
        glint: hex('#b8806a'),
    }),
    antigravity: Object.freeze({
        shadow: hex('#253859'),
        body: hex('#3f618f'),
        light: hex('#5a82b0'),
        glint: hex('#769ec7'),
    }),
});

export const APRON_SPEC = Object.freeze({
    width: 144,
    height: 80,
    anchor: Object.freeze([72, 46]),
});

export const PILLAR_SPEC = Object.freeze({
    width: 32,
    height: 68,
    anchor: Object.freeze([16, 60]),
});

function hash2d(x, y) {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x5bf03635;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}

function makeCanvas(width, height) {
    const png = new PNG({ width, height, colorType: 6 });
    const material = new PNG({ width, height, colorType: 6 });
    const occluder = new PNG({ width, height, colorType: 6 });
    const set = (x, y, rgb, kind = 'stone', face = SURFACE_FACE.up, h = 0) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const i = (y * width + x) * 4;
        png.data[i] = rgb[0];
        png.data[i + 1] = rgb[1];
        png.data[i + 2] = rgb[2];
        png.data[i + 3] = 255;
        material.data[i] = materialClassId(kind);
        material.data[i + 1] = 0;
        material.data[i + 2] = 0;
        material.data[i + 3] = 255;
        const { r, b } = encodeSurface(face, Math.max(0, Math.min(255, Math.round(h))));
        occluder.data[i] = r;
        occluder.data[i + 1] = 255;
        occluder.data[i + 2] = b;
        occluder.data[i + 3] = 255;
    };
    const opaque = (x, y) => x >= 0 && y >= 0 && x < width && y < height && png.data[(y * width + x) * 4 + 3] > 0;
    const outline = (defaultFace = SURFACE_FACE.left, heightFor = () => 1) => {
        const ring = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (opaque(x, y)) continue;
                if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
                    ring.push([x, y]);
                }
            }
        }
        for (const [x, y] of ring) {
            const face = typeof defaultFace === 'function' ? defaultFace(x, y) : defaultFace;
            set(x, y, INK, 'stone', face, heightFor(x, y));
        }
    };
    return { png, material, occluder, set, opaque, outline };
}

// ─── 1. prop.quotaTerraceApron (144x80, anchor [72, 46]) ───────────────────

export function bakeApron() {
    const { width: W, height: H, anchor } = APRON_SPEC;
    const [cx, cy] = anchor;
    const art = makeCanvas(W, H);

    // Chamfered 2:1 isometric terrace deck (top surface at elevation 4 px) with
    // a stepped 2-riser SE front landing lip.
    const inMainDeck = (dx, dy) => {
        const y = dy + 3;
        if (Math.abs(dx) > 65 || Math.abs(y) > 27) return false;
        const man = Math.abs(dx) / 68 + Math.abs(y) / 34;
        if (man > 1.21) return false;
        // Gentle bevel on the two back shoulders to hug the crescent nicely.
        if (y < -15 && Math.abs(dx) > 46) return false;
        return true;
    };
    const inFrontStep = (dx, dy) => {
        if (dy < 22 || dy > 26) return false;
        const halfW = 22 - (dy - 22) * 2;
        return Math.abs(dx) <= halfW;
    };
    const inDeck = (dx, dy) => inMainDeck(dx, dy) || inFrontStep(dx, dy);

    const sockets = QUOTA_TERRACE_SLOTS.map((slot) => ({
        provider: slot.provider,
        sx: cx + slot.apronOffset[0],
        sy: cy + slot.apronOffset[1],
    }));

    // Sundial center in front-center of the crescent.
    const dialX = cx;
    const dialY = cy + 7;

    // 1a. Draw the 4px cut-stone riser rim beneath the terrace deck.
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            if (inDeck(dx, dy)) continue;
            let drop = 0;
            for (let d = 1; d <= 5; d++) {
                if (inDeck(dx, dy - d)) {
                    drop = d;
                    break;
                }
            }
            if (!drop) continue;
            const east = dx >= 0;
            const joint = ((x + (drop > 2 ? 4 : 0)) % 9) === 0;
            const course = drop === 3;
            let color;
            if (joint || course) color = ASHLAR[2];
            else if (drop === 5) color = east ? ASHLAR[2] : ASHLAR[3];
            else if (drop === 1) color = east ? ASHLAR[4] : ASHLAR[6];
            else color = east ? ASHLAR[3] : ASHLAR[5];
            // Sparse mossy flecks nestled along the base where stone meets turf.
            if (drop >= 4 && (hash2d(x, y) & 15) === 0) color = FOLIAGE[1];
            art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, Math.max(1, 5 - drop));
        }
    }

    // 1b. Draw the ashlar flagstone terrace deck surface.
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            if (!inDeck(dx, dy)) continue;
            const onStep = !inMainDeck(dx, dy);

            // Distance to deck border (for dressed stone curb).
            const nearEdge = !inDeck(dx - 2, dy) || !inDeck(dx + 2, dy) || !inDeck(dx, dy - 1) || !inDeck(dx, dy + 1);
            const litEdge = (!inDeck(dx - 1, dy) || !inDeck(dx, dy - 1)) && (dx <= 14 || dy <= 0);
            const shadeEdge = !inDeck(dx + 1, dy) || !inDeck(dx, dy + 1);

            // Isometric 2:1 running-bond flagstone coordinates.
            const u = Math.floor((dx + dy * 2) / 14);
            const v = Math.floor((dy * 2 - dx) / 14);
            const uOff = (v & 1) * 7;
            const lu = (((dx + dy * 2 + uOff) % 14) + 14) % 14;
            const lv = (((dy * 2 - dx) % 14) + 14) % 14;
            const mortar = lu === 0 || lv === 0;
            const bevel = !mortar && (lu === 1 || lv === 1);
            const tileHash = hash2d(u + 100, v + 100);
            const cool = (tileHash % 3) === 0;
            const tone = tileHash % 4;
            const ramp = cool ? PLAZA_COOL : PLAZA;

            let color;
            let kind = 'stone';
            if (onStep) {
                const stepEdge = dy === 22 || dy === 25;
                color = stepEdge ? ASHLAR[7] : (mortar ? ASHLAR[3] : ASHLAR[5]);
            } else if (litEdge) {
                color = ASHLAR[8];
            } else if (shadeEdge) {
                color = dx >= 0 ? ASHLAR[4] : ASHLAR[6];
            } else if (nearEdge) {
                const curbJoint = ((x + y * 2) % 8) === 0;
                color = curbJoint ? ASHLAR[3] : (dx < 0 ? ASHLAR[7] : ASHLAR[5]);
            } else if (mortar) {
                color = (lu === 0 && lv === 0) ? ASHLAR[1] : ASHLAR[2];
            } else if (bevel) {
                color = cool ? PLAZA_COOL[4] : ASHLAR[8];
            } else {
                const idx = tone === 0 ? 1 : tone === 1 ? 2 : tone === 2 ? 3 : 2;
                color = ramp[idx];
                // Subtle chiseled stone grain on ~1/6 of interior texels.
                const grain = hash2d(x * 3, y * 5) % 9;
                if (grain === 0) color = ramp[Math.max(0, idx - 1)];
                else if (grain === 1) color = ramp[Math.min(4, idx + 1)];
            }

            // 1c. Inset weathered bronze sundial / tide-compass ring at center-front.
            const sdx = x - dialX;
            const sdy = y - dialY;
            const isoR = Math.hypot(sdx / 22, sdy / 11);
            if (isoR <= 1.12 && !onStep) {
                if (isoR >= 0.96 && isoR <= 1.09) {
                    // Recessed weathered stone ring bevel.
                    color = sdy < 0 ? ASHLAR[2] : ASHLAR[7];
                } else if (isoR >= 0.72 && isoR < 0.96) {
                    // Weathered bronze sundial band with 8 compass hour ticks.
                    const ang = Math.atan2(sdy * 2, sdx);
                    const sector = ((ang / Math.PI) * 4 + 8) % 1;
                    const isTick = sector < 0.14 || sector > 0.86;
                    kind = 'metal';
                    if (isTick) {
                        color = TRIM_GOLD[0];
                    } else {
                        const litBronze = sdx + sdy * 2 < 0;
                        color = litBronze ? CLOTH_OCHRE[1] : CLOTH_OCHRE[0];
                        if (isoR > 0.88 && litBronze) color = TRIM_GOLD[1];
                    }
                } else if (isoR >= 0.64 && isoR < 0.72) {
                    color = ASHLAR[3];
                } else if (isoR < 0.64) {
                    // Inner carved limestone sundial medallion + tapered 4-point compass rose.
                    const onV = Math.abs(sdx) <= (Math.abs(sdy) <= 2 ? 1 : 0) && Math.abs(sdy) <= 5;
                    const onH = Math.abs(sdy) <= (Math.abs(sdx) <= 4 ? 1 : 0) && Math.abs(sdx) <= 10;
                    const onCenter = Math.abs(sdx) <= 1 && Math.abs(sdy) <= 1;
                    if (onCenter) {
                        kind = 'metal';
                        color = sdx <= 0 && sdy <= 0 ? TRIM_GOLD[1] : TRIM_GOLD[0];
                    } else if (onV || onH) {
                        kind = 'metal';
                        color = (sdx < 0 || sdy < 0) ? CLOTH_OCHRE[1] : CLOTH_OCHRE[0];
                    } else {
                        const innerRing = isoR > 0.44 && isoR < 0.52;
                        color = innerRing ? PLAZA_COOL[2] : ((sdx + sdy) < 0 ? PLAZA_COOL[4] : PLAZA_COOL[3]);
                    }
                }
            }

            // 1d. Four carved stepped plinth sockets aligned to pillar world feet.
            for (const sock of sockets) {
                const px = x - sock.sx;
                const py = y - sock.sy;
                const man = Math.abs(px) / 14 + Math.abs(py) / 7;
                if (man <= 1.0) {
                    kind = 'stone';
                    if (man >= 0.84) {
                        color = (px + py * 2 < 0) ? ASHLAR[8] : ASHLAR[3];
                    } else if (man >= 0.62) {
                        color = (px < 0) ? ASHLAR[6] : ASHLAR[4];
                    } else {
                        // Dark carved mortise seating pocket under pillar base.
                        color = (man < 0.35) ? ASHLAR[1] : ASHLAR[2];
                    }
                }
            }

            art.set(x, y, color, kind, SURFACE_FACE.up, onStep ? 2 : 4);
        }
    }

    // 1e. Crisp 1px warm-ink outer silhouette where the terrace meets turf.
    art.outline((x) => (x < cx ? SURFACE_FACE.left : SURFACE_FACE.right), () => 1);
    return art;
}

// ─── 2. prop.quotaPillar (32x68, anchor [16, 60]) ──────────────────────────

export function bakePillar() {
    const { width: W, height: H } = PILLAR_SPEC;
    const art = makeCanvas(W, H);
    const emissive = new PNG({ width: W, height: H, colorType: 6 });

    const setEmissive = (x, y, rgb, alpha) => {
        const i = (y * W + x) * 4;
        emissive.data[i] = rgb[0];
        emissive.data[i + 1] = rgb[1];
        emissive.data[i + 2] = rgb[2];
        emissive.data[i + 3] = alpha;
    };

    const cx = 16;

    // 2a. Solid stepped isometric ashlar pedestal plinth (y = 50..65).
    // Flares cleanly outward from the shaft (18px -> 22px -> 26px) with zero
    // inward waist pinch, sitting on a true 2:1 isometric diamond footprint.
    for (let y = 55; y <= 65; y++) {
        for (let x = 3; x <= 28; x++) {
            const dx = x - cx;
            const adx = Math.abs(dx);
            if (adx > 12) continue;
            const topY = 55 + Math.floor(adx / 3);
            const botY = 65 - Math.floor(adx / 2);
            if (y < topY || y > botY) continue;
            const east = dx >= 0;
            const h = Math.max(1, 65 - y);
            if (y <= topY + 1) {
                const color = y === topY ? (east ? ASHLAR[6] : ASHLAR[8]) : (east ? ASHLAR[5] : ASHLAR[7]);
                art.set(x, y, color, 'stone', SURFACE_FACE.up, h);
            } else {
                const joint = (adx === 5 && y >= 58) || (dx === 0 && y >= 59);
                const course = y === botY - 2;
                let color = east ? ASHLAR[3] : ASHLAR[6];
                if (joint || course) color = ASHLAR[2];
                else if (y === botY) color = east ? ASHLAR[2] : ASHLAR[4];
                else if (!east && dx <= -8) color = ASHLAR[7];
                art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
            }
        }
    }

    // Upper stepped pedestal collar (y = 50..59, width 22px, x = 5..26).
    for (let y = 50; y <= 60; y++) {
        for (let x = 5; x <= 26; x++) {
            const dx = x - cx;
            const adx = Math.abs(dx);
            if (adx > 10) continue;
            const topY = 50 + Math.floor(adx / 4);
            const botY = 60 - Math.floor(adx / 2);
            if (y < topY || y > botY) continue;
            const east = dx >= 0;
            const h = 65 - y;
            if (y === topY) {
                art.set(x, y, east ? ASHLAR[6] : ASHLAR[8], 'stone', SURFACE_FACE.up, h);
            } else {
                const joint = adx === 5 || (dx === 0 && y >= 53);
                const bottomRim = y === botY;
                let color = east ? ASHLAR[4] : ASHLAR[7];
                if (joint) color = ASHLAR[2];
                else if (bottomRim) color = east ? ASHLAR[2] : ASHLAR[5];
                art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
            }
        }
    }

    // 2b. Chamfered 2:1 isometric carved stone shaft (y = 16..52, x = 7..25):
    //   - sunlit SW cheek (x = 7..10)
    //   - recessed 5-course gauge channel (x = 11..20)
    //   - shaded front-right niche frame (x = 21..22)
    //   - 3px deep-shaded SE right-side bevel return facet (x = 23..25) stepping
    //     up in true 2:1 isometric slope to match the corner-on plinth below
    //     while staying within x <= 26 (clean separation between spaced pillars).
    for (let y = 16; y <= 52; y++) {
        for (let x = 7; x <= 25; x++) {
            const dx = x - cx;
            const adx = Math.abs(dx);
            const seBevel = x >= 23;
            const shaftTopY = seBevel ? (16 - Math.floor((x - 22) / 2)) : 16;
            const shaftBotY = seBevel
                ? (51 - Math.floor((x - 21) / 2))
                : (52 - Math.floor(adx / 3));
            if (y < shaftTopY || y > shaftBotY) continue;
            const h = 65 - y;
            const east = dx >= 0;

            // Shaded 2:1 SE right-side bevel return facet (x = 23..25).
            if (seBevel) {
                const bevelY = y + Math.floor((x - 22) / 2);
                const courseJoint = bevelY === 22 || bevelY === 28 || bevelY === 34 || bevelY === 40 || bevelY === 46;
                let color;
                if (courseJoint) {
                    color = INK;
                } else if (x === 23) {
                    // Crisp chamfer arris catching bounce light along each block top.
                    color = ((bevelY % 6) === 1) ? ASHLAR[5] : ((bevelY % 6) === 2 ? ASHLAR[4] : ASHLAR[2]);
                } else if (x === 25) {
                    color = ((bevelY % 6) === 1) ? ASHLAR[3] : ASHLAR[1];
                } else {
                    color = ((bevelY % 6) === 1) ? ASHLAR[4] : (((hash2d(x, y) % 3) === 0) ? ASHLAR[1] : ASHLAR[2]);
                }
                art.set(x, y, color, 'stone', SURFACE_FACE.right, h);
                continue;
            }

            // Left sunlit SW stone cheek (x = 7..10) and right niche frame (x = 21..22).
            if (x <= 10 || x >= 21) {
                const courseJoint = y === 22 || y === 28 || y === 34 || y === 40 || y === 46;
                const outerEdge = x === 7;
                const innerBevel = x === 10 || x === 21;
                let color;
                if (courseJoint) {
                    color = east ? INK : ASHLAR[2];
                } else if (!east) {
                    if (outerEdge) color = ASHLAR[8];
                    else if (innerBevel) color = ASHLAR[4];
                    else color = ((y % 6) === 1) ? ASHLAR[8] : ASHLAR[7];
                } else {
                    if (innerBevel) color = ASHLAR[6]; // catchlight on recessed niche right lip
                    else color = ((y % 6) === 1) ? ASHLAR[5] : ASHLAR[3];
                }
                if (!courseJoint && !innerBevel && !outerEdge && (hash2d(x, y) % 4) === 0) {
                    color = east ? ASHLAR[2] : ASHLAR[5];
                }
                art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
                continue;
            }

            // Bottom stone sill ledge below gauge recess (y = 49..52, x = 11..20).
            if (y >= 49) {
                const color = y === 49 ? (east ? ASHLAR[6] : ASHLAR[8]) : (east ? ASHLAR[4] : ASHLAR[6]);
                art.set(x, y, color, 'stone', y === 49 ? SURFACE_FACE.up : (east ? SURFACE_FACE.right : SURFACE_FACE.left), h);
                continue;
            }

            // Top recessed lintel shadow above gauge channel (y = 16..18, x = 11..20).
            if (y <= 18) {
                const color = y === 18 ? ASHLAR[1] : (east ? ASHLAR[3] : ASHLAR[5]);
                art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
                continue;
            }

            // Recessed empty gauge channel (x = 11..20, y = 19..48): dark carved stone
            // with vertical flute groove and faint horizontal course notches.
            const divider = ((y - 18) % 6) === 0;
            const innerRim = x === 11 || x === 20;
            const flute = (x === 15 || x === 16) && ((y - 19) % 6) >= 1 && ((y - 19) % 6) <= 3;
            let color = ASHLAR[2];
            if (divider || innerRim) color = ASHLAR[1];
            else if (flute) color = ASHLAR[3];
            art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
        }
    }

    // 2c. Projecting isometric cornice + 10x2 bronze provider crest bezel (y = 11..16).
    for (let x = 5; x <= 26; x++) {
        const dx = x - cx;
        const adx = Math.abs(dx);
        const east = dx >= 0;
        const seReturn = x >= 24;
        const drop = Math.max(0, 1 - Math.floor(adx / 7)); // subtle isometric prow center +1px
        for (let row = 0; row < 5; row++) {
            const y = 11 + row + drop;
            if (row === 0 && adx > 9) continue;
            if (row === 4 && adx > 9) continue;
            const h = 65 - y;
            let color;
            let kind = 'stone';
            let face = east ? SURFACE_FACE.right : SURFACE_FACE.left;
            if (row === 0) {
                color = seReturn ? ASHLAR[4] : (east ? ASHLAR[6] : ASHLAR[8]);
                face = SURFACE_FACE.up;
            } else if (row === 4) {
                color = seReturn ? ASHLAR[1] : ASHLAR[2];
            } else if (x >= 10 && x <= 21 && y >= 13 && y <= 16) {
                kind = 'metal';
                const frame = x === 10 || x === 21 || y === 13 || y === 16;
                color = frame ? TRIM_GOLD[0] : CLOTH_OCHRE[0];
            } else if (seReturn) {
                color = x === 26 ? ASHLAR[1] : ASHLAR[2];
            } else {
                const dentil = (x % 3) === 0 && row === 3;
                color = dentil ? ASHLAR[2] : (east ? ASHLAR[4] : ASHLAR[7]);
            }
            art.set(x, y, color, kind, face, h);
        }
    }

    // 2d. Carved stone lantern-crown housing with shaded SE return (y = 7..11, x = 9..23).
    for (let y = 7; y <= 11; y++) {
        for (let x = 9; x <= 23; x++) {
            const east = x >= cx;
            const h = 65 - y;
            if (x === 23) {
                art.set(x, y, y === 7 ? ASHLAR[3] : ASHLAR[2], 'stone', SURFACE_FACE.right, h);
            } else if (y === 7) {
                art.set(x, y, east ? ASHLAR[4] : ASHLAR[6], 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
            } else if (x <= 11 || x >= 20) {
                const pierEdge = x === 9 || x === 22;
                const color = !east
                    ? (pierEdge ? ASHLAR[8] : ASHLAR[6])
                    : (pierEdge ? ASHLAR[2] : ASHLAR[4]);
                art.set(x, y, color, 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
            } else if (x === 12 || x === 19) {
                art.set(x, y, ASHLAR[1], 'stone', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
            } else {
                const core = (x === 15 || x === 16) && (y === 9 || y === 10);
                const mid = x >= 14 && x <= 17 && y >= 8 && y <= 11;
                const dayGlass = x === 13 ? SLATE[2] : (core ? SLATE[1] : SLATE[0]);
                art.set(x, y, dayGlass, 'glass', east ? SURFACE_FACE.right : SURFACE_FACE.left, h);
                if (core) setEmissive(x, y, EMISSIVE[2], 200);
                else if (mid) setEmissive(x, y, EMISSIVE[1], 172);
                else setEmissive(x, y, EMISSIVE[0], 128);
            }
        }
    }

    // 2e. Isometric stepped pyramid capstone + weathered bronze finial (y = 2..7).
    const capRows = [
        { y: 6, x0: 8, x1: 24 },
        { y: 5, x0: 10, x1: 22 },
        { y: 4, x0: 12, x1: 20 },
        { y: 3, x0: 14, x1: 18 },
    ];
    for (const { y, x0, x1 } of capRows) {
        for (let x = x0; x <= x1; x++) {
            const east = x >= cx;
            const h = 65 - y;
            const ridge = x === 15 || x === 16;
            const isTop = y <= 4 || x === x0 || x === x0 + 1;
            let color;
            if (y === 3 && ridge) {
                color = east ? TRIM_GOLD[0] : CLOTH_OCHRE[1];
                art.set(x, y, color, 'metal', SURFACE_FACE.up, h);
                continue;
            }
            color = !east
                ? (isTop ? ASHLAR[8] : ASHLAR[7])
                : (x >= x1 - 1 ? ASHLAR[2] : ASHLAR[4]);
            art.set(x, y, color, 'stone', y <= 5 ? SURFACE_FACE.up : (east ? SURFACE_FACE.right : SURFACE_FACE.left), h);
        }
    }
    // Weathered bronze spire finial (y = 1..2, x = 15..16).
    art.set(15, 2, TRIM_GOLD[1], 'metal', SURFACE_FACE.left, 63);
    art.set(16, 2, TRIM_GOLD[0], 'metal', SURFACE_FACE.right, 63);
    art.set(15, 1, CLOTH_OCHRE[1], 'metal', SURFACE_FACE.up, 64);

    // 2f. Crisp 1px warm-ink outer silhouette (100% ink share for outline-landmarks.mjs).
    art.outline(
        (x) => (x < cx ? SURFACE_FACE.left : SURFACE_FACE.right),
        (_x, y) => Math.max(1, 65 - y),
    );

    return { ...art, emissive };
}

// ─── 3. prop.quotaPillarStrip (96 cells of 16x48 = 1536x48) ─────────────────

function setStripPixel(png, cellIndex, lx, ly, rgb, alpha = 255) {
    const [fw, fh] = QUOTA_PILLAR_STRIP_FRAME;
    if (lx < 0 || ly < 0 || lx >= fw || ly >= fh) return;
    const x = cellIndex * fw + lx;
    const i = (ly * png.width + x) * 4;
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = alpha;
}

function paintProviderCrest(png, cell, pal) {
    // Base cornice crest bezel is x = 10..21, y = 13..16 -> local lx = 2..13, ly = 1..4.
    // Interior inlaid banner is 10x2 px (lx = 3..12, ly = 2..3) in the provider's house hue
    // so pillars in l0, limit, or unknown stay identifiable at z1 and z3.
    for (let ly = 1; ly <= 4; ly++) {
        for (let lx = 2; lx <= 13; lx++) {
            let rgb;
            if (ly === 1) {
                rgb = lx === 13 ? ASHLAR[2] : TRIM_GOLD[0];
            } else if (ly === 4) {
                rgb = INK;
            } else if (lx === 2) {
                rgb = TRIM_GOLD[0];
            } else if (lx === 13) {
                rgb = INK;
            } else if (ly === 2) {
                // Lit upper half of the 10x2 inlaid banner.
                rgb = lx <= 5 ? pal.glint : lx <= 9 ? pal.light : pal.body;
            } else {
                // Faceted lower half of the 10x2 inlaid banner.
                rgb = lx <= 4 ? pal.light : lx <= 9 ? pal.body : pal.shadow;
            }
            setStripPixel(png, cell, lx, ly, rgb);
        }
    }
}

function paintEmptyCourse(png, cell, yTop) {
    for (let row = 0; row < 5; row++) {
        const ly = yTop + row;
        for (let lx = 3; lx <= 12; lx++) {
            const rim = lx === 3 || lx === 12 || row === 0;
            const runeHollow = (lx === 7 || lx === 8) && (row === 1 || row === 3);
            const runeCatch = ((lx === 6 || lx === 9) && row === 2) || (lx === 7 && row === 2);
            let rgb = ASHLAR[2];
            if (rim) rgb = INK;
            else if (runeHollow) rgb = INK;
            else if (runeCatch) rgb = ASHLAR[4];
            else if (row === 4) rgb = ASHLAR[1];
            setStripPixel(png, cell, lx, ly, rgb);
        }
    }
    // Deep horizontal stone groove between courses.
    for (let lx = 3; lx <= 12; lx++) {
        setStripPixel(png, cell, lx, yTop + 5, INK);
    }
}

function paintLitCourse(png, cell, yTop, pal, { peak = false, trickleRow = -1, emissivePng = null } = {}) {
    // Carved crystalline runic bar: chamfered stone pocket edges at lx=3,12,
    // faceted glowing crystal tablet at lx=4..11 with bright vertical-left prism
    // spine (lx=5..6) and engraved center runic diamond, never reading like a drawer.
    for (let row = 0; row < 5; row++) {
        const ly = yTop + row;
        for (let lx = 3; lx <= 12; lx++) {
            let rgb;
            let emRgb = null;
            let emAlpha = 0;
            if (lx === 3 || lx === 12) {
                // Dark carved niche side wall framing the crystal stave.
                rgb = lx === 3 ? (row === 0 ? INK : ASHLAR[1]) : INK;
            } else if (peak) {
                const core = lx >= 5 && lx <= 10 && row >= 1 && row <= 3;
                rgb = core ? PEAK : PEAK_EDGE;
                emRgb = core ? PEAK : PEAK_EDGE;
                emAlpha = core ? 136 : 96;
            } else {
                const isTrickle = trickleRow === row && (lx === 6 || lx === 7 || lx === 8);
                const cornerCut = (row === 0 || row === 4) && (lx === 4 || lx === 11);
                const runeNotch = (row === 2 && lx === 8) || ((row === 1 || row === 3) && lx === 9);
                if (cornerCut) {
                    rgb = INK;
                } else if (isTrickle) {
                    rgb = lx === 7 ? pal.glint : pal.shadow;
                } else if (runeNotch) {
                    // Crisp engraved rune bevel inside the crystal face.
                    rgb = pal.shadow;
                } else if (row === 0) {
                    rgb = lx <= 7 ? pal.glint : pal.light;
                } else if (row === 4) {
                    rgb = lx <= 6 ? pal.shadow : INK;
                } else if (lx === 4) {
                    rgb = pal.light;
                } else if (lx === 5) {
                    // Crisp vertical crystal prism highlight down the left facet.
                    rgb = (row === 1 || row === 2) ? pal.glint : pal.light;
                } else if (lx === 6) {
                    rgb = row === 2 ? pal.glint : pal.light;
                } else if (lx === 7) {
                    rgb = row === 2 ? pal.glint : pal.body;
                } else if (lx === 11) {
                    rgb = pal.shadow;
                } else {
                    rgb = pal.body;
                }
                // Low-alpha night emissive on lit crystal faces (steady across
                // trickle phases so shimmer never churns the emissive channel).
                if (!cornerCut && !(row === 4 && lx > 6)) {
                    const prismCore = (lx === 5 || lx === 6 || lx === 7) && (row === 1 || row === 2);
                    const shadeEdge = row === 4 || lx === 11 || runeNotch;
                    emRgb = prismCore ? pal.glint : (shadeEdge ? pal.body : pal.light);
                    emAlpha = prismCore ? 112 : (shadeEdge ? 60 : 88);
                }
            }
            setStripPixel(png, cell, lx, ly, rgb);
            if (emissivePng && emRgb && emAlpha > 0) {
                setStripPixel(emissivePng, cell, lx, ly, emRgb, emAlpha);
            }
        }
    }
    // Crisp dark horizontal stone course divider so all 5 courses count at z1.
    for (let lx = 3; lx <= 12; lx++) {
        setStripPixel(png, cell, lx, yTop + 5, peak ? TRIM_GOLD[0] : INK);
    }
}

function paintShroud(png, cell) {
    // Dark shadowed slate/linen shroud strictly inset inside the carved stone
    // recess (lx = 3..12, ly = 7..36 — never overflowing onto cheeks, lintel, or
    // sill). Clearly darker than l1 lit courses so unknown never outshines live
    // gauges or resembles the cream peak flash.
    const y0 = 7;
    const y1 = 36;
    const cinch = 21;
    for (let ly = y0; ly <= y1; ly++) {
        const pinched = Math.abs(ly - cinch) <= 1;
        const hem = ly >= y1 - 1;
        const clothLeft = pinched ? 5 : 4;
        const clothRight = pinched ? 10 : 11;
        for (let lx = 3; lx <= 12; lx++) {
            let rgb;
            if (lx === 3 || lx === 12 || ly === y0 || ly === y1) {
                // Dark recessed stone niche wall framing the inset cloth veil.
                rgb = INK;
            } else if (lx < clothLeft || lx > clothRight) {
                // Shadowed stone recess visible at the cinched waist.
                rgb = INK;
            } else if (ly === cinch) {
                // Dark tie cord with carved stone clasp catchlight at center.
                rgb = (lx === 7 || lx === 8) ? ASHLAR[4] : INK;
            } else if (ly === cinch - 1 || ly === cinch + 1) {
                rgb = (lx === clothLeft || lx === 8) ? SLATE[2] : INK;
            } else if (hem) {
                rgb = (lx % 2 === 0) ? SLATE[1] : INK;
            } else {
                // Crisp vertical shadowed slate-linen pleats (deep ink troughs
                // alternating with cool slate ridges; stays dark and clearly
                // below l1 lit crystal brightness).
                const pleat = (lx - 4) % 3;
                if (lx === 4) rgb = ly < cinch ? SLATE[2] : SLATE[1];
                else if (lx === 11) rgb = INK;
                else if (pleat === 0) rgb = (ly % 4 === 0) ? ASHLAR[3] : SLATE[2];
                else if (pleat === 1) rgb = SLATE[0];
                else rgb = INK;
            }
            setStripPixel(png, cell, lx, ly, rgb);
        }
    }
}

function paintLimitSeal(png, cell, emissivePng = null) {
    // Spent recess already drawn; stretch a crisp horizontal muted rose-crimson
    // seal band strictly across the recess (lx = 3..12, ly = 19..24) with a
    // centered round stamped wax seal — legible at z1 and z3 and distinct from
    // Claude's lavender-plum courses.
    for (let lx = 3; lx <= 12; lx++) {
        setStripPixel(png, cell, lx, 19, INK);
        setStripPixel(png, cell, lx, 20, lx <= 7 ? SEAL.glint : SEAL.body);
        setStripPixel(png, cell, lx, 21, lx <= 9 ? SEAL.body : SEAL.mid);
        setStripPixel(png, cell, lx, 22, lx <= 6 ? SEAL.mid : SEAL.shade);
        setStripPixel(png, cell, lx, 23, SEAL.shade);
        setStripPixel(png, cell, lx, 24, INK);
        if (emissivePng) {
            setStripPixel(emissivePng, cell, lx, 20, lx <= 7 ? SEAL.glint : SEAL.body, 84);
            setStripPixel(emissivePng, cell, lx, 21, SEAL.body, 76);
            setStripPixel(emissivePng, cell, lx, 22, SEAL.mid, 56);
        }
    }
    // Centered round wax seal medallion at (7.5, 21.5) with crisp dark rim and
    // upper-left specular glint.
    for (let ly = 18; ly <= 25; ly++) {
        for (let lx = 4; lx <= 11; lx++) {
            const d = Math.hypot(lx - 7.5, ly - 21.5);
            if (d > 3.25) continue;
            let rgb;
            let emRgb = null;
            let emAlpha = 0;
            if (d > 2.55) {
                rgb = INK;
            } else if (d > 2.05) {
                rgb = SEAL.shade;
                emRgb = SEAL.mid;
                emAlpha = 52;
            } else if (lx <= 7 && ly <= 21) {
                rgb = SEAL.glint;
                emRgb = SEAL.glint;
                emAlpha = 112;
            } else if (lx === 8 && ly === 22) {
                rgb = SEAL.shade; // embossed center stamp pip
                emRgb = SEAL.mid;
                emAlpha = 64;
            } else {
                rgb = SEAL.body;
                emRgb = SEAL.body;
                emAlpha = 88;
            }
            setStripPixel(png, cell, lx, ly, rgb);
            if (emissivePng && emRgb && emAlpha > 0) {
                setStripPixel(emissivePng, cell, lx, ly, emRgb, emAlpha);
            }
        }
    }
}

function paintCell(png, cell, provider, state, phase = null, emissivePng = null) {
    const pal = PROVIDER_PALETTES[provider] || PROVIDER_PALETTES.claude;
    // Always paint the 10x2 top provider identity banner so every pillar stays readable.
    paintProviderCrest(png, cell, pal);

    if (state === 'unknown') {
        paintShroud(png, cell);
        return;
    }

    const peak = state === 'peak';
    const level = peak ? QUOTA_PILLAR_LEVELS : (state === 'limit' ? 0 : Number(state.slice(1)));

    // 5 bold vertical courses (c = 1 bottom .. 5 top; yTop = 37 - c*6).
    for (let c = 1; c <= QUOTA_PILLAR_LEVELS; c++) {
        const yTop = 37 - c * 6;
        if (c <= level) {
            // MB-5 active-spend trickle: 3-phase downward bead ripple across lit courses.
            const trickleRow = phase === null ? -1 : ((phase * 2 + (QUOTA_PILLAR_LEVELS - c)) % 5);
            paintLitCourse(png, cell, yTop, pal, { peak, trickleRow, emissivePng });
        } else {
            paintEmptyCourse(png, cell, yTop);
        }
    }

    if (state === 'limit') paintLimitSeal(png, cell, emissivePng);
}

export function bakeStripWithEmissive(providers = QUOTA_TERRACE_PROVIDERS) {
    const [fw, fh] = QUOTA_PILLAR_STRIP_FRAME;
    const totalCells = quotaPillarStripCellCount(providers);
    const strip = new PNG({ width: fw * totalCells, height: fh, colorType: 6 });
    const emissive = new PNG({ width: fw * totalCells, height: fh, colorType: 6 });

    for (const provider of providers) {
        for (const state of QUOTA_PILLAR_STATES) {
            paintCell(strip, quotaPillarStateCell(provider, state, providers), provider, state, null, emissive);
        }
        for (let level = 1; level <= QUOTA_PILLAR_LEVELS; level++) {
            for (let phase = 0; phase < QUOTA_PILLAR_STREAM_PHASES; phase++) {
                paintCell(strip, quotaPillarStreamCell(provider, level, phase, providers), provider, `l${level}`, phase, emissive);
            }
        }
    }

    return { strip, emissive };
}

export function bakeStrip(providers = QUOTA_TERRACE_PROVIDERS) {
    return bakeStripWithEmissive(providers).strip;
}

export function bakeStripEmissive(providers = QUOTA_TERRACE_PROVIDERS) {
    return bakeStripWithEmissive(providers).emissive;
}

export function buildAllQuotaTerracePngs() {
    const apron = bakeApron();
    const pillar = bakePillar();
    const { strip, emissive: stripEmissive } = bakeStripWithEmissive();
    return [
        { name: 'prop.quotaTerraceApron.png', png: apron.png },
        { name: 'prop.quotaTerraceApron.material.png', png: apron.material },
        { name: 'prop.quotaTerraceApron.occluder.png', png: apron.occluder },
        { name: 'prop.quotaPillar.png', png: pillar.png },
        { name: 'prop.quotaPillar.emissive.png', png: pillar.emissive },
        { name: 'prop.quotaPillar.material.png', png: pillar.material },
        { name: 'prop.quotaPillar.occluder.png', png: pillar.occluder },
        { name: 'prop.quotaPillarStrip.png', png: strip },
        { name: 'prop.quotaPillarStrip.emissive.png', png: stripEmissive },
    ];
}

function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const previewArg = args.find((a) => a.startsWith('--preview='));
    const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;

    const outputs = buildAllQuotaTerracePngs();
    if (!check) mkdirSync(PROPS_DIR, { recursive: true });
    if (previewDir) mkdirSync(previewDir, { recursive: true });

    let mismatched = 0;
    for (const { name, png } of outputs) {
        const dest = join(PROPS_DIR, name);
        const bytes = PNG.sync.write(png);
        if (check) {
            if (!existsSync(dest) || !readFileSync(dest).equals(bytes)) {
                console.error(`[bake-quota-terrace] stale or missing: ${name}`);
                mismatched++;
            } else {
                console.log(`[bake-quota-terrace] ok: ${name} (${png.width}x${png.height})`);
            }
        } else {
            writeFileSync(dest, bytes);
            console.log(`[bake-quota-terrace] wrote: ${name} (${png.width}x${png.height})`);
        }
        if (previewDir) writeFileSync(join(previewDir, name), bytes);
    }

    if (mismatched > 0) {
        console.error(`[bake-quota-terrace] ${mismatched} file(s) out of date; run node scripts/sprites/bake-quota-terrace.mjs`);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
