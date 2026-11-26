import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AssetManager, PLACEHOLDER_PATH } from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import {
    GLASS_RIM_ANCHOR,
    GLASS_RIM_ASSET_ID,
    GLASS_RIM_SIZE,
    GLASS_ROW_SPANS,
    InspectionGlass,
    glassRimImageFits,
    resolveGlassRimImage,
} from '../../claudeville/src/presentation/character-mode/InspectionGlass.js';
import {
    CouncilRibbon,
    PORTRAIT_H,
    PORTRAIT_HEADROOM,
    PORTRAIT_TOP,
    PORTRAIT_W,
    RIBBON_HEIGHT,
    UNDERLINE_TOP,
    VERB_GLYPH_H,
    VERB_TOP,
    drawCouncilScrim,
    layoutCouncilRibbon,
    measurePortraitBounds,
    portraitCropWindow,
    resolveScrimScale,
} from '../../claudeville/src/presentation/character-mode/CouncilRibbon.js';
import { paintPlaque, worldMaskEntry } from '../../claudeville/src/presentation/character-mode/BuildingPlaques.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { buildingCenterToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import {
    CREST_CHIP,
    attentionMarkRecords,
    drawAttentionPlates,
    layoutAttentionPlates,
} from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { LABEL_INK, WALNUT } from '../../claudeville/src/presentation/character-mode/WorldLabelKit.js';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry } from '../sprites/manifest-utils.mjs';

// W4-Fix-A — Wave 4 council fixes: the Glass rim never resolves to the
// checker placeholder, Theatre's Pure Stage drops harbour and banner
// signage, the Council Ribbon blits 1:1 portraits with verb breathing room
// over a backing-resolution scrim, plaques never leak ctx state, replaced
// masks rebuild their collision tables and crest-chip age notches sit in
// the motif gutter.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD = join(ROOT, 'claudeville/src/presentation/character-mode');
const MANIFEST = loadSpriteManifest();

// A Proxy 2D context: known fields are stored, every other call is recorded.
function anyCtx(extra = {}) {
    const calls = [];
    const state = {
        calls,
        saves: 0,
        restores: 0,
        font: '',
        fillStyle: '',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        measureText: text => ({ width: String(text).length * 7 }),
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        save() { state.saves++; },
        restore() { state.restores++; },
        ...extra,
    };
    return new Proxy(state, {
        get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'symbol') return undefined;
            return (...args) => { calls.push([key, ...args, target.fillStyle]); };
        },
        set(target, key, value) {
            target[key] = value;
            return true;
        },
    });
}

const textsOf = ctx => ctx.calls.filter(([method]) => method === 'fillText').map(([, text]) => String(text));

// ─── P0: AssetManager._pathFor + The Glass rim ──────────────────────────────

test('P0: every manifest entry resolves to a real sprite path, never the checker placeholder', () => {
    const pathFor = entry => AssetManager.prototype._pathFor.call(null, entry);
    // The runtime walk (AssetManager._flattenManifest) and the sprite
    // tooling's walk (every sprite group), so a new group cannot slip past.
    const runtime = AssetManager.prototype._flattenManifest.call(null, MANIFEST);
    const everywhere = collectSpriteEntries(MANIFEST);
    assert.ok(runtime.length > 200, `the runtime walk sees the manifest (${runtime.length})`);
    assert.deepEqual(runtime.map(entry => entry.id), everywhere.map(entry => entry.id), 'runtime and tooling walk the same entries');
    for (const entry of everywhere) {
        const path = pathFor(entry);
        assert.notEqual(path, PLACEHOLDER_PATH, `${entry.id} must not fall through to ${PLACEHOLDER_PATH}`);
        assert.equal(path, `assets/sprites/${pathForEntry(entry)}`, `${entry.id}: runtime path matches the sprite tooling`);
        assert.ok(existsSync(join(ROOT, 'claudeville', path)), `${entry.id} -> ${path} exists on disk`);
    }
    const byId = new Map(everywhere.map(entry => [entry.id, entry]));
    assert.equal(
        pathFor(byId.get(GLASS_RIM_ASSET_ID)),
        'assets/sprites/overlays/overlay.inspectionGlass.rim.png',
    );
    assert.equal(pathFor({ id: 'overlay.inspectionGlass.rim' }), 'assets/sprites/overlays/overlay.inspectionGlass.rim.png');
    // An explicit assetPath still wins over the generic overlay rule.
    assert.equal(pathFor(byId.get('overlay.pennantStrip')), 'assets/sprites/overlays/pennant.strip.png');
    // The specific prefixes are unchanged.
    assert.equal(pathFor({ id: 'overlay.status.selected' }), 'assets/sprites/overlays/overlay.status.selected.png');
    assert.equal(pathFor({ id: 'overlay.accessory.hoodUp' }), 'assets/sprites/overlays/overlay.accessory.hoodUp.png');
    const rim = PNG.sync.read(readFileSync(join(ROOT, 'claudeville', pathFor({ id: GLASS_RIM_ASSET_ID }))));
    assert.deepEqual([rim.width, rim.height], [GLASS_RIM_SIZE, GLASS_RIM_SIZE]);
});

