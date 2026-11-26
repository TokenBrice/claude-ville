import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { STATUS_VISUALS } from '../../claudeville/src/config/theme.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import {
    BUILDING_VISUAL_REGISTRY,
    getBuildingSignAnchor,
    signBoxFor,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import {
    CARVED_MOTIF_ORDER,
    PLAQUE_HEAD_H,
    carvedMotifTexels,
    carvedTallyRects,
    drawCarvedMotifBracket,
    foreignArea,
    isForeignRect,
    normalizeSignageMode,
    roofRowFor,
    signChitRungs,
    worldMaskEntry,
} from '../../claudeville/src/presentation/character-mode/BuildingPlaques.js';
import {
    CREST_CHIP,
    CREST_FULL_AGE_MS,
    attentionKeyAt,
    attentionMarkRecords,
    attentionScreenRects,
    crestAgeText,
    crestChipWidth,
    drawAttentionPlates,
    layoutAttentionPlates,
} from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import { drawCrowdClusterBadges } from '../../claudeville/src/presentation/character-mode/CrowdClusterOverlay.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { LABEL_INK } from '../../claudeville/src/presentation/character-mode/WorldLabelKit.js';
import { buildingHoverLine, hoverPlateLines, placeHoverPlate } from '../../claudeville/src/presentation/shared/WorldHoverPlate.js';
import { collectSpriteEntries, loadSpriteManifest } from '../sprites/manifest-utils.mjs';
import { signAnchorReport } from '../world/validate-buildings.mjs';

// W4-A (Spec 04 §2.3, §4.2, §4.3; R1, R3, R4, R5, R6, R7, R12, R14) — the
// signage diet, authored `sign.at`, the crest chip and the Carved Motifs,
// measured on the real sprites where the contract is about art.

const SPRITES = 'claudeville/assets/sprites';
const LANDMARKS = BUILDING_DEFS.filter(def => def.labelPriority === 'landmark').map(def => def.type);
const MANIFEST = new Map(collectSpriteEntries(loadSpriteManifest(), ['buildings']).map(entry => [entry.id, entry]));

function readPng(path) {
    return PNG.sync.read(readFileSync(path));
}

function alphaMask(png) {
    const mask = new Uint8Array(png.width * png.height);
    for (let i = 0; i < mask.length; i++) mask[i] = png.data[i * 4 + 3] > 16 ? 1 : 0;
    return mask;
}

const BASES = new Map(LANDMARKS.map(type => [type, readPng(join(SPRITES, 'buildings', `building.${type}`, 'base.png'))]));
const EMISSIVES = new Map(LANDMARKS.map(type => [type, readPng(join(SPRITES, 'buildings', `building.${type}`, 'base.emissive.png'))]));
const ASH = readPng(join(SPRITES, 'vegetation', 'veg.tree.ash.world.png'));
const ASH_MASK = { mask: alphaMask(ASH), w: ASH.width, h: ASH.height };

// An AssetManager stand-in over the real landmark masks, dims and anchors.
function realAssets() {
    const assets = {
        dims: new Map(),
        anchors: new Map(),
        masks: new Map(),
        getDims(id) { return this.dims.get(id); },
        getAnchor(id) { return this.anchors.get(id) || [0, 0]; },
        getMask(id) { return this.masks.get(id); },
        getEntry(id) { return this.dims.has(id) ? { id } : undefined; },
        has() { return false; },
        get() { return undefined; },
    };
    for (const type of LANDMARKS) {
        const id = `building.${type}`;
        const png = BASES.get(type);
        assets.dims.set(id, { w: png.width, h: png.height });
        assets.anchors.set(id, MANIFEST.get(id).anchor);
        assets.masks.set(id, alphaMask(png));
    }
    return assets;
}

