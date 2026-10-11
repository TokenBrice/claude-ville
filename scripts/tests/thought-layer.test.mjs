import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import {
    createThoughtColumn, layoutThoughtColumn, needsConfidenceMark,
    THOUGHT_CANDIDATE_COUNT, THOUGHT_CANDIDATE_SLOT, THOUGHT_CANDIDATE_LATERAL,
} from '../../claudeville/src/presentation/character-mode/ThoughtColumn.js';

function rendererHost() {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = { zoom: 1 };
    renderer._overlayBubbleOrder = [];
    renderer._overlayBubbleBaseRects = [];
    renderer._overlayBubbleOccupiedRects = [];
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    return renderer;
}

function entry(text) {
    return { text, accent: '#f2d36b', confidence: null, shape: 'speech', badge: '' };
}

function speakingSprite(id, thread = [entry('Checking the renderer')], options = {}) {
    return {
        agent: { id, name: 'Atlas', status: 'working' },
        x: options.x ?? 100, y: 200, selected: false, addedAt: -60000,
        _dialogueDisplayUntil: options.fresh ?? 0,
        _activitySnapshot: thread[0],
        _activityThread: () => thread,
        _shouldUseLongWaitClock: () => false,
        thoughtRepoAccent: () => options.repo ?? '#77aa88',
        thoughtSpeakerTag: () => options.tag ?? 'ATL',
        _providerTrimColor: () => options.trim ?? '#ffffff',
        _statusVisual: () => ({ color: '#f2d36b' }),
    };
}

function assign(renderer, sprites, labels = [], useGrid = false, now = 1000) {
    renderer._assignAgentBubbleSlots(sprites, 1, labels, useGrid ? null : false, now);
}

// Mirrors IsometricRenderer's THOUGHT_BUDGET and THOUGHT_MIN_SEAT_MS.
const BUDGET = 8;
const MIN_SEAT_MS = 4000;

function placedIds(sprites) {
    return sprites.filter(sprite => sprite.bubbleSlot != null).map(sprite => sprite.agent.id);
}

for (const useGrid of [false, true]) {
    test(`only a focused speaker overlaps; a blocked crowd is filtered (${useGrid ? 'grid' : 'linear'})`, () => {
        const renderer = rendererHost();
        const speakers = Array.from({ length: THOUGHT_CANDIDATE_COUNT + 5 }, (_, i) =>
            speakingSprite(`speaker-${String(i).padStart(2, '0')}`, [entry(`Thought ${String(i).padStart(2, '0')}`)]));
        const focused = speakers[7];
        focused.selected = true;
        // Every candidate is blocked, not just the home slot.
        const blocker = { x: -10000, y: -10000, w: 20000, h: 20000 };
        const probe = speakingSprite('probe', focused._activityThread());
        assert.equal(renderer._prepareThought(probe, 1), true);
        let leastArea = Infinity;
        let leastIndex = -1;
        for (let index = 0; index < THOUGHT_CANDIDATE_COUNT; index++) {
            const rects = renderer._thoughtCandidateRects(probe, index, 1);
            assert.equal(renderer._thoughtRectsCollide(rects, null, [blocker], false), true);
            const area = renderer._thoughtOverlapArea(rects, null, [blocker], false);
            if (area < leastArea) {
                leastArea = area;
                leastIndex = index;
            }
        }
        assign(renderer, speakers, [blocker], useGrid);
        assert.equal(focused._bubbleCandidate, leastIndex);
        assert.equal(focused.bubbleSlot, THOUGHT_CANDIDATE_SLOT[leastIndex]);
        assert.equal(focused.bubbleLateral, THOUGHT_CANDIDATE_LATERAL[leastIndex] * focused._thoughtSide);
        assert.equal(focused._thoughtFiltered, false);
        for (const sprite of speakers) {
            if (sprite === focused) continue;
            assert.equal(sprite.bubbleSlot, null, `${sprite.agent.id} overlapped the blocker`);
            assert.equal(sprite._thoughtFiltered, true);
        }
    });
}

test('the budget admits the freshest lines first', () => {
    const renderer = rendererHost();
    const speakers = Array.from({ length: BUDGET + 4 }, (_, i) =>
        speakingSprite(`s${String(i).padStart(2, '0')}`, [entry(`Line ${i}`)], { x: i * 1000, fresh: 1000 + i }));
    assign(renderer, speakers);
    const expected = speakers.slice(4).map(sprite => sprite.agent.id);
    assert.deepEqual(placedIds(speakers).sort(), expected.sort());
    for (const sprite of speakers.slice(0, 4)) assert.equal(sprite._thoughtFiltered, true);
});

