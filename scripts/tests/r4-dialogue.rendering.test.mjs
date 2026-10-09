// Bubble legibility. The old renderer shrank text one character at a time and
// cut mid-word, which is what produced unreadable fragments over villagers'
// heads. These tests defend the pixel-fit-then-word-boundary behaviour and the
// hover provenance that makes the badge on the bubble mean something.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite, CODEX_WEAPON_ASSETS } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { createThoughtColumn, layoutThoughtColumn, THOUGHT_HEAD, THOUGHT_STACK_STEP, THOUGHT_PAINT } from '../../claudeville/src/presentation/character-mode/ThoughtColumn.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';

function speakingSprite(id, now) {
    const agent = new Agent({
        id,
        status: 'working',
        dialogue: {
            text: 'Checking the renderer', kind: 'intent', source: 'omp.tool.i',
            fidelity: 'verbatim', observedAt: now - 5_000, actionId: 'call-1',
        },
    });
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        agent,
        _activityTrail: [],
        _providerTrimColor: () => '#ffffff',
        _archiveFadeProgress: () => 0,
    });
    sprite._activitySnapshot = sprite._captureActivitySnapshot(agent, now);
    return sprite;
}

test('new thoughts expire independently after thirty seconds, measured from receipt', (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now });
    const first = speakingSprite('first', now);
    t.mock.timers.tick(500);
    const second = speakingSprite('second', Date.now());
    t.mock.timers.tick(29_499);
    assert.equal(first._activityThread().length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(first._activityThread(), []);
    assert.equal(second._activityThread().length, 1);
    assert.equal(IsometricRenderer.prototype._spriteWantsBubble.call({}, first), false);
    assert.equal(IsometricRenderer.prototype._spriteWantsBubble.call({}, second), true);
    t.mock.timers.tick(500);
    assert.deepEqual(second._activityThread(), []);
});

test('duplicate snapshots and temporarily missing dialogue do not replay an expired thought', (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now });
    const sprite = speakingSprite('first', now);
    t.mock.timers.tick(20_000);
    sprite.agent.dialogue = { ...sprite.agent.dialogue };
    sprite._activitySnapshot = sprite._captureActivitySnapshot();
    t.mock.timers.tick(10_000);
    assert.deepEqual(sprite._activityThread(), []);
    const dialogue = sprite.agent.dialogue;
    sprite.agent.dialogue = null;
    assert.deepEqual(sprite._activityThread(), []);
    sprite.agent.dialogue = dialogue;
    assert.deepEqual(sprite._activityThread(), []);
    // The same words in a genuinely new source event still deserve a window.
    sprite.agent.dialogue = { ...dialogue, observedAt: Date.now() };
    assert.equal(sprite._activityThread().length, 1);
    t.mock.timers.tick(30_000);
    assert.deepEqual(sprite._activityThread(), []);
});

test('expired history cannot keep bubbles alive after the current thought expires', (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now });
    const sprite = speakingSprite('first', now);
    sprite._rememberActivitySnapshot({ text: 'An earlier thought', key: 'earlier', timestamp: now });
    t.mock.timers.tick(30_000);
    assert.deepEqual(sprite._activityThread(), []);
});

test('a new thought gets its own window without reviving expired history', (t) => {
    const now = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now });
    const sprite = speakingSprite('first', now);
    const previous = sprite._activitySnapshot;
    t.mock.timers.tick(30_000);
    sprite.agent.dialogue = { ...sprite.agent.dialogue, text: 'Running the tests', observedAt: Date.now() };
    sprite._rememberActivitySnapshot(previous);
    assert.deepEqual(sprite._activityThread().map(entry => entry.text), ['Running the tests']);
    t.mock.timers.tick(29_999);
    assert.deepEqual(sprite._activityThread().map(entry => entry.text), ['Running the tests']);
    t.mock.timers.tick(1);
    assert.deepEqual(sprite._activityThread(), []);
});

test('GPU per-agent overlays leave thought painting to the dedicated layer in every annotation mode', () => {
    let bubbles = 0;
    const host = {
        agent: { status: 'working' }, gpuWorldEnabled: true, selected: false,
        chatting: false, gpuActionOverlay: false,
        _gpuFrameRecord: { contentTopY: 40 },
        _labelTopY: y => y,
        _drawStatus: () => bubbles++,
        _drawStatusEmote() {}, _drawPlanModeGlyph() {}, _drawRetryGlyph() {}, _drawNameTag() {},
    };
    const renderer = new AgentGpuOverlayRenderer(host);
    for (const mode of ['full', 'compact', 'minimal', 'full']) renderer.draw({}, 1, mode);
    assert.equal(bubbles, 0);
});

