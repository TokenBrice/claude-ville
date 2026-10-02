import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

function renderer() {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        _pairBuckets: new Map(),
        _pairColumnPool: [],
        _pairBucketPool: [],
        _pairIds: new Map(),
        _pairIdentityRanks: new Map(),
        _pairDuplicatePairs: new Map(),
    });
}

// Reference the established first-encounter semantics independently of bucket
// ranks. Orientation and order are observable because steering mutates bodies.
function referencePairs(host, sprites, size, visitor) {
    const buckets = new Map();
    const ids = new Map();
    const visited = new Set();
    for (let index = 0; index < sprites.length; index++) {
        const sprite = sprites[index];
        if (!sprite) continue;
        ids.set(sprite, host._spriteStableId(sprite, index));
        const key = `${Math.floor(sprite.x / size)},${Math.floor(sprite.y / size)}`;
        const bucket = buckets.get(key) || [];
        bucket.push(sprite);
        buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets) {
        const [cx, cy] = key.split(',').map(Number);
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                const other = buckets.get(`${cx + ox},${cy + oy}`);
                if (!other) continue;
                for (const a of bucket) {
                    for (const b of other) {
                        if (a === b) continue;
                        const idA = ids.get(a);
                        const idB = ids.get(b);
                        if (!idA || !idB || idA === idB) continue;
                        const pair = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
                        if (visited.has(pair)) continue;
                        visited.add(pair);
                        if (visitor(a, b) === false) return false;
                    }
                }
            }
        }
    }
    return true;
}

function collect(run, sprites, size, stopAfter = Infinity) {
    const pairs = [];
    const complete = run(sprites, size, (a, b) => {
        pairs.push([a, b]);
        if (pairs.length === stopAfter) return false;
    });
    return { pairs, complete };
}

const sprite = (id, x, y) => ({ agent: { id }, x, y });

test('nearby pairs retain bucket insertion order, neighbor order, and oriented triangular order', () => {
    const host = renderer();
    const a = sprite('a', 48, 48);
    const b = sprite('b', 49, 49);
    const left = sprite('left', 0, 48);
    const aboveLeft = sprite('above-left', 0, 0);
    const above = sprite('above', 48, 0);
    const far = sprite('far', 240, 240);
    const sprites = [a, left, b, above, aboveLeft, far];
    assert.deepEqual(collect(host._forEachNearbySpritePair.bind(host), sprites, 48), {
        complete: true,
        pairs: [
            [a, aboveLeft], [b, aboveLeft],
            [a, left], [b, left],
            [a, above], [b, above], [a, b],
            [left, aboveLeft], [left, above], [above, aboveLeft],
        ],
    });
});

test('pair ordering and early stop match first encounter across sparse, dense, and reused grids', () => {
    const host = renderer();
    const fast = host._forEachNearbySpritePair.bind(host);
    const reference = (sprites, size, visitor) => referencePairs(host, sprites, size, visitor);
    for (const count of [100, 9, 140, 0, 37]) {
        for (const size of [16, 48, 71]) {
            const sprites = Array.from({ length: count }, (_, index) => sprite(
                `agent-${index}`,
                (index * 113 % 1800) - 900,
                (index * 79 % 1000) - 500,
            ));
            assert.deepEqual(collect(fast, sprites, size), collect(reference, sprites, size));
            assert.deepEqual(collect(fast, sprites, size, 3), collect(reference, sprites, size, 3));
        }
    }
    const dense = Array.from({ length: 100 }, (_, index) => sprite(`dense-${index}`, index % 7, index % 11));
    assert.deepEqual(collect(fast, dense, 48), collect(reference, dense, 48));
});

test('missing entries, repeated sprites, and repeated identities keep the first oriented pair only', () => {
    const host = renderer();
    const a = sprite('a', 0, 0);
    const duplicateA = sprite('a', 49, 0);
    const b = sprite('b', 1, 1);
    const c = sprite('c', 50, 1);
    const anonymous = { x: 2, y: 2 };
    const sprites = [null, a, b, a, duplicateA, c, anonymous, anonymous];
    const reference = (sprites, size, visitor) => referencePairs(host, sprites, size, visitor);
    assert.deepEqual(
        collect(host._forEachNearbySpritePair.bind(host), sprites, 48),
        collect(reference, sprites, 48),
    );
});