test('a seated column holds its seat against fresher lines for the seat hold', () => {
    const renderer = rendererHost();
    const seated = Array.from({ length: BUDGET }, (_, i) =>
        speakingSprite(`seated-${i}`, [entry(`Line ${i}`)], { x: i * 1000, fresh: 1000 + i }));
    assign(renderer, seated, [], false, 1000);
    assert.equal(placedIds(seated).length, BUDGET);
    const newcomer = speakingSprite('newcomer', [entry('A fresher line')], { x: 50_000, fresh: 9000 });
    const all = [...seated, newcomer];
    assign(renderer, all, [], false, 1000 + MIN_SEAT_MS - 1);
    assert.equal(newcomer.bubbleSlot, null);
    assert.equal(newcomer._thoughtFiltered, true);
    // Past the hold the freshest lines win: the stalest seat goes.
    assign(renderer, all, [], false, 1000 + MIN_SEAT_MS);
    assert.notEqual(newcomer.bubbleSlot, null);
    assert.equal(seated[0].bubbleSlot, null);
    assert.equal(placedIds(all).length, BUDGET);
});

test('older lines are drawn only in a calm scene or for the focused speaker', () => {
    const thread = () => [entry('Head line'), entry('Earlier line'), entry('Oldest line')];
    const calm = Array.from({ length: 4 }, (_, i) => speakingSprite(`calm-${i}`, thread(), { x: i * 1000 }));
    let renderer = rendererHost();
    assign(renderer, calm);
    for (const sprite of calm) assert.equal(sprite._thoughtColumn.rows, 3);

    const crowd = Array.from({ length: 5 }, (_, i) => speakingSprite(`crowd-${i}`, thread(), { x: i * 1000 }));
    crowd[2].hovered = true;
    renderer = rendererHost();
    assign(renderer, crowd);
    for (const sprite of crowd) {
        assert.equal(sprite._thoughtColumn.rows, sprite === crowd[2] ? 3 : 1);
        assert.equal(sprite._thoughtHistoryLimit, sprite === crowd[2] ? 2 : 0);
    }
});

for (const length of [1, 2, 3]) {
    test(`reservation matches painted column height for ${length} thread rows`, () => {
        const renderer = rendererHost();
        const thread = Array.from({ length }, (_, i) => entry(`Thought row ${i}`));
        const sprite = speakingSprite('geometry', thread);
        for (const scale of [1, 0.5, 2]) {
            assert.equal(renderer._prepareThought(sprite, scale), true);
            for (const candidate of [0, 1, 3]) {
                const rects = renderer._thoughtCandidateRects(sprite, candidate, scale);
                const tagLength = THOUGHT_CANDIDATE_LATERAL[candidate] === 0 ? 0 : 3;
                const painted = layoutThoughtColumn(createThoughtColumn(), thread, false, true, tagLength);
                assert.equal(painted.rows, length);
                assert.equal(painted.height, [28, 45, 62][length - 1]);
                assert.equal(rects.body.h, painted.height * scale);
                assert.equal(rects.body.w, painted.width * scale);
                assert.equal(rects.body.y, sprite.bubbleBaseY + (painted.top - THOUGHT_CANDIDATE_SLOT[candidate] * 24) * scale);
            }
        }
    });
}

function assertSeparate(first, second) {
    const renderer = rendererHost();
    // Close enough to share a merge cluster, far enough for both to fit.
    second.x = first.x + 60;
    renderer._prepareThought(first, 1);
    renderer._prepareThought(second, 1);
    assert.notEqual(renderer._bubbleMergeKey(first), renderer._bubbleMergeKey(second));
    assign(renderer, [first, second]);
    for (const sprite of [first, second]) {
        assert.equal(sprite.bubbleMergedInto, null);
        assert.equal(sprite.bubbleMergedCount, 1);
        assert.notEqual(sprite.bubbleSlot, null);
    }
}

test('same head with different history keeps both complete threads', () => {
    assertSeparate(
        speakingSprite('a', [entry('Same head'), entry('Earlier test')]),
        speakingSprite('b', [entry('Same head'), entry('Earlier edit')]),
    );
});

