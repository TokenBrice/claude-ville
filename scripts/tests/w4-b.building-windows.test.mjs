import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { PNG } from 'pngjs';

import {
    BUILDING_VISUAL_REGISTRY,
    getBuildingDoorSpillDescriptor,
    getBuildingWindowRects,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';

test('mine and portal windows stay inside their native sprite dimensions', () => {
    for (const type of ['mine', 'portal']) {
        const visual = BUILDING_VISUAL_REGISTRY[type];
        assert.ok(visual.windowRects.length >= 2 && visual.windowRects.length <= 4);
        for (const rect of visual.windowRects) {
            const [x, y] = rect.at;
            assert.ok(x - rect.w / 2 >= 0, `${type} window crosses the left edge`);
            assert.ok(x + rect.w / 2 <= visual.nativeSize.w, `${type} window crosses the right edge`);
            assert.ok(y - rect.h / 2 >= 0, `${type} window crosses the top edge`);
            assert.ok(y + rect.h / 2 <= visual.nativeSize.h, `${type} window crosses the bottom edge`);
        }
    }
});

// Window rects are art-coupled and move whenever a sprite is re-authored, so
// the contract is not their literal values: each lit window must sit on the
// building's own opaque art (a stamp over empty canvas lights thin air) and
// inside its native canvas.
function loadBaseArt(type) {
    const manifest = yaml.load(readFileSync(new URL('../../claudeville/assets/sprites/manifest.yaml', import.meta.url), 'utf8'));
    const entry = manifest.buildings.find((building) => building.id === `building.${type}`);
    const png = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/buildings/building.${type}/base.png`, import.meta.url)));
    return { entry, png };
}

test('every calibrated window sits on its building\'s opaque art', () => {
    for (const [type, visual] of Object.entries(BUILDING_VISUAL_REGISTRY)) {
        const { entry, png } = loadBaseArt(type);
        assert.equal(png.width, entry.width, `${type} manifest width matches base.png`);
        assert.equal(png.height, entry.height, `${type} manifest height matches base.png`);
        const alphaAt = (x, y) => png.data[(y * png.width + x) * 4 + 3];
        for (const rect of visual.windowRects) {
            const [cx, cy] = rect.at;
            const left = Math.round(cx - rect.w / 2);
            const top = Math.round(cy - rect.h / 2);
            assert.ok(left >= 0 && top >= 0 && left + rect.w <= png.width && top + rect.h <= png.height,
                `${type} window ${cx},${cy} leaves the canvas`);
            let opaque = 0;
            for (let y = top; y < top + rect.h; y++) {
                for (let x = left; x < left + rect.w; x++) if (alphaAt(x, y) >= 128) opaque++;
            }
            assert.ok(alphaAt(Math.round(cx), Math.round(cy)) >= 128, `${type} window ${cx},${cy} is centred off the art`);
            assert.ok(opaque >= rect.w * rect.h * 0.6, `${type} window ${cx},${cy} is mostly off the art`);
        }
    }
});

test('calibrated windows never select the legacy radial warmth fallback', () => {
    for (const [type, visual] of Object.entries(BUILDING_VISUAL_REGISTRY)) {
        assert.ok(visual.windowRects?.length, `${type} has no calibrated windows`);
        assert.strictEqual(getBuildingWindowRects(type), visual.windowRects, type);
    }
});

test('door spill is zero when empty and scales monotonically with occupancy', () => {
    for (const type of ['mine', 'portal']) {
        const alphaAt = (occupancy) => getBuildingDoorSpillDescriptor(type, {
            occupancy,
            beaconIntensity: 0.8,
            weatherWetness: 0.6,
        }).alpha;
        const samples = [0, 0.25, 0.5, 0.75, 1].map(alphaAt);
        assert.equal(samples[0], 0, type);
        for (let i = 1; i < samples.length; i++) {
            assert.ok(samples[i] >= samples[i - 1], `${type} spill fell at sample ${i}`);
        }
    }
});

test('reduced motion keeps door spill alpha static with no animation phase', () => {
    const options = {
        occupancy: 0.7,
        beaconIntensity: 0.8,
        weatherWetness: 0.4,
        atmosphereWarmth: 0.9,
    };
    const descriptor = getBuildingDoorSpillDescriptor('portal', options);
    const reducedMotion = getBuildingDoorSpillDescriptor('portal', {
        ...options,
        reducedMotion: true,
    });
    assert.deepEqual(reducedMotion, descriptor);
    assert.equal(reducedMotion.staticAlpha, true);
    assert.equal('phase' in reducedMotion, false);
    assert.equal('pulse' in reducedMotion, false);
});

test('portal rune light stays distinct from mine fire', () => {
    assert.notEqual(BUILDING_VISUAL_REGISTRY.portal.windowColor, BUILDING_VISUAL_REGISTRY.mine.windowColor);
    assert.notEqual(BUILDING_VISUAL_REGISTRY.portal.doorSpill.color, BUILDING_VISUAL_REGISTRY.mine.doorSpill.color);
});
