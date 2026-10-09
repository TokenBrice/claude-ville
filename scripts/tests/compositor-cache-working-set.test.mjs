import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compositor } from '../../claudeville/src/presentation/character-mode/Compositor.js';

function compositorWith(entries) {
    const compositor = Object.create(Compositor.prototype);
    Object.assign(compositor, { cache: new Map(), cacheUsedAt: new Map(), cachePixels: 0 });
    for (const [key, pixels, ageMs] of entries) {
        compositor.cache.set(key, { width: pixels, height: 1 });
        compositor.cacheUsedAt.set(key, performance.now() - ageMs);
        compositor.cachePixels += pixels;
    }
    return compositor;
}

// Nine idle agents with distinct robe variants each sample a 1.7 Mpx action
// strip every frame; trimming that set rebaked and re-uploaded every strip
// on every frame (4 FPS in the many-waiting scenario).
test('the compositor never trims composites drawn within the hot window', () => {
    const strips = Array.from({ length: 9 }, (_, i) => [`strip|${i}`, 1_692_800, 0]);
    const compositor = compositorWith(strips);
    compositor._trimCache();
    assert.equal(compositor.cache.size, 9);
    assert.equal(compositor.cachePixels, 9 * 1_692_800);
});

test('the compositor trims cold composites oldest first down to its limits', () => {
    const compositor = compositorWith([
        ['cold-a', 6_000_000, 60_000],
        ['cold-b', 6_000_000, 30_000],
        ['hot', 6_000_000, 0],
    ]);
    compositor._trimCache();
    assert.deepEqual([...compositor.cache.keys()], ['cold-b', 'hot']);
    assert.deepEqual([...compositor.cacheUsedAt.keys()], ['cold-b', 'hot']);
    assert.equal(compositor.cachePixels, 12_000_000);
});
