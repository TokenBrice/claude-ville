// W3-Fix-B — body marks pixel craft, carried artifact / Report Cairn depth
// slot, workflow ribbons, still-work and shelter routing ownership, the
// compaction rite's clock, late-joiner guard and chit, and stepped trails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    AgentSprite,
    BODY_MARK_ALPHA_MIN,
    bodyMarkPixels,
    cellOpaqueRowRuns,
} from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { LAYER_ORDER, agentLayerRecords } from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import {
    ARTIFACT_KINDS,
    ARTIFACT_SIZE,
    CAIRN_BUNDLE_HEIGHT,
    CAIRN_DOOR_ZONE_CAP,
    CAIRN_MAX_OFFSET,
    CAIRN_UNIT_STRIDE,
    CAIRN_VIEW_CAP,
    CAIRN_WIDTH,
    admitReportCairn,
    artifactPaletteColor,
    artifactSetDownRect,
    artifactStampRows,
    artifactWalkingAnchor,
    artifactWalkingRect,
    assignWorkflowRibbons,
    reportCairnRect,
    reportCairnSpec,
    reportCairnStamp,
    resolveCarriedArtifact,
    workflowRibbonRows,
    workflowRibbonStamp,
} from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import { ArrivalDepartureController } from '../../claudeville/src/presentation/character-mode/ArrivalDeparture.js';
import { precipitationFrozenFor, squallShelter } from '../../claudeville/src/presentation/character-mode/CrowdRoutine.js';
import { gradeTone } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { SPEED_RUNGS } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { postcardFrame, withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { DEFAULT_CELL, DIRECTIONS } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { TRAIL_ALPHA_STEPS, TrailRenderer, footprintAlphaStep } from '../../claudeville/src/presentation/character-mode/TrailRenderer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHAR_DIR = path.join(ROOT, 'claudeville/assets/sprites/characters');
const WORLD = path.join(ROOT, 'claudeville/src/presentation/character-mode');
const T0 = 1_764_121_000_000;
const TOP_RUNG = SPEED_RUNGS[SPEED_RUNGS.length - 1];

// ---------------------------------------------------------------------------
// Harness: real sheets, a recording 2D context, a pixel-recording document.
// ---------------------------------------------------------------------------

const SHEET_IDS = fs.readdirSync(CHAR_DIR)
    .filter(id => fs.existsSync(path.join(CHAR_DIR, id, 'sheet.png')))
    .sort();

const sheetCache = new Map();
function sheet(id) {
    if (!sheetCache.has(id)) sheetCache.set(id, PNG.sync.read(fs.readFileSync(path.join(CHAR_DIR, id, 'sheet.png'))));
    return sheetCache.get(id);
}

// One 92 px cell's RGBA, cut from a decoded sheet.
function cellPixels(png, col, row, size = DEFAULT_CELL) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
        const from = ((row * size + y) * png.width + col * size) * 4;
        data.set(png.data.subarray(from, from + size * 4), y * size * 4);
    }
    return data;
}

const alphaAt = (data, x, y, size = DEFAULT_CELL) =>
    x >= 0 && y >= 0 && x < size && y < size ? data[(y * size + x) * 4 + 3] : 0;

function recordingContext() {
    const fills = [];
    const texts = [];
    const images = [];
    const ctx = {
        fills, texts, images,
        globalAlpha: 1, fillStyle: '#000000', font: '', textAlign: 'left', textBaseline: 'alphabetic',
        imageSmoothingEnabled: true,
        save() { this._stack = [...(this._stack || []), { a: this.globalAlpha, f: this.fillStyle }]; },
        restore() { const top = this._stack?.pop(); if (top) { this.globalAlpha = top.a; this.fillStyle = top.f; } },
        translate() {}, scale() {}, setTransform() {},
        fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha }); },
        fillText(text) { texts.push(String(text)); },
        drawImage(image, x, y) { images.push({ image, x, y }); },
    };
    return ctx;
}

// A `document` whose canvases record their pixels (`fillRect` only).
function pixelDocument() {
    return {
        createElement() {
            const pixels = new Map();
            const canvas = { width: 0, height: 0, pixels };
            const ctx = {
                fillStyle: '#000000', imageSmoothingEnabled: true,
                fillRect(x, y, w, h) {
                    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixels.set(`${xx},${yy}`, this.fillStyle);
                },
            };
            canvas.getContext = () => ctx;
            return canvas;
        },
    };
}

function withDocument(t) {
    const previous = globalThis.document;
    globalThis.document = pixelDocument();
    t.after(() => {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    });
}

function spriteStub(fields = {}) {
    return Object.assign(Object.create(AgentSprite.prototype), fields);
}

// ---------------------------------------------------------------------------
// 1. Body marks on all 40 real sheets: 0 % off-body pixels.
// ---------------------------------------------------------------------------

