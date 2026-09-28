import test from 'node:test';
import assert from 'node:assert/strict';

import { VillageDirector } from '../../claudeville/src/presentation/character-mode/VillageDirector.js';

function scene(index, now, type = 'incident') {
    return {
        id: `scene-${index}`,
        type,
        kind: `kind-${index}`,
        label: `Scene ${index}`,
        startedAt: now,
        expiresAt: now + 10_000,
    };
}

test('keeps eight render scenes and drops the least salient first', () => {
    const director = new VillageDirector({ buildings: new Map() });
    const now = Date.now();
    for (let index = 0; index < 8; index++) director._addScene(scene(index, now, 'lifecycle'));
    for (let index = 8; index < 11; index++) director._addScene(scene(index, now));

    const snapshot = director.update(null, 16, now);
    assert.equal(director.scenes.length, 8);
    assert.equal(snapshot.activeSceneCount, 8);
    assert.equal(director.scenes.filter(item => item.type === 'incident').length, 3);
    assert.equal(director.getStats().sceneDrops, 3);
    director.dispose();
});
