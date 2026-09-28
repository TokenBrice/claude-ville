import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LIGHT_ROLE_CODES,
    LIGHT_TILE_PX,
    LIGHT_TILE_SLOTS,
    LIGHT_TILE_STRIDE,
    WATER_COLUMN_REACH,
    binGpuLights,
    clampGpuLights,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

// A feed slot as PostFxFeed builds it: world foot, ground radius, emitter
// height and the V5 role code.
function light(id, footX, footY, { role = 'point', radius = 40, height = 16, priority = 0, intensity = 1 } = {}) {
    return {
        id,
        x: footX,
        y: footY,
        footX,
        footY,
        radiusWorld: radius,
        height,
        role: LIGHT_ROLE_CODES[role],
        attention: role === 'attention',
        priority,
        intensity,
    };
}

// Backing store 1024x640 at scale 1, camera at the world origin, so a world
// point (x, y) is backing px (x, y).
const VIEW = { cameraX: 0, cameraY: 0, scale: 1, width: 1024, height: 640 };

// The light indices the clustered walk visits for the fragment at backing px
// (x, y): the tile's count, then that many slots.
function tileWalk(bins, x, y) {
    const tile = Math.floor(y / LIGHT_TILE_PX) * bins.tilesX + Math.floor(x / LIGHT_TILE_PX);
    const base = tile * LIGHT_TILE_STRIDE;
    const count = bins.index[base];
    return Array.from(bins.index.subarray(base + 1, base + 1 + count));
}

test('admission ranks attention > aperture > fixture > point before priority', () => {
    const lights = [
        light('point', 100, 300, { priority: 99, intensity: 9 }),
        light('fixture', 300, 300, { role: 'fixture', priority: 5 }),
        light('aperture', 500, 300, { role: 'aperture', priority: 0 }),
        light('attention', 700, 300, { role: 'attention', priority: -5 }),
    ];
    const ranked = clampGpuLights(lights, 64, 64);
    assert.deepEqual(ranked.map(l => l.id), ['attention', 'aperture', 'fixture', 'point']);

    // A count of two admits the first two in that order and nothing else.
    const bins = binGpuLights(ranked, { ...VIEW, cap: 2 });
    assert.deepEqual(bins.admitted.map(l => l.id), ['attention', 'aperture']);
    assert.equal(bins.overCap, 2);

    // An attention light is admitted past a zero count; the others are not.
    const none = binGpuLights(ranked, { ...VIEW, cap: 0 });
    assert.deepEqual(none.admitted.map(l => l.id), ['attention']);
});

test('a full tile rejects later lights there but not elsewhere on screen', () => {
    const crowd = Array.from({ length: LIGHT_TILE_SLOTS + 4 }, (_, i) => light(`p${String(i).padStart(2, '0')}`, 200, 320));
    const far = light('far', 900, 330);
    const ranked = clampGpuLights([...crowd, far], 256, 256);
    const bins = binGpuLights(ranked, { ...VIEW, cap: 128 });
    assert.equal(bins.tileFull, 4);
    assert.equal(bins.maxPerTile, LIGHT_TILE_SLOTS);
    assert.ok(bins.admitted.some(l => l.id === 'far'), 'a light in free tiles is still admitted');
    // The first sixteen in rank order win the crowded tiles.
    const admittedCrowd = bins.admitted.filter(l => l.id !== 'far').map(l => l.id);
    assert.deepEqual(admittedCrowd, crowd.slice(0, LIGHT_TILE_SLOTS).map(l => l.id));

    // An attention light standing in the crowd ranks first, so it keeps a
    // slot and one crowd light more is turned away.
    const withAttention = clampGpuLights([...crowd, light('attention:a', 200, 320, { role: 'attention' })], 256, 256);
    const bins2 = binGpuLights(withAttention, { ...VIEW, cap: 128 });
    assert.equal(bins2.admitted[0].id, 'attention:a');
    assert.equal(bins2.admitted.length, LIGHT_TILE_SLOTS);
    assert.equal(bins2.tileFull, 5);
});

test('lights off the backing store are culled, not admitted', () => {
    const ranked = clampGpuLights([light('on', 400, 300), light('off', 4000, 300)], 64, 64);
    const bins = binGpuLights(ranked, { ...VIEW, cap: 64 });
    assert.deepEqual(bins.admitted.map(l => l.id), ['on']);
    assert.equal(bins.culled, 1);
});

test('the clustered walk visits every admitted light wherever it can light, in admission order', () => {
    // A deterministic scatter of every role, with columns and tall facades.
    const roles = ['point', 'aperture', 'fixture', 'attention'];
    const lights = [];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 90; i++) {
        lights.push(light(`l${i}`, Math.round(rand() * 1100 - 40), Math.round(rand() * 720 - 40), {
            role: roles[i % 4],
            radius: 24 + Math.round(rand() * 80),
            height: Math.round(rand() * 100),
            priority: Math.round(rand() * 4),
        }));
    }
    const ranked = clampGpuLights(lights, 256, 256);
    const bins = binGpuLights(ranked, { ...VIEW, cap: 48 });
    assert.ok(bins.admitted.length > 20, `${bins.admitted.length} admitted`);
    const slotOf = new Map(bins.admitted.map((l, slot) => [l, slot]));

    // Points each admitted light certainly reaches: its foot, its pool's rim
    // on the ground either side, a wall pixel at its own height above the
    // foot, and for an aperture or fixture its water column's last row.
    for (const l of bins.admitted) {
        const slot = slotOf.get(l);
        const points = [
            [l.footX, l.footY],
            [l.footX - l.radiusWorld + 1, l.footY],
            [l.footX + l.radiusWorld - 1, l.footY],
            [l.footX, l.footY - l.height],
        ];
        if (l.role === LIGHT_ROLE_CODES.aperture || l.role === LIGHT_ROLE_CODES.fixture) {
            points.push([l.footX, l.footY + WATER_COLUMN_REACH * l.radiusWorld - 1]);
        }
        for (const [x, y] of points) {
            if (x < 0 || y < 0 || x >= VIEW.width || y >= VIEW.height) continue;
            assert.ok(tileWalk(bins, x, y).includes(slot), `${l.id} missing from the tile at ${x},${y}`);
        }
    }
    // Each tile walks its lights in admission order, and only admitted ones:
    // the clustered walk is the flat walk restricted to the tile.
    for (let ty = 0; ty < bins.tilesY; ty++) {
        for (let tx = 0; tx < bins.tilesX; tx++) {
            const walk = tileWalk(bins, tx * LIGHT_TILE_PX, ty * LIGHT_TILE_PX);
            assert.ok(walk.length <= LIGHT_TILE_SLOTS);
            for (let k = 0; k < walk.length; k++) {
                assert.ok(walk[k] < bins.admitted.length);
                if (k > 0) assert.ok(walk[k] > walk[k - 1], `tile ${tx},${ty} out of order`);
            }
        }
    }
});