// A 2D context that measures Departure-Mono-like 7 px glyphs and records.
function recordingCtx() {
    const calls = [];
    const ctx = {
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
    return ctx;
}

function texts(ctx) {
    return ctx.calls.filter(([method]) => method === 'fillText').map(([, text]) => text);
}

// A BuildingSprite over the real landmarks, with `_paintPlaque` recording
// what the label pass would paint (the motif stamps need a DOM canvas).
function harness({ sprites = [], ash = true } = {}) {
    const renderer = new BuildingSprite(realAssets(), {}, null);
    renderer.buildings = BUILDING_DEFS;
    renderer.agentSprites = sprites;
    if (ash) renderer.setWorldAshMask({ ...ASH_MASK });
    else renderer.setWorldAshMask(null);
    renderer.painted = [];
    renderer._paintPlaque = (ctx, plaque, options) => renderer.painted.push({ plaque, options });
    return renderer;
}

function worker(id, building, status = AgentStatus.WORKING, extra = {}) {
    return { agent: { id, name: id, status }, _lastBuildingType: building, ...extra };
}

function drawn(renderer, options = {}) {
    renderer.painted = [];
    renderer.drawLabels(recordingCtx(), { zoom: 1, reserved: [], ...options });
    return renderer.plaqueWorldRects.map((rect, index) => ({ ...rect, plaque: renderer.painted[index]?.plaque }));
}

// ─── sign.at on the real art ────────────────────────────────────────────────

test('all nine landmarks author a sign.at whose 12 × 14 box passes the §2.3 checks on base.png', () => {
    assert.equal(LANDMARKS.length, 9);
    for (const type of LANDMARKS) {
        const at = getBuildingSignAnchor(type);
        assert.ok(at, `${type} has sign.at`);
        assert.deepEqual(signBoxFor(at), { left: at[0] - 6, top: at[1], w: 12, h: 14 });
        const report = signAnchorReport(type, BUILDING_VISUAL_REGISTRY[type], BASES.get(type), EMISSIVES.get(type));
        assert.equal(report.error, undefined, type);
        assert.ok(report.opaque >= 0.6, `${type}: ${(report.opaque * 100).toFixed(1)}% opaque`);
        assert.equal(report.emissiveTexels, 0, `${type}: no emissive texel`);
        assert.equal(report.windowTexels, 0, `${type}: no windowRects glass`);
        assert.equal(report.cutTexels, 0, `${type}: outside every aperture cut`);
        assert.equal(report.outside, 0, `${type}: inside the sprite`);
    }
});

test('the sign checks catch glass, an aperture cut and bare air', () => {
    const command = BUILDING_VISUAL_REGISTRY.command;
    const report = (at, visual = command, type = 'command') => signAnchorReport(type, { ...visual, sign: { at } }, BASES.get(type), EMISSIVES.get(type));
    const onWindow = report([143, 97]);
    assert.ok(onWindow.emissiveTexels > 0 && onWindow.windowTexels > 0, 'a dome-drum pane is glass');
    assert.ok(report([270, 186]).cutTexels > 0, 'the east-wing cut is no wall to bolt to');
    assert.ok(report([4, 2]).opaque < 0.6, 'open sky is not the building');
    assert.ok(report([-20, 0]).outside > 0);
});

// ─── P0 / P1 / P2 against the foreign masks ─────────────────────────────────

test('the §2.3 rungs: P0 crown (post), P1 eave, P2 lintel, in screen px about the sign column', () => {
    const rungs = signChitRungs({ signX: 100, signY: 300, roofY: 200, boardH: 17, labelScale: 1 });
    assert.deepEqual(rungs.map(rung => rung.level), ['P0', 'P1', 'P2']);
    const [p0, p1, p2] = rungs;
    assert.equal(p0.x, 100);
    assert.equal(p0.y + 8.5, 200 - 7, 'P0 board bottom 7 px above roofY');
    assert.equal(p0.poleBottom, 202, 'P0 posts into the roof');
    assert.equal(p1.y - 8.5, 200 + 6, 'P1 board top 6 px below roofY');
    assert.equal(p1.poleBottom, null);
    assert.equal(p2.y + 8.5, 300 - 4, 'P2 board bottom 4 px above sign.y');
    assert.equal(p2.poleBottom, null);
    const half = signChitRungs({ signX: 0, signY: 300, roofY: 200, boardH: 8.5, labelScale: 0.5 });
    assert.equal(half[0].y + 4.25, 200 - 3.5, 'gaps are screen px: halved in world at zoom 2');
    const mask = new Uint8Array(40 * 10);
    mask[3 * 40 + 30] = 1; // outside the band of x = 5
    mask[6 * 40 + 18] = 1;
    assert.equal(roofRowFor(mask, 40, 10, 5), 6, 'first opaque row inside sign.x ± 16');
    assert.equal(roofRowFor(mask, 40, 10, 30), 3);
});

test('foreign(rect) counts >= 12 px² of another mask only, scaled by zoom²', () => {
    const square = new Uint8Array(10 * 10).fill(1);
    const entries = [worldMaskEntry('tavern', square, 10, 10, 0, 0), worldMaskEntry('harbor', square, 10, 10, 100, 0)];
    const rect = { left: 7, top: 6, right: 13, bottom: 10 };
    assert.equal(foreignArea(rect, entries, 'harbor'), 12);
    assert.equal(isForeignRect(rect, entries, 'harbor', 1), true);
    assert.equal(isForeignRect(rect, entries, 'tavern', 1), false, 'own mask is never foreign');
    assert.equal(isForeignRect({ left: 8, top: 6, right: 13, bottom: 10 }, entries, 'harbor', 1), false, '8 px² is not enough');
    assert.equal(isForeignRect({ left: 8, top: 6, right: 13, bottom: 10 }, entries, 'harbor', 2), true, '8 texels are 32 px² at zoom 2');
});

test('the ladder moves HARBOR off the Tavern and LIGHTHOUSE off the World Ash (real masks)', () => {
    const renderer = harness({ sprites: LANDMARKS.map((type, index) => worker(`w${index}`, type)) });
    const rects = drawn(renderer);
    assert.equal(rects.length, 9, 'every occupied landmark keeps its chit');
    const masks = renderer._signForeignMasks();
    for (const rect of rects) {
        assert.equal(foreignArea(rect, masks, rect.type), 0, `${rect.type} chit (${rect.level}) lies on no foreign mask`);
        assert.match(rect.level, /^P[012]$/);
    }
    // The shipped placement (spriteTop - 24 px, centred on the sprite) did.
    const legacy = (type, width, height) => {
        const def = BUILDING_DEFS.find(entry => entry.type === type);
        const id = `building.${type}`;
        const center = buildingCenterToWorld(def);
        const anchor = renderer.assets.getAnchor(id);
        const dims = renderer.assets.getDims(id);
        const first = renderer.assets.getMask(id).indexOf(1);
        const y = Math.round(center.y - anchor[1]) + Math.floor(first / dims.w) - 24;
        return { left: center.x - width / 2, right: center.x + width / 2, top: y - height / 2, bottom: y + height / 2 };
    };
    const overlapWith = (rect, owner) => foreignArea(rect, masks.filter(entry => entry.type === owner), '');
    const harbor = rects.find(rect => rect.type === 'harbor');
    const lighthouse = rects.find(rect => rect.type === 'watchtower');
    const size = rect => [rect.right - rect.left, rect.bottom - rect.top];
    assert.ok(overlapWith(legacy('harbor', ...size(harbor)), 'tavern') >= 12, 'the old HARBOR board sat on the Tavern');
    assert.equal(overlapWith(harbor, 'tavern'), 0);
    assert.ok(overlapWith(legacy('watchtower', ...size(lighthouse)), 'world-ash') >= 12, 'the old LIGHTHOUSE board sat on the Ash');
    assert.equal(overlapWith(lighthouse, 'world-ash'), 0);
    // The same holds at the district and inspect tiers.
    for (const zoom of [2, 3]) {
        const tier = drawn(renderer, { zoom });
        for (const rect of tier) assert.ok(!isForeignRect(rect, masks, rect.type, zoom), `${rect.type} at zoom ${zoom}`);
    }
});

test('a micro-offset never lands a chit back on a foreign mask; a board that fits nowhere is not drawn', () => {
    const renderer = harness({ sprites: [worker('h', 'harbor')] });
    // Wall the whole harbor column with a foreign mask: no rung, offset or
    // motif-only fallback may stand there.
    const wall = new Uint8Array(400 * 400).fill(1);
    const harbor = BUILDING_DEFS.find(def => def.type === 'harbor');
    const center = buildingCenterToWorld(harbor);
    renderer.setWorldAshMask({ mask: wall, w: 400, h: 400, left: Math.round(center.x - 200), top: Math.round(center.y - 400) });
    assert.equal(drawn(renderer).length, 0);
    assert.equal(renderer.plaqueDrawnTypes.has('harbor'), false, 'a dropped chit owns nobody');
    // The contract's `worldAshBox` (a plain world box) walls it the same way.
    renderer.setWorldAshMask(null);
    assert.equal(drawn(renderer).length, 1, 'no ash, the harbor chit stands');
    const box = { left: center.x - 200, top: center.y - 400, right: center.x + 200, bottom: center.y };
    assert.equal(drawn(renderer, { worldAshBox: box }).length, 0);
    assert.equal(drawn(renderer, { worldAshBox: { ...box } }).length, 0, 'a fresh box object reuses the cached mask');
});

// ─── occupied-only, zoom tiers, R4 ──────────────────────────────────────────

test('occupied-only: an empty landmark has no chit at rest; hover, selection, READ and The Glass bring it', () => {
    const renderer = harness();
    assert.equal(drawn(renderer).length, 0, 'no occupant, no chit');
    assert.deepEqual(drawn(renderer, { hoveredType: 'forge' }).map(rect => rect.type), ['forge']);
    renderer.hovered = BUILDING_DEFS.find(def => def.type === 'mine');
    assert.deepEqual(drawn(renderer).map(rect => rect.type), ['mine'], 'the renderer\'s own hover');
    renderer.hovered = null;
    assert.deepEqual(drawn(renderer, { selectedType: 'archive' }).map(rect => rect.type), ['archive']);
    assert.equal(drawn(renderer, { readMode: true }).length, 9, 'READ: every landmark');
    for (const { plaque } of drawn(renderer, { readMode: true })) assert.equal(plaque.countText, '');

    // The Glass: a second pass for the landmarks whose sign the lens covers,
    // leaving the resting pass's records in place.
    const resting = drawn(renderer);
    const restingRects = renderer.plaqueWorldRects;
    const forge = BUILDING_DEFS.find(def => def.type === 'forge');
    const forgeCenter = buildingCenterToWorld(forge);
    const anchor = renderer.assets.getAnchor('building.forge');
    const [sx, sy] = getBuildingSignAnchor('forge');
    const signX = Math.round(forgeCenter.x - anchor[0]) + sx;
    const signY = Math.round(forgeCenter.y - anchor[1]) + sy;
    renderer.painted = [];
    renderer.drawLabels(recordingCtx(), {
        zoom: 1, reserved: [], glassPass: true,
        inGlass: (x, y) => Math.abs(x - signX) < 2 && Math.abs(y - signY) < 2,
    });
    assert.equal(renderer.painted.length, 1, 'the lens reads the forge');
    assert.equal(renderer.plaqueWorldRects, restingRects, 'the Glass pass keeps the resting records');
    assert.equal(resting.length, 0);
});

test('a failed push lights the empty Lighthouse; patrons occupy the Tavern', () => {
    const renderer = harness();
    renderer.harborStatus = { failedPushActive: true };
    assert.deepEqual(drawn(renderer).map(rect => rect.type), ['watchtower']);
    renderer.harborStatus = { failedPushActive: false };
    const patron = { agent: { id: 'p', name: 'p', status: AgentStatus.IDLE }, visitRole: 'rest' };
    renderer.agentSprites = [patron];
    renderer._arrivedPatronBuilding = () => 'tavern';
    const rects = drawn(renderer);
    assert.deepEqual(rects.map(rect => rect.type), ['tavern']);
    assert.equal(rects[0].plaque.patronText, '1');
    assert.equal(renderer.plaqueBuildingByAgentId.get('p'), 'tavern');
    assert.ok(renderer.plaqueDrawnTypes.has('tavern'), 'the patron cell shows its patron');
});

test('Layer 0 and motifs mode retire every resting chit but keep the explicit reveals', () => {
    const renderer = harness({ sprites: [worker('f', 'forge'), worker('m', 'mine')] });
    assert.equal(drawn(renderer).length, 2);
    assert.equal(drawn(renderer, { theatreMode: true }).length, 0, 'Pure Stage: no resting chit');
    assert.equal(drawn(renderer, { theatreMode: true, readMode: true }).length, 9, 'READ still reads a Pure Stage');
    assert.deepEqual(drawn(renderer, { theatreMode: true, hoveredType: 'forge' }).map(rect => rect.type), ['forge']);
    assert.equal(renderer.setSignageMode('motifs'), true);
    assert.equal(renderer.getSignageMode(), 'motifs');
    assert.equal(drawn(renderer).length, 0, 'motifs: the bracket carries the tally at rest');
    assert.deepEqual(drawn(renderer, { selectedType: 'mine' }).map(rect => rect.type), ['mine']);
    assert.equal(drawn(renderer, { signageMode: 'compact' }).length, 2, 'the option overrides the stored mode');
    renderer.setSignageMode('nonsense');
    assert.equal(renderer.getSignageMode(), 'compact');
    assert.equal(normalizeSignageMode('motifs'), 'motifs');
    assert.equal(normalizeSignageMode(undefined), 'compact');
});

test('OVERVIEW (< 1.6, on the rest tier) is the 17 px head band; DISTRICT adds ledger and muster rows', () => {
    const now = Date.now();
    const repos = [
        { project: '/w/alpha', branch: 'main', pendingCommits: 3, oldestCommitTime: now - 60_000 },
        { project: '/w/beta', branch: 'main', pendingCommits: 1, oldestCommitTime: now - 30_000 },
    ];
    const squads = [{ parentId: 'p1', name: 'Wave', project: '', out: 2, returned: 1 }];
    const renderer = harness({ sprites: [worker('h', 'harbor'), worker('c', 'command')] });
    const heights = options => Object.fromEntries(drawn(renderer, { harborPendingRepos: repos, squads, ...options })
        .map(rect => [rect.type, rect.plaque.height]));
    const overview = heights({ zoom: 1 });
    assert.equal(overview.harbor, PLAQUE_HEAD_H, 'no Harbor ledger rows in OVERVIEW');
    assert.equal(overview.command, PLAQUE_HEAD_H, 'no Command muster rows in OVERVIEW');
    assert.ok(renderer.plaqueDrawnTypes.has('harbor'), 'the head band shows the harbor count');
    const district = heights({ zoom: 2 });
    assert.ok(district.harbor > PLAQUE_HEAD_H, 'Harbor ledger rows in DISTRICT');
    assert.ok(district.command > PLAQUE_HEAD_H, 'Command muster rows in DISTRICT');
    assert.equal(renderer.plaqueDrawnTypes.has('harbor'), false, 'a ledger plaque hides its count, so it owns nobody');
    // R1 — mid-glide at 1.8 towards the 1× rest tier stays OVERVIEW.
    const glide = heights({ zoom: 1.8, restZoom: 1 });
    assert.equal(glide.harbor, PLAQUE_HEAD_H);
    renderer.setZoom(1.8, 1);
    assert.equal(heights({ zoom: 1.8 }).command, PLAQUE_HEAD_H, 'the renderer\'s own rest tier is the default');
    // A hover brings the full rows at any tier.
    assert.ok(heights({ zoom: 1, hoveredType: 'harbor' }).harbor > PLAQUE_HEAD_H);
});

test('R4: Command\'s plaque drops its attention cell while the cloth banner is raised', () => {
    const renderer = harness({ sprites: [worker('n', 'command', AgentStatus.WAITING_ON_USER)] });
    renderer.attentionBanner = null;
    const lowered = drawn(renderer).find(rect => rect.type === 'command');
    assert.equal(lowered.plaque.attentionText, '1');
    renderer.attentionBanner = { count: 1, tier: 0 };
    const raised = drawn(renderer).find(rect => rect.type === 'command');
    assert.equal(raised.plaque.attention, undefined);
    assert.ok(raised.plaque.width < lowered.plaque.width);
});

// ─── T5 exact +N subtraction ────────────────────────────────────────────────

function crowdAt(tileX, tileY, ids, building) {
    const at = tileToWorld(tileX, tileY);
    return ids.map((id, index) => worker(id, building, AgentStatus.WORKING, { x: at.x + index, y: at.y }));
}

function badgeTexts({ sprites, owned = null, owners = null, theatreMode = false }) {
    const ctx = recordingCtx();
    const cell = `${Math.floor(30 / 4)},${Math.floor(30 / 4)}`;
    drawCrowdClusterBadges(ctx, {
        crowdStats: { clusters: [{ id: cell, tileX: 30.5, tileY: 30.5, count: sprites.length }] },
        agentSprites: new Map(sprites.map(sprite => [sprite.agent.id, sprite])),
        zoom: 1,
        plaqueDrawnTypes: owned,
        plaqueBuildingByAgentId: owners,
        theatreMode,
    });
    return texts(ctx).filter(text => text.startsWith('+'));
}

test('T5: a painted chit owns its members exactly, with no double subtraction', () => {
    const sprites = crowdAt(30, 30, ['a', 'b', 'c', 'd'], 'forge');
    const owners = new Map(sprites.map(sprite => [sprite.agent.id, 'forge']));
    assert.deepEqual(badgeTexts({ sprites }), ['+4'], 'no ownership published: the tab counts everyone');
    assert.deepEqual(badgeTexts({ sprites, owned: new Set(['forge']), owners }), [], 'the forge chit shows all four');
    sprites[0].overlaySlot = 0; // a named member stays named, never also owned
    assert.deepEqual(badgeTexts({ sprites, owned: new Set(['forge']), owners }), []);
    assert.deepEqual(badgeTexts({ sprites, owned: new Set(['mine']), owners }), ['+3'], 'a suppressed chit owns nobody');
    owners.delete('d');
    assert.deepEqual(badgeTexts({ sprites, owned: new Set(['forge']), owners }), ['+1'], 'an uncounted member stays hidden');
    assert.deepEqual(badgeTexts({ sprites, theatreMode: true }), [], 'Layer 0 draws no +N tab');
});

test('T5 end to end: the label pass publishes owners and drawn types; a suppressed chit gives the +N back', () => {
    const sprites = crowdAt(30, 30, ['a', 'b', 'c', 'd'], 'forge');
    const renderer = harness({ sprites });
    drawn(renderer);
    assert.ok(renderer.plaqueDrawnTypes.has('forge'));
    assert.deepEqual([...renderer.plaqueBuildingByAgentId], [['a', 'forge'], ['b', 'forge'], ['c', 'forge'], ['d', 'forge']]);
    const published = { owned: renderer.plaqueDrawnTypes, owners: renderer.plaqueBuildingByAgentId };
    assert.deepEqual(badgeTexts({ sprites, ...published }), [], '0 +N tabs beside an occupied landmark whose chit drew');
    // SM-7: names everywhere leave the chit no candidate.
    renderer.identityWorldRects = [{ left: -5000, top: -5000, right: 5000, bottom: 5000 }];
    drawn(renderer);
    assert.equal(renderer.plaqueDrawnTypes.has('forge'), false);
    assert.deepEqual(badgeTexts({ sprites, owned: renderer.plaqueDrawnTypes, owners: renderer.plaqueBuildingByAgentId }), ['+4']);
});

test('T5 in motifs mode: a painted bracket tally owns its members though no chit rests', () => {
    const sprites = crowdAt(30, 30, ['a', 'b', 'c'], 'forge');
    const renderer = harness({ sprites });
    renderer.setSignageMode('motifs');
    drawn(renderer); // counts for the next world pass
    const forge = BUILDING_DEFS.find(def => def.type === 'forge');
    const center = buildingCenterToWorld(forge);
    const ctx = recordingCtx();
    renderer._drawCarvedMotif(ctx, forge, { id: 'building.forge' }, center.x, center.y, 'whole');
    assert.deepEqual(texts(ctx), [], 'a carved sign has no text');
    assert.ok(ctx.calls.some(([, , , w, h, color]) => w === 2 && h === 2 && color === ART_RAMPS.trimGold[1]), 'brass pips');
    drawn(renderer);
    assert.equal(renderer.painted.length, 0, 'no resting chit in motifs mode');
    assert.ok(renderer.plaqueDrawnTypes.has('forge'), 'the bracket tally owns its members');
    assert.deepEqual(badgeTexts({ sprites, owned: renderer.plaqueDrawnTypes, owners: renderer.plaqueBuildingByAgentId }), []);
    drawn(renderer);
    assert.equal(renderer.plaqueDrawnTypes.has('forge'), false, 'the bracket set is consumed once per label frame');
});

test('Carved Motifs: compact mode hangs nothing; Layer 0 and postcards hang the sign without its tally', () => {
    const sprites = crowdAt(30, 30, ['a', 'b'], 'mine');
    const renderer = harness({ sprites });
    drawn(renderer);
    const mine = BUILDING_DEFS.find(def => def.type === 'mine');
    const center = buildingCenterToWorld(mine);
    const run = () => {
        const ctx = recordingCtx();
        renderer._bracketTallyTypes.clear();
        renderer._drawCarvedMotif(ctx, mine, { id: 'building.mine' }, center.x, center.y, 'whole');
        return { fills: ctx.calls.filter(([m]) => m === 'fillRect').length, tallied: renderer._bracketTallyTypes.has('mine') };
    };
    assert.deepEqual(run(), { fills: 0, tallied: false }, 'compact: no bracket');
    renderer.setSignageMode('motifs');
    const lit = run();
    assert.ok(lit.fills > 0 && lit.tallied);
    renderer.setTheatreMode(true);
    const stage = run();
    assert.ok(stage.fills > 0 && stage.fills < lit.fills && !stage.tallied, 'Theatre: the sign hangs, the tally goes');
    renderer.setTheatreMode(false);
    let postcard = null;
    withPostcardFrame(() => { postcard = run(); });
    assert.ok(postcard.fills > 0 && !postcard.tallied, 'postcard: the sign hangs, the tally goes');
    // A column pass draws only the slice of the bracket inside its column.
    const ctx = recordingCtx();
    const [sx] = getBuildingSignAnchor('mine');
    const originX = Math.round(center.x - renderer.assets.getAnchor('building.mine')[0]);
    const far = { worldLeft: originX + sx + 40, worldRight: originX + sx + 56 };
    renderer._drawCarvedMotif(ctx, mine, { id: 'building.mine' }, center.x, center.y, 'column', null, far);
    assert.equal(ctx.calls.length, 0, 'a column the bracket misses draws nothing');
});

test('Carved Motifs: the drawn cell is the committed prop.carvedMotifs frame, texel for texel', () => {
    const sheet = readPng(join(SPRITES, 'props', 'prop.carvedMotifs.png'));
    assert.deepEqual(CARVED_MOTIF_ORDER, BUILDING_DEFS.map(def => def.type));
    assert.equal(sheet.width, CARVED_MOTIF_ORDER.length * 16);
    const hex = value => [1, 3, 5].map(i => Number.parseInt(value.slice(i, i + 2), 16));
    CARVED_MOTIF_ORDER.forEach((type, frame) => {
        const drawnCell = new Map(carvedMotifTexels(type).map(({ x, y, color }) => [`${x},${y}`, hex(color)]));
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const i = (y * sheet.width + frame * 16 + x) * 4;
                const want = sheet.data[i + 3] ? [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2]] : null;
                assert.deepEqual(drawnCell.get(`${x},${y}`) || null, want, `${type} texel ${x},${y}`);
            }
        }
    });
});