function rimCtx() {
    const fills = [];
    const draws = [];
    return {
        fills,
        draws,
        imageSmoothingEnabled: true,
        fillStyle: '',
        save() {},
        restore() {},
        fillRect(x, y, w, h) { fills.push({ x, y, w, h }); },
        drawImage(img, x, y, w, h) { draws.push({ img, x, y, w, h }); },
    };
}

function activeGlass(x = 400, y = 300) {
    const glass = new InspectionGlass({ enabled: true });
    glass.onPointerMove(x, y, { pointerType: 'mouse' });
    glass.onKeyDown('KeyG');
    assert.equal(glass.isActive(), true);
    return glass;
}

function assertProceduralRim(ctx, cx, cy) {
    assert.equal(ctx.draws.length, 0, 'no image is stretched over the lens');
    assert.ok(ctx.fills.length > 0, 'the procedural rim is painted');
    const left = Math.min(...ctx.fills.map(f => f.x));
    const top = Math.min(...ctx.fills.map(f => f.y));
    const right = Math.max(...ctx.fills.map(f => f.x + f.w));
    const bottom = Math.max(...ctx.fills.map(f => f.y + f.h));
    assert.deepEqual([left, top, right - left, bottom - top], [cx - 114, cy - 114, 228, 228], 'exact 228x228 stepped rim');
    // The aperture stays clear: no rim fill crosses a GLASS_ROW_SPANS row.
    for (const fill of ctx.fills) {
        assert.equal(fill.h, 1);
        const span = GLASS_ROW_SPANS[fill.y - cy + 110];
        if (!span) continue;
        const x0 = cx + span.x0;
        const x1 = x0 + span.width;
        assert.ok(fill.x + fill.w <= x0 || fill.x >= x1, `rim fill at (${fill.x}, ${fill.y}) stays out of the aperture`);
    }
}

test('P0: drawRim blits only the resident, exactly 228x228 rim — a 64 px placeholder gets the procedural rim', () => {
    const glass = activeGlass(400, 300);
    const placeholder = { naturalWidth: 64, naturalHeight: 64, width: 64, height: 64 };
    const realRim = { naturalWidth: 228, naturalHeight: 228, width: 228, height: 228 };

    // The AssetManager after a failed load: get() hands back the checker,
    // has() reports it missing.
    const failed = { has: () => false, get: () => placeholder };
    let ctx = rimCtx();
    assert.equal(glass.drawRim(ctx, failed), true);
    assertProceduralRim(ctx, 400, 300);

    // Even a resident-looking source cannot stretch a wrong-sized image.
    ctx = rimCtx();
    glass.drawRim(ctx, { has: () => true, get: () => placeholder });
    assertProceduralRim(ctx, 400, 300);

    // Undecoded image (0x0) and a direct 64 px image: procedural too.
    ctx = rimCtx();
    glass.drawRim(ctx, { has: () => true, get: () => ({ naturalWidth: 0, naturalHeight: 0, width: 0, height: 0 }) });
    assertProceduralRim(ctx, 400, 300);
    ctx = rimCtx();
    glass.drawRim(ctx, placeholder);
    assertProceduralRim(ctx, 400, 300);

    // The real resident rim draws once, 1:1, at (cx - 114, cy - 114).
    const queried = [];
    const resident = {
        has: (id, options) => { queried.push([id, options]); return id === GLASS_RIM_ASSET_ID; },
        get: id => (id === GLASS_RIM_ASSET_ID ? realRim : undefined),
    };
    ctx = rimCtx();
    assert.equal(glass.drawRim(ctx, resident), true);
    assert.deepEqual(ctx.draws, [{ img: realRim, x: 400 - GLASS_RIM_ANCHOR[0], y: 300 - GLASS_RIM_ANCHOR[1], w: 228, h: 228 }]);
    assert.equal(ctx.fills.length, 0);
    assert.deepEqual(queried[0], [GLASS_RIM_ASSET_ID, { request: false }], 'residency is checked without requesting a load');

    // A direct 228 px image is accepted too.
    ctx = rimCtx();
    glass.drawRim(ctx, realRim);
    assert.equal(ctx.draws.length, 1);

    assert.equal(glassRimImageFits(placeholder), false);
    assert.equal(glassRimImageFits(realRim), true);
    assert.equal(glassRimImageFits({ width: 228, height: 228 }), true, 'canvas / bitmap sizes count');
    assert.equal(resolveGlassRimImage(null), null);
    assert.equal(resolveGlassRimImage(failed), null);
    assert.equal(resolveGlassRimImage({ [GLASS_RIM_ASSET_ID]: realRim }), realRim, 'id-keyed sources still resolve');

    // A postcard frame never draws the rim.
    ctx = rimCtx();
    withPostcardFrame(() => assert.equal(glass.drawRim(ctx, resident), false));
    assert.equal(ctx.draws.length + ctx.fills.length, 0);
});

