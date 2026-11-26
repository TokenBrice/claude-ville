import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { luminance, measureGrainDensity, oklab, THRESHOLDS } from '../sprites/art-analyze.mjs';
import {
    CARVED_MOTIFS_PATH,
    CARVED_MOTIF_ORDER,
    CELL_SIZE,
    SHEET_HEIGHT,
    SHEET_WIDTH,
    bakeCarvedMotifsPng,
} from '../sprites/bake-carved-motifs.mjs';
import {
    INSPECTION_GLASS_RIM_PATH,
    bakeInspectionGlassRimPng,
} from '../sprites/bake-inspection-glass.mjs';
import {
    GLASS_CUTAWAY_MIN_ZOOM,
    GLASS_DIAMETER,
    GLASS_DWELL_MS,
    GLASS_EXIT_MS,
    GLASS_RADIUS,
    GLASS_RIM_ANCHOR,
    GLASS_RIM_ASSET_ID,
    GLASS_RIM_SIZE,
    GLASS_ROW_SPANS,
    GLASS_STORAGE_KEY,
    GLASS_TOUCH_OFFSET_Y,
    InspectionGlass,
    applyGlassClip,
    inGlass,
    readGlassSetting,
    writeGlassSetting,
} from '../../claudeville/src/presentation/character-mode/InspectionGlass.js';
import {
    CHILD_CELL_W,
    COUNCIL_RIBBON_RESERVED_NAME,
    CouncilRibbon,
    LEAD_CELL_W,
    MAX_VISIBLE_CHILDREN,
    OVERFLOW_CELL_W,
    RETOLD_SCRUBBER_RESERVED_NAME,
    RIBBON_HEIGHT,
    RIBBON_STACK_GAP,
    SCRIM_ALPHA_DAY,
    SCRIM_ALPHA_NIGHT,
    SCRIM_COLOR,
    councilVerbFor,
    drawCouncilScrim,
    hitTestCouncilRibbon,
    layoutCouncilRibbon,
} from '../../claudeville/src/presentation/character-mode/CouncilRibbon.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { getReservedRect, publishReservedBox } from '../../claudeville/src/presentation/shared/ReservedRects.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ALL_ART_STOPS = Object.values(ART_RAMPS).flat().map((h) => oklab(...hexRgb(h)));

function inspectPngArt(png) {
    let visible = 0;
    let semi = 0;
    let tierA = 0;
    let offRamp = 0;
    const colours = new Set();
    for (let i = 0; i < png.data.length; i += 4) {
        const a = png.data[i + 3];
        if (a === 0) continue;
        visible++;
        if (a < 255) semi++;
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        colours.add((r << 16) | (g << 8) | b);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (
            luminance(r, g, b) > THRESHOLDS.tierALuminance
            || (sat > THRESHOLDS.tierASaturation && max >= THRESHOLDS.tierASaturationMinValue * 255)
        ) {
            tierA++;
        }
        const lab = oklab(r, g, b);
        let best = Infinity;
        for (const stop of ALL_ART_STOPS) {
            const d = Math.hypot(lab[0] - stop[0], lab[1] - stop[1], lab[2] - stop[2]);
            if (d < best) best = d;
        }
        if (best > THRESHOLDS.offRampDistance) offRamp++;
    }
    return { visible, semi, tierA, offRamp, colours: colours.size };
}