test('Carved Motifs: tallies are 1–5 brass pips 1 apart, then a 3 × 5 numeral, walnut and brass only, no text', () => {
    assert.equal(carvedTallyRects(0), null);
    for (let n = 1; n <= 5; n++) {
        const tally = carvedTallyRects(n);
        const pips = tally.rects.filter(rect => rect.pip);
        assert.equal(pips.length, n);
        assert.equal(tally.w, 3 * n + 3);
        pips.forEach((pip, index) => {
            assert.equal(pip.w, 2);
            assert.equal(pip.h, 2);
            if (index) assert.equal(pip.x - pips[index - 1].x, 3, '2-texel pip, 1 apart');
        });
        if (n === 5) assert.equal(pips[4].x + 2 - pips[0].x, 14, 'five pips are 14 wide');
    }
    const six = carvedTallyRects(6);
    assert.equal(six.numeral, '6');
    assert.equal(six.rects.some(rect => rect.pip), false);
    assert.equal(six.h, 9, 'a 3 × 5 numeral on its plate');
    const twelve = carvedTallyRects(12);
    assert.equal(twelve.numeral, '12');
    assert.equal(twelve.w, 2 * 4 - 1 + 4);
    const palette = new Set([ART_RAMPS.timber[0], ART_RAMPS.trimGold[1], '#060402']);
    const statusHues = new Set(Object.values(STATUS_VISUALS).map(visual => visual.color));
    for (const n of [1, 3, 5, 6, 9, 12, 140]) {
        for (const rect of carvedTallyRects(n).rects) {
            assert.ok(palette.has(rect.color), `tally ${n} ink ${rect.color}`);
            assert.equal(statusHues.has(rect.color), false);
        }
    }
    for (const [n, type] of [[0, 'forge'], [3, 'tavern'], [7, 'harbor'], [23, 'portal']]) {
        const ctx = recordingCtx();
        const painted = drawCarvedMotifBracket(ctx, { x: 100, y: 50, type, tally: n });
        assert.equal(painted, n > 0);
        assert.deepEqual(texts(ctx), [], `zero fillText for ${type} at ${n}`);
        const fills = ctx.calls.filter(([m]) => m === 'fillRect');
        assert.ok(fills.length > 0);
        // The board fills the validated sign box.
        const board = fills.filter(([, x, y]) => x >= 94 && x <= 105 && y >= 50 && y <= 63);
        assert.ok(board.length > 0);
    }
    // Graded on the GPU overlay: every ink passes through the light grade.
    const graded = recordingCtx();
    const dusk = {
        purkinje: [1, 1, 1], saturation: 0.8, gain: [1, 0.9, 0.8], exposure: 0.6, lift: [0, 0, 0],
        gamma: [1, 1, 1], shadowTint: [1, 1, 1], highlightTint: [1, 1, 1], faceMix: 0,
    };
    drawCarvedMotifBracket(graded, { x: 0, y: 0, type: 'mine', tally: 2, grade: dusk });
    const inks = graded.calls.filter(([m]) => m === 'fillRect').map(([, , , , , color]) => color);
    assert.ok(inks.every(color => /^#[0-9a-f]{6}$/i.test(color)));
    assert.equal(inks.includes(ART_RAMPS.trimGold[1]), false, 'the brass takes the dusk grade');
});

// ─── the crest chip ─────────────────────────────────────────────────────────

const ctx7 = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
const camera = { worldToScreen: (x, y) => ({ x, y: y + 300 }) };
const viewport = { width: 1600, height: 900 };
const NOW = 50_000_000;

function waiting(id, x, ageMs, extra = {}) {
    return { x, y: 0, agent: { id, name: `Agent ${id}`, status: AgentStatus.WAITING_ON_USER, statusSince: ageMs == null ? null : NOW - ageMs }, ...extra };
}

function plateFor(layout, id) {
    return layout.plates.find(plate => plate.ids.includes(id));
}

const width = plate => plate.rect.right - plate.rect.left;

test('crest chip geometry: 43 px single (age), 29 / 36 px group (count), 54 px edge chip', () => {
    assert.equal(CREST_CHIP.single, 43);
    assert.equal(crestChipWidth(1), 29);
    assert.equal(crestChipWidth(2), 36);
    assert.deepEqual([45_000, 4 * 60_000, 12 * 60_000, 3_600_000, 26 * 3_600_000].map(crestAgeText), ['45s', '4m', '12m', '1h', '1d']);
    const single = layoutAttentionPlates(ctx7, { sprites: [waiting('a', 400, 45_000)], camera, viewport, now: NOW });
    const chip = single.plates[0];
    assert.equal(chip.compact, true);
    assert.equal(width(chip), 43);
    assert.equal(chip.rect.bottom - chip.rect.top, 17);
    assert.equal(chip.chip.text, '45s');
    assert.equal(chip.text, 'Agent a', 'the plate keeps its full-plate fields');

    const trio = layoutAttentionPlates(ctx7, { sprites: ['a', 'b', 'c'].map((id, i) => waiting(id, 400 + i * 30, 60_000 + i)), camera, viewport, now: NOW });
    assert.equal(trio.plates.length, 1);
    assert.equal(trio.plates[0].chip.text, '3');
    assert.equal(width(trio.plates[0]), 29);
    assert.equal(trio.beacons.length, 3, 'every member keeps its beacon');
    assert.equal(trio.plates[0].tier, 1, 'age notches for the oldest member');

    const dozen = layoutAttentionPlates(ctx7, { sprites: Array.from({ length: 12 }, (_, i) => waiting(`g${i}`, 400 + i * 6, 10_000 + i)), camera, viewport, now: NOW });
    assert.equal(dozen.plates[0].chip.text, '12');
    assert.equal(width(dozen.plates[0]), 36);

    const edge = layoutAttentionPlates(ctx7, { sprites: [waiting('far', 2400, 45_000)], camera, viewport, now: NOW });
    assert.equal(edge.plates[0].side, 'right');
    assert.equal(width(edge.plates[0]), 54, 'the arrow cell in front of the chip');
});

test('the full plate returns on hover, selection, A hold, READ, The Glass and a 5-minute wait', () => {
    const base = { camera, viewport, now: NOW };
    const sprites = () => [waiting('a', 400, 45_000), waiting('b', 1000, 30_000)];
    const full = (options, id = 'a', list = sprites()) => {
        const plate = plateFor(layoutAttentionPlates(ctx7, { sprites: list, ...base, ...options }), id);
        return plate.compact === false && width(plate) === plate.widths.width;
    };
    assert.equal(full({}), false, 'at rest: the chip');
    assert.equal(full({ hoveredAgentId: 'a' }), true, 'pointer over the body');
    assert.equal(full({ hoveredAgentId: 'a' }, 'b'), false, 'only the hovered agent');
    assert.equal(full({}, 'a', [waiting('a', 400, 45_000, { hovered: true })]), true, 'the sprite\'s own hover flag');
    assert.equal(full({ selectedAgentId: 'a' }), true);
    assert.equal(full({}, 'a', [waiting('a', 400, 45_000, { selected: true })]), true);
    assert.equal(full({ attentionHold: true }, 'b'), true, 'A holds every plate');
    assert.equal(full({ readMode: true }, 'b'), true);
    assert.equal(full({}, 'a', [waiting('a', 400, CREST_FULL_AGE_MS - 1)]), false);
    assert.equal(full({}, 'a', [waiting('a', 400, CREST_FULL_AGE_MS)]), true, '>= 5 min: the full plate at rest');
    assert.equal(full({ compact: false }), true, 'callers may keep the wide plates');

    // Pointer over the chip: the key it hands back brings the full plate.
    const rest = layoutAttentionPlates(ctx7, { sprites: sprites(), ...base });
    const chip = plateFor(rest, 'a');
    const key = attentionKeyAt(rest, chip.rect.left + 2, chip.rect.top + 2);
    assert.equal(key, chip.key);
    assert.equal(full({ hoveredAttentionKey: key }), true);
    const beacon = rest.beacons.find(b => b.id === 'b');
    assert.equal(attentionKeyAt(rest, beacon.left + 1, beacon.top + 1), 'b', 'the beacon hands back its agent');
    assert.equal(attentionKeyAt(rest, 5, 5), null);

    // A group expands as one when any member is hovered.
    const trio = ['a', 'b', 'c'].map((id, i) => waiting(id, 400 + i * 30, 60_000));
    const group = plateFor(layoutAttentionPlates(ctx7, { sprites: trio, ...base, hoveredAgentId: 'c' }), 'a');
    assert.equal(group.compact, false);
    assert.equal(group.members, 3, 'expanding never regroups the knot');

    // Edge chips expand under the same triggers.
    const edge = plateFor(layoutAttentionPlates(ctx7, { sprites: [waiting('far', 2400, 45_000)], ...base, selectedAgentId: 'far' }), 'far');
    assert.equal(edge.compact, false);
    assert.equal(width(edge), edge.widths.width);
});

test('a hovered plate holds full for the dwell after the pointer leaves, then rests as a chip', () => {
    const state = {};
    const frame = (clock, options = {}) => plateFor(layoutAttentionPlates(ctx7, {
        sprites: [waiting('a', 400, 45_000)], camera, viewport, now: NOW, state, dwellNow: clock, ...options,
    }), 'a');
    assert.equal(frame(1000, { hoveredAgentId: 'a' }).compact, false);
    assert.equal(frame(1300).compact, false, 'held inside the 500 ms dwell');
    assert.equal(frame(1600).compact, true);
});

test('The Glass: a covered chip carries its full twin; the Glass pass draws only twins', () => {
    const layout = layoutAttentionPlates(ctx7, {
        sprites: [waiting('a', 400, 45_000), waiting('b', 1000, 30_000)],
        camera, viewport, now: NOW,
        glassScreen: { cx: 400, cy: 300 },
    });
    const a = plateFor(layout, 'a');
    const b = plateFor(layout, 'b');
    assert.equal(a.compact, true, 'outside the lens: exactly the resting frame');
    assert.ok(a.glass && a.glass.compact === false);
    assert.equal(a.glass.rect.right - a.glass.rect.left, a.widths.width);
    assert.equal(a.glass.rect.top, a.rect.top, 'the twin sits on the chip\'s rows');
    assert.ok(a.glass.rect.left <= a.rect.left && a.glass.rect.right >= a.rect.right, 'and covers it');
    assert.equal(b.glass, undefined);
    const ctx = recordingCtx();
    drawAttentionPlates(ctx, layout, { glassPass: true });
    assert.deepEqual(texts(ctx).sort(), ['45s', 'Agent a', 'NEEDS YOU'].sort());
    let postcard = null;
    withPostcardFrame(() => {
        const card = recordingCtx();
        drawAttentionPlates(card, layout, { glassPass: true });
        postcard = card.calls.length;
    });
    assert.equal(postcard, 0, 'The Glass never reaches a postcard');
});

test('Layer 0: Theatre draws the beacons only — overlay, mark records and reserved rects agree', () => {
    const sprites = [waiting('a', 400, 45_000), waiting('far', 2400, 45_000)];
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => new RasterCanvas() };
    try {
        const layout = layoutAttentionPlates(ctx7, { sprites, camera, viewport, now: NOW, theatreMode: true });
        assert.equal(layout.theatre, true);
        assert.deepEqual(layout.tallies, []);
        const ctx = recordingCtx();
        drawAttentionPlates(ctx, layout);
        assert.deepEqual(texts(ctx), [], 'no chip text on a Pure Stage');
        assert.equal(ctx.calls.filter(([m]) => m === 'fillRect').length, 0, 'no plate or leader fills');
        assert.ok(ctx.calls.some(([m]) => m === 'drawImage'), 'the beacons stay');
        const plain = layoutAttentionPlates(ctx7, { sprites, camera, viewport, now: NOW });
        const explicit = recordingCtx();
        drawAttentionPlates(explicit, plain, { theatreMode: true });
        assert.deepEqual(texts(explicit), []);
        assert.equal(attentionScreenRects(layout).length, layout.beacons.length);
        const records = attentionMarkRecords(layout, { out: [] });
        assert.ok(records.length > 0);
        assert.ok(records.every(record => record.textureKey.startsWith('mark:beacon')), 'beacon stamps only');
        // The Glass still reads a Pure Stage.
        const lens = layoutAttentionPlates(ctx7, { sprites, camera, viewport, now: NOW, theatreMode: true, glassScreen: { cx: 400, cy: 300 } });
        const glass = recordingCtx();
        drawAttentionPlates(glass, lens, { glassPass: true });
        assert.ok(texts(glass).includes('Agent a'));
    } finally {
        globalThis.document = previousDocument;
    }
});

// A tiny raster (as w3-a.incident-marks): integer-scale fills, clears and
// stamp blits, so the overlay and the GPU records compare pixel for pixel.
class RasterCanvas {
    constructor(width = 0, height = 0) {
        this._w = width;
        this._h = height;
        this.px = new Array(width * height).fill('');
    }
    get width() { return this._w; }
    set width(value) { this._w = value; this.px = new Array(this._w * this._h).fill(''); }
    get height() { return this._h; }
    set height(value) { this._h = value; this.px = new Array(this._w * this._h).fill(''); }
    at(x, y) { return x >= 0 && y >= 0 && x < this._w && y < this._h ? this.px[y * this._w + x] : ''; }
    getContext() { return this.ctx || (this.ctx = new RasterContext(this)); }
}

class RasterContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '';
        this.font = '';
        this.globalCompositeOperation = 'source-over';
        this.globalAlpha = 1;
        this.m = [1, 0, 0, 1, 0, 0];
        this.stack = [];
        this.texts = [];
    }
    save() { this.stack.push({ m: [...this.m], op: this.globalCompositeOperation, fill: this.fillStyle }); }
    restore() {
        const state = this.stack.pop();
        this.m = state.m;
        this.globalCompositeOperation = state.op;
        this.fillStyle = state.fill;
    }
    setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
    getTransform() { const [a, b, c, d, e, f] = this.m; return { a, b, c, d, e, f }; }
    measureText(text) { return { width: String(text).length * 7 }; }
    fillText(text) { this.texts.push(text); }
    _rect(x, y, w, h, value) {
        const [a, , , d, e, f] = this.m;
        for (let py = y * d + f; py < (y + h) * d + f; py++) {
            for (let px = x * a + e; px < (x + w) * a + e; px++) {
                if (px >= 0 && py >= 0 && px < this.canvas.width && py < this.canvas.height) this.canvas.px[py * this.canvas.width + px] = value;
            }
        }
    }
    fillRect(x, y, w, h) { if (this.fillStyle !== 'transparent') this._rect(x, y, w, h, this.fillStyle); }
    clearRect(x, y, w, h) { this._rect(x, y, w, h, ''); }
    drawImage(source, dx, dy) {
        for (let y = 0; y < source.height; y++) {
            for (let x = 0; x < source.width; x++) {
                const ink = source.at(x, y);
                if (!ink) continue;
                const tx = dx + x;
                const ty = dy + y;
                if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
                this.canvas.px[ty * this.canvas.width + tx] = this.globalCompositeOperation === 'destination-out' ? '' : ink;
            }
        }
    }
}