// ─── P1: Theatre Pure Stage drops harbour signage and the banner board ──────

// The body of `name` in `file` up to the next method definition (the
// postcard test's parser).
const DEFINITION = /^(?:export )?(?:async )?function (\w+)|^    (?:static )?(?:async )?([_a-zA-Z]\w*)\s*\([^;]*\)\s*\{\s*$/;
function methodBody(file, name) {
    const lines = readFileSync(join(WORLD, file), 'utf8').split('\n');
    const nameAt = line => {
        const match = DEFINITION.exec(line);
        return match && (match[1] || match[2]);
    };
    const start = lines.findIndex(line => nameAt(line) === name);
    assert.ok(start >= 0, `${file} defines ${name}`);
    let end = start + 1;
    while (end < lines.length && !nameAt(lines[end])) end++;
    return lines.slice(start, end).join('\n');
}

test('P1: every harbour signage guard stands down for Theatre beside its postcard guard', () => {
    for (const name of [
        '_drawShipTierBadge',
        '_drawAmendSuperscript',
        '_drawRepoShield',
        '_drawReleaseConvoyCue',
        '_drawCommitPennant',
        '_drawHoverCargoLabel',
        '_drawFinaleEffect',
        '_drawRepoAnchorage',
        'drawScreenSummary',
    ]) {
        const body = methodBody('HarborTraffic.js', name);
        const postcardGuards = body.match(/postcardFrame\(\)/g) || [];
        const theatreGuards = body.match(/this\._theatreMode/g) || [];
        assert.ok(postcardGuards.length > 0, `${name} keeps its postcard guard`);
        assert.equal(theatreGuards.length, postcardGuards.length, `${name}: every postcardFrame() guard has a Theatre twin`);
    }
    assert.match(methodBody('BuildingSprite.js', '_drawAttentionBannerBoard'), /postcardFrame\(\) \|\| this\._theatreMode === true/);
});

test('P1: HarborTraffic.setTheatreMode drops every plate, superscript, caption and summary', () => {
    const harbor = new HarborTraffic({});
    assert.equal(harbor._theatreMode, false);
    const ship = { id: 's1', x: 100, y: 100, monogram: 'CV', project: '/repo/claude-ville', branch: 'main', amendCount: 2, sha: 'abc1234' };
    const paint = () => {
        const ctx = anyCtx();
        harbor._drawRepoShield(ctx, ship, 2);
        harbor._drawAmendSuperscript(ctx, ship, 2);
        harbor._drawFinaleEffect(ctx, { status: 'success', progress: 0.5, x: 10, y: 10, shipCount: 3 });
        harbor._drawHoverCargoLabel(ctx, ship, 2);
        return ctx;
    };
    const live = paint();
    assert.ok(textsOf(live).includes('CV'), 'the live harbour labels its shields');
    assert.ok(textsOf(live).length >= 3);
    const liveShieldFills = live.calls.filter(([method]) => method === 'fillRect').length;

    harbor.setTheatreMode(true);
    assert.equal(harbor._theatreMode, true);
    const stage = paint();
    assert.deepEqual(textsOf(stage), [], 'Pure Stage: no harbour text at all');
    assert.ok(stage.calls.filter(([method]) => method === 'fillRect').length > 0, 'the shields themselves still sail');
    assert.ok(stage.calls.filter(([method]) => method === 'fillRect').length <= liveShieldFills);

    // The screen summary never even reads its summary on a Pure Stage.
    let read = 0;
    harbor.latestScreenSummary = () => { read++; return null; };
    harbor.drawScreenSummary(anyCtx(), { width: 1280, height: 720 }, null, 0);
    assert.equal(read, 0);
    harbor.setTheatreMode(false);
    harbor.drawScreenSummary(anyCtx(), { width: 1280, height: 720 }, null, 0);
    assert.equal(read, 1);
    assert.ok(textsOf(paint()).includes('CV'), 'leaving Theatre restores the labels');
});

// An AssetManager stand-in over one solid landmark mask per building.
function solidAssets() {
    const masks = new Map();
    const dims = new Map();
    for (const def of BUILDING_DEFS) {
        const id = `building.${def.type}`;
        masks.set(id, new Uint8Array(40 * 30).fill(1));
        dims.set(id, { w: 40, h: 30 });
    }
    return {
        masks,
        dims,
        getMask(id) { return this.masks.get(id); },
        getDims(id) { return this.dims.get(id); },
        getAnchor() { return [20, 30]; },
        getEntry(id) { return this.dims.has(id) ? { id } : undefined; },
        has() { return false; },
        get() { return undefined; },
    };
}

test('P1: the Command attention banner count board never paints on a Pure Stage', () => {
    const renderer = new BuildingSprite(solidAssets(), {}, null);
    renderer.buildings = BUILDING_DEFS;
    renderer.attentionBanner = { count: 2, tier: 0 };
    const command = BUILDING_DEFS.find(def => def.type === 'command');
    const center = buildingCenterToWorld(command);
    const board = () => {
        const ctx = anyCtx();
        renderer._drawAttentionBannerBoard(ctx, command, { id: 'building.command' }, center.x, center.y, 'whole');
        return ctx;
    };
    assert.deepEqual(textsOf(board()), ['2'], 'the live board prints the actionable count');
    renderer.setTheatreMode(true);
    const stage = board();
    assert.equal(stage.calls.length, 0, 'Pure Stage: no board, no count');
    renderer.setTheatreMode(false);
    assert.deepEqual(textsOf(board()), ['2']);
    let postcard = null;
    withPostcardFrame(() => { postcard = board(); });
    assert.equal(postcard.calls.length, 0, 'postcards still drop it');
});

// ─── P2: replaced landmark masks rebuild their foreign collision tables ─────

test('P2: replacing a resident landmark mask invalidates its foreign summed-area table', () => {
    const assets = solidAssets();
    const renderer = new BuildingSprite(assets, {}, null);
    renderer.buildings = BUILDING_DEFS;
    const first = renderer._signForeignMasks(false);
    assert.equal(first.length, BUILDING_DEFS.length);
    assert.equal(renderer._signForeignMasks(false), first, 'unchanged masks reuse the cache');

    // Replace the forge mask (same presence, new pixels): an empty mask.
    const id = 'building.forge';
    assets.masks.set(id, new Uint8Array(40 * 30));
    const second = renderer._signForeignMasks(false);
    assert.notEqual(second, first, 'a replaced mask rebuilds the landmark tables');
    const forgeBefore = first.find(entry => entry.type === 'forge');
    const forgeAfter = second.find(entry => entry.type === 'forge');
    // Compare against a fresh table over the replacement mask.
    const expected = worldMaskEntry('forge', assets.masks.get(id), 40, 30, forgeAfter.left, forgeAfter.top);
    assert.deepEqual([...forgeAfter.sat], [...expected.sat]);
    assert.notDeepEqual([...forgeAfter.sat], [...forgeBefore.sat]);
    assert.equal(renderer._signForeignMasks(false), second);

    // A mask that disappears and returns as a new object rebuilds as well.
    assets.masks.delete(id);
    const third = renderer._signForeignMasks(false);
    assert.equal(third.some(entry => entry.type === 'forge'), false);
    assets.masks.set(id, new Uint8Array(40 * 30).fill(1));
    const fourth = renderer._signForeignMasks(false);
    assert.equal(fourth.some(entry => entry.type === 'forge'), true);
});

// ─── P1: BuildingPlaques.paintPlaque balances save/restore on a throw ───────

test('P1: paintPlaque restores ctx state even when a paint call throws', () => {
    const plaque = { width: 60, height: 17, rows: [], title: 'FORGE', titleWidth: 35, headWidth: 50 };
    const options = { x: 100, y: 100, labelScale: 1, poleBottom: null, isLandmark: true, accent: '#d4984e' };
    const ok = anyCtx();
    paintPlaque(ok, plaque, options);
    assert.equal(ok.saves, ok.restores, 'a normal paint is balanced');
    assert.ok(textsOf(ok).includes('FORGE'));

    const throwing = anyCtx({ fillText() { throw new Error('glass pass failure'); } });
    assert.throws(() => paintPlaque(throwing, plaque, options), /glass pass failure/);
    assert.ok(throwing.saves > 0);
    assert.equal(throwing.saves, throwing.restores, 'the throw never leaks the plaque transform');
});

// ─── P1 + P2: Council Ribbon portraits, verb breathing room, DPR scrim ──────

// A tiny raster context: integer fillRects into a pixel map; drawImage is
// recorded (its source rect and destination rect).
function rasterCtx() {
    const pixels = new Map();
    const blits = [];
    return {
        pixels,
        blits,
        fillStyle: '',
        imageSmoothingEnabled: true,
        save() {},
        restore() {},
        fillRect(x, y, w, h) {
            for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixels.set(`${xx},${yy}`, this.fillStyle);
        },
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            blits.push({ img, sx, sy, sw, sh, dx, dy, dw, dh, smooth: this.imageSmoothingEnabled });
        },
    };
}