test('rain shoulders, hem stitches and salt cuff land 100% on opaque body pixels on all 40 real sheets', () => {
    assert.equal(SHEET_IDS.length, 40, 'forty manifest character sheets');
    let cells = 0;
    let shoulderCells = 0;
    let stitchCells = 0;
    let cuffCells = 0;
    let markPixels = 0;
    const off = [];
    for (const id of SHEET_IDS) {
        const png = sheet(id);
        const cols = png.width / DEFAULT_CELL;
        const rows = png.height / DEFAULT_CELL;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const data = cellPixels(png, col, row);
                const runs = cellOpaqueRowRuns(data, DEFAULT_CELL, DEFAULT_CELL);
                const marks = bodyMarkPixels(runs, { shoulders: true, stitches: 4, saltCuff: true, west: col >= 5 });
                if (marks.top < 0) continue;
                cells++;
                const height = marks.bottom - marks.top;
                const check = (x, y, kind) => {
                    markPixels++;
                    // On the body, and one texel in from the silhouette on both sides.
                    for (const px of [x - 1, x, x + 1]) {
                        if (alphaAt(data, px, y) < BODY_MARK_ALPHA_MIN) off.push(`${id} c${col} r${row} ${kind} (${x},${y})`);
                    }
                };
                if (marks.shoulders.length) shoulderCells++;
                for (const run of marks.shoulders) {
                    const share = (run.y - marks.top) / height;
                    assert.ok(share >= 0.36 && share <= 0.43, `${id} c${col} r${row}: shoulder line at ${share.toFixed(2)} of the body`);
                    for (let x = run.x; x < run.x + run.w; x++) check(x, run.y, 'shoulder');
                }
                if (marks.stitches.length) stitchCells++;
                assert.ok(marks.stitches.length <= 4);
                for (const px of marks.stitches) {
                    assert.ok(px.y === marks.bottom - 3 || px.y === marks.bottom - 4, `${id}: hem 3–4 rows up`);
                    check(px.x, px.y, 'stitch');
                }
                if (marks.cuff.length) cuffCells++;
                assert.ok(marks.cuff.length === 0 || marks.cuff.length === 2);
                for (const px of marks.cuff) {
                    assert.ok(px.y === marks.bottom - 1 || px.y === marks.bottom - 2, `${id}: cuff 1–2 rows up`);
                    check(px.x, px.y, 'cuff');
                }
            }
        }
    }
    assert.deepEqual(off.slice(0, 10), [], `${off.length} of ${markPixels} mark texels off the body`);
    assert.ok(cells >= 40 * 80 * 0.95, `measured ${cells} body cells`);
    assert.ok(shoulderCells / cells >= 0.98, `shoulders found on ${shoulderCells}/${cells}`);
    assert.ok(stitchCells / cells >= 0.95, `hem found on ${stitchCells}/${cells}`);
    assert.ok(cuffCells / cells >= 0.9, `cuff found on ${cuffCells}/${cells}`);
});

function patinaSprite(id = 'agent.claude.opus', col = 2, row = 6, fields = {}) {
    const data = cellPixels(sheet(id), col, row);
    const runs = cellOpaqueRowRuns(data, DEFAULT_CELL, DEFAULT_CELL);
    const sprite = spriteStub({
        agent: { id: 'smith', status: AgentStatus.WORKING },
        _zoom: 2,
        motionScale: 1,
        moving: false,
        direction: col,
        gpuWorldEnabled: false,
        _patina: { mendedStitches: 4, saltCuff: true },
        _weather: { type: 'rain', precipitation: 0.6, intensity: 0.6 },
        _seatedSeat: () => null,
        _bodyMarkRuns: () => runs,
        ...fields,
    });
    return { sprite, data, runs };
}

const GEOMETRY = Object.freeze({ dx: 100, dy: 200, drawScale: 1, bounds: { minX: 30, minY: 20, maxX: 60, maxY: 80 }, markCell: { sx: 0, sy: 0, sw: 92, sh: 92 } });

test('the body pass paints every patina and rain texel on the drawn cell, graded, in palette tones', () => {
    const { sprite, data } = patinaSprite();
    const ctx = recordingContext();
    sprite._drawPatinaAndWeatherBody(ctx, GEOMETRY);
    const kinds = new Map([
        [ART_RAMPS.slate[0], 'shoulder'],
        [ART_RAMPS.snow[3], 'stitch'],
        [ART_RAMPS.snow[2], 'cuff'],
    ]);
    const counts = { shoulder: 0, stitch: 0, cuff: 0 };
    for (const fill of ctx.fills) {
        const kind = kinds.get(fill.color);
        assert.ok(kind, `palette tone ${fill.color}`);
        counts[kind] += fill.w;
        assert.equal(fill.h, 1, 'one texel tall');
        for (let x = fill.x; x < fill.x + fill.w; x++) {
            assert.ok(alphaAt(data, x - GEOMETRY.dx, fill.y - GEOMETRY.dy) >= BODY_MARK_ALPHA_MIN, `${kind} on the body`);
        }
        if (kind === 'shoulder') assert.ok(fill.alpha > 0.2 && fill.alpha < 0.5, 'a glaze, not paint');
        else assert.equal(fill.alpha, 1);
    }
    assert.ok(counts.shoulder > 4);
    assert.equal(counts.stitch, 4);
    assert.equal(counts.cuff, 2);
    // The resident overlay grades the same texels with the frame's grade.
    const grade = evaluateGrade({ minuteOfDay: 22 * 60 });
    const graded = recordingContext();
    Object.assign(sprite, { gpuWorldEnabled: true, overlayLightGrade: grade });
    sprite._drawPatinaAndWeatherBody(graded, GEOMETRY);
    assert.deepEqual(graded.fills.map(f => [f.x, f.y, f.w]), ctx.fills.map(f => [f.x, f.y, f.w]));
    assert.deepEqual(graded.fills.map(f => f.color), ctx.fills.map(f => gradeTone(f.color, grade)));
    assert.ok(graded.fills.some((f, i) => f.color !== ctx.fills[i].color), 'the night grade changes the tones');
});

test('half-scale crowd bodies carry no body marks, and seated bodies keep no hem or cuff', () => {
    const { sprite } = patinaSprite();
    for (const geometry of [{ ...GEOMETRY, lod: true }, { ...GEOMETRY, drawScale: 0.5 }]) {
        const ctx = recordingContext();
        sprite._drawPatinaAndWeatherBody(ctx, geometry);
        assert.deepEqual(ctx.fills, []);
    }
    for (const seated of [{ geometry: { ...GEOMETRY, seated: true } }, { geometry: GEOMETRY, seat: () => ({ id: 'bench' }) }]) {
        if (seated.seat) sprite._seatedSeat = seated.seat;
        const ctx = recordingContext();
        sprite._drawPatinaAndWeatherBody(ctx, seated.geometry);
        assert.deepEqual(ctx.fills, [], 'no hem, no cuff and no rain glaze on a seated body');
        sprite._seatedSeat = () => null;
    }
    // The GPU overlay sheds them on an LOD record too, as Canvas does.
    const calls = [];
    const host = {
        gpuWorldEnabled: true, selected: false, agent: { status: AgentStatus.WORKING },
        _labelTopY: y => y, _drawPatinaAndWeatherBody: () => calls.push('patina'),
        _drawSignatureMark() {}, _drawReceiveBeat() {}, _drawStanceOverlay() {}, _drawActionPoseOverlay() {},
        _drawToolRitualOverlay() {}, _drawToolGlyphBadge() { return false; }, _drawStatusEmote() {},
        _drawPlanModeGlyph() {}, _drawRetryGlyph() {}, _drawNameTag() {},
    };
    const overlay = new AgentGpuOverlayRenderer(host);
    host._gpuFrameRecord = { contentTopY: 10, frameGeometry: { ...GEOMETRY, lod: true } };
    overlay.draw(recordingContext(), 2);
    assert.deepEqual(calls, []);
    host._gpuFrameRecord = { contentTopY: 10, frameGeometry: GEOMETRY };
    overlay.draw(recordingContext(), 2);
    assert.deepEqual(calls, ['patina']);
});

