import test from 'node:test';
import assert from 'node:assert/strict';

import { HEARTH_FIXTURES, hearthLightSources } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';

test('hearths stand outside every work building and light only on the lamps gate', () => {
    assert.ok(HEARTH_FIXTURES.length >= 3);
    for (const hearth of HEARTH_FIXTURES) {
        for (const def of BUILDING_DEFS) {
            const inside = hearth.tileX >= def.x && hearth.tileX < def.x + def.width
                && hearth.tileY >= def.y && hearth.tileY < def.y + def.height;
            assert.ok(!inside, `${hearth.id} inside ${def.type}`);
        }
        assert.ok(!BUILDING_DEFS.some((def) => hearth.id.includes(def.type)), hearth.id);
    }
    // No agent input exists: an empty village at night lights exactly the hearths.
    assert.deepEqual(hearthLightSources({ lampsLit: false }), []);
    const lit = hearthLightSources({ lampsLit: true, core: 1 });
    assert.deepEqual(lit.map((light) => light.id), HEARTH_FIXTURES.map((row) => row.id));
    for (const light of lit) {
        assert.equal(light.role, 'fixture');
        assert.equal(light.fire, false);
    }
});
