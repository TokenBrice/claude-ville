#!/usr/bin/env node

// Plan 1.3 (The Waking Isle) — emitters keep their own light.
//
// 1. Derives the emissive sidecars of three world props from their own albedo
//    by colour, inside a reviewed rect: the rune brazier's flame and coal bed,
//    the street lantern's glass, the bridge post's rune glass. A pixel joins
//    the sidecar only when its hue, saturation and value match the reviewed
//    rule for that prop; the rect keeps stone highlights and timber out. The
//    sidecar carries the albedo colour at a fixed contribution alpha.
// 2. Puts warm emissive art on the reserved light ramp, ART_RAMPS.emissive ∪
//    EFFECT_COLORS.work (M15). The sidecar RGB is the emitted light: a colour
//    within OKLab ΔE 0.08 of a stop is on the ramp and is kept; a chromatic
//    off-ramp colour (HSV S ≥ 0.55, or any lime/green hue 50–160°) snaps to
//    its nearest stop; a low-chroma off-ramp colour is lit masonry or timber
//    — a receiver, not a source — and leaves the sidecar (the pool light
//    lights it instead). The albedo under the mask keeps its painted value
//    structure (the Forge's red back wall, the Archive's stepped panes); only
//    its hue defects move: a lime/yellow-green albedo pixel (hue 50–160°,
//    S ≥ 0.4, V ≥ 0.6) snaps to its nearest stop, so the Forge's lime flame
//    tips go gold by day and by night. Entries that declare
//    `emissiveFamily: 'cool'` (the Mine crystals, the bridge post's rune
//    glass) keep their cool pixels; only their warm pixels ramp.
//
// Scope: world emitters (buildings and props that declare `emissiveSidecar`).
// Character accents are provider identity colours, not lamps, and are left
// alone. Deterministic and idempotent: a second run writes nothing.
//
//   node scripts/sprites/emissive-sidecars.mjs            write
//   node scripts/sprites/emissive-sidecars.mjs --check    exit 1 if a run would change a PNG

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';
import {
    collectSpriteEntries,
    loadSpriteManifest,
    pathForEntry,
    spritesRoot,
} from './manifest-utils.mjs';

const check = process.argv.includes('--check');

export const ON_RAMP_DELTA_E = 0.08;
const CHROMATIC_SATURATION = 0.55;

// Reviewed per-prop rules: rect [x, y, w, h] in sprite px, contribution
// alpha (emitterWeight = alpha/127.5 × gate × core energy; ≥ 128 is a fully
// ungraded emitter at night), and the colour rule on HSV (hue in degrees).
export const PROP_SIDECAR_RULES = Object.freeze({
    // The gold flame, its dark-orange flame edge and the red coal bed; the
    // stone bowl, its rim highlights and the bronze feet stay albedo.
    'prop.runeBrazier': {
        rect: [14, 0, 20, 29],
        alpha: 144,
        accept: ({ h, s, v }) => (h >= 15 && h <= 62 && s >= 0.2 && v >= 0.45)
            || ((h >= 340 || h <= 8) && s >= 0.5 && v >= 0.7),
    },
    // The four lit panes of the lantern head; the iron cage and the dark red
    // side pane stay albedo.
    'prop.lantern': {
        rect: [15, 0, 7, 5],
        alpha: 144,
        accept: ({ h, s, v }) => (h <= 45 || h >= 345) && s >= 0.25 && v >= 0.65,
    },
    // The blue rune glass; the carved timber stays albedo.
    'prop.bridgeLanternPost': {
        rect: [12, 9, 8, 7],
        alpha: 136,
        accept: ({ h, s, v }) => h >= 160 && h <= 215 && s >= 0.25 && v >= 0.45,
    },
});

export const LIGHT_RAMP = Object.freeze([...ART_RAMPS.emissive, ...EFFECT_COLORS.work]);
const RAMP_RGB = LIGHT_RAMP.map(hexToRgb);
const RAMP_LAB = RAMP_RGB.map(oklab);

export function hexToRgb(hex) {
    const text = String(hex).replace('#', '');
    return [0, 2, 4].map((offset) => parseInt(text.slice(offset, offset + 2), 16));
}

function linear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function oklab([r8, g8, b8]) {
    const r = linear(r8);
    const g = linear(g8);
    const b = linear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

export function hsv([r8, g8, b8]) {
    const r = r8 / 255;
    const g = g8 / 255;
    const b = b8 / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max > 0 ? d / max : 0, v: max };
}

export function nearestRampStop(rgb) {
    const lab = oklab(rgb);
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < RAMP_LAB.length; index++) {
        const [l, a, b] = RAMP_LAB[index];
        const distance = Math.hypot(lab[0] - l, lab[1] - a, lab[2] - b);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
        }
    }
    return { rgb: RAMP_RGB[best], hex: LIGHT_RAMP[best], distance: bestDistance };
}

function isWarm({ h, s }) {
    return s >= 0.12 && (h < 65 || h > 330);
}

// The ramp decision for one sidecar colour: 'keep', 'remove' or a stop.
export function rampDecision(rgb, { cool = false } = {}) {
    const colour = hsv(rgb);
    const lime = colour.h >= 50 && colour.h <= 160 && colour.s >= 0.4;
    if (cool && !isWarm(colour)) return { action: 'keep' };
    const nearest = nearestRampStop(rgb);
    if (nearest.distance <= ON_RAMP_DELTA_E) return { action: 'keep' };
    if (colour.s >= CHROMATIC_SATURATION || lime) return { action: 'snap', rgb: nearest.rgb, hex: nearest.hex };
    return { action: 'remove' };
}

