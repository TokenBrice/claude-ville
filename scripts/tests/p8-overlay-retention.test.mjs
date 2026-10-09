import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

function rendererHost() {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer._overlayNameGrid = renderer._createRectGrid();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    return renderer;
}

test('a new grid frame releases items in cells that are never revisited', () => {
    const renderer = rendererHost();
    const grid = renderer._overlayNameGrid;
    const rect = { x: 0, y: 0, w: 300, h: 300 };
    const departed = { rect };
    renderer._beginRectGridFrame(grid);
    renderer._insertRectGridItem(grid, rect, departed);
    renderer._insertRectGridItem(grid, rect, departed);
    assert.equal(renderer._firstRectGridOverlap(grid, rect), departed);
    const buckets = [...grid.buckets.values()];
    const touched = grid.touchedBuckets;

    renderer._beginRectGridFrame(grid);
    renderer._insertRectGridItem(grid, { x: 10000, y: 10000, w: 1, h: 1 });
    assert.equal(renderer._firstRectGridOverlap(grid, rect), null);
    assert.equal(renderer._rectGridHasOverlap(grid, rect), false);
    for (const bucket of buckets) assert.deepEqual(bucket.items, []);
    assert.equal(grid.seen.has(departed), false);
    assert.equal(grid.touchedBuckets, touched);
});

test('shrinking clusters release departed members when spatial layout switches off', () => {
    const renderer = rendererHost();
    const sprites = ['a', 'b', 'c'].map(id => ({
        agent: { id },
        _activitySnapshot: { text: 'Working', accent: '#ffffff' },
        _statusThread: [{ text: 'Working', accent: '#ffffff' }],
        bubbleMergedCount: 1,
        bubbleMergedInto: null,
    }));
    const rects = [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 1000, y: 1000, w: 10, h: 10 },
    ];
    renderer._mergeIdenticalClusterBubbles(sprites, rects, true);
    assert.equal(sprites[0].bubbleMergedCount, 2);
    assert.equal(sprites[1].bubbleMergedInto, sprites[0]);
    const spareCluster = renderer._overlayBubbleClusters[1];

    renderer._mergeIdenticalClusterBubbles([sprites[0]], [rects[0]], false);
    assert.deepEqual(spareCluster.members, []);
    assert.equal(renderer._overlayBubbleClusterCount, 1);
    for (const bucket of renderer._overlayClusterGrid.buckets.values()) {
        assert.deepEqual(bucket.items, []);
    }
    assert.equal(renderer._overlayBubbleGroups.size, 0);

    renderer._mergeIdenticalClusterBubbles([], [], false);
    for (const cluster of renderer._overlayBubbleClusters) assert.deepEqual(cluster.members, []);
    renderer._mergeIdenticalClusterBubbles([sprites[2]], [rects[2]], true);
    assert.deepEqual(renderer._overlayBubbleClusters[0].members, [sprites[2]]);
});