test('falling snow never darkens the shoulders nor sends idle villagers running for shelter', () => {
    const january = new Date(2026, 0, 14);
    const july = new Date(2026, 6, 14);
    const authoredSnow = { type: 'rain', intensity: 0.9, precipitation: 0.7 };
    assert.equal(precipitationFrozenFor(authoredSnow, { date: january }), true, 'authored winter snow');
    assert.equal(precipitationFrozenFor(authoredSnow, { date: july }), false);
    assert.equal(precipitationFrozenFor({ ...authoredSnow, frozen: false }, { date: january }), false, 'a real sky says rain');
    assert.equal(precipitationFrozenFor({ ...authoredSnow, frozen: true }), true);
    assert.equal(precipitationFrozenFor(authoredSnow), false, 'no flag, no date: liquid');

    const idle = { status: AgentStatus.IDLE, position: { tileX: 23, tileY: 19 } };
    assert.ok(squallShelter(idle, authoredSnow, idle.position, { date: july }));
    assert.equal(squallShelter(idle, authoredSnow, idle.position, { date: january }), null);
    assert.equal(squallShelter(idle, { type: 'storm', frozen: true }), null);
    assert.equal(squallShelter(idle, { type: 'storm' }, idle.position, { frozen: true }), null);
    assert.equal(squallShelter(idle, { type: 'storm' }).visitRole, 'shelter');

    for (const fields of [{ _weatherDate: january }, { _weather: { ...authoredSnow, frozen: true } }, { getSnowBucket: () => 2 }]) {
        const { sprite } = patinaSprite('agent.codex.gpt55', 2, 6, { _patina: null, _weather: authoredSnow, ...fields });
        const ctx = recordingContext();
        sprite._drawPatinaAndWeatherBody(ctx, GEOMETRY);
        assert.deepEqual(ctx.fills, [], `no rain glaze under snow (${Object.keys(fields)[0]})`);
    }
    const { sprite } = patinaSprite('agent.codex.gpt55', 2, 6, { _patina: null, _weather: authoredSnow, _weatherDate: july });
    const ctx = recordingContext();
    sprite._drawPatinaAndWeatherBody(ctx, GEOMETRY);
    assert.ok(ctx.fills.length > 0 && ctx.fills.every(f => f.color === ART_RAMPS.slate[0]), 'summer rain glazes the shoulders');
});

test('the freezing breath puff shows only on a still body at z >= 2, on the deterministic motion clock', () => {
    const fields = { _patina: null, _weather: { type: 'clear', freezing: true } };
    const { sprite } = patinaSprite('agent.gemini.base', 2, 6, fields);
    const puff = (overrides = {}) => {
        Object.assign(sprite, overrides);
        const ctx = recordingContext();
        const realNow = Date.now;
        Date.now = () => { throw new Error('the breath puff never reads the wall clock'); };
        try {
            sprite._drawPatinaAndWeatherBody(ctx, GEOMETRY);
        } finally {
            Date.now = realNow;
        }
        return ctx.fills;
    };
    // Find a motion time inside the puff.
    let inside = null;
    for (let t = 0; t < 3200 && inside === null; t += 20) if (puff({ _motionTimeMs: t }).length) inside = t;
    assert.notEqual(inside, null, 'the puff appears within one cycle');
    const first = puff({ _motionTimeMs: inside });
    assert.deepEqual(puff({ _motionTimeMs: inside }), first, 'the same motion time paints the same puff');
    assert.ok(first.every(f => f.color === ART_RAMPS.snow[3] && f.alpha < 0.5));
    const face = first[0];
    assert.ok(face.x > GEOMETRY.dx + 40, 'east-facing: the puff leaves the face on the east side');
    assert.deepEqual(puff({ _motionTimeMs: inside, moving: true }), [], 'a walking body shows no breath');
    assert.deepEqual(puff({ moving: false, _zoom: 1.6 }), [], 'below z2');
    assert.deepEqual(puff({ _zoom: 2, motionScale: 0 }), [], 'reduced motion');
    // The clock falls back to the renderer's motion clock, never Date.now().
    Object.assign(sprite, { motionScale: 1, _motionTimeMs: undefined, _motionClock: { elapsedMs: inside } });
    assert.equal(sprite._motionNowMs(), inside);
    assert.deepEqual(puff(), first);
});

test('the ally nod stamps and reads the motion clock, never the wall clock', () => {
    const sprite = spriteStub({ motionScale: 1, _motionClock: { elapsedMs: 5_000 } });
    const realNow = Date.now;
    Date.now = () => { throw new Error('wall clock'); };
    try {
        sprite.triggerAllyNod(123_456_789);
    } finally {
        Date.now = realNow;
    }
    assert.equal(sprite._allyNodStart, 5_000);
    const reduced = spriteStub({ motionScale: 0, _motionClock: { elapsedMs: 5_000 } });
    reduced.triggerAllyNod();
    assert.equal(reduced._allyNodStart, undefined);
    const source = fs.readFileSync(path.join(WORLD, 'AgentSprite.js'), 'utf8');
    const nod = source.slice(source.indexOf('// W3-D — the PairAffinity ally nod: a 1-texel dip'), source.indexOf('// V7 — every cell of this facing'));
    assert.match(nod, /this\._motionNowMs\(\) - this\._allyNodStart/);
    assert.doesNotMatch(nod, /Date\.now\(\)/);
});

// ---------------------------------------------------------------------------
// 2. Stale marks, depth slot order and LOD.
// ---------------------------------------------------------------------------