test('dedicated thought painting stays live across annotation modes and receives both phases', () => {
    const ctx = {};
    const phases = [];
    const host = {
        agent: { status: 'working' }, bubbleSlot: 0, chatting: false,
        _drawStatus: (paintCtx, phase) => {
            assert.equal(paintCtx, ctx);
            phases.push(phase);
        },
    };
    for (const mode of ['full', 'compact', 'minimal', 'full']) {
        host.annotationMode = mode;
        AgentSprite.prototype.drawThought.call(host, ctx, 2, THOUGHT_PAINT.LEADER);
        AgentSprite.prototype.drawThought.call(host, ctx, 2, THOUGHT_PAINT.COLUMN);
    }
    assert.deepEqual(phases, Array.from({ length: 4 }, () => [THOUGHT_PAINT.LEADER, THOUGHT_PAINT.COLUMN]).flat());
    assert.equal(host._zoom, 2);
    host.bubbleSlot = null;
    AgentSprite.prototype.drawThought.call(host, ctx, 2, THOUGHT_PAINT.COLUMN);
    host.bubbleSlot = 0;
    host.chatting = true;
    AgentSprite.prototype.drawThought.call(host, ctx, 2, THOUGHT_PAINT.COLUMN);
    assert.equal(phases.length, 8);
});

// Monospace stand-in: every glyph is 6px wide, so expected widths are exact and
// the assertions do not depend on a real font being present.
const CHAR_PX = 6;
function fakeCtx() {
    return {
        font: '10px test',
        measureCalls: 0,
        measureText(text) {
            this.measureCalls++;
            return { width: String(text).length * CHAR_PX };
        },
    };
}

function layout(text, maxWidthChars) {
    const ctx = fakeCtx();
    // Fresh host per call, so the layout cache never masks a measurement count.
    const host = { _bubbleLayoutCacheKey: null, _bubbleLayoutCache: null };
    const result = AgentSprite.prototype._bubbleLayout.call(host, ctx, text, maxWidthChars * CHAR_PX, true);
    return { ...result, measureCalls: ctx.measureCalls };
}

test('text that fits is left completely alone', () => {
    const { displayText } = layout('Running the checks', 40);
    assert.equal(displayText, 'Running the checks');
});

test('overlong text is cut at a word boundary, never mid-word', () => {
    const { displayText } = layout('Reclassify supplemental Aave lending rows', 24);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length <= 24, true);
    // The body must end on a whole word.
    const body = displayText.slice(0, -1);
    assert.equal('Reclassify supplemental Aave lending rows'.startsWith(body), true);
    assert.match(body, /(Reclassify|supplemental|Aave|lending)$/);
});

test('a long unbroken token still yields readable text', () => {
    // No space to break on: a word-boundary-only rule would collapse this to
    // nothing, which is worse than a hard cut.
    const { displayText } = layout('$PROJECT/src/presentation/character-mode/AgentSprite.js', 20);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length > 2, true);
});

test('fitting is logarithmic, not one character per measurement', () => {
    const long = 'Reclassify supplemental Aave lending rows so they stop outranking native wrappers';
    const { measureCalls } = layout(long, 24);
    // Character-by-character shrinking would need ~60 measurements here.
    assert.equal(measureCalls < 15, true, `expected a binary search, got ${measureCalls} measureText calls`);
});

test('trailing punctuation is not left dangling before the ellipsis', () => {
    const { displayText } = layout('Checking the adapter, then the renderer', 22);
    assert.doesNotMatch(displayText, /[,;:]…$/);
});

test('a surrogate pair is never split', () => {
    const { displayText } = layout('🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷', 6);
    assert.doesNotMatch(displayText, /[\ud800-\udbff]…$/);
});

test('hover exposes the untrimmed wording and the exact origin', () => {
    const host = {
        _activitySnapshot: {
            text: 'The user wants me to execute a research procedure for mint…',
            full: 'The user wants me to execute a research procedure for mint-bridge-boundary analysis.',
            kind: 'thinking',
            source: 'grok.thought.chunk',
            fidelity: 'excerpt',
            redacted: false,
        },
    };
    const tip = AgentSprite.prototype.dialogueTooltip.call(host);
    // Full text, so hovering recovers what the bubble had to cut.
    assert.match(tip, /boundary analysis\./);
    // And the origin, named exactly.
    assert.match(tip, /Model reasoning — grok\.thought\.chunk \(excerpt\)/);
});

test('hover discloses redaction', () => {
    const host = {
        _activitySnapshot: {
            text: 'Implemented the fix in $PROJECT/src/foo.js',
            full: null,
            kind: 'assistant',
            source: 'claude.text',
            fidelity: 'verbatim',
            redacted: true,
        },
    };
    assert.match(AgentSprite.prototype.dialogueTooltip.call(host), /\(redacted\)/);
});

test('a silent villager has no tooltip', () => {
    assert.equal(AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: null }), '');
    // Harness status entries carry no source, so they claim no provenance.
    assert.equal(
        AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: { text: 'WORKING', source: null } }),
        '',
    );
});