function rasterRecords(records, w, h) {
    const out = new RasterCanvas(w, h);
    for (const record of records) {
        for (let py = record.y; py < record.y + record.height; py++) {
            for (let px = record.x; px < record.x + record.width; px++) {
                const sx = record.sx + Math.floor(((px + 0.5 - record.x) / record.width) * record.sw);
                const sy = record.sy + Math.floor(((py + 0.5 - record.y) / record.height) * record.sh);
                const ink = record.source.at(sx, sy);
                if (ink && px >= 0 && py >= 0 && px < w && py < h) out.px[py * w + px] = ink;
            }
        }
    }
    return out;
}

test('crest chips: the GPU mark records paint exactly the overlay chip pixels, ink-only clears exactly them', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => new RasterCanvas() };
    try {
        const layout = layoutAttentionPlates(ctx7, {
            sprites: [
                waiting('solo', 300, 90_000), // a notched single chip
                ...['g1', 'g2', 'g3'].map((id, i) => waiting(id, 700 + i * 20, 20_000)), // a group chip
                waiting('old', 1100, 6 * 60_000), // the full plate
                waiting('edge', 2400, 30_000), // an edge chip
                { ...waiting('up', 600, 10_000), y: -900 },
            ],
            camera, viewport, now: NOW,
        });
        assert.ok(layout.plates.filter(plate => plate.compact).length >= 3);
        assert.ok(layout.plates.some(plate => !plate.compact));
        for (const scale of [1, 2]) {
            const w = viewport.width * scale;
            const h = viewport.height * scale;
            const overlay = new RasterCanvas(w, h);
            const overlayCtx = overlay.getContext('2d');
            overlayCtx.setTransform(scale, 0, 0, scale, 0, 0);
            drawAttentionPlates(overlayCtx, layout);
            const records = attentionMarkRecords(layout, { scale, out: [] });
            assert.ok(records && records.length);
            for (const record of records) assert.ok(record.flags & GPU_RECORD_FLAGS.screenSpace);
            const gpu = rasterRecords(records, w, h);
            assert.deepEqual(gpu.px, overlay.px, `chip records match the overlay at scale ${scale}`);
            for (const record of records) {
                if (!(record.flags & GPU_RECORD_FLAGS.actionMark)) continue;
                for (let sy = record.sy; sy < record.sy + record.sh; sy++) {
                    for (let sx = record.sx; sx < record.sx + record.sw; sx++) {
                        const ink = record.source.at(sx, sy);
                        assert.ok(ink !== LABEL_INK.plateOutline && ink !== LABEL_INK.plate, `role-2 record samples ${ink}`);
                    }
                }
            }
            const inked = new RasterCanvas(w, h);
            inked.px.fill('under');
            const inkedCtx = inked.getContext('2d');
            inkedCtx.setTransform(scale, 0, 0, scale, 0, 0);
            drawAttentionPlates(inkedCtx, layout, { inkOnly: true });
            assert.deepEqual(inked.px.map(ink => ink === ''), gpu.px.map(ink => ink !== ''));
            assert.deepEqual(inkedCtx.texts, overlayCtx.texts);
            assert.ok(overlayCtx.texts.includes('1m') && overlayCtx.texts.includes('3'), 'chip ages and counts print');
        }
    } finally {
        globalThis.document = previousDocument;
    }
});