test('every frame clears stale body-frame marks before any hidden, impostor or LOD return', () => {
    const stale = { stamp: { width: 6, height: 6 }, x: 1, y: 2 };
    const marks = () => ({ _artifactMark: stale, _cairnMark: stale, _ribbonMark: stale, _lanternMark: stale });
    const hidden = spriteStub({ ...marks(), x: 10, y: 10, _gpuFrameRecord: {}, isArrivalPending: () => true });
    hidden._drawAtScreenPosition(recordingContext(), 2);
    assert.deepEqual([hidden._artifactMark, hidden._cairnMark, hidden._ribbonMark, hidden._lanternMark], [null, null, null, null]);
    const impostor = spriteStub({
        ...marks(), x: 10, y: 10, agent: { id: 'a', status: AgentStatus.WORKING }, selected: false, hovered: false,
        gpuWorldEnabled: false, isArrivalPending: () => false, _archiveFadeProgress: () => 0,
        _setBodyBox() {}, _drawBudgetImpostor() {}, _drawNameTag() {}, _onOpenFloor: true,
    });
    impostor._drawAtScreenPosition(recordingContext(), 2, 'compact');
    assert.deepEqual([impostor._artifactMark, impostor._cairnMark, impostor._ribbonMark, impostor._lanternMark], [null, null, null, null]);
    impostor._gpuFrameRecord = { id: 'lod' };
    assert.equal(impostor._artifactRecord(), null);
    assert.equal(impostor._cairnRecord(), null);
    assert.equal(impostor._ribbonRecord(), null);
});

test('Canvas strikes the body-slot marks in the GPU LAYER_ORDER, with the Report Cairn at layer 6', () => {
    assert.deepEqual(LAYER_ORDER.map(([name]) => name), [
        'seatBack', 'weaponBack', 'body', 'hat', 'frost', 'snow',
        'weaponFront', 'artifact', 'ribbon', 'seatFront', 'candle', 'lantern', 'tankard', 'cairn',
    ]);
    const layers = Object.fromEntries(LAYER_ORDER);
    assert.deepEqual([layers.artifact, layers.ribbon, layers.cairn], [5, 5, 6]);
    const records = agentLayerRecords({ body: { id: 'b' }, cairn: { id: 'c' }, tankard: { id: 't' }, artifact: { id: 'a' }, ribbon: { id: 'r' } });
    assert.deepEqual(records.map(r => [r.id, r.layer]), [['b', 2], ['a', 5], ['r', 5], ['t', 6], ['c', 6]]);

    const source = fs.readFileSync(path.join(WORLD, 'AgentSprite.js'), 'utf8');
    const start = source.indexOf("if (canvasBody && !sheathed) this._drawCodexEquipment(ctx, identity, frameGeometry, 'front');");
    const block = source.slice(start, source.indexOf('if (departedBody) ctx.restore();', start));
    const order = [
        ['weaponFront', "_drawCodexEquipment(ctx, identity, frameGeometry, 'front')"],
        ['artifact', 'ctx.drawImage(artifact.stamp'],
        ['ribbon', 'ctx.drawImage(ribbon.stamp'],
        ['seatFront', 'ctx.drawImage(seatStones.front.canvas'],
        ['candle', 'ctx.drawImage(candle.stamp'],
        ['lantern', 'ctx.drawImage(lantern.stamp'],
        ['tankard', 'ctx.drawImage(tankard.stamp'],
        ['cairn', 'ctx.drawImage(cairn.stamp'],
    ];
    const at = order.map(([name, needle]) => [name, block.indexOf(needle)]);
    assert.ok(at.every(([, index]) => index >= 0), JSON.stringify(at));
    assert.deepEqual(at.map(([name]) => name), [...at].sort((a, b) => a[1] - b[1]).map(([name]) => name));
    const gpu = LAYER_ORDER.map(([name]) => name).filter(name => order.some(([n]) => n === name));
    assert.deepEqual(order.map(([name]) => name), gpu, 'one order on both backends');
});

// ---------------------------------------------------------------------------
// 3. Carried artifact & Report Cairn.
// ---------------------------------------------------------------------------

test('a proof chit needs a dated result inside its freshness window', () => {
    const ok = { exitCode: 0, exitCodeSource: 'exit' };
    const proof = (result, now = T0) => resolveCarriedArtifact({ status: 'working', lastResults: [result] }, { now })?.kind ?? null;
    assert.equal(proof({ ...ok, completedAt: T0 - 1000 }), 'proof');
    assert.equal(proof({ ...ok, completedAt: T0 - 89_000 }), 'proof');
    assert.equal(proof({ ...ok, completedAt: T0 - 91_000 }), null, 'stale');
    for (const completedAt of [undefined, null, '', 'soon', NaN]) {
        assert.equal(proof({ ...ok, completedAt }), null, `undated (${completedAt}) is never fresh`);
    }
    const failed = { exitCode: 2, exitCodeSource: 'exit', completedAt: T0 - 500 };
    assert.deepEqual(resolveCarriedArtifact({ status: 'working', lastResults: [failed] }, { now: T0, failureStreak: 3 }),
        { kind: 'brokenProof', notches: 3 });
    assert.equal(resolveCarriedArtifact({ status: 'working', lastResults: [{ ...failed, completedAt: undefined }] }, { now: T0 }), null);
});

test('the walking artifact centres on the trailing hand; the set-down stamp clears the ground ring', () => {
    const bounds = { minX: 10, minY: 20, width: 100, height: 100 };
    for (const west of [false, true]) {
        const hand = artifactWalkingAnchor({ bounds, west });
        const rect = artifactWalkingRect({ bounds, west });
        assert.deepEqual(rect, { x: hand.x - 3, y: hand.y - 3, w: ARTIFACT_SIZE, h: ARTIFACT_SIZE });
        assert.equal(rect.x + ARTIFACT_SIZE / 2, hand.x);
        assert.equal(rect.y + ARTIFACT_SIZE / 2, hand.y);
    }
    // Spec 04 slot without a ring, unchanged.
    assert.deepEqual(artifactSetDownRect({ footX: 100, footY: 200 }), { x: 85, y: 196, w: 6, h: 6 });
    // A ring reaching 14 texels: one clear texel past its outermost pixel.
    const east = artifactSetDownRect({ footX: 100, footY: 200, ringHalfWidth: 14 });
    assert.equal(east.x + east.w - 1, 100 - 16, 'east: innermost pixel at -16, ring at -14');
    assert.equal(east.y + east.h, 202, 'bottom stays at y = +2');
    const west = artifactSetDownRect({ footX: 100, footY: 200, west: true, ringHalfWidth: 14 });
    assert.equal(west.x, 100 + 16, 'west: innermost pixel at +16, ring at +14');
    // Never past the trailing body column.
    for (const ring of [17, 30]) {
        const r = artifactSetDownRect({ footX: 100, footY: 200, ringHalfWidth: ring });
        assert.ok(r.x >= 100 - CAIRN_MAX_OFFSET);
        const w = artifactSetDownRect({ footX: 100, footY: 200, west: true, ringHalfWidth: ring });
        assert.ok(w.x + w.w <= 100 + CAIRN_MAX_OFFSET);
    }

    // The sprite reads its own ring reach off this frame's ground marks.
    const sprite = spriteStub({
        agent: { id: 'smith' }, carriedArtifact: { kind: 'billet' }, _zoom: 2, moving: false, direction: 2,
        _placeX: 100, _placeY: 200,
        _groundMarks: [
            { kind: 'shadow', x: 88, stamp: { width: 24 } },
            { kind: 'working', x: 86, stamp: { width: 30 } },
        ],
    });
    assert.equal(sprite._groundRingReach(false), 14);
    assert.equal(sprite._groundRingReach(true), 15);
});