function readPng(path) {
    return PNG.sync.read(readFileSync(path));
}

function samePixels(a, b) {
    return a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;
}

function derivePropSidecar(albedo, rule) {
    const out = new PNG({ width: albedo.width, height: albedo.height, colorType: 6 });
    const [rx, ry, rw, rh] = rule.rect;
    for (let y = ry; y < Math.min(albedo.height, ry + rh); y++) {
        for (let x = rx; x < Math.min(albedo.width, rx + rw); x++) {
            const i = (y * albedo.width + x) * 4;
            if (albedo.data[i + 3] === 0) continue;
            const rgb = [albedo.data[i], albedo.data[i + 1], albedo.data[i + 2]];
            if (!rule.accept(hsv(rgb))) continue;
            out.data[i] = rgb[0];
            out.data[i + 1] = rgb[1];
            out.data[i + 2] = rgb[2];
            out.data[i + 3] = rule.alpha;
        }
    }
    return out;
}

function rampSidecar(albedo, sidecar, { cool }) {
    const nextAlbedo = new PNG({ width: albedo.width, height: albedo.height, colorType: 6 });
    albedo.data.copy(nextAlbedo.data);
    const nextSidecar = new PNG({ width: sidecar.width, height: sidecar.height, colorType: 6 });
    sidecar.data.copy(nextSidecar.data);
    const census = { kept: 0, snapped: 0, removed: 0, albedoSnapped: 0 };
    const decisions = new Map();
    for (let i = 0; i < sidecar.data.length; i += 4) {
        if (sidecar.data[i + 3] === 0) continue;
        const albedoRgb = [albedo.data[i], albedo.data[i + 1], albedo.data[i + 2]];
        const albedoColour = hsv(albedoRgb);
        if (!cool && albedo.data[i + 3] > 0 && albedoColour.h >= 50 && albedoColour.h <= 160
            && albedoColour.s >= 0.4 && albedoColour.v >= 0.6) {
            const stop = nearestRampStop(albedoRgb).rgb;
            nextAlbedo.data[i] = stop[0];
            nextAlbedo.data[i + 1] = stop[1];
            nextAlbedo.data[i + 2] = stop[2];
            census.albedoSnapped++;
        }
        const rgb = [sidecar.data[i], sidecar.data[i + 1], sidecar.data[i + 2]];
        const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        let decision = decisions.get(key);
        if (!decision) {
            decision = rampDecision(rgb, { cool });
            decisions.set(key, decision);
        }
        if (decision.action === 'keep') {
            census.kept++;
        } else if (decision.action === 'remove') {
            nextSidecar.data.fill(0, i, i + 4);
            census.removed++;
        } else {
            nextSidecar.data[i] = decision.rgb[0];
            nextSidecar.data[i + 1] = decision.rgb[1];
            nextSidecar.data[i + 2] = decision.rgb[2];
            census.snapped++;
        }
    }
    return { albedo: nextAlbedo, sidecar: nextSidecar, census };
}

function emitterEntries(manifest) {
    return collectSpriteEntries(manifest, ['buildings', 'props'])
        .filter((entry) => entry?.emissiveSidecar === true || PROP_SIDECAR_RULES[entry?.id]);
}

function run() {
    const manifest = loadSpriteManifest();
    const changes = [];
    for (const entry of emitterEntries(manifest)) {
        const albedoPath = join(spritesRoot, pathForEntry(entry));
        const sidecarPath = albedoPath.replace(/\.png$/, '.emissive.png');
        const albedo = readPng(albedoPath);
        const rule = PROP_SIDECAR_RULES[entry.id];
        const cool = entry.emissiveFamily === 'cool';
        let ramped;
        if (rule) {
            // Re-derived from the albedo's own colours on every run. A lime
            // albedo pixel snaps first, then the sidecar is derived again from
            // the snapped albedo, so a second run finds nothing to change.
            ramped = rampSidecar(albedo, derivePropSidecar(albedo, rule), { cool });
            if (!samePixels(albedo, ramped.albedo)) {
                ramped = rampSidecar(ramped.albedo, derivePropSidecar(ramped.albedo, rule), { cool });
            }
        } else {
            if (!existsSync(sidecarPath)) continue;
            ramped = rampSidecar(albedo, readPng(sidecarPath), { cool });
        }
        const current = existsSync(sidecarPath) ? readPng(sidecarPath) : null;
        const albedoChanged = !samePixels(albedo, ramped.albedo);
        const sidecarChanged = !current || !samePixels(current, ramped.sidecar);
        const { kept, snapped, removed, albedoSnapped } = ramped.census;
        console.log(`[emissive-sidecars] ${entry.id}${cool ? ' (cool)' : ''}: kept ${kept}, snapped ${snapped}, removed ${removed}, albedo snapped ${albedoSnapped}${albedoChanged || sidecarChanged ? '' : ' — unchanged'}`);
        if (albedoChanged) changes.push({ path: albedoPath, png: ramped.albedo });
        if (sidecarChanged) changes.push({ path: sidecarPath, png: ramped.sidecar });
    }
    if (check) {
        if (changes.length) {
            console.error(`[emissive-sidecars] ${changes.length} PNG(s) would change; run node scripts/sprites/emissive-sidecars.mjs`);
            process.exit(1);
        }
        return;
    }
    for (const { path, png } of changes) {
        writeFileSync(path, PNG.sync.write(png, { colorType: 6 }));
        console.log(`[emissive-sidecars] wrote ${path.slice(spritesRoot.length + 1)}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