test('P2: ribbon rows — 30 px portrait, underline 32-34, verb 36-40 with a clear row on each side, 44 px total', () => {
    assert.equal(RIBBON_HEIGHT, 44);
    assert.equal(PORTRAIT_W, 32);
    assert.equal(PORTRAIT_H, 30);
    assert.equal(PORTRAIT_TOP, 2);
    assert.equal(UNDERLINE_TOP, 32);
    assert.equal(VERB_TOP, 36);
    assert.equal(VERB_TOP + VERB_GLYPH_H + 1, RIBBON_HEIGHT - 2, 'one clear row between the verb and the bottom bevel');

    const lead = { id: 'lead', status: 'working', currentTool: 'Bash' };
    const child = { id: 'child', status: 'working', currentTool: 'Edit' };
    const layout = layoutCouncilRibbon({ lead, children: [child], viewport: { width: 1280, height: 720 }, selectedId: 'lead' });
    const [leadCell, childCell] = layout.cells;
    assert.deepEqual(leadCell.portraitRect, { x: leadCell.x + 6, y: leadCell.y + 2, width: 32, height: 30 });
    assert.deepEqual(leadCell.underlineRect, { x: leadCell.x + 6, y: leadCell.y + 32, width: 32, height: 3 });
    assert.equal(leadCell.verbTop, leadCell.y + 36);
    assert.deepEqual(childCell.portraitRect, { x: childCell.x + 4, y: childCell.y + 2, width: 32, height: 30 });

    const ribbon = new CouncilRibbon({ publishBox: () => {} });
    ribbon.setSquad({ lead, children: [child], selectedId: 'lead' });
    const ctx = rasterCtx();
    const box = ribbon.draw(ctx, { width: 1280, height: 720 });
    assert.ok(box);
    const cell = box.cells[0];
    assert.equal(cell.verb, 'EXEC');
    const row = dy => {
        const colours = new Set();
        for (let x = cell.x + 2; x < cell.x + cell.width - 2; x++) colours.add(ctx.pixels.get(`${x},${cell.y + dy}`));
        return colours;
    };
    // The gold EXEC glyphs live only on rows 36-40.
    let goldRows = 0;
    for (let dy = 0; dy < RIBBON_HEIGHT; dy++) {
        const hasGold = row(dy).has(LABEL_INK.gold);
        if (dy >= 36 && dy <= 40) goldRows += hasGold ? 1 : 0;
        else if (dy !== 1) assert.equal(hasGold, false, `no verb gold on row ${dy}`);
    }
    assert.equal(goldRows, 5, 'the 5-row verb is drawn whole');
    assert.deepEqual([...row(35)], [WALNUT.fill], 'row 35 is clear walnut (under the underline)');
    assert.deepEqual([...row(41)], [WALNUT.fill], 'row 41 is clear walnut (above the bevel)');
    assert.equal(ctx.pixels.get(`${cell.x + 10},${cell.y + 42}`), LABEL_INK.brass, 'row 42 is the bottom brass bevel');
    assert.equal(ctx.pixels.get(`${cell.x + 10},${cell.y + 32}`), cell.statusColor, 'underline starts on row 32');
    assert.equal(ctx.pixels.get(`${cell.x + 10},${cell.y + 34}`), cell.statusColor, 'underline ends on row 34');
});

