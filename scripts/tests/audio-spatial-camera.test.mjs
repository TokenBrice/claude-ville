import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BUILDING_WORLD,
    CAMERA_PAN_STEP,
    ISLAND_MAP,
    OPEN_LOWPASS_HZ,
    cameraSnapshot,
    mapPlacement,
    placeCoastFromCamera,
    placeFromCamera,
    samePlacement,
} from '../../claudeville/src/presentation/shared/audio/SpatialField.js';

const W = 1600;
const H = 900;
// A camera whose viewport centre looks at world point (cx, cy).
const lookAt = (cx, cy, zoom = 1) => ({ x: W / (2 * zoom) - cx, y: H / (2 * zoom) - cy, zoom, viewportW: W, viewportH: H, unitZoom: 1 });
const ISLAND_CENTRE = { x: 0, y: 624 };
const UPDATE_SEC = 0.5;
const TAU = 0.25;

test('a still camera places every emitter identically, so the caller writes nothing', () => {
    // Arrive by panning, then stop: one settling write at most, then none.
    let harbor = null;
    let coast = null;
    for (let k = 0; k <= 6; k++) {
        const moving = lookAt(120 - 60 * (6 - k), 700, 1.5);
        harbor = placeFromCamera('harbor', moving, harbor);
        coast = placeCoastFromCamera(moving, coast);
    }
    const camera = lookAt(120, 700, 1.5);
    harbor = placeFromCamera('harbor', camera, harbor);
    coast = placeCoastFromCamera(camera, coast);
    for (let k = 0; k < 20; k++) {
        const nextHarbor = placeFromCamera('harbor', camera, harbor);
        const nextCoast = placeCoastFromCamera(camera, coast);
        assert.ok(samePlacement(nextHarbor, harbor), `harbor moved on update ${k}`);
        assert.ok(samePlacement(nextCoast, coast), `coast moved on update ${k}`);
        harbor = nextHarbor;
        coast = nextCoast;
    }
    assert.equal(harbor.pan, placeFromCamera('harbor', camera).pan, 'the lead is gone once the camera rests');
});

test('an emitter under the camera is centred and a crossing flips its side', () => {
    const harbor = BUILDING_WORLD.harbor;
    assert.equal(placeFromCamera('harbor', lookAt(harbor.x, harbor.y)).pan, 0);
    assert.ok(placeFromCamera('harbor', lookAt(harbor.x - 200, harbor.y)).pan > 0, 'camera left of the harbor: it sounds right');
    assert.ok(placeFromCamera('harbor', lookAt(harbor.x + 200, harbor.y)).pan < 0, 'camera right of the harbor: it sounds left');
    // A world point and a building id are the same emitter.
    assert.ok(samePlacement(placeFromCamera(harbor, lookAt(0, 600)), placeFromCamera({ building: 'harbor' }, lookAt(0, 600))));
    assert.equal(placeFromCamera('nowhere', lookAt(0, 600)), null);
    assert.equal(placeFromCamera('harbor', { x: 0, y: 0, zoom: 1 }), null, 'a camera without a viewport places nothing');
});

// The pan an AudioParam holds at `t` after a list of setTargetAtTime(pan, at, τ) writes.
function paramAt(writes, t, initial) {
    let value = initial;
    let from = null;
    let target = initial;
    const settle = until => (from == null ? value : target + (value - target) * Math.exp(-(until - from) / TAU));
    for (const w of writes) {
        if (w.at > t) break;
        value = settle(w.at);
        from = w.at;
        target = w.pan;
    }
    return settle(t);
}

test('a scripted pan across the Harbor moves its pan through 0 within 0.6 s of the crossing, ≤ 0.2 per update', () => {
    const harbor = BUILDING_WORLD.harbor;
    const zoom = 1;
    // The harbor slides across the screen from x = 0.9 to 0.1 of the viewport in 4 s.
    const halfW = W / (2 * zoom);
    const speed = (0.8 * 2 * halfW) / 4;
    const startX = harbor.x - 0.8 * halfW;
    const crossing = (harbor.x - startX) / speed;
    for (let phase = 0; phase < UPDATE_SEC; phase += 0.05) {
        const writes = [];
        let previous = null;
        for (let t = phase; t <= 4; t += UPDATE_SEC) {
            const placed = placeFromCamera('harbor', lookAt(startX + speed * t, harbor.y, zoom), previous);
            if (previous) assert.ok(Math.abs(placed.pan - previous.pan) <= CAMERA_PAN_STEP + 1e-9);
            if (!samePlacement(placed, previous)) writes.push({ at: t, pan: placed.pan });
            previous = placed;
        }
        const initial = writes[0].pan;
        assert.ok(initial > 0);
        let through = null;
        for (let t = crossing - 1; t <= 4; t += 0.005) {
            if (paramAt(writes, t, initial) <= 0) { through = t; break; }
        }
        assert.ok(through != null, `phase ${phase.toFixed(2)}: the pan never crossed 0`);
        const lag = through - crossing;
        assert.ok(lag <= 0.6, `phase ${phase.toFixed(2)}: the pan crossed 0 ${lag.toFixed(3)} s after the camera`);
    }
});