test('seven artifact kinds keep distinct silhouettes and their own palette accents', () => {
    const masks = new Map();
    const tones = kind => new Set(artifactStampRows(kind).join('').split('').filter(c => c !== '.').map(artifactPaletteColor));
    for (const kind of ARTIFACT_KINDS) {
        const mask = artifactStampRows(kind).map(row => row.replace(/[^.]/g, '#')).join('/');
        assert.ok(![...masks.values()].includes(mask), `${kind} silhouette is its own`);
        masks.set(kind, mask);
    }
    const has = (kind, ...colors) => colors.every(c => tones(kind).has(c));
    assert.ok(has('billet', ART_RAMPS.stone[0], ART_RAMPS.emissive[0], ART_RAMPS.emissive[1]), 'dark iron + amber');
    assert.ok(has('scroll', ART_RAMPS.blossomIvory[3], ART_RAMPS.clothCrimson[1], ART_RAMPS.timber[1]), 'cream + seal on rods');
    assert.ok(has('letter', ART_RAMPS.blossomIvory[3], EFFECT_COLORS.magic[0]), 'folded ivory + wax');
    assert.ok(has('proof', ART_RAMPS.sand[4], ART_RAMPS.surfGlow[0]), 'parchment + emerald check');
    assert.ok(has('brokenProof', ART_RAMPS.slate[3], ART_RAMPS.slate[2], EFFECT_COLORS.failure), 'notched slate + crimson crack');
    assert.ok(has('plan', ART_RAMPS.seaPath[2], ART_RAMPS.trimGold[1], ART_RAMPS.slate[0]), 'cyan sheet, brass, ruled');
    assert.ok(has('orders', ART_RAMPS.clothCrimson[1], ART_RAMPS.trimGold[2]), 'gold-waxed crimson seal');
});

test('reportCairnStamp caches one crisp stamp of the exact stack or bundle', (t) => {
    withDocument(t);
    const exact = reportCairnSpec({ returned: 2, outstanding: 1, returnedTrims: ['#a78bfa', '#4ade80'] });
    const stamp = reportCairnStamp(exact);
    assert.ok(stamp);
    assert.equal(stamp.width, CAIRN_WIDTH);
    assert.equal(stamp.height, 3 * CAIRN_UNIT_STRIDE - 1);
    assert.match(stamp.__cvGroundKey, /^report-cairn:exact:/);
    assert.equal(reportCairnStamp({ ...exact }), stamp, 'cached by content');
    // Bottom unit: a returned scroll with the first child's trim seal at its centre.
    assert.equal(stamp.pixels.get(`2,${stamp.height - 1}`), '#a78bfa');
    assert.equal(stamp.pixels.get(`0,${stamp.height - 1}`), ART_RAMPS.timber[1]);
    // Top unit: an outstanding child's hollow chalk outline.
    assert.equal(stamp.pixels.get('2,0'), ART_RAMPS.blossomIvory[2]);
    assert.equal(stamp.pixels.get('2,1'), undefined, 'hollow');
    const bundle = reportCairnStamp(reportCairnSpec({ returned: 7, outstanding: 3 }));
    assert.equal(bundle.height, CAIRN_BUNDLE_HEIGHT);
    assert.equal(bundle.__cvGroundKey, 'report-cairn:bundle');
    assert.equal(reportCairnStamp(null), null);
});

test('Report Cairn admission keeps 6 in view and 2 per door zone', () => {
    const base = { id: 'lead', footX: 100, footY: 200, returned: 2, outstanding: 1 };
    assert.ok(admitReportCairn(base), 'counts omitted: not capped');
    assert.ok(admitReportCairn({ ...base, viewCount: CAIRN_VIEW_CAP - 1 }));
    assert.equal(admitReportCairn({ ...base, viewCount: CAIRN_VIEW_CAP }), null);
    assert.equal(admitReportCairn({ ...base, existingCount: CAIRN_VIEW_CAP }), null, 'existingCount alias');
    assert.ok(admitReportCairn({ ...base, doorCount: CAIRN_DOOR_ZONE_CAP - 1 }));
    assert.equal(admitReportCairn({ ...base, doorCount: CAIRN_DOOR_ZONE_CAP }), null);
    const admitted = admitReportCairn({ id: 'lead', footX: 100, footY: 200, returned: 3, existingCount: 0 });
    assert.equal(admitted.total, 3);
    assert.deepEqual(admitted.rect, reportCairnRect({ footX: 100, footY: 200, width: admitted.width, height: admitted.height }));
    assert.deepEqual(admitted.rect, { x: 78, y: 202 - admitted.height, w: 5, h: admitted.height });
    assert.equal(admitReportCairn({ id: 'lead', footX: 100, footY: 200 }), null, 'nothing counted, nothing stands');
});

