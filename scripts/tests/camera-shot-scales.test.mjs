import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import {
    Camera,
    SURVEY_TIER,
    islandAreaInWorldRect,
    shotScaleTiers,
    zoomTierLadder,
} from '../../claudeville/src/presentation/character-mode/Camera.js';
import { CameraDirector } from '../../claudeville/src/presentation/character-mode/CameraDirector.js';
import { collectSpriteEntries, loadSpriteManifest, pathForEntry, spritesRoot } from '../sprites/manifest-utils.mjs';

// Viewports are the World canvas in CSS px: the window less the 240 px sidebar
// and the 48 px top bar.
const scalesFor = (canvasW, canvasH, dpr) => ({ ...shotScaleTiers(canvasW, canvasH, zoomTierLadder(dpr)) });
const canvasOf = (w, h, dpr = 1) => ({
    _claudeVilleCssWidth: w,
    _claudeVilleCssHeight: h,
    _claudeVilleDpr: dpr,
    style: {},
    addEventListener() {},
    removeEventListener() {},
});

// The renderer's sprite metrics (IsometricRenderer → Camera.setSpriteMetrics):
// dims and anchor for every sprite, an alpha mask for buildings only
// (AssetManager builds masks for interaction art), so a prop's crown is its
// sprite top.
const ENTRIES = new Map(collectSpriteEntries(loadSpriteManifest(), ['buildings', 'props']).map((entry) => [entry.id, entry]));
const spriteMetrics = (id) => {
    const entry = ENTRIES.get(id);
    if (!entry) return null;
    const png = PNG.sync.read(readFileSync(join(spritesRoot, pathForEntry(entry))));
    let mask;
    if (id.startsWith('building.')) {
        mask = new Uint8Array(png.width * png.height);
        for (let i = 0; i < mask.length; i++) mask[i] = png.data[i * 4 + 3] > 0 ? 1 : 0;
    }
    return { dims: { w: png.width, h: png.height }, anchor: entry.anchor, mask };
};
const ISLAND_AREA = islandAreaInWorldRect(-1e6, -1e6, 1e6, 1e6);
const LANDMARK_EDGE_AIR_PX = 4;
// The frame a pose shows, and where a landmark mark lands in it (screen px).
const viewOf = (camera, pose) => ({
    left: -pose.x,
    top: -pose.y,
    w: camera._viewportWidth() / pose.zoom,
    h: camera._viewportHeight() / pose.zoom,
});
const crownY = (view, mark, zoom) => (mark.minY - view.top) * zoom;
const markInColumns = (view, mark) => mark.minX >= view.left && mark.maxX <= view.left + view.w;
const bodyWhole = (view, body) => body.x - 20 >= view.left && body.x + 20 <= view.left + view.w
    && body.y - 76 >= view.top && body.y + 6 <= view.top + view.h;

test('1920×1080 at DPR 1 has no survey: wide 1, medium 2, close 3', () => {
    assert.deepEqual(scalesFor(1680, 1032, 1), { survey: null, wide: 1, medium: 2, close: 3 });
});

test('5120×1440 at DPR 1 surveys 1:1 at z1 and rests the wide at z2, the medium at z3', () => {
    assert.deepEqual(scalesFor(4880, 1392, 1), { survey: 1, wide: 2, medium: 3, close: 3 });
});

test('2560×1440 at DPR 1 surveys at z1 and meets wide and medium at z2', () => {
    assert.deepEqual(scalesFor(2320, 1392, 1), { survey: 1, wide: 2, medium: 2, close: 3 });
});

test('1512×982 at DPR 2 keeps shots on logical tiers even where a half rung is nearer', () => {
    // Zoom 1.5 shows 0.53e6 world px², nearer the medium target than zoom 2
    // does, but the half rungs are operator rests, never shot scales.
    assert.deepEqual(scalesFor(1272, 934, 2), { survey: 0.5, wide: 1, medium: 2, close: 2 });
});