// A synthetic 92x92 villager: a 2 px staff from row 8, a 16 px head at
// columns 38-53 from row 17, shoulders and body below.
function villagerAlpha(x, y, { shift = 0 } = {}) {
    if (x >= 70 && x <= 71 && y >= 8 && y <= 75) return 255;
    if (y >= 17 + shift && y <= 30 + shift && x >= 38 && x <= 53) return 255;
    if (y > 30 + shift && y <= 72 && x >= 30 && x <= 61) return 255;
    return 0;
}

function villagerData(options) {
    const data = new Uint8ClampedArray(92 * 92 * 4);
    for (let y = 0; y < 92; y++) for (let x = 0; x < 92; x++) data[(y * 92 + x) * 4 + 3] = villagerAlpha(x, y, options);
    return data;
}

test('P1: portrait crop is an integer 1:1 window on the head and shoulders, never a resample', () => {
    const bounds = measurePortraitBounds(villagerData(), 92, 92);
    assert.equal(bounds.minY, 17, 'the 2 px staff above the head never claims the head top');
    assert.equal(bounds.centerX, 46, 'the head column, not the staff or the body bbox');
    const crop = portraitCropWindow({ sx: 184, sy: 276, sw: 92, sh: 92 }, bounds);
    assert.deepEqual(crop, { sx: 184 + 30, sy: 276 + 17 - PORTRAIT_HEADROOM, sw: 32, sh: 30, dx: 0, dy: 0 });
    // Fallback (unreadable cell): the centre-top box, still 1:1.
    const fallback = portraitCropWindow({ sx: 0, sy: 0, sw: 92, sh: 92 }, null);
    assert.deepEqual(fallback, { sx: 31, sy: 11, sw: 32, sh: 30, dx: 0, dy: 0 });
    // A cell smaller than the box is centred, never stretched.
    assert.deepEqual(portraitCropWindow({ sx: 0, sy: 0, sw: 20, sh: 16 }, null), { sx: 0, sy: 0, sw: 20, sh: 16, dx: 6, dy: 0 });
    assert.equal(measurePortraitBounds(new Uint8ClampedArray(92 * 92 * 4), 92, 92), null, 'a clear cell has no head');
});