test('the lead paints its cairn in its own depth slot, yielding the trailing side to a set-down artifact', (t) => {
    withDocument(t);
    const cairn = admitReportCairn({ id: 'lead', footX: 100, footY: 200, returned: 2, outstanding: 1 });
    const sprite = spriteStub({
        agent: { id: 'lead' }, _cairnSpec: cairn, _zoom: 2, moving: false, direction: 2, _placeX: 100, _placeY: 200,
        _gpuFrameRecord: { id: 'body' },
    });
    sprite._layoutCairnMark({});
    assert.deepEqual([sprite._cairnMark.x, sprite._cairnMark.y], [78, 202 - cairn.height]);
    const record = sprite._cairnRecord();
    assert.equal(record.id, 'report-cairn:lead');
    assert.match(record.textureKey, /^report-cairn:exact:/);
    assert.equal(record.source, sprite._cairnMark.stamp);
    assert.deepEqual([record.x, record.y, record.width, record.height], [78, 202 - cairn.height, 5, cairn.height]);
    assert.equal(agentLayerRecords({ body: { id: 'b' }, cairn: record }).at(-1).layer, 6);
    // A set-down artifact on the trailing column: the cairn takes the facing side.
    sprite._artifactMark = { stamp: {}, x: 79, y: 196 };
    sprite._layoutCairnMark({});
    assert.equal(sprite._cairnMark.x, 117);
    // Walking, zoomed out, or without a cairn: none.
    for (const fields of [{ moving: true }, { _zoom: 1.5, moving: false }, { _zoom: 2, _cairnSpec: null }]) {
        Object.assign(sprite, fields);
        sprite._layoutCairnMark({});
        assert.equal(sprite._cairnMark, null);
    }
});

// ---------------------------------------------------------------------------
// 4. Workflow ribbons.
// ---------------------------------------------------------------------------