test('a camera cut glides the pan across the field, never more than 0.2 per update', () => {
    const harbor = BUILDING_WORLD.harbor;
    let placed = placeFromCamera('harbor', lookAt(harbor.x - 2000, harbor.y));
    assert.equal(placed.pan, 0.75);
    const far = lookAt(harbor.x + 2000, harbor.y);
    const pans = [];
    for (let k = 0; k < 10; k++) {
        const next = placeFromCamera('harbor', far, placed);
        assert.ok(Math.abs(next.pan - placed.pan) <= CAMERA_PAN_STEP + 1e-9);
        pans.push(next.pan);
        placed = next;
    }
    assert.equal(pans.at(-1), -0.75);
    assert.equal(pans.at(-2), -0.75, 'it settles, then stays');
});

test('zooming into the Forge makes it present and dry while the far Archive softens', () => {
    const forge = BUILDING_WORLD.forge;
    const survey = lookAt(forge.x, forge.y, 0.5);
    const close = lookAt(forge.x, forge.y, 3);
    const forgeFar = placeFromCamera('forge', survey);
    const forgeNear = placeFromCamera('forge', close);
    assert.equal(forgeNear.gain, 1);
    assert.equal(forgeNear.air, 0.12);
    assert.ok(forgeNear.lowpassHz > forgeFar.lowpassHz && forgeNear.lowpassHz <= OPEN_LOWPASS_HZ);
    assert.ok(forgeNear.air <= forgeFar.air);
    const archiveFar = placeFromCamera('archive', survey);
    const archiveNear = placeFromCamera('archive', close);
    assert.ok(archiveNear.gain < archiveFar.gain);
    assert.ok(archiveNear.lowpassHz < archiveFar.lowpassHz);
    assert.ok(archiveNear.air > archiveFar.air);
    assert.ok(archiveNear.pan < 0 && Math.abs(archiveNear.pan) <= 0.75);
});

test('the coast is centred when the whole island is in view and leans toward the near shore', () => {
    const wide = placeCoastFromCamera(lookAt(ISLAND_CENTRE.x, ISLAND_CENTRE.y, 0.5));
    assert.ok(Math.abs(wide.pan) < 0.05, `survey coast pan ${wide.pan}`);
    // The east shore (tile x = 39) is on the right of a camera near it.
    const east = placeCoastFromCamera(lookAt(900, 624, 2));
    assert.ok(east.pan > 0.2, `east shore pan ${east.pan}`);
    // Deep inland and zoomed in, the shore is far but never below −6 dB.
    const inland = placeCoastFromCamera(lookAt(ISLAND_CENTRE.x, ISLAND_CENTRE.y, 3));
    assert.ok(inland.gain >= 0.5 && inland.gain < wide.gain);
    assert.ok(inland.lowpassHz >= 2000 && inland.lowpassHz < wide.lowpassHz);
});

test('the listener ignores the idle drift and the Dashboard keeps the island map', () => {
    const camera = {
        x: 108, y: -20, zoom: 2, _displayPixelZoomScale: 2,
        _idleDrift: { baseX: 100, baseY: -12 },
        _viewportWidth: () => W,
        _viewportHeight: () => H,
    };
    assert.deepEqual(cameraSnapshot(camera), { x: 100, y: -12, zoom: 2, viewportW: W, viewportH: H, unitZoom: 2 });
    assert.equal(cameraSnapshot({ ...camera, _viewportWidth: () => 0 }), null);
    // Tier 1 on a 2× display hears like tier 1 on a 1× one.
    const tierOne = { x: 100, y: -12, zoom: 1, viewportW: W / 2, viewportH: H / 2, unitZoom: 1 };
    assert.ok(samePlacement(placeFromCamera('forge', cameraSnapshot(camera)), placeFromCamera('forge', tierOne)));

    const dash = mapPlacement('harbor');
    assert.deepEqual(dash, { pan: ISLAND_MAP.harbor, lowpassHz: OPEN_LOWPASS_HZ, gain: 1, air: 0.18 });
});