test('prop.carvedMotifs.png is 144x16, deterministic, 9 landmark frames, 0 off-ramp, 0 Tier-A, in-band grain', () => {
    const baked = bakeCarvedMotifsPng();
    const disk = readFileSync(CARVED_MOTIFS_PATH);
    assert.ok(disk.equals(baked), 'on-disk prop.carvedMotifs.png must match deterministic bake');

    const png = PNG.sync.read(disk);
    assert.equal(png.width, 144);
    assert.equal(png.height, 16);
    assert.equal(SHEET_WIDTH, 144);
    assert.equal(SHEET_HEIGHT, 16);
    assert.equal(CARVED_MOTIF_ORDER.length, 9);
    assert.deepEqual([...CARVED_MOTIF_ORDER], BUILDING_DEFS.map((b) => b.type));

    // Each 16x16 frame must contain opaque carved sign art and distinct emblem pixels.
    const frameHashes = new Set();
    for (let f = 0; f < 9; f++) {
        let opaque = 0;
        const sig = [];
        for (let y = 0; y < CELL_SIZE; y++) {
            for (let x = 0; x < CELL_SIZE; x++) {
                const i = (y * png.width + f * CELL_SIZE + x) * 4;
                if (png.data[i + 3] > 0) opaque++;
                sig.push(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
            }
        }
        assert.ok(opaque >= 120, `frame ${f} (${CARVED_MOTIF_ORDER[f]}) has too few opaque pixels: ${opaque}`);
        frameHashes.add(sig.join(','));
    }
    assert.equal(frameHashes.size, 9, 'all 9 landmark carved motif frames must be distinct');

    const metrics = inspectPngArt(png);
    assert.equal(metrics.semi, 0, 'zero semi-alpha anti-aliasing pixels');
    assert.equal(metrics.tierA, 0, 'zero Tier-A pixels');
    assert.equal(metrics.offRamp, 0, 'zero off-ramp pixels');
    assert.ok(metrics.colours <= 48, `colour count ${metrics.colours} <= 48`);

    const tavern = PNG.sync.read(readFileSync(join(ROOT, 'claudeville/assets/sprites/buildings/building.tavern/base.png')));
    const tavernGrain = measureGrainDensity(tavern).densityPer32x32;
    const motifGrain = measureGrainDensity(png).densityPer32x32;
    const ratio = motifGrain / tavernGrain;
    assert.ok(
        ratio >= THRESHOLDS.grainRatioBand[0] && ratio <= THRESHOLDS.grainRatioBand[1],
        `carved motifs grain ratio ${ratio.toFixed(3)} must lie in [${THRESHOLDS.grainRatioBand.join(', ')}]`,
    );
});

test('overlay.inspectionGlass.rim.png is 228x228, deterministic, 220px transparent inner disc, 4px hard brass bezel', () => {
    const baked = bakeInspectionGlassRimPng();
    const disk = readFileSync(INSPECTION_GLASS_RIM_PATH);
    assert.ok(disk.equals(baked), 'on-disk overlay.inspectionGlass.rim.png must match deterministic bake');

    const png = PNG.sync.read(disk);
    assert.equal(png.width, 228);
    assert.equal(png.height, 228);

    // Every single pixel inside the 220 px aperture (GLASS_ROW_SPANS) MUST be 100% transparent.
    let innerOpaque = 0;
    for (const span of GLASS_ROW_SPANS) {
        const y = GLASS_RIM_ANCHOR[1] + span.y;
        for (let dx = span.x0; dx < span.x0 + span.width; dx++) {
            const x = GLASS_RIM_ANCHOR[0] + dx;
            if (png.data[(y * png.width + x) * 4 + 3] !== 0) innerOpaque++;
        }
    }
    assert.equal(innerOpaque, 0, 'inner 220 px disc must be 100% transparent');

    // Cardinal 4 px bezel check on the north edge (x=114, y=0..3 opaque, y=4 transparent).
    for (let y = 0; y < 4; y++) {
        assert.equal(png.data[(y * 228 + 114) * 4 + 3], 255, `north bezel row ${y} must be opaque`);
    }
    assert.equal(png.data[(4 * 228 + 114) * 4 + 3], 0, 'first aperture row y=4 must be transparent');

    const metrics = inspectPngArt(png);
    assert.equal(metrics.semi, 0, 'zero anti-aliasing semi-alpha pixels');
    assert.equal(metrics.tierA, 0, 'zero Tier-A pixels');
    assert.equal(metrics.offRamp, 0, 'zero off-ramp pixels');
    assert.ok(metrics.colours >= 4 && metrics.colours <= 16, `expected 3 brass courses + ink (${metrics.colours} colours)`);
});

test('InspectionGlass row spans, hard clip (zero arc/ellipse), and inGlass predicate match exactly', () => {
    assert.equal(GLASS_DIAMETER, 220);
    assert.equal(GLASS_RADIUS, 110);
    assert.equal(GLASS_RIM_SIZE, 228);
    assert.equal(GLASS_DWELL_MS, 300);
    assert.equal(GLASS_EXIT_MS, 400);
    assert.equal(GLASS_TOUCH_OFFSET_Y, 134);
    assert.equal(GLASS_CUTAWAY_MIN_ZOOM, 2);
    assert.equal(GLASS_RIM_ASSET_ID, 'overlay.inspectionGlass.rim');
    assert.equal(GLASS_ROW_SPANS.length, 220);

    // Static proof: zero ctx.arc or ctx.ellipse anywhere in InspectionGlass.js.
    const src = readFileSync(join(ROOT, 'claudeville/src/presentation/character-mode/InspectionGlass.js'), 'utf8');
    assert.equal(/\.arc\(|\.ellipse\(/.test(src), false, 'InspectionGlass.js must never call arc() or ellipse()');

    // Verify applyGlassClip issues 220 1px-high rects and clips.
    const rects = [];
    let began = 0;
    let clipped = 0;
    const mockCtx = {
        beginPath() { began++; },
        rect(x, y, w, h) { rects.push({ x, y, w, h }); },
        clip() { clipped++; },
    };
    applyGlassClip(mockCtx, 300.4, 250.6); // rounds to (300, 251)
    assert.equal(began, 1);
    assert.equal(clipped, 1);
    assert.equal(rects.length, 220);
    for (let i = 0; i < 220; i++) {
        assert.equal(rects[i].h, 1);
        assert.equal(Number.isInteger(rects[i].x), true);
        assert.equal(Number.isInteger(rects[i].y), true);
        assert.equal(Number.isInteger(rects[i].w), true);
        assert.ok(rects[i].w > 0 && rects[i].w <= 220);
    }

    // Verify inGlass agrees with every row span edge pixel.
    for (const span of GLASS_ROW_SPANS) {
        const y = 251 + span.y;
        const left = 300 + span.x0;
        const right = left + span.width - 1;
        assert.equal(inGlass(300.4, 250.6, left, y), true);
        assert.equal(inGlass(300.4, 250.6, right, y), true);
        assert.equal(inGlass(300.4, 250.6, left - 1, y), false);
        assert.equal(inGlass(300.4, 250.6, right + 1, y), false);
    }
    assert.equal(inGlass(300, 251, 300, 251 - 111), false);
    assert.equal(inGlass(300, 251, 300, 251 + 110), false);
});

test('InspectionGlass setting gate, mouse/touch/pen contract, L unbound, dwell cutaway, and postcard stand-down', () => {
    // Storage defaults to 'off'.
    const store = new Map();
    const fakeStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
    };
    assert.equal(readGlassSetting(fakeStorage), 'off');
    assert.equal(writeGlassSetting('on', fakeStorage), 'on');
    assert.equal(store.get(GLASS_STORAGE_KEY), 'on');
    assert.equal(readGlassSetting(fakeStorage), 'on');
    assert.equal(writeGlassSetting('bogus', fakeStorage), 'off');

    // Disabled by default: KeyG and arming are no-ops.
    const glass = new InspectionGlass();
    assert.equal(glass.enabled, false);
    assert.equal(glass.onKeyDown('KeyG'), false);
    assert.equal(glass.setArmed(true), false);
    assert.equal(glass.isActive(), false);

    // Enabled: KeyL is NEVER bound; KeyG activates at last pointer and releases on keyup/blur.
    glass.setEnabled(true);
    assert.equal(glass.onPointerMove(420, 310, { pointerType: 'mouse' }), false, 'mouse move is passive');
    assert.equal(glass.onKeyDown('KeyL'), false, 'KeyL must stay unbound');
    assert.equal(glass.isActive(), false);
    assert.equal(glass.onKeyDown('KeyG'), true);
    assert.equal(glass.isActive(), true);
    assert.deepEqual(glass.getCenter(), { x: 420, y: 310 });
    assert.equal(glass.onPointerMove(500, 360, { pointerType: 'mouse' }), false);
    assert.deepEqual(glass.getCenter(), { x: 500, y: 360 });
    assert.equal(glass.onKeyUp('KeyG'), true);
    assert.equal(glass.isActive(), false);

    // Blur releases held key.
    glass.onKeyDown('KeyG');
    assert.equal(glass.isActive(), true);
    glass.onBlur();
    assert.equal(glass.isActive(), false);

    // Touch/pen armed mode: tap selects (pointerUp returns false), drag places lens y - 134, 2-finger cancels drag.
    assert.equal(glass.setArmed(true), true);
    assert.equal(glass.onPointerDown(200, 400, { pointerType: 'touch', pointerId: 1 }), false);
    assert.equal(glass.onPointerMove(202, 401, { pointerType: 'touch', pointerId: 1 }), false, 'below drag threshold');
    assert.equal(glass.onPointerUp(202, 401, { pointerType: 'touch', pointerId: 1 }), false, 'tap preserves selection');

    // Single-finger drag >= threshold activates lens at (x, y - 134).
    glass.onPointerDown(200, 400, { pointerType: 'touch', pointerId: 2 });
    assert.equal(glass.onPointerMove(220, 400, { pointerType: 'touch', pointerId: 2 }), true);
    assert.equal(glass.isActive(), true);
    assert.deepEqual(glass.getCenter(), { x: 220, y: 400 - GLASS_TOUCH_OFFSET_Y });

    // Second finger cancels Glass drag so two-finger pan/zoom proceeds untouched.
    assert.equal(glass.onPointerDown(260, 410, { pointerType: 'touch', pointerId: 3 }), false);
    assert.equal(glass.isActive(), false);
    assert.equal(glass.onPointerMove(230, 405, { pointerType: 'touch', pointerId: 2 }), false);
    glass.onPointerUp(230, 405, { pointerType: 'touch', pointerId: 2 });
    glass.onPointerUp(260, 410, { pointerType: 'touch', pointerId: 3 });

    // Cutaway dwell state machine: 300ms continuous dwell at z >= 2 opens, 400ms after leaving closes, selection wins.
    glass.setArmed(false);
    glass.onPointerMove(300, 300, { pointerType: 'mouse' });
    glass.onKeyDown('KeyG');

    // Below zoom 2: never opens.
    assert.equal(glass.updateCutaway({ buildingId: 'forge', zoom: 1.5, nowMs: 1000 }).buildingId, null);
    assert.equal(glass.updateCutaway({ buildingId: 'forge', zoom: 1.5, nowMs: 2000 }).buildingId, null);

    // At zoom 2: 299ms not open, 300ms opens with source 'glass'.
    assert.equal(glass.updateCutaway({ buildingId: 'forge', zoom: 2, nowMs: 2000 }).buildingId, null);
    assert.equal(glass.updateCutaway({ buildingId: 'forge', zoom: 2, nowMs: 2299 }).buildingId, null);
    const opened = glass.updateCutaway({ buildingId: 'forge', zoom: 2, nowMs: 2300 });
    assert.deepEqual(opened, { buildingId: 'forge', source: 'glass', changed: true });

    // Leaving for 399ms stays open; 400ms closes.
    assert.equal(glass.updateCutaway({ buildingId: null, zoom: 2, nowMs: 2500 }).buildingId, 'forge');
    assert.equal(glass.updateCutaway({ buildingId: null, zoom: 2, nowMs: 2899 }).buildingId, 'forge');
    const closed = glass.updateCutaway({ buildingId: null, zoom: 2, nowMs: 2900 });
    assert.deepEqual(closed, { buildingId: null, source: null, changed: true });

    // Selection cutaway takes priority immediately.
    glass.updateCutaway({ buildingId: 'archive', zoom: 2, nowMs: 3000 });
    assert.equal(glass.updateCutaway({ buildingId: 'archive', zoom: 2, nowMs: 3300 }).buildingId, 'archive');
    const yielded = glass.updateCutaway({ buildingId: 'archive', zoom: 2, selectionCutawayActive: true, nowMs: 3350 });
    assert.deepEqual(yielded, { buildingId: null, source: null, changed: true });

    // drawRim draws sprite at Math.round(cx - 114), Math.round(cy - 114), skipped during postcardFrame().
    const draws = [];
    const rimCtx = {
        imageSmoothingEnabled: true,
        fillStyle: '',
        save() {},
        restore() {},
        fillRect() {},
        drawImage(img, x, y, w, h) { draws.push({ img, x, y, w, h }); },
    };
    const fakeRim = { id: GLASS_RIM_ASSET_ID };
    const assets = { get: (id) => (id === GLASS_RIM_ASSET_ID ? fakeRim : null) };
    assert.equal(glass.drawRim(rimCtx, assets), true);
    assert.deepEqual(draws, [{ img: fakeRim, x: 300 - 114, y: 300 - 114, w: 228, h: 228 }]);

    draws.length = 0;
    withPostcardFrame(() => {
        assert.equal(glass.drawRim(rimCtx, assets), false, 'rim must never draw during postcardFrame()');
    });
    assert.equal(draws.length, 0);
});

test('CouncilRibbon layout, Retold stacking (+4px), overflow +N, hitTest, verbs, and drawCouncilScrim', () => {
    assert.equal(RIBBON_HEIGHT, 44);
    assert.equal(LEAD_CELL_W, 44);
    assert.equal(CHILD_CELL_W, 40);
    assert.equal(MAX_VISIBLE_CHILDREN, 8);

    // 4-letter verb derivation covers all canonical verbs.
    assert.equal(councilVerbFor({ status: 'working', currentTool: 'Edit' }), 'EDIT');
    assert.equal(councilVerbFor({ status: 'working', readToolVerb: 'TESTING' }), 'TEST');
    assert.equal(councilVerbFor({ status: 'working', currentTool: 'Read' }), 'READ');
    assert.equal(councilVerbFor({ status: 'waiting_on_user' }), 'WAIT');
    assert.equal(councilVerbFor({ status: 'working', currentTool: 'Bash' }), 'EXEC');
    assert.equal(councilVerbFor({ status: 'working', readToolVerb: 'PLANNING' }), 'PLAN');
    assert.equal(councilVerbFor({ status: 'idle' }), 'IDLE');

    // Stack 4 px above a reserved bottom Retold scrubber rect.
    publishReservedBox(RETOLD_SCRUBBER_RESERVED_NAME, { left: 440, top: 840, right: 1000, bottom: 884 });
    try {
        const lead = { id: 'lead-1', status: 'working', currentTool: 'Plan' };
        const children = Array.from({ length: 11 }, (_, i) => ({
            id: `child-${i + 1}`,
            status: i % 2 === 0 ? 'working' : 'waiting',
            currentTool: i % 2 === 0 ? 'Edit' : 'Read',
        }));

        const viewport = { width: 1440, height: 900 };
        const ribbon = new CouncilRibbon();
        ribbon.setSquad({ lead, children, selectedId: 'lead-1' });

        const box = ribbon.layout(viewport);
        const expectedWidth = LEAD_CELL_W + MAX_VISIBLE_CHILDREN * CHILD_CELL_W + OVERFLOW_CELL_W;
        assert.equal(box.width, expectedWidth);
        assert.equal(box.height, 44);
        assert.equal(box.x, Math.round((1440 - expectedWidth) / 2));
        assert.equal(box.y, 840 - RIBBON_STACK_GAP - RIBBON_HEIGHT);
        assert.equal(box.cells.length, 10); // 1 lead + 8 children + 1 overflow
        assert.equal(box.overflowCount, 3);
        assert.equal(box.cells[0].kind, 'lead');
        assert.equal(box.cells[0].width, 44);
        assert.equal(box.cells[1].kind, 'child');
        assert.equal(box.cells[1].width, 40);
        assert.equal(box.cells[9].kind, 'overflow');
        assert.equal(box.cells[9].label, '+3');

        // Reserved box published for caption-band clearance.
        const published = getReservedRect(COUNCIL_RIBBON_RESERVED_NAME);
        assert.ok(published);
        assert.equal(published.top, box.y);
        assert.equal(published.bottom, box.y + 44);

        // Hit-testing lead, child, overflow (+3 -> null), and outside -> null.
        assert.equal(ribbon.hitTest(box.cells[0].x + 10, box.y + 10), 'lead-1');
        assert.equal(ribbon.hitTest(box.cells[3].x + 10, box.y + 20), 'child-3');
        assert.equal(ribbon.hitTest(box.cells[9].x + 10, box.y + 20), null);
        assert.equal(hitTestCouncilRibbon(box, 0, 0), null);

        // Clicking glides to member while keeping Council Focus active.
        const selectedEvents = [];
        const hitId = ribbon.onClick(box.cells[2].x + 15, box.y + 15, (id, meta) => selectedEvents.push({ id, meta }));
        assert.equal(hitId, 'child-2');
        assert.deepEqual(selectedEvents, [{ id: 'child-2', meta: { keepCouncilFocus: true } }]);
        assert.equal(ribbon.isActive(), true, 'Council Focus remains active after member click');

        // Standalone layout without overflow.
        const small = layoutCouncilRibbon({ lead, children: children.slice(0, 2), viewport });
        assert.equal(small.cells.length, 3);
        assert.equal(small.overflowCount, 0);

        ribbon.dispose();
        assert.equal(getReservedRect(COUNCIL_RIBBON_RESERVED_NAME), null);
    } finally {
        publishReservedBox(RETOLD_SCRUBBER_RESERVED_NAME, null);
    }

    // drawCouncilScrim: #0e0906 alpha 0.28 day / 0.18 night, destination-out holes only for visible non-occluded members.
    const ops = [];
    const scrimCtx = {
        fillStyle: '',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: true,
        save() {},
        restore() {},
        clearRect() {},
        fillRect(x, y, w, h) {
            ops.push({ op: 'fillRect', fill: this.fillStyle, alpha: this.globalAlpha, gco: this.globalCompositeOperation, x, y, w, h });
        },
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            ops.push({
                op: 'drawImage',
                img,
                gco: this.globalCompositeOperation,
                smooth: this.imageSmoothingEnabled,
                dx, dy, dw, dh,
            });
        },
    };
    const fakeSheet = { tag: 'pose-sheet' };
    const squad = [
        { id: 'visible-lead', _occludedByWorld: false, _behindBuilding: false, _poseCell: { canvas: fakeSheet, sx: 0, sy: 0, sw: 92, sh: 92, dx: 100, dy: 200 } },
        { id: 'occluded-world', _occludedByWorld: true, _behindBuilding: false, _poseCell: { canvas: fakeSheet, sx: 0, sy: 0, sw: 92, sh: 92, dx: 150, dy: 200 } },
        { id: 'behind-bldg', _occludedByWorld: false, _behindBuilding: true, _poseCell: { canvas: fakeSheet, sx: 0, sy: 0, sw: 92, sh: 92, dx: 200, dy: 200 } },
        { id: 'visible-child', _occludedByWorld: false, _behindBuilding: false, _poseCell: { canvas: fakeSheet, sx: 92, sy: 0, sw: 92, sh: 92, dx: 250, dy: 220 } },
    ];

    const dayRes = drawCouncilScrim(scrimCtx, { width: 1280, height: 720 }, squad, false, { direct: true });
    assert.deepEqual(dayRes, { drawn: true, alpha: SCRIM_ALPHA_DAY, holesCut: 2 });
    assert.equal(ops[0].fill, SCRIM_COLOR);
    assert.equal(ops[0].alpha, 0.28);
    const holeOps = ops.filter((o) => o.op === 'drawImage');
    assert.equal(holeOps.length, 2);
    assert.ok(holeOps.every((o) => o.gco === 'destination-out' && o.smooth === false));

    ops.length = 0;
    const nightRes = drawCouncilScrim(scrimCtx, { width: 1280, height: 720 }, squad, true, { direct: true });
    assert.deepEqual(nightRes, { drawn: true, alpha: SCRIM_ALPHA_NIGHT, holesCut: 2 });
    assert.equal(ops[0].alpha, 0.18);

    // Postcard frame suppresses scrim and ribbon.
    withPostcardFrame(() => {
        const pcRes = drawCouncilScrim(scrimCtx, { width: 1280, height: 720 }, squad, false, { direct: true });
        assert.equal(pcRes.drawn, false);
    });
});