test('workflow ribbons paint a 3×5 / 4×6 swallowtail device in the repo accent, no text, on both backends', (t) => {
    withDocument(t);
    assert.deepEqual(workflowRibbonRows(0).map(r => r.length), [3, 3, 3, 3, 3]);
    assert.deepEqual(workflowRibbonRows(1).map(r => r.length), [4, 4, 4, 4, 4, 4]);
    assert.equal(workflowRibbonRows(2), null);
    assert.equal(workflowRibbonRows(null), null);
    const zero = workflowRibbonStamp(0, '#a78bfa');
    assert.deepEqual([zero.width, zero.height], [3, 5]);
    assert.equal(zero.pixels.get('1,1'), '#a78bfa');
    assert.equal(zero.pixels.get('1,4'), undefined, 'swallowtail notch');
    const one = workflowRibbonStamp(1, '#a78bfa');
    assert.deepEqual([one.width, one.height], [4, 6]);
    assert.equal(one.pixels.get('1,2'), ART_RAMPS.blossomIvory[3], 'the second device carries a cream band');
    assert.equal(workflowRibbonStamp(0, 'not-a-colour').pixels.get('1,1'), ART_RAMPS.trimGold[2]);

    const { byAgentId } = assignWorkflowRibbons([
        { id: 'c1', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_1', workflowName: 'Sweep', turnStartedAt: 1 },
        { id: 'c2', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_2', workflowName: 'Audit', turnStartedAt: 2 },
        { id: 'c3', parentSessionId: 'lead', provider: 'claude', workflowId: 'wf_3', workflowName: 'Third', turnStartedAt: 3 },
    ]);
    assert.equal(byAgentId.get('c1').count, 3);
    const geometry = { dx: 100, dy: 200, bounds: { minX: 30, minY: 20, maxX: 60, maxY: 80 } };
    const child = (id, fields = {}) => spriteStub({
        agent: { id }, workflowRibbon: byAgentId.get(id), _zoom: 2, direction: 2, _gpuFrameRecord: { id: 'body' },
        thoughtRepoAccent: () => '#a78bfa', ...fields,
    });
    const east = child('c1');
    east._layoutRibbonMark(geometry);
    assert.equal(east._ribbonMark.stamp, zero);
    assert.ok(east._ribbonMark.x > geometry.dx + geometry.bounds.maxX, 'on the facing (pennon) side, beside the body');
    const west = child('c2', { direction: DIRECTIONS.indexOf('w') });
    west._layoutRibbonMark(geometry);
    assert.equal(west._ribbonMark.stamp, one);
    assert.ok(west._ribbonMark.x + one.width <= geometry.dx + geometry.bounds.minX);
    const record = east._ribbonRecord();
    assert.equal(record.id, 'workflow-ribbon:c1');
    assert.equal(record.textureKey, zero.__cvGroundKey);
    const third = child('c3');
    third._layoutRibbonMark(geometry);
    assert.equal(third._ribbonMark, null, 'a third run wears no ribbon');
    const far = child('c1', { _zoom: 1.5 });
    far._layoutRibbonMark(geometry);
    assert.equal(far._ribbonMark, null);
    // No text anywhere in the ribbon path: the postcard holds by construction.
    const source = fs.readFileSync(path.join(WORLD, 'AgentSprite.js'), 'utf8');
    const ribbonPath = source.slice(source.indexOf('    _layoutRibbonMark(frameGeometry) {'), source.indexOf('    _ribbonRecord() {'));
    assert.doesNotMatch(ribbonPath, /fillText|strokeText/);
});

// ---------------------------------------------------------------------------
// 5. Still-work and shelter routing ownership.
// ---------------------------------------------------------------------------

const ARCHIVE = BUILDING_DEFS.find(b => b.type === 'archive');
const ARCHIVE_WORK = ARCHIVE.visitTiles.filter(tile => tile.role === 'work' || !tile.role);

function routingSprite(agent, fields = {}) {
    const calls = { pick: 0, release: 0, routes: [] };
    const sprite = spriteStub({
        agent,
        x: 0, y: 0, moving: false, waitTimer: 0, motionScale: 1, direction: 2,
        visitRole: null, chatPartner: null, chatting: false, leaving: false, _straightWalk: false,
        _crowd: { status: agent.status, phase: agent.status === AgentStatus.IDLE ? 'sit' : null, place: null, cycle: 0, recentScenic: [] },
        behavior: { recentBuildings: [], setRoute() {}, acceptIntent() {}, recordBlocked() {}, finishVisit() {} },
        getIntentForAgent: () => null,
        isArrivalPending: () => false,
        _screenToTile: () => ({ tileX: 23, tileY: 20 }),
        _phaseForAgentState: () => null,
        _waypointsForVisitTarget: () => [],
        _assignTarget(x, y, tileX, tileY) { this._targetReachable = true; this.targetX = x; this.targetY = y; },
        _congestedBuilding: () => false,
        _pickTarget() { calls.pick++; },
        _releaseVisitReservation() { calls.release++; },
        ...fields,
    });
    const route = sprite._routeToVisitTarget;
    sprite._routeToVisitTarget = function (...args) {
        calls.routes.push({ building: args[0]?.type, target: { tileX: args[2]?.tileX, tileY: args[2]?.tileY }, role: args[3]?.role ?? null });
        return route.apply(this, args);
    };
    return { sprite, calls };
}

test('still-work routes ordinary work visits that _syncRestPlace never releases or re-picks', () => {
    const now = Date.now();
    const station = ARCHIVE_WORK[0];
    // 38 s into a think: the pace's away leg.
    const agent = { id: 'scribe', status: AgentStatus.WORKING, lastActivityAt: now - 38_000 };
    const { sprite, calls } = routingSprite(agent, {
        _lastBuildingType: 'archive',
        _lastTargetTile: { tileX: station.tileX, tileY: station.tileY },
    });
    sprite._advanceErrand(now);
    assert.equal(sprite._stillWorkPose, 'pace-work');
    assert.deepEqual(sprite._stillWorkStation, { tileX: station.tileX, tileY: station.tileY });
    assert.equal(calls.routes.length, 1);
    assert.equal(calls.routes[0].role, null, 'an ordinary work visit, never a place role');
    assert.equal(sprite.visitRole, null);
    assert.deepEqual(sprite._stillWorkTarget && { tileX: sprite._stillWorkTarget.tileX, tileY: sprite._stillWorkTarget.tileY }, calls.routes[0].target);
    for (let i = 0; i < 5; i++) sprite._syncRestPlace(now + i * 16);
    assert.deepEqual([calls.pick, calls.release], [0, 0], 'no release, no re-pick');
    // Arrived: the dwell holds for the think, the same tile is not re-routed.
    sprite.moving = false;
    sprite.waitTimer = 0;
    sprite._advanceErrand(now);
    assert.equal(calls.routes.length, 1);
    assert.ok(sprite.waitTimer >= 60, 'the visit timeout never re-picks mid-think');
    // The pace walks at the gentlest stroll.
    assert.equal(sprite._speedForState(), SPEED_RUNGS[0]);
});

test('two minutes into a think the worker holds a still thinking frame; a real tool sends it back at a run', () => {
    const now = Date.now();
    const station = ARCHIVE_WORK[0];
    const agent = { id: 'scribe', status: AgentStatus.WORKING, lastActivityAt: now - 130_000 };
    const { sprite, calls } = routingSprite(agent, {
        _lastBuildingType: 'archive',
        _lastTargetTile: { tileX: station.tileX, tileY: station.tileY },
        observation: { state: 'fresh' },
    });
    sprite._advanceErrand(now);
    assert.equal(sprite._stillWorkPose, 'sit-work');
    assert.equal(calls.routes.length, 0, 'already on its station');
    assert.equal(sprite._stillWorkSettled(), true);
    const meta = { cell: 92, groups: { think: { rows: [10, 12], hold: 11 } } };
    assert.equal(sprite._actionStripFrame(meta, 'think', now), 'hold', 'one still thinking frame');
    // A real tool fires: the think ends and the body runs one beat back.
    Object.assign(agent, { pendingTool: 'Edit', lastActivityAt: now, lastToolAt: now });
    sprite._advanceErrand(now);
    assert.equal(sprite._stillWorkPose, null);
    assert.ok(sprite._stillWorkRunBoostUntil > now);
    assert.equal(sprite._urgentRunDue(now), true);
    assert.equal(sprite._speedForState(), TOP_RUNG);
    Object.assign(sprite, {
        _gaitSpeed: TOP_RUNG, _spriteIdentity: { spriteId: 'agent.codex.gpt56sol' },
        assets: { getActionStrip: () => ({ image: {}, meta: { cell: 92, groups: { run: { rows: [21, 26] } } } }) },
    });
    assert.equal(sprite._runGaitDue(), true, 'TravelGait.RUN on the return beat');
    assert.equal(sprite._urgentRunDue(now + 1_000), false, 'one beat only');
});

test('still-work never invents an Archive visit and never routes against an active visit intent', () => {
    const now = Date.now();
    const agent = { id: 'scribe', status: AgentStatus.WORKING, lastActivityAt: now - 38_000 };
    const homeless = routingSprite(agent, { _lastBuildingType: null, _lastTargetTile: null });
    homeless.sprite._advanceErrand(now);
    assert.equal(homeless.sprite._stillWorkPose, null);
    assert.deepEqual(homeless.calls.routes, []);

    const intent = { id: 'intent-7', building: 'forge', priority: 80 };
    const busy = routingSprite(agent, {
        _lastBuildingType: 'archive',
        _lastTargetTile: { tileX: ARCHIVE_WORK[0].tileX, tileY: ARCHIVE_WORK[0].tileY },
        _lastIntentId: 'intent-7',
        _stillWorkPose: 'pace-work',
        getIntentForAgent: () => intent,
    });
    busy.sprite._advanceErrand(now);
    assert.deepEqual(busy.calls.routes, [], 'the intent owns the route');
    assert.equal(busy.sprite._lastIntentId, 'intent-7', 'its id is never cleared');
    assert.equal(busy.sprite._stillWorkPose, null);
    assert.equal(busy.sprite._crowd.intentSeenAt, now);
});

test('a squall rouses a seated idle villager, who runs to shelter and holds it', () => {
    const now = Date.now();
    const agent = { id: 'idler', status: AgentStatus.IDLE };
    const { sprite, calls } = routingSprite(agent, {
        visitRole: 'rest',
        _restSeat: { id: 'bench', tileX: 22, tileY: 21 },
        _weather: { type: 'storm', intensity: 0.9, precipitation: 0.8 },
        allocateVisitTile: ({ building, role }) => ({ tileX: 23, tileY: 19, slotId: `${building.type}:${role}`, buildingType: building.type }),
        getDayHour: () => 14,
    });
    sprite._advanceIdleLoop(now);
    const place = sprite._crowd.place;
    assert.equal(place.role, 'shelter');
    assert.equal(place.gait, 'run');
    assert.ok(place.target && Number.isFinite(place.target.tileX));
    // Seated (visitRole 'rest'), wanted at a shelter: it stands up.
    sprite._syncRestPlace(now);
    assert.deepEqual([calls.release, calls.pick], [1, 1]);
    // The re-pick routes the shelter place.
    assert.equal(sprite._routeToRestPlace(), true);
    assert.equal(sprite.visitRole, 'shelter');
    assert.equal(sprite._restSeat, null);
    assert.equal(calls.routes.at(-1).role, 'shelter');
    assert.equal(sprite._urgentRunDue(now), true);
    assert.equal(sprite._speedForState(), TOP_RUNG, 'it runs for cover');
    // Holding its shelter: no further re-picks.
    sprite._placeRetryAt = 0;
    sprite._syncRestPlace(now + 2_500);
    assert.equal(calls.pick, 1);
    // A different shelter target is a different place: re-aim.
    place.key = 'shelter:gate:19,38';
    sprite._syncRestPlace(now + 5_000);
    assert.equal(calls.pick, 2);

    // Falling snow sends nobody running.
    const snow = routingSprite({ id: 'snowy', status: AgentStatus.IDLE }, {
        visitRole: 'rest',
        _weather: { type: 'rain', intensity: 0.9, precipitation: 0.8 },
        _weatherDate: new Date(2026, 0, 20),
    });
    snow.sprite._advanceIdleLoop(now);
    assert.notEqual(snow.sprite._crowd.place?.role, 'shelter');
    snow.sprite._syncRestPlace(now);
    assert.equal(snow.calls.pick, 0, 'the seated villager stays seated in the snow');
});

// ---------------------------------------------------------------------------
// 6. Compaction rite: clock, late joiner, chit.
// ---------------------------------------------------------------------------

test('the compaction rite runs on the monotonic clock and never plays a compaction from before the page opened', () => {
    const ctrl = new ArrivalDepartureController({ pageStartWallMs: T0 });
    assert.equal(ctrl._pageStartWallMs, T0);
    ctrl.primeCompactions([{ id: 'resident' }]);
    const sprite = { x: 100, y: 200 };
    const late = {
        id: 'late-joiner',
        compactions: [{ at: T0 - 30_000, trigger: 'auto', preTokens: 412_300, postTokens: 38_100 }],
    };
    // Inside the 120 s window, but before the page opened: never.
    assert.deepEqual(ctrl.observeAgentCompactions(late, sprite, { wallNow: T0 + 10_000 }), []);
    // A compaction after the page opened plays, on the monotonic clock.
    late.compactions = [...late.compactions, { at: T0 + 5_000, trigger: 'auto', preTokens: 412_300, postTokens: 38_100 }];
    const before = performance.now();
    const started = ctrl.observeAgentCompactions(late, sprite, { wallNow: T0 + 10_000 });
    const after = performance.now();
    assert.equal(started.length, 1);
    assert.ok(started[0].startedAt >= before && started[0].startedAt <= after, 'now defaults to performance.now()');
    assert.ok(Math.abs(started[0].startedAt - Date.now()) > 1e6, 'never the wall clock');
    const fresh = new ArrivalDepartureController();
    assert.ok(Math.abs(fresh._pageStartWallMs - Date.now()) < 5_000, 'page start is captured at construction');
});

test('the compaction chit shows 412K → 38K on a live frame and no text on a postcard frame', () => {
    const ctrl = new ArrivalDepartureController({ pageStartWallMs: T0 });
    const rite = ctrl.beginCompactionRite({ id: 'a1' }, { x: 100, y: 200 },
        { at: T0 + 1_000, trigger: 'manual', preTokens: 412_300, postTokens: 38_100 }, { now: 1_000 });
    const live = recordingContext();
    ctrl._drawCompactionRite(live, rite, 1_300, 2);
    assert.deepEqual(live.texts, ['412K → 38K']);
    assert.ok(live.fills.some(f => f.color === ART_RAMPS.sand[4]), 'parchment backing');
    const card = recordingContext();
    withPostcardFrame(() => {
        assert.equal(postcardFrame(), true);
        ctrl._drawCompactionRite(card, rite, 1_300, 2);
    });
    assert.deepEqual(card.texts, []);
    assert.ok(card.fills.length > 0, 'the bird still flies');
    assert.ok(!card.fills.some(f => f.color === ART_RAMPS.sand[4]), 'no chit backing either');
});

// ---------------------------------------------------------------------------
// 7. Stepped trails.
// ---------------------------------------------------------------------------

test('snow and wet-sand footprints fade in TRAIL_ALPHA_STEPS whole steps, never a continuous ramp', async (t) => {
    const levels = new Set();
    for (let i = 0; i <= 1000; i++) levels.add(footprintAlphaStep(i / 1000));
    assert.deepEqual([...levels].sort(), [0, ...Array.from({ length: TRAIL_ALPHA_STEPS }, (_, k) => (k + 1) / TRAIL_ALPHA_STEPS)].sort());
    assert.equal(footprintAlphaStep(-1), 0);
    assert.equal(footprintAlphaStep(NaN), 0);
    assert.equal(footprintAlphaStep(2), 1);

    const renderer = new TrailRenderer({ sprites: new Map(), surfaceAt: () => 'sand' });
    t.after(() => renderer.dispose());
    const now = T0;
    renderer.surfaceWetness = 0.2;
    renderer.snowBucket = 1;
    renderer.footprints = Array.from({ length: 60 }, (_, i) => ({
        agentId: 'w', ts: now - i * 60_000, tileX: 10 + (i % 7), tileY: 10, footprint: i % 2 ? 'snow' : 'sand',
    }));
    const ctx = recordingContext();
    renderer.draw(ctx, {}, {}, now);
    assert.ok(ctx.fills.length > 20);
    const alphas = new Set(ctx.fills.map(f => Math.round(f.alpha * 1e6) / 1e6));
    const allowed = new Set([1, 2, 3].map(k => Math.round(0.45 * k / TRAIL_ALPHA_STEPS * 1e6) / 1e6));
    for (const alpha of alphas) assert.ok(allowed.has(alpha), `alpha ${alpha} is a whole step`);
    assert.ok(alphas.size >= 2, 'the steps are reached');
});