test('1800×1169 at DPR 2 surveys at 0.5: wide 1, medium 2, close 3', () => {
    assert.deepEqual(scalesFor(1560, 1121, 2), { survey: 0.5, wide: 1, medium: 2, close: 3 });
});

test('backing DPR 2 exposes every whole backing-pixel scale; DPR 1 keeps three tiers', () => {
    assert.deepEqual([...zoomTierLadder(2).steps], [0.5, 1, 1.5, 2, 2.5, 3]);
    assert.deepEqual([...zoomTierLadder(1).steps], [1, 2, 3]);
});

test('ordinary Auto rests no closer than the wide scale and never zooms past a wider rest', () => {
    const autoCap = (wide, tier) => CameraDirector.prototype._currentMaxZoom.call({
        camera: { shotTier: () => wide, currentZoomTier: () => tier },
    });
    assert.equal(autoCap(2, 3), 2);
    assert.equal(autoCap(2, 1), 1);
    assert.equal(autoCap(1, 2.5), 1);
});

test('an Ambient cohort shot frames only the members standing at its building', () => {
    const center = { x: -80, y: 536 }; // Command
    const sprite = (id, x, y, fold = null) => ({ agent: { id }, x, y, _foldBuildingType: fold });
    const sprites = [
        sprite('folded', -96, 624, 'command'),
        sprite('apron', -256, 576),
        sprite('chatting-at-portal', -798, 602, 'portal'),
        sprite('walking-far', -837, 643),
        sprite('not-a-member', -60, 560, 'command'),
    ];
    const cohort = { type: 'command', center, agentIds: ['folded', 'apron', 'chatting-at-portal', 'walking-far'] };
    const subject = CameraDirector.prototype._cohortSubject.call({}, cohort, sprites);
    assert.deepEqual(subject.ids, ['apron', 'folded']);
    assert.ok(subject.box.minX > -400, 'the Portal is not in the subject box');

    const nobodyThere = CameraDirector.prototype._cohortSubject.call({}, { ...cohort, agentIds: ['walking-far'] }, sprites);
    assert.deepEqual(nobodyThere.ids, []);
    assert.ok(nobodyThere.box.minX <= center.x && nobodyThere.box.maxX >= center.x, 'the building alone');
});

// MB-1 — a 2508 × 1398 window at DPR 1 (the World canvas 2268 × 1350) meets
// wide and medium at z2, so the broadcast's establishing shot was a z2 crop.
// Its wide steps out to the survey, the scale the opening frames the island
// at, and keeps the isle landmarks' crowns: the Belfry is the account instrument.
test('2268×1350 at DPR 1: the Ambient wide is the opening\'s island scale and keeps the Belfry crown (MB-1)', () => {
    assert.deepEqual(scalesFor(2268, 1350, 1), { survey: 1, wide: 2, medium: 2, close: 3 });
    const camera = new Camera(canvasOf(2268, 1350));
    camera.setSpriteMetrics(spriteMetrics);
    const director = new CameraDirector(camera);
    const bodies = [{ x: -400, y: 980 }, { x: 260, y: 1010 }, { x: -60, y: 760 }];
    const options = director._ambientGlideOptions('ambient:wide', {
        paddingPx: 200, composition: { x: 0.5, y: 0.55 }, wide: true, bodies,
    });
    assert.equal(options.minZoom, camera.shotTier('survey'));
    assert.equal(options.maxZoom, camera.shotTier('survey'));
    assert.equal(options.keepLandmarks, true);

    const belfry = camera._landmarkSilhouettes().find((mark) => mark.type === 'prop.hourglassBelfry');
    assert.ok(belfry?.noPlate, 'the isle landmarks are crown-protected, without a plate');
    // The south districts at work (the Forge, the Task Board, the Harbor).
    const box = { minX: -460, maxX: 320, minY: 680, maxY: 1020 };
    const pose = camera._poseForWorldBox(box, options);
    // Camera.establishingShot opens on SURVEY_TIER wherever a survey exists.
    assert.equal(pose.zoom, camera.tierZoom(SURVEY_TIER));
    const view = viewOf(camera, pose);
    const island = islandAreaInWorldRect(view.left, view.top, view.left + view.w, view.top + view.h) / ISLAND_AREA;
    assert.ok(island >= 0.95, `the whole island (${island.toFixed(3)})`);
    assert.ok(markInColumns(view, belfry), 'the Belfry stands in the frame');
    assert.ok(crownY(view, belfry, pose.zoom) >= LANDMARK_EDGE_AIR_PX, `Belfry crown at ${crownY(view, belfry, pose.zoom)} px`);
    for (const body of bodies) assert.ok(bodyWhole(view, body), `body at ${body.x},${body.y}`);
    director.dispose();

    // Where wide and medium differ the wide is unchanged (1251 × 1398 tile).
    const tile = new Camera(canvasOf(1011, 1350));
    const tileDirector = new CameraDirector(tile);
    assert.equal(tileDirector._ambientGlideOptions('ambient:wide', { paddingPx: 200, wide: true }).maxZoom, tile.shotTier('wide'));
    tileDirector.dispose();
});