// A DOM double whose scratch canvases read pixels from a synthetic source.
function withPortraitDom(run) {
    const previous = globalThis.document;
    globalThis.document = {
        createElement() {
            const canvas = { width: 0, height: 0 };
            let drawn = null;
            canvas.getContext = () => ({
                imageSmoothingEnabled: true,
                drawImage(source, sx, sy, sw, sh) { drawn = { source, sx, sy, sw, sh }; },
                getImageData(x, y, w, h) {
                    const data = new Uint8ClampedArray(w * h * 4);
                    for (let yy = 0; yy < h; yy++) {
                        for (let xx = 0; xx < w; xx++) {
                            data[(yy * w + xx) * 4 + 3] = drawn.source.alphaAt(drawn.sx + xx - drawn.source.cellX, drawn.sy + yy - drawn.source.cellY);
                        }
                    }
                    return { data };
                },
            });
            return canvas;
        },
    };
    try {
        return run();
    } finally {
        globalThis.document = previous;
    }
}

test('P1: ribbon portraits blit the live pose cell at 1:1, head-centred, and hold still through a 1 px bob', () => {
    withPortraitDom(() => {
        let shift = 0;
        const sheet = { width: 736, height: 920, cellX: 92, cellY: 184, alphaAt: (x, y) => villagerAlpha(x, y, { shift }) };
        // A bobbing sheet is a fresh generation per frame (immutable sources).
        const pose = () => ({ canvas: sheet, sx: 92, sy: 184, sw: 92, sh: 92 });
        const lead = { agent: { id: 'lead', status: 'working' }, currentPoseCell: pose };
        const ribbon = new CouncilRibbon({ publishBox: () => {} });
        ribbon.setSquad({ lead, children: [{ id: 'kid', status: 'idle' }], selectedId: 'lead' });

        const frame = () => {
            const ctx = rasterCtx();
            const box = ribbon.draw(ctx, { width: 1280, height: 720 });
            const blit = ctx.blits.find(b => b.img === sheet);
            return { box, blit };
        };
        const { box, blit } = frame();
        const rect = box.cells[0].portraitRect;
        assert.ok(blit, 'the pose cell is blitted');
        assert.equal(blit.smooth, false);
        assert.equal(blit.dw, blit.sw, '1:1 width');
        assert.equal(blit.dh, blit.sh, '1:1 height');
        for (const value of [blit.sx, blit.sy, blit.sw, blit.sh, blit.dx, blit.dy]) assert.ok(Number.isInteger(value));
        assert.deepEqual([blit.sx, blit.sy, blit.sw, blit.sh], [92 + 30, 184 + 16, 32, 30], 'the head-and-shoulders window');
        assert.ok(blit.dx >= rect.x && blit.dx + blit.dw <= rect.x + rect.width, 'inside the portrait box');
        assert.ok(blit.dy >= rect.y && blit.dy + blit.dh <= rect.y + rect.height);

        // The idle bob (head 1 px lower, a new sheet generation) keeps the window.
        shift = 1;
        sheet.__cvSourceGeneration = 2;
        assert.deepEqual([frame().blit.sx, frame().blit.sy], [blit.sx, blit.sy], 'a 1 px bob never moves the crop');
        // A real change of posture (head 4 px lower) re-frames.
        shift = 4;
        sheet.__cvSourceGeneration = 3;
        assert.deepEqual([frame().blit.sx, frame().blit.sy], [92 + 30, 184 + 20]);
    });
});