// ─── the hover plate ────────────────────────────────────────────────────────

test('hover plate: a landmark line with its exact counts, and a one-line plate that fits a 240 px strip', () => {
    assert.equal(buildingHoverLine('forge', { count: 3 }), 'Forge · 3 villagers');
    assert.equal(buildingHoverLine('tavern', { count: 1, patrons: 2 }), 'Tavern · 1 villager · 2 resting');
    assert.equal(buildingHoverLine('mine'), 'Mine');
    assert.equal(buildingHoverLine('nowhere', { count: 2 }), '');
    assert.deepEqual(hoverPlateLines('Moss\nForge\nEdit', { maxLines: 1 }), ['Moss · Forge · Edit']);
    assert.deepEqual(hoverPlateLines('Moss\nForge\nEdit'), ['Moss', 'Forge · Edit']);
    const spot = placeHoverPlate({ point: { x: 1430, y: 200 }, width: 180, height: 22, hostWidth: 1440, hostHeight: 222, edge: 4 });
    assert.ok(spot.x >= 4 && spot.x + 180 <= 1436 && spot.y >= 4 && spot.y + 22 <= 218, JSON.stringify(spot));
    const tall = placeHoverPlate({ point: { x: 10, y: 10 }, width: 120, height: 400, hostWidth: 300, hostHeight: 222, edge: 4 });
    assert.equal(tall.y, 4, 'a plate taller than the strip pins to its top edge');
});
