#!/usr/bin/env node
// Wave 5-B (Spec 03 §1.2 item 5.1, D6) — Open-Front Forge calibration baker.
//
// `OpenFront.js` ships a geometric `FORGE_ARCH_ROWS` (piers x 46..57 and
// 115..128, mouth x 58..114) authored for a re-authored 2-tile open bay. The
// Forge that actually ships (`building.forge/base.png`, 256 x 232, anchor
// [128, 169]) keeps its furnace arch on the SW gable: the open mouth is the
// fire and its fire-lit jamb reveal at x 50..87, y 135..204, exactly the
// texels the authored rest mask `banked.png` and the tongues mask
// `hearth.png` restate. Measured against the art, the shipped run table
// would split the stone right of the mouth into the rear and the bay tiles
// project onto the wall beside the arch. This baker derives the calibration
// from the real pixels instead (0 PixelLab generations; base.png and every
// registered layer stay byte-identical):
//
//   mouth        per row, the span of `banked.png` ∪ `hearth.png` (the
//                rear interior a smith stands in front of).
//   frontArch    every opaque base.png texel in the arch window (x 36..112,
//                y 121..214) outside the mouth, the bellows' frame box and the
//                sign box: lintel, voussoirs, spandrels and both piers.
//   bays         two smith slots on the mouth floor, 3 texels above its
//                bottom: `forge-hearth` (mid-mouth) and `forge-anvil` (the
//                mouth's yard side, facing the anvil stump).
//   post line    the front-arch sort line runs 2 texels below the mouth's
//                lowest texel (`postLineInset` < 0: the gable's foot stands in
//                front of the footprint edge), so a smith in the mouth sorts
//                after the building's columns and before the arch overlay.
//
// The result is written into the generated `FORGE_OPEN_FRONT_CALIBRATION`
// block of BuildingVisualRegistry.js (between `// <forge-open-front>`
// markers), with SHA-256 fingerprints of the art it was measured on, so a
// re-authored Forge fails `--check` until it is re-calibrated. `--check` also
// verifies the Forge and Command `base.surface.png` pages (H16 === 0 outside
// alpha, B <= 63, valid bit, authored AO-monotonic pairs).
//
// Usage:
//   node scripts/sprites/bake-forge-openfront.mjs           # rewrite the registry block
//   node scripts/sprites/bake-forge-openfront.mjs --check   # verify block, art and surfaces
//   node scripts/sprites/bake-forge-openfront.mjs --help

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import {
    BUILDING_VISUAL_REGISTRY,
    getBuildingSurfaceAoPairs,
    signBoxFor,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { OPEN_FRONT_PROFILES, splitOpenFrontMask } from '../../claudeville/src/presentation/character-mode/OpenFront.js';
import { buildingCenterToWorld, tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { checkAoMonotonicity, validateSurfaceV1Buffer } from './bake-depth-channels.mjs';
import { BUILDINGS_DIR, REPO_ROOT, readPng } from './bake-cutaway-command.mjs';
import { loadSpriteManifest } from './manifest-utils.mjs';

export const FORGE_DIR = join(BUILDINGS_DIR, 'building.forge');
export const REGISTRY_PATH = join(REPO_ROOT, 'claudeville/src/presentation/character-mode/BuildingVisualRegistry.js');
export const BLOCK_OPEN = '// <forge-open-front>';
export const BLOCK_CLOSE = '// </forge-open-front>';

export const FORGE_NATIVE = Object.freeze({ width: 256, height: 232, anchor: Object.freeze([128, 169]) });
// The arch window: the SW gable around the furnace mouth, below the sign box.
export const FORGE_ARCH_WINDOW = Object.freeze({ left: 36, right: 112, top: 121, bottom: 214 });
// Registered layers this calibration must leave exactly where they are.
export const FORGE_REGISTERED_LAYERS = Object.freeze({
    hearth: Object.freeze({ anchor: [128, 169], width: 256, height: 232 }),
    banked: Object.freeze({ anchor: [128, 169], width: 256, height: 232 }),
    bellows: Object.freeze({ anchor: [57, 197], frameW: 28, frameH: 22 }),
    billetRack: Object.freeze({ anchor: [211, 191], frameW: 18, frameH: 26 }),
});
export const FORGE_SIGN_AT = Object.freeze([73, 107]);
const ROUND = 1000;
const r3 = (value) => Math.round(value * ROUND) / ROUND;
const floor8 = (value) => Math.floor(value * 8) / 8;
const ceil8 = (value) => Math.ceil(value * 8) / 8;

function sha12(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
}

function layerBox(layer) {
    const w = layer.frameW ?? layer.width;
    const h = layer.frameH ?? layer.height;
    if (layer.width === FORGE_NATIVE.width && layer.height === FORGE_NATIVE.height) return null;
    const left = Math.round(layer.anchor[0] - w / 2);
    const top = Math.round(layer.anchor[1] - h);
    return { left, top, right: left + w - 1, bottom: top + h - 1 };
}

/** Per-row mouth spans from the authored rest (`banked`) and tongues (`hearth`) masks. */
export function forgeMouthRows(hearth, banked) {
    const rows = new Map();
    for (let y = 0; y < hearth.height; y++) {
        let minX = Infinity;
        let maxX = -Infinity;
        for (let x = 0; x < hearth.width; x++) {
            const o = (y * hearth.width + x) * 4;
            if (hearth.data[o + 3] > 0 || banked.data[o + 3] > 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
        if (maxX >= minX) rows.set(y, [minX, maxX]);
    }
    return rows;
}

function encodeRuns(mask, width, height) {
    const rows = [];
    for (let y = 0; y < height; y++) {
        const spans = [];
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const on = x < width && mask[y * width + x] === 1;
            if (on && start < 0) start = x;
            if (!on && start >= 0) {
                spans.push(`${start}+${x - start}`);
                start = -1;
            }
        }
        if (spans.length) rows.push(`${y}:${spans.join(',')};`);
    }
    return rows;
}

function forgeDef() {
    return BUILDING_DEFS.find((def) => def.type === 'forge');
}

function spriteToTile(sx, sy) {
    const def = forgeDef();
    const center = buildingCenterToWorld({ position: { tileX: def.x, tileY: def.y }, width: def.width, height: def.height });
    const world = { x: sx - FORGE_NATIVE.anchor[0] + center.x, y: sy - FORGE_NATIVE.anchor[1] + center.y };
    const tile = worldToTile(world.x, world.y);
    return { world, tileX: tile.tileX, tileY: tile.tileY, dx: tile.tileX - def.x, dy: tile.tileY - def.y };
}

// Sprite-local y of the footprint's SW front edge (tileY = y + height) at sprite x.
function frontEdgeSpriteY(sx) {
    const def = forgeDef();
    const center = buildingCenterToWorld({ position: { tileX: def.x, tileY: def.y }, width: def.width, height: def.height });
    const left = tileToWorld(def.x, def.y + def.height);
    const leftSprite = { x: left.x - center.x + FORGE_NATIVE.anchor[0], y: left.y - center.y + FORGE_NATIVE.anchor[1] };
    return leftSprite.y + 0.5 * (sx - leftSprite.x);
}

/** Derive the full calibration from the shipped art. Pure; no writes. */
export function calibrateForgeOpenFront({
    base = readPng(join(FORGE_DIR, 'base.png')),
    hearth = readPng(join(FORGE_DIR, 'hearth.png')),
    banked = readPng(join(FORGE_DIR, 'banked.png')),
} = {}) {
    const { width, height } = base;
    const mouth = forgeMouthRows(hearth, banked);
    const win = FORGE_ARCH_WINDOW;
    const exclusions = [];
    const bellows = layerBox(FORGE_REGISTERED_LAYERS.bellows);
    if (bellows) exclusions.push(bellows);
    const sign = signBoxFor(FORGE_SIGN_AT);
    exclusions.push({ left: sign.left, top: sign.top, right: sign.left + sign.w - 1, bottom: sign.top + sign.h - 1 });

    const front = new Uint8Array(width * height);
    for (let y = win.top; y <= win.bottom; y++) {
        const span = mouth.get(y);
        for (let x = win.left; x <= win.right; x++) {
            if (base.data[(y * width + x) * 4 + 3] === 0) continue;
            if (span && x >= span[0] && x <= span[1]) continue;
            if (exclusions.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) continue;
            front[y * width + x] = 1;
        }
    }
    const rows = encodeRuns(front, width, height);

    // Mouth floor: the lowest opaque mask texel per column (the row spans
    // above are filled, so a notch of open ground under the fire never
    // becomes floor).
    let mouthLeft = Infinity;
    let mouthRight = -Infinity;
    let mouthTop = Infinity;
    let mouthBottom = -Infinity;
    const columnBottom = new Map();
    for (const [y, [x0, x1]] of mouth) {
        mouthLeft = Math.min(mouthLeft, x0);
        mouthRight = Math.max(mouthRight, x1);
        mouthTop = Math.min(mouthTop, y);
        mouthBottom = Math.max(mouthBottom, y);
        for (let x = x0; x <= x1; x++) {
            const o = (y * width + x) * 4;
            const masked = hearth.data[o + 3] > 0 || banked.data[o + 3] > 0;
            if (!masked || base.data[o + 3] === 0) continue;
            columnBottom.set(x, Math.max(columnBottom.get(x) ?? -Infinity, y));
        }
    }
    const bayAt = (sx) => [sx, columnBottom.get(sx) - 3];
    const hearthX = Math.round((mouthLeft + mouthRight) / 2);
    const anvilX = mouthRight - 6;
    const bayDefs = [
        { id: 'forge-hearth', at: bayAt(hearthX), pose: 'tinker', facing: 'north-east' },
        { id: 'forge-anvil', at: bayAt(anvilX), pose: 'hammer', facing: 'south-east' },
    ];
    const def = forgeDef();
    const bays = bayDefs.map((bay) => {
        const tile = spriteToTile(bay.at[0], bay.at[1]);
        return {
            id: bay.id,
            at: bay.at,
            tile: { tileX: r3(tile.tileX), tileY: r3(tile.tileY) },
            relTile: { dx: r3(tile.dx), dy: r3(tile.dy) },
            pose: bay.pose,
            facing: bay.facing,
            anchorOffset: [0, 0],
        };
    });

    // Floor rect (building-local tiles) around the mouth floor texels.
    let minDx = Infinity;
    let maxDx = -Infinity;
    let minDy = Infinity;
    let maxDy = -Infinity;
    for (let sx = mouthLeft + 2; sx <= mouthRight - 2; sx++) {
        const bottom = columnBottom.get(sx);
        if (!Number.isFinite(bottom)) continue;
        for (let sy = bottom - 6; sy <= bottom - 1; sy++) {
            const t = spriteToTile(sx, sy);
            minDx = Math.min(minDx, t.dx);
            maxDx = Math.max(maxDx, t.dx);
            minDy = Math.min(minDy, t.dy);
            maxDy = Math.max(maxDy, t.dy);
        }
    }
    const rect = {
        dx: floor8(minDx),
        dy: floor8(minDy),
        width: r3(ceil8(maxDx) - floor8(minDx)),
        height: r3(ceil8(maxDy) - floor8(minDy)),
    };

    // Front-arch sort line: 2 texels under the mouth's lowest texel, as a
    // footprint-edge inset (negative = in front of the edge).
    let lineDrop = -Infinity;
    for (const [x, bottom] of columnBottom) lineDrop = Math.max(lineDrop, bottom + 2 - frontEdgeSpriteY(x));
    const postLineInset = -ceil8(lineDrop / (2 * 16));

    return {
        width,
        height,
        mouth,
        front,
        rows,
        bays,
        rect,
        postLineInset,
        mouthBounds: { left: mouthLeft, right: mouthRight, top: mouthTop, bottom: mouthBottom },
        relTileOf: spriteToTile,
        def,
    };
}

/** The generated registry block text (deterministic). */
export function renderCalibrationBlock(calibration, fingerprints) {
    const { rows, bays, rect, postLineInset, mouthBounds } = calibration;
    const rowLines = [];
    for (let i = 0; i < rows.length; i += 3) rowLines.push(`        '${rows.slice(i, i + 3).join('')}',`);
    const bayLines = bays.map((bay) => [
        '        Object.freeze({',
        `            id: '${bay.id}',`,
        `            at: Object.freeze([${bay.at[0]}, ${bay.at[1]}]),`,
        `            tile: Object.freeze({ tileX: ${bay.tile.tileX}, tileY: ${bay.tile.tileY} }),`,
        `            relTile: Object.freeze({ dx: ${bay.relTile.dx}, dy: ${bay.relTile.dy} }),`,
        `            pose: '${bay.pose}',`,
        `            facing: '${bay.facing}',`,
        '            anchorOffset: Object.freeze([0, 0]),',
        '        }),',
    ].join('\n'));
    const win = FORGE_ARCH_WINDOW;
    return [
        `${BLOCK_OPEN} — generated by scripts/sprites/bake-forge-openfront.mjs; do not hand-edit.`,
        '// The open-front Forge measured on the shipped furnace arch (D6): the mouth is',
        '// banked.png ∪ hearth.png, the front arch every other opaque texel of the',
        '// arch window (bellows and sign boxes excluded). Overrides OPEN_FRONT_PROFILES.forge',
        "// (`frontArchRows`, `postLineInset`, `interiorFloorBounds`, `bays`) at runtime.",
        'export const FORGE_OPEN_FRONT_CALIBRATION = Object.freeze({',
        "    profile: 'forge',",
        "    drawables: 'BuildingSprite',",
        `    source: Object.freeze({ base: '${fingerprints.base}', hearth: '${fingerprints.hearth}', banked: '${fingerprints.banked}', rooms: '${fingerprints.rooms}' }),`,
        `    archWindow: Object.freeze({ left: ${win.left}, right: ${win.right}, top: ${win.top}, bottom: ${win.bottom} }),`,
        `    mouthBounds: Object.freeze({ left: ${mouthBounds.left}, right: ${mouthBounds.right}, top: ${mouthBounds.top}, bottom: ${mouthBounds.bottom} }),`,
        `    postLineInset: ${postLineInset},`,
        '    lintelDepthBias: 0,',
        '    columnPx: 8,',
        '    interiorFloorBounds: Object.freeze({',
        `        tileRects: Object.freeze([Object.freeze({ dx: ${rect.dx}, dy: ${rect.dy}, width: ${rect.width}, height: ${rect.height} })]),`,
        `        spriteBounds: Object.freeze({ left: ${mouthBounds.left}, right: ${mouthBounds.right}, top: ${mouthBounds.top}, bottom: ${mouthBounds.bottom} }),`,
        '    }),',
        '    bays: Object.freeze([',
        bayLines.join('\n'),
        '    ]),',
        '    frontArchRows: [',
        ...rowLines,
        "    ].join(''),",
        '});',
        BLOCK_CLOSE,
    ].join('\n');
}

export function forgeFingerprints() {
    return {
        base: sha12(join(FORGE_DIR, 'base.png')),
        hearth: sha12(join(FORGE_DIR, 'hearth.png')),
        banked: sha12(join(FORGE_DIR, 'banked.png')),
        rooms: sha12(join(FORGE_DIR, 'base.rooms.png')),
    };
}

/** Invariants of a calibration against the art, the manifest and OpenFront. */
export function verifyForgeCalibration(calibration, { base, manifest = loadSpriteManifest() } = {}) {
    const errors = [];
    const { width, height, front, mouth, bays, rect, postLineInset } = calibration;
    if (width !== FORGE_NATIVE.width || height !== FORGE_NATIVE.height) errors.push(`base.png is ${width}x${height}, expected 256x232`);

    // Registered layers and anchors untouched (manifest + registry).
    const entry = (manifest.buildings || []).find((candidate) => candidate.id === 'building.forge');
    if (!entry) errors.push('manifest: building.forge missing');
    else {
        if (String(entry.anchor) !== String(FORGE_NATIVE.anchor)) errors.push(`manifest: building.forge anchor ${entry.anchor} != [128,169]`);
        if (entry.width !== FORGE_NATIVE.width || entry.height !== FORGE_NATIVE.height) errors.push('manifest: building.forge is no longer 256x232');
        for (const [name, expected] of Object.entries(FORGE_REGISTERED_LAYERS)) {
            const layer = entry.layers?.[name];
            if (!layer) {
                errors.push(`manifest: building.forge.${name} missing`);
                continue;
            }
            if (String(layer.anchor) !== String(expected.anchor)) errors.push(`manifest: building.forge.${name} anchor moved to [${layer.anchor}]`);
        }
    }
    if (String(BUILDING_VISUAL_REGISTRY.forge?.sign?.at) !== String(FORGE_SIGN_AT)) errors.push('registry: forge sign.at moved');
    for (const name of ['base.rooms.png', 'hearth.png', 'banked.png', 'base.emissive.png', 'base.occluder.png', 'base.material.png']) {
        const path = join(FORGE_DIR, name);
        if (!existsSync(path)) {
            errors.push(`${name} missing`);
            continue;
        }
        const png = readPng(path);
        if (png.width !== width || png.height !== height) errors.push(`${name} is ${png.width}x${png.height}, not registered to base.png`);
    }

    // Exact zero-loss split through OpenFront.
    const rows = calibration.rows.join('');
    const split = splitOpenFrontMask(width, height, rows, base.data);
    if (split.frontArchCount + split.rearInteriorCount !== width * height) errors.push('split does not partition the sprite');
    let frontCount = 0;
    for (let i = 0; i < front.length; i++) {
        if (front[i] !== split.frontArchMask[i]) {
            errors.push('encoded rows do not round-trip the front mask');
            break;
        }
        frontCount += front[i];
    }
    if (frontCount < 1500) errors.push(`front arch covers only ${frontCount} texels (expected the piers, lintel and spandrels)`);
    for (const [y, [x0, x1]] of mouth) {
        for (let x = x0; x <= x1; x++) {
            if (split.frontArchMask[y * width + x]) {
                errors.push(`mouth texel (${x},${y}) split into the front arch`);
                break;
            }
        }
    }
    for (let i = 0; i < front.length; i++) {
        if (front[i] && base.data[i * 4 + 3] === 0) {
            errors.push('front arch includes a transparent texel');
            break;
        }
    }

    // Bays on the mouth floor, in the floor rect, between the building's
    // column sort line (half a tile behind the footprint edge) and the arch.
    for (const bay of bays) {
        const [sx, sy] = bay.at;
        const span = mouth.get(sy);
        if (!span || sx < span[0] || sx > span[1]) errors.push(`${bay.id} [${sx},${sy}] is not on the mouth floor`);
        if (base.data[(sy * width + sx) * 4 + 3] === 0) errors.push(`${bay.id} [${sx},${sy}] stands on a transparent texel`);
        if (split.frontArchMask[sy * width + sx]) errors.push(`${bay.id} feet fall on the front arch`);
        const { dx, dy } = bay.relTile;
        if (!(dx >= rect.dx && dx < rect.dx + rect.width && dy >= rect.dy && dy < rect.dy + rect.height)) {
            errors.push(`${bay.id} relTile (${dx}, ${dy}) is outside the floor rect`);
        }
        const behindColumns = sy - (frontEdgeSpriteY(sx) - 16.5);
        if (!(behindColumns > 0)) errors.push(`${bay.id} would sort behind the Forge's own columns`);
        const archLine = frontEdgeSpriteY(sx) - postLineInset * 32;
        if (!(archLine - sy >= 4)) errors.push(`${bay.id} is within ${(archLine - sy).toFixed(1)} texels of the arch sort line`);
    }
    // The yard stays in front of the arch: the forge's visit tiles all sort after it.
    const def = calibration.def;
    for (const visit of def.visitTiles || []) {
        if (visit.tileY < def.y + def.height) continue;
        if (!(visit.tileY > def.y + def.height - postLineInset)) errors.push(`visit tile (${visit.tileX},${visit.tileY}) would sort behind the arch line`);
    }
    // The shipped geometric profile is what this calibration overrides.
    if (!OPEN_FRONT_PROFILES.forge) errors.push('OpenFront has no forge profile');
    return errors;
}

/** Verify a building's surface-v1 page: H16/B/valid contract + AO pairs. */
export function verifySurfacePage(type, pairs = getBuildingSurfaceAoPairs(type)) {
    const dir = join(BUILDINGS_DIR, `building.${type}`);
    const surfacePath = join(dir, 'base.surface.png');
    if (!existsSync(surfacePath)) return [`${type}: base.surface.png missing (run bake-depth-channels.mjs --id=building.${type})`];
    const surface = readPng(surfacePath);
    const albedo = readPng(join(dir, 'base.png'));
    const errors = [];
    if (surface.width !== albedo.width || surface.height !== albedo.height) {
        return [`${type}: base.surface.png ${surface.width}x${surface.height} != base.png ${albedo.width}x${albedo.height}`];
    }
    const validation = validateSurfaceV1Buffer(surface.data, albedo.data, surface.width, surface.height);
    if (!validation.ok) errors.push(...validation.errors.slice(0, 4).map((error) => `${type}: ${error}`));
    const mono = checkAoMonotonicity({ rgba: surface.data, width: surface.width, height: surface.height, pairs });
    if (!pairs.length) errors.push(`${type}: registry has no surfaceAoPairs to check AO monotonicity`);
    if (!mono.ok) errors.push(`${type}: AO not monotonic at ${JSON.stringify(mono.violations)}`);
    return errors;
}

function readBlock(source) {
    const start = source.indexOf(BLOCK_OPEN);
    const end = source.indexOf(BLOCK_CLOSE);
    if (start < 0 || end < start) return null;
    return { start, end: end + BLOCK_CLOSE.length, text: source.slice(start, end + BLOCK_CLOSE.length) };
}

function printHelp() {
    console.log([
        'Usage: node scripts/sprites/bake-forge-openfront.mjs [--check] [--help]',
        '',
        'Calibrates the open-front Forge (OpenFront `forge` profile) to building.forge/base.png',
        'and writes FORGE_OPEN_FRONT_CALIBRATION into BuildingVisualRegistry.js. 0 PixelLab generations;',
        'base.png, its sidecars and every registered layer stay byte-identical.',
        '',
        '  --check   Verify the registry block, the art fingerprints, the split invariants and the',
        '            Forge/Command base.surface.png pages (H16 = 0 outside alpha, B <= 63, AO pairs).',
    ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return 0;
    }
    const checkOnly = argv.includes('--check');
    const base = readPng(join(FORGE_DIR, 'base.png'));
    const calibration = calibrateForgeOpenFront({ base });
    const errors = verifyForgeCalibration(calibration, { base });
    const block = renderCalibrationBlock(calibration, forgeFingerprints());
    const source = readFileSync(REGISTRY_PATH, 'utf8');
    const current = readBlock(source);
    if (!current) errors.push(`BuildingVisualRegistry.js has no ${BLOCK_OPEN} … ${BLOCK_CLOSE} block`);

    if (checkOnly) {
        if (current && current.text !== block) errors.push('registry FORGE_OPEN_FRONT_CALIBRATION is stale (run without --check)');
        errors.push(...verifySurfacePage('forge'));
        errors.push(...verifySurfacePage('command'));
    }
    if (errors.length) {
        for (const error of errors) console.error(`[forge:open-front] INVALID ${error}`);
        return 1;
    }
    const summary = `front arch ${calibration.front.reduce((s, v) => s + v, 0)} texels in ${calibration.rows.length} rows, mouth x ${calibration.mouthBounds.left}..${calibration.mouthBounds.right} y ${calibration.mouthBounds.top}..${calibration.mouthBounds.bottom}, postLineInset ${calibration.postLineInset}, bays ${calibration.bays.map((b) => `${b.id}@[${b.at}]`).join(' ')}`;
    if (checkOnly) {
        console.log(`[forge:open-front] OK calibration matches the art (${summary})`);
        console.log('[forge:open-front] OK base.surface.png pages: forge, command');
        return 0;
    }
    writeFileSync(REGISTRY_PATH, `${source.slice(0, current.start)}${block}${source.slice(current.end)}`);
    console.log(`[forge:open-front] WROTE FORGE_OPEN_FRONT_CALIBRATION (${summary})`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main());
}