// MB-1 / D8 — ordinary Auto keeps today's policy (cap, pan, no zoom-in) but no
// longer parks the Belfry under the top edge; a villager it shows whole wins.
test('ordinary Auto keeps landmark crowns whole, never at a whole villager\'s expense (MB-1)', () => {
    const camera = new Camera(canvasOf(2268, 1350));
    camera.setSpriteMetrics(spriteMetrics);
    camera.zoom = camera.tierZoom(1);
    const director = new CameraDirector(camera);
    const belfry = camera._landmarkSilhouettes().find((mark) => mark.type === 'prop.hourglassBelfry');
    // A crowd in the south: the land-weighted rest sat low enough to cut the
    // Belfry's glasses off under the top bar (lane 03's live frame).
    const bodies = [{ x: -411, y: 960 }, { x: 189, y: 960 }, { x: -111, y: 800 }];
    const box = { minX: -461, maxX: 239, minY: 710, maxY: 1010 };
    const options = director._ordinaryGlideOptions(bodies);
    assert.equal(options.keepLandmarks, true);
    assert.equal(options.allowZoomIn, false, 'the Auto policy is unchanged');
    const plain = camera._poseForWorldBox(box, { ...options, keepLandmarks: false });
    assert.ok(crownY(viewOf(camera, plain), belfry, plain.zoom) < 0, 'the plain rest crops the Belfry');
    const kept = camera._poseForWorldBox(box, options);
    assert.equal(kept.zoom, plain.zoom);
    const view = viewOf(camera, kept);
    assert.ok(crownY(view, belfry, kept.zoom) >= LANDMARK_EDGE_AIR_PX, `Belfry crown at ${crownY(view, belfry, kept.zoom)} px`);
    for (const body of bodies) assert.ok(bodyWhole(view, body), `body at ${body.x},${body.y}`);

    // At z2 a villager standing low in the frame holds the pose: the crown
    // may stay cut rather than push that body out.
    camera.zoom = camera.tierZoom(2);
    const low = { x: -40, y: 640 };
    const near = { minX: -140, maxX: 60, minY: 430, maxY: 650 };
    const z2 = camera._poseForWorldBox(near, { ...director._ordinaryGlideOptions([low]), keepLandmarks: false });
    const nudged = camera._landmarkClearPose(z2, near, [low]);
    const lowView = viewOf(camera, nudged);
    assert.ok(bodyWhole(viewOf(camera, z2), low), 'the body starts whole');
    assert.ok(bodyWhole(lowView, low), 'and stays whole');
    assert.ok(crownY(lowView, belfry, nudged.zoom) < LANDMARK_EDGE_AIR_PX, 'the Belfry crown gives way');
    director.dispose();
});