test('same head with different repo pennants keeps both speakers', () => {
    assertSeparate(
        speakingSprite('a', [entry('Same head')], { repo: '#ff0000' }),
        speakingSprite('b', [entry('Same head')], { repo: '#0000ff' }),
    );
});

test('different painted history fallback strokes keep both speakers', () => {
    assertSeparate(
        speakingSprite('a', [entry('Same head'), { ...entry('Same history'), accent: null }], { trim: '#ff0000' }),
        speakingSprite('b', [entry('Same head'), { ...entry('Same history'), accent: null }], { trim: '#0000ff' }),
    );
});

test('different speaker tags cannot merge identical wording', () => {
    assertSeparate(
        speakingSprite('a', [entry('Same head')], { tag: 'ATL' }),
        speakingSprite('b', [entry('Same head')], { tag: 'SOL' }),
    );
});

for (const useGrid of [false, true]) {
    test(`identical complete threads and attribution merge losslessly (${useGrid ? 'grid' : 'linear'})`, () => {
        const renderer = rendererHost();
        const thread = [entry('Same head'), entry('Same earlier line'), entry('Same oldest line')];
        const first = speakingSprite('a', thread);
        const second = speakingSprite('b', thread.map(row => ({ ...row })));
        assign(renderer, [second, first], [], useGrid);
        assert.equal(renderer._bubbleMergeKey(first), renderer._bubbleMergeKey(second));
        assert.equal(first.bubbleMergedCount, 2);
        assert.equal(second.bubbleMergedInto, first);
        assert.notEqual(first.bubbleSlot, null);
        assert.equal(second.bubbleSlot, null);
        assert.equal(first._thoughtColumn.rows, 3);
        assert.ok(first._thoughtColumn.countWidth > 0);
    });
}

test('committed candidate stays free across frames and waits for a persistent collision', () => {
    const renderer = rendererHost();
    const sprite = speakingSprite('sticky');
    assign(renderer, [sprite], [], false, 1000);
    const committed = sprite._bubbleCandidate;
    assert.equal(committed, 0);
    for (const now of [1016, 1500, 5000, 10000]) {
        assign(renderer, [sprite], [], false, now);
        assert.equal(sprite._bubbleCandidate, committed);
        assert.equal(sprite._bubbleBlockedSince, 0);
    }
    const home = renderer._thoughtCandidateRects(sprite, committed, 1).body;
    // Leave the leader's landing free so re-search has a collision-free exit.
    const blocker = { x: home.x + 1, y: home.y + 1, w: 1, h: 1 };
    for (const now of [11000, 11100, 11299]) {
        assign(renderer, [sprite], [blocker], false, now);
        assert.equal(sprite._bubbleCandidate, committed);
        assert.equal(sprite._bubbleBlockedSince, 11000);
    }
    assign(renderer, [sprite], [blocker], false, 11301);
    assert.notEqual(sprite._bubbleCandidate, committed);
    assert.equal(sprite._bubbleBlockedSince, 0);
    assert.equal(renderer._thoughtRectsCollide(sprite._thoughtRects, null, [blocker], false), false);
});

test('a brief collision does not accumulate toward a later re-search', () => {
    const renderer = rendererHost();
    const sprite = speakingSprite('brief-crossing');
    assign(renderer, [sprite], [], false, 1000);
    const blocker = { ...sprite._thoughtRects.body };
    assign(renderer, [sprite], [blocker], false, 1100);
    assign(renderer, [sprite], [], false, 1300);
    assert.equal(sprite._bubbleBlockedSince, 0);
    assign(renderer, [sprite], [blocker], false, 1500);
    assign(renderer, [sprite], [blocker], false, 1799);
    assert.equal(sprite._bubbleCandidate, 0);
    assert.equal(sprite._bubbleBlockedSince, 1500);
});

test('speech with null confidence never gains a classifier uncertainty mark', () => {
    assert.equal(needsConfidenceMark('Checking the renderer', null), false);
    assert.equal(needsConfidenceMark('Checking the renderer', undefined), false);
    assert.equal(needsConfidenceMark('Checking the renderer', 0.5), true);
    assert.equal(needsConfidenceMark('Checking the renderer?', 0.5), false);
    assert.equal(needsConfidenceMark('Checking the renderer', 0.9), false);
});