test('P2: drawCouncilScrim cuts holes on whole backing pixels at DPR 2 (1.5x rung) and composites 1:1', () => {
    const surfaces = [];
    const createCanvas = (width, height) => {
        const ops = [];
        const surfaceCtx = {
            fillStyle: '',
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: true,
            save() {}, restore() {},
            setTransform(...args) { ops.push({ op: 'setTransform', args }); },
            clearRect(x, y, w, h) { ops.push({ op: 'clearRect', x, y, w, h }); },
            fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h, alpha: this.globalAlpha }); },
            drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
                ops.push({ op: 'hole', gco: this.globalCompositeOperation, smooth: this.imageSmoothingEnabled, dx, dy, dw, dh });
            },
        };
        const surface = { width, height, ops, getContext: () => surfaceCtx };
        surfaces.push(surface);
        return surface;
    };
    const composites = [];
    const screen = {
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        save() {}, restore() {},
        getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { composites.push({ img, sx, sy, sw, sh, dx, dy, dw, dh, smooth: this.imageSmoothingEnabled }); },
    };
    const sheet = { tag: 'sheet' };
    // Camera at the 1.5x rung: one world texel is 1.5 CSS px = 3 device px.
    const camera = { zoom: 1.5, worldToScreen: (x, y) => ({ x: x * 1.5 + 0.25, y: y * 1.5 + 0.75 }) };
    const squad = [
        { id: 'a', _poseCell: { canvas: sheet, sx: 0, sy: 0, sw: 92, sh: 92, dx: 101, dy: 57, drawScale: 1 } },
        { id: 'hidden', _occludedByWorld: true, _poseCell: { canvas: sheet, sx: 0, sy: 0, sw: 92, sh: 92, dx: 0, dy: 0 } },
    ];
    const result = drawCouncilScrim(screen, { width: 1280, height: 720 }, squad, false, { camera, zoom: 1.5, createCanvas });
    assert.deepEqual(result, { drawn: true, alpha: 0.28, holesCut: 1 });
    assert.equal(surfaces.length, 1);
    const [surface] = surfaces;
    assert.deepEqual([surface.width, surface.height], [2560, 1440], 'the scratch is backing-sized');
    const fill = surface.ops.find(op => op.op === 'fillRect');
    assert.deepEqual([fill.x, fill.y, fill.w, fill.h], [0, 0, 2560, 1440]);
    const [hole] = surface.ops.filter(op => op.op === 'hole');
    assert.equal(hole.gco, 'destination-out');
    assert.equal(hole.smooth, false);
    for (const value of [hole.dx, hole.dy, hole.dw, hole.dh]) assert.ok(Number.isInteger(value), `hole ${value} is whole backing px`);
    assert.deepEqual([hole.dx, hole.dy, hole.dw, hole.dh], [Math.round((101 * 1.5 + 0.25) * 2), Math.round((57 * 1.5 + 0.75) * 2), 276, 276]);
    assert.equal(hole.dw / 92, 3, 'three device px per texel, exactly');
    assert.equal(composites.length, 1);
    const [composite] = composites;
    assert.deepEqual([composite.sw, composite.sh, composite.dw, composite.dh], [2560, 1440, 1280, 720], 'one scratch px per device px');
    assert.equal(composite.smooth, false);

    // An explicit dpr wins; fractional DPR 1.5 stays fractional (whole device px).
    assert.equal(resolveScrimScale(screen, { dpr: 3 }), 3);
    assert.equal(resolveScrimScale(screen), 2, 'derived from the screen transform');
    assert.equal(resolveScrimScale({}, {}), Number(globalThis.devicePixelRatio) > 0 ? globalThis.devicePixelRatio : 1);
    assert.equal(resolveScrimScale({ getTransform: () => ({ a: 1.9999999 }) }), 2, 'float noise snaps');
    surfaces.length = 0;
    drawCouncilScrim({ ...screen, getTransform: () => ({ a: 1.5 }) }, { width: 1281, height: 721 }, [], false, { createCanvas });
    assert.deepEqual([surfaces[0].width, surfaces[0].height], [Math.round(1281 * 1.5), Math.round(721 * 1.5)]);

    // Direct mode snaps hole coordinates to backing px under the caller's transform.
    const directOps = [];
    const direct = {
        ...screen,
        fillRect() {},
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { directOps.push({ dx, dy, dw, dh }); },
    };
    drawCouncilScrim(direct, { width: 1280, height: 720 }, squad, true, { camera, zoom: 1.5, direct: true });
    const [directHole] = directOps;
    for (const value of [directHole.dx, directHole.dy, directHole.dw, directHole.dh]) {
        assert.ok(Number.isInteger(value * 2), `${value} CSS px is a whole device px at DPR 2`);
    }
    assert.equal(directHole.dw, 138);
});

