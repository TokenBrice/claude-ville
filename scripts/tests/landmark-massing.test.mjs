import test from 'node:test';
import assert from 'node:assert/strict';

import { MASSING_LIMITS, massingReport, projectMassing } from '../sprites/massing.mjs';
import { loadSpriteManifest } from '../sprites/manifest-utils.mjs';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { LANDMARK_MASSING } from '../../claudeville/src/config/landmarkMassing.js';

const manifest = loadSpriteManifest();

test('every landmark has a massing entry, and no entry names a landmark that is gone', () => {
    const types = BUILDING_DEFS.map(def => def.type).sort();
    assert.deepEqual(Object.keys(LANDMARK_MASSING).sort(), types);
});

test('a fitted landmark\'s solids stay inside its sprite\'s silhouette (the fitting check)', () => {
    const fitted = BUILDING_DEFS.map(def => def.type).filter(type => LANDMARK_MASSING[type].fitted);
    assert.ok(fitted.includes('command') && fitted.includes('tavern'), 'the two reference fits');
    for (const type of fitted) {
        const report = massingReport(type, { manifest });
        assert.equal(report.pass, true, `${type}: ${report.failures.join('; ')}`);
        // An entry may loosen a limit for itself, with a comment saying what its solids leave out.
        const limits = { ...MASSING_LIMITS, ...LANDMARK_MASSING[type].limits };
        assert.ok(report.numbers.cover >= limits.cover && report.numbers.skylineMean <= limits.skylineMean);
    }
});

test('a coarse or missing mass fails the check, so it cannot be marked fitted by mistake', () => {
    for (const def of BUILDING_DEFS) {
        const entry = LANDMARK_MASSING[def.type];
        if (entry.fitted) continue;
        const report = massingReport(def.type, { manifest });
        assert.equal(report.fitted, false);
        assert.equal(report.pass, false, `${def.type} is not fitted yet and would pass: mark it fitted`);
    }
});

test('solids project the way the engine draws the sprite: plan on the footprint, heights straight up', () => {
    const entry = { anchor: [100, 200] };
    const type = 'tavern';
    const def = BUILDING_DEFS.find(row => row.type === type);
    const [house] = projectMassing(type, entry);
    assert.equal(house.solid.kind, 'gable');
    const [x0, y0] = house.solid.at;
    const column = house.columns[0];
    // The solid's back corner (x0, y0): tiles from the footprint centre at 32 x 16 px a tile.
    const planX = entry.anchor[0] + ((x0 - def.width / 2) - (y0 - def.height / 2)) * 32;
    const planY = entry.anchor[1] + ((x0 - def.width / 2) + (y0 - def.height / 2)) * 16;
    assert.ok(Math.abs(column.plan[0][0] - planX) < 1e-9 && Math.abs(column.plan[0][1] - planY) < 1e-9);
    assert.equal(column.top[0][0], column.plan[0][0]);
    assert.equal(column.plan[0][1] - column.top[0][1], house.solid.eave, 'a point z px high draws z px up');
});