// Bubble slot geometry. These call the real methods so every module-level
// constant they touch is actually evaluated. A missing declaration is a runtime
// ReferenceError that `node --check` cannot see and that pauses the whole world
// renderer after three consecutive frame failures — which is exactly how it
// escaped review once already.
function slotHost() {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = { zoom: 1 };
    return renderer;
}

test('column reservation widens with the real line length and stays bounded', () => {
    const width = text => layoutThoughtColumn(createThoughtColumn(), [{ text }]).width;
    assert.ok(width('IDLE') > 0);
    assert.ok(width('Checking git state and largest files') > width('IDLE'));
    // The capped text cells plus padding and the stroke are all reserved.
    assert.equal(width('x'.repeat(400)), width('x'.repeat(Math.floor(THOUGHT_HEAD.maxText / 7))));
    assert.ok(width('x'.repeat(400)) <= THOUGHT_HEAD.maxText + THOUGHT_HEAD.pad * 2 + 2);
});

test('stacked candidates step upward and placement avoids occupied column geometry', () => {
    const host = slotHost();
    const entry = { text: 'Running the checks' };
    const sprite = {
        agent: { id: 'slot-speaker', status: 'working' },
        x: 100, y: 200,
        _activitySnapshot: entry,
        _activityThread: () => [entry],
    };
    assert.equal(host._prepareThought(sprite, 1), true);
    // Candidate rect storage is reused; copy before requesting the next one.
    const slot0 = { ...host._thoughtCandidateRects(sprite, 0, 1).body };
    const slot1 = { ...host._thoughtCandidateRects(sprite, 3, 1).body };
    for (const rect of [slot0, slot1]) {
        for (const key of ['x', 'y', 'w', 'h']) {
            assert.equal(Number.isFinite(rect[key]), true, `${key} must be finite, got ${rect[key]}`);
        }
        assert.ok(rect.h > 0 && rect.w > 0);
    }
    assert.equal(slot0.y - slot1.y, THOUGHT_STACK_STEP);
    // A neighbouring reservation clips the home column but not its anchor.
    const blocker = { x: slot0.x + 1, y: slot0.y + 1, w: 1, h: 1 };
    const occupied = [blocker];
    host._placeThought(sprite, 1, 1000, null, occupied, false);
    assert.notEqual(sprite._bubbleCandidate, 0);
    const placed = host._thoughtCandidateRects(sprite, sprite._bubbleCandidate, 1);
    // Exclude this placement's own reservations from the collision query.
    assert.equal(host._thoughtRectsCollide(placed, null, [blocker], false), false);
});

test('only villagers with something to show reserve a slot', () => {
    const wants = (sprite) => IsometricRenderer.prototype._spriteWantsBubble.call(slotHost(), sprite);

    assert.equal(wants({ _activitySnapshot: { text: 'Running the checks' } }), true);
    // Silent and not waiting: reserves nothing, so a speaking neighbour keeps slot 0.
    assert.equal(wants({ _activitySnapshot: null }), false);
    // Silent but blocked long enough for the wait clock: still needs its slot.
    assert.equal(wants({ _activitySnapshot: null, _shouldUseLongWaitClock: () => true }), true);
    assert.equal(wants({ chatting: true, _activitySnapshot: { text: 'x' } }), false);
    assert.equal(wants(null), false);
});

// A Sol villager rendered its dawnblade behind its own body in every direction,
// which hid roughly two thirds of the blade and left the authored empty hands
// gripping air. Measured on a frozen pose: 16,026 visible weapon pixels forced
// behind the body versus 29,570 with the default rule.
test('an empty-handed sprite carries its weapon in front, and tucks it away only when facing away', () => {
    const backLayer = (def, dir) => AgentSprite.prototype._assetWeaponBackLayer.call({}, def, dir);
    const dawnblade = CODEX_WEAPON_ASSETS.dawnblade;

    // The bug: `backLayer: 'always'` on a hand-held weapon.
    assert.equal(dawnblade.backLayer, undefined);
    for (const dir of ['s', 'se', 'e', 'sw', 'w']) {
        assert.equal(backLayer(dawnblade, dir), false, `dawnblade should be held in view facing ${dir}`);
    }
    // Facing away, the blade belongs behind the body.
    for (const dir of ['n', 'ne', 'nw']) {
        assert.equal(backLayer(dawnblade, dir), true, `dawnblade should sit behind the body facing ${dir}`);
    }

    // Sol/Luna/Terra sprites are all authored empty-handed, so none of them may
    // force its signature weapon behind the body.
    for (const key of ['dawnblade', 'crescentSaber', 'earthbreaker']) {
        assert.notEqual(CODEX_WEAPON_ASSETS[key].backLayer, 'always', `${key} must stay visible from the front`);
    }

    // `greatsword` is the deliberate exception: it pairs with procedural heavy
    // armour drawn on the front layer, so its blade has to stay behind.
    assert.equal(CODEX_WEAPON_ASSETS.greatsword.backLayer, 'always');
    assert.equal(backLayer(CODEX_WEAPON_ASSETS.greatsword, 's'), true);
});