// ─── P2: crest chip age notch in the motif gutter; READ in Theatre ──────────

const ctx7 = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
const camera = { worldToScreen: (x, y) => ({ x, y: y + 300 }) };
const viewport = { width: 1600, height: 900 };
const NOW = 50_000_000;

function waiting(id, x, ageMs) {
    return { x, y: 0, agent: { id, name: `Agent ${id}`, status: AgentStatus.WAITING_ON_USER, statusSince: NOW - ageMs } };
}

function recordingCtx() {
    const calls = [];
    return {
        calls,
        font: '',
        fillStyle: '',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {}, restore() {}, translate() {}, scale() {}, setTransform() {},
        beginPath() {}, rect() {}, clip() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: text => ({ width: String(text).length * 7 }),
        fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h, this.fillStyle]); },
        clearRect(x, y, w, h) { calls.push(['clearRect', x, y, w, h]); },
        fillText(text, x, y) { calls.push(['fillText', String(text), x, y, this.fillStyle]); },
        drawImage(...args) { calls.push(['drawImage', ...args]); },
    };
}

// A canvas double for the GPU mark-record stamps (they only need a 2D
// context to bake into).
function withStampDom(run) {
    const previous = globalThis.document;
    globalThis.document = {
        createElement() {
            const canvas = { width: 0, height: 0 };
            canvas.getContext = () => anyCtx();
            return canvas;
        },
    };
    try {
        return run();
    } finally {
        globalThis.document = previous;
    }
}

test('P2: a crest chip\'s age notch sits in the motif cell\'s right gutter, not after the digits', () => {
    withStampDom(() => {
        // 2 minutes: rung 1 (one notch row), still a resting chip.
        const layout = layoutAttentionPlates(ctx7, { sprites: [waiting('a', 400, 2 * 60_000)], camera, viewport, now: NOW });
        const plate = layout.plates[0];
        assert.equal(plate.compact, true);
        assert.equal(plate.tier, 1);
        const left = plate.rect.left;
        const top = plate.rect.top;
        assert.equal(plate.rect.right - left, CREST_CHIP.single, 'chip width unchanged (43 px)');

        const ctx = recordingCtx();
        drawAttentionPlates(ctx, layout);
        const notches = ctx.calls.filter(([m, , , w, h, ink]) => m === 'fillRect' && w === 3 && h === 2 && ink === LABEL_INK.plate);
        assert.equal(notches.length, 1);
        const [, nx, ny] = notches[0];
        assert.equal(nx, left + 1 + 13, 'one clear pixel after the 8 px motif (cell columns 4-11)');
        assert.equal(ny, top + 11);
        const [, text, textX] = ctx.calls.find(([m]) => m === 'fillText');
        assert.equal(text, '2m');
        assert.equal(textX, left + 1 + 16, 'the text cell starts right after the gutter');
        assert.ok(nx + 3 <= textX, 'the notch ends before the first glyph cell');
        assert.ok(nx > left + 1 + 4 + 7, 'the notch clears the motif');

        // The GPU mark records carry the same notch at backing scale.
        const records = attentionMarkRecords(layout, { scale: 2, out: [] });
        assert.ok(records, 'records express the chip exactly');
        const notchRecord = records.find(r => r.textureKey === 'mark:inks' && r.width === 6 && r.height === 4 && r.x === nx * 2 && r.y === ny * 2);
        assert.ok(notchRecord, 'the GPU notch record matches the overlay fill, pixel for pixel');
    });
});

test('P2: READ inside Theatre (effective theatreMode false) lays out and draws the full plates', () => {
    const sprites = [waiting('a', 400, 45_000)];
    const read = layoutAttentionPlates(ctx7, { sprites, camera, viewport, now: NOW, readMode: true, theatreMode: false });
    assert.equal(read.theatre, false);
    assert.equal(read.plates[0].compact, false, 'READ returns the full plate');
    const ctx = recordingCtx();
    drawAttentionPlates(ctx, read, { theatreMode: false, beaconsOnly: false });
    const drawnTexts = ctx.calls.filter(([m]) => m === 'fillText').map(([, t]) => t);
    assert.ok(drawnTexts.includes('NEEDS YOU'), 'the status word is drawn');
    assert.ok(drawnTexts.includes('Agent a'), 'the name is drawn');
    // A Pure Stage layout (no READ) stays beacons only.
    const stage = layoutAttentionPlates(ctx7, { sprites, camera, viewport, now: NOW, theatreMode: true });
    const stageCtx = recordingCtx();
    drawAttentionPlates(stageCtx, stage, { theatreMode: true, beaconsOnly: true });
    assert.equal(stageCtx.calls.filter(([m]) => m === 'fillText').length, 0);
});
