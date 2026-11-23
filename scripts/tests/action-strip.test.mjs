import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { VERIFIED_CELEBRATION_MS } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { DIRECTIONS, resolveActionFrame } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import {
    actionStripMismatch,
    actionStripPathFor,
} from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import { ritualDownbeat, ritualPhaseOffset, workStripGroup } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const spritesRoot = path.join(repoRoot, 'claudeville/assets/sprites');
const manifest = yaml.load(fs.readFileSync(path.join(spritesRoot, 'manifest.yaml'), 'utf8'));
const characters = manifest.characters || [];

const PILOT = {
    path: 'characters/agent.claude.sonnet/actions.png',
    cell: 92,
    groups: {
        read: { rows: [0, 3], hold: 3 },
        wait: { rows: [4, 4], hold: 4 },
    },
    grip: { hand: 'both', sheathe: true },
};

test('a work strip follows the real tool class wherever it lands; the building only breaks ties', () => {
    assert.equal(workStripGroup('Grep', 'forge'), 'gaze', 'a lookup at the Forge gazes, it never strikes');
    assert.equal(workStripGroup('Read', 'archive'), 'gaze');
    assert.equal(workStripGroup('WebFetch', 'portal'), 'gaze');
    assert.equal(workStripGroup('Edit', 'forge'), 'strike');
    assert.equal(workStripGroup('apply_patch', 'taskboard'), 'strike');
    assert.equal(workStripGroup('Bash', 'portal'), 'tinker', 'a shell command tinkers even at the Portal');
    assert.equal(workStripGroup('Task', 'forge'), 'strike', 'no tool class: the Forge breaks the tie');
    assert.equal(workStripGroup('mcp__browser__click', 'portal'), null, 'an MCP call is not a shell command');
    assert.equal(workStripGroup('mcp__browser__click', 'archive'), null);
    assert.equal(workStripGroup('', 'forge'), null);
});

test('a named group resolves one cell per direction and frame', () => {
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, 0), { sx: 0, sy: 0, sw: 92, sh: 92 });
    // Direction is the column; the group's first row is the frame origin.
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 6, 2), { sx: 6 * 92, sy: 2 * 92, sw: 92, sh: 92 });
    assert.deepEqual(resolveActionFrame(PILOT, 'wait', 3, 0), { sx: 3 * 92, sy: 4 * 92, sw: 92, sh: 92 });
    // A direction key resolves to the same column as its index.
    for (let index = 0; index < DIRECTIONS.length; index++) {
        assert.deepEqual(
            resolveActionFrame(PILOT, 'read', DIRECTIONS[index], 1),
            resolveActionFrame(PILOT, 'read', index, 1),
        );
    }
});

test('frames wrap inside their group and never leak into the next one', () => {
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, 4), resolveActionFrame(PILOT, 'read', 0, 0));
    assert.deepEqual(resolveActionFrame(PILOT, 'read', 0, -1), resolveActionFrame(PILOT, 'read', 0, 3));
    // The single-row wait group holds no matter which frame is asked for.
    for (const frame of [0, 1, 7, 40]) {
        assert.equal(resolveActionFrame(PILOT, 'wait', 0, frame).sy, 4 * 92);
    }
});

test("frame 'hold' selects the declared static row, falling back to the last row", () => {
    assert.equal(resolveActionFrame(PILOT, 'read', 0, 'hold').sy, 3 * 92);
    assert.equal(resolveActionFrame(PILOT, 'wait', 0, 'hold').sy, 4 * 92);
    const noHold = { ...PILOT, groups: { read: { rows: [0, 3] } } };
    assert.equal(resolveActionFrame(noHold, 'read', 0, 'hold').sy, 3 * 92);
    const outOfRange = { ...PILOT, groups: { read: { rows: [0, 3], hold: 9 } } };
    assert.equal(resolveActionFrame(outOfRange, 'read', 0, 'hold').sy, 3 * 92);
});

test('a missing strip, unknown group, or bad direction resolves to null', () => {
    assert.equal(resolveActionFrame(undefined, 'read', 0, 0), null);
    assert.equal(resolveActionFrame(null, 'read', 0, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'shout', 0, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 8, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', -1, 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 'up', 0), null);
    assert.equal(resolveActionFrame(PILOT, 'read', 0, Number.NaN), null);
    assert.equal(resolveActionFrame({ ...PILOT, cell: 0 }, 'read', 0, 0), null);
    assert.equal(resolveActionFrame({ ...PILOT, groups: { read: { rows: [3, 0] } } }, 'read', 0, 0), null);
});

test('strip paths stay sprites-root relative however they are declared', () => {
    assert.equal(actionStripPathFor(PILOT), 'assets/sprites/characters/agent.claude.sonnet/actions.png');
    assert.equal(
        actionStripPathFor({ path: 'assets/sprites/characters/x/actions.png' }),
        'assets/sprites/characters/x/actions.png',
    );
    assert.equal(actionStripPathFor({}), null);
    assert.equal(actionStripPathFor({ path: '   ' }), null);
});

test('a strip whose pixels cannot serve its groups is refused', () => {
    const good = { width: 8 * 92, height: 5 * 92 };
    assert.equal(actionStripMismatch(PILOT, good), null);
    assert.match(actionStripMismatch(PILOT, { width: 7 * 92, height: 5 * 92 }), /width/);
    assert.match(actionStripMismatch(PILOT, { width: 8 * 92, height: 5 * 92 + 3 }), /whole 92px rows/);
    // The declared wait row must exist in the PNG.
    assert.match(actionStripMismatch(PILOT, { width: 8 * 92, height: 4 * 92 }), /groups.wait/);
    assert.match(actionStripMismatch({ ...PILOT, groups: {} }, good), /groups is empty/);
});

test('every declared action strip exists at the engine cell and covers its groups', () => {
    const declared = characters.filter((entry) => entry.actionStrip);
    assert.ok(declared.length > 0, 'the pilot characters must declare action strips');
    for (const entry of declared) {
        const strip = entry.actionStrip;
        const file = path.join(spritesRoot, strip.path);
        assert.ok(fs.existsSync(file), `${entry.id} strip PNG missing at ${strip.path}`);
        // IHDR width/height without decoding the whole image.
        const header = fs.readFileSync(file).subarray(16, 24);
        const width = header.readUInt32BE(0);
        const height = header.readUInt32BE(4);
        assert.equal(strip.cell, 92, `${entry.id} strip must use the 92px engine cell`);
        assert.equal(width, 8 * strip.cell, `${entry.id} strip needs 8 direction columns`);
        const rows = height / strip.cell;
        assert.ok(Number.isInteger(rows), `${entry.id} strip height is not whole cells`);
        for (const [name, group] of Object.entries(strip.groups)) {
            assert.ok(group.rows[1] < rows, `${entry.id} group ${name} points past the strip`);
            const frame = resolveActionFrame(strip, name, 7, 'hold');
            assert.ok(frame.sy + frame.sh <= height, `${entry.id} group ${name} hold row is outside the PNG`);
        }
    }
});

test('a work beat cannot cross its body cell into the next cycle while the overlay draws', (t) => {
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        direction: 2,
        motionScale: 1,
        _toolRitual: { pose: 'hammer', phase: 'playing', beatOrigin: 1, motionEnabled: true },
        _poseCell: {
            source: 'strip',
            group: 'strike',
            now: 459,
            meta: { groups: { strike: { contact: { e: [40, 50] } } } },
        },
    });
    const pixels = [];
    const ctx = {
        globalAlpha: 1,
        save() {},
        restore() {},
        fillRect(x, y, w, h) { pixels.push([x, y, w, h]); },
    };
    const geometry = { dx: 0, dy: 0, drawScale: 1, bounds: { minX: 0, maxX: 92, minY: 0, maxY: 92 } };
    // The body chose the last wind-up frame; the overlay runs just after the
    // 460 ms boundary. Its cream contact core must wait for the next body.
    t.mock.method(Date, 'now', () => 460);
    sprite._drawToolRitualOverlay(ctx, geometry);
    assert.equal(pixels.some(([, , w, h]) => w === 2 && h === 2), false, 'no contact core on the wind-up body');
    pixels.length = 0;
    sprite._poseCell.now = 460;
    sprite._drawToolRitualOverlay(ctx, geometry);
    assert.deepEqual(pixels[0], [39, 49, 2, 2]);
});

const FULL_META = {
    cell: 92,
    groups: {
        read: { rows: [0, 3], hold: 3 },
        wait: { rows: [4, 6], hold: 6, directions: ['se', 'e', 'w', 'sw'] },
        sit: { rows: [7, 8], hold: 8, directions: ['se', 'sw'] },
        strike: { rows: [9, 14], hold: 14, contactFrame: 2, directions: ['se', 'e', 'w', 'sw'] },
        tinker: { rows: [15, 20], hold: 20, contactFrame: 1, directions: ['se', 'e', 'w', 'sw'] },
        gaze: { rows: [21, 24], hold: 24, directions: ['se', 'e', 'w', 'sw'] },
        celebrate: { rows: [25, 27], hold: 27, directions: ['se', 'w', 'sw'] },
        think: { rows: [28, 30], hold: 30, directions: ['se', 'e', 'w', 'sw'] },
    },
};

function makeSprite(id, overrides = {}) {
    const sprite = new AgentSprite({
        id,
        status: AgentStatus.WORKING,
        provider: 'claude',
        model: 'claude-opus-5-5',
        ...overrides,
    }, {});
    sprite.moving = false;
    sprite.motionScale = 1;
    sprite.observation = { state: 'fresh', observedAt: Date.now(), ageMs: 0 };
    return sprite;
}

test('arrived workers play whole-call work strips (Archive prefers read, Portal prefers gaze) on a burst/pause cycle', () => {
    const smith = makeSprite('smith-1', { currentTool: 'Edit' });
    smith._lastBuildingType = 'forge';
    assert.equal(smith.actionStripGroup(), 'strike');

    const reader = makeSprite('reader-1', { currentTool: 'Read' });
    reader._lastBuildingType = 'archive';
    assert.equal(reader.actionStripGroup(), 'read', 'Archive prefers read');

    const researcher = makeSprite('portal-1', { currentTool: 'WebFetch' });
    researcher._lastBuildingType = 'portal';
    assert.equal(researcher.actionStripGroup(), 'gaze', 'Portal prefers gaze');

    const mcpPortal = makeSprite('portal-2', { currentTool: 'mcp__browser__click' });
    mcpPortal._lastBuildingType = 'portal';
    assert.equal(mcpPortal.actionStripGroup(), 'gaze', 'Portal MCP call prefers gaze');

    // Burst/pause cycle visits both numeric work frames and hold breathers over 6 s.
    const frames = new Set();
    for (let t = 0; t < 6000; t += 100) {
        frames.add(smith._actionStripFrame(FULL_META, 'strike', t));
    }
    assert.ok(frames.has('hold'), 'breather holds the strip');
    assert.ok([...frames].some((f) => typeof f === 'number'), 'work burst animates frames');
    smith.motionScale = 0;
    assert.equal(smith._actionStripFrame(FULL_META, 'strike', 1000), 'hold', 'reduced motion holds');
});

test('seated patrons cycle sit on a seeded 1.4-2.2 s cadence; petitioners beckon and glance, holding on reduced/stale', () => {
    const a = makeSprite('patron-a', { status: AgentStatus.IDLE });
    const b = makeSprite('patron-b', { status: AgentStatus.IDLE });
    const seqA = Array.from({ length: 40 }, (_, i) => a._actionStripFrame(FULL_META, 'sit', i * 150));
    const seqB = Array.from({ length: 40 }, (_, i) => b._actionStripFrame(FULL_META, 'sit', i * 150));
    assert.ok(new Set(seqA).size === 2, 'cycles both sit rows');
    assert.notDeepEqual(seqA, seqB, 'seeded per agent');

    a.motionScale = 0;
    assert.equal(a._actionStripFrame(FULL_META, 'sit', 1000), 'hold', 'reduced motion holds sit');
    a.motionScale = 1;
    a.observation = { state: 'stale' };
    assert.equal(a._actionStripFrame(FULL_META, 'sit', 1000), 'hold', 'stale state holds sit');

    const pet = makeSprite('pet-1', { status: AgentStatus.WAITING_ON_USER });
    const waitFrames = new Set();
    for (let t = 0; t < 6500; t += 100) waitFrames.add(pet._actionStripFrame(FULL_META, 'wait', t));
    assert.ok(waitFrames.has('hold'), 'wait includes hold window');
    assert.ok(waitFrames.has(0) && waitFrames.has(1), 'wait plays 3-frame beckon');
    pet.motionScale = 0;
    assert.equal(pet._actionStripFrame(FULL_META, 'wait', 1000), 'hold', 'reduced motion holds wait');

    // Petitioner 1-column head glances in _holdRestPlace stay within STRIP_FACINGS.
    const queuer = makeSprite('pet-glance', { status: AgentStatus.WAITING_ON_USER });
    queuer.visitRole = 'queue';
    queuer.direction = 2; // E
    queuer._renewVisitReservation = () => {};
    queuer._markCrowdArrival = () => {};
    queuer._queueRefreshAt = Infinity;
    const seenGoals = new Set();
    for (let t = 0; t < 6000; t += 100) {
        queuer._holdRestPlace(t, 100);
        if (queuer._facingGoal != null) seenGoals.add(queuer._facingGoal);
    }
    assert.ok(seenGoals.has(1), 'E petitioner glances 1 column to SE');
});

test('read/think/celebrate ping-pong across all authored rows on seeded per-agent phases (no lockstep)', () => {
    const r1 = makeSprite('reader-alpha', { currentTool: 'Read' });
    const r2 = makeSprite('reader-beta', { currentTool: 'Read' });
    const seenRead = new Set();
    const seq1 = [];
    const seq2 = [];
    for (let t = 0; t < 4000; t += 140) {
        const f1 = r1._actionStripFrame(FULL_META, 'read', t);
        const f2 = r2._actionStripFrame(FULL_META, 'read', t);
        seenRead.add(f1);
        seq1.push(f1);
        seq2.push(f2);
    }
    assert.deepEqual([...seenRead].sort(), [0, 1, 2, 3], 'plays all 4 read rows (0->1->2->3->2->1)');
    assert.notDeepEqual(seq1, seq2, 'two readers do not flip in lockstep');

    const seenThink = new Set();
    for (let t = 0; t < 3000; t += 150) seenThink.add(r1._actionStripFrame(FULL_META, 'think', t));
    assert.deepEqual([...seenThink].sort(), [0, 1, 2], 'plays all 3 think rows (0->1->2->1)');

    // ritualDownbeat honours per-agent phase offset when agentId is present.
    const offA = ritualPhaseOffset('worker-a', 460);
    const offB = ritualPhaseOffset('worker-b', 460);
    assert.notEqual(offA, offB);
    assert.equal(ritualPhaseOffset(null, 460), 0);
    const beatA = ritualDownbeat({ agentId: 'worker-a', pose: 'hammer', phase: 'playing', beatOrigin: 1, motionEnabled: true }, 460 - offA);
    assert.equal(beatA?.phase, 'peak');
});

test('celebrate preempts work strips, latches mid-walk until arrival, honors authored directions, and rejected push recoils 3 s', () => {
    const hero = makeSprite('hero-1', { currentTool: 'Bash' });
    hero._lastBuildingType = 'harbor';
    hero._toolRitual = { agentId: 'hero-1', stripGroup: 'tinker', phase: 'playing', pose: 'haul', motionEnabled: true };
    assert.equal(hero.actionStripGroup(), 'tinker');

    // Mid-walk verified win latches until arrival, then preempts Harbor's tinker.
    hero.moving = true;
    const now = Date.now();
    let squadNotified = false;
    hero.onCelebrationArrived = () => { squadNotified = true; };
    assert.deepEqual(hero.observeVerifiedOutcome({ kind: 'release', at: now }, now), { latched: true });
    hero._advanceWalkAnimation = () => {};
    hero._faceBuilding = () => {};
    hero._waitDurationForState = () => 60;
    hero._beginStopBeat = () => {};
    hero._arriveAtTarget(0, 1, 0, 16, null);
    assert.equal(squadNotified, true, 'SquadNotice fires on arrival');
    assert.equal(hero.actionStripGroup(), 'celebrate', 'celebrate preempts Harbor 30 s tinker');

    // Strip facing honours celebrate's manifest directions (omitting 'e' here).
    hero._spriteIdentity = { spriteId: 'agent.claude.opus' };
    hero.assets = { getActionStrip: () => ({ image: {}, meta: FULL_META }) };
    hero.direction = 2; // E — not in celebrate's ['se', 'w', 'sw']
    hero._facingGoal = null;
    hero._holdStripFacing();
    assert.ok([1, 6, 7].includes(hero._facingGoal), 'turns off unauthored E onto an authored celebrate facing');

    // Rejected push triggers a 3 s head-drop recoil (and latches mid-walk).
    const pushed = makeSprite('harbor-fail', { status: AgentStatus.WAITING });
    pushed.moving = true;
    pushed.agent.gitEvents = [{ id: 'p1', type: 'push', success: false, exitCode: 1, stderr: 'rejected', timestamp: now }];
    pushed._observeRejectedPushes(now);
    assert.equal(pushed._pushRecoilDrop(now), 0, 'latched while walking');
    pushed._advanceWalkAnimation = () => {};
    pushed._faceBuilding = () => {};
    pushed._waitDurationForState = () => 60;
    pushed._beginStopBeat = () => {};
    pushed._arriveAtTarget(0, 1, 0, 16, null);
    const after = Date.now();
    assert.equal(pushed._pushRecoilDrop(after + 100), 3, '3-texel head-drop recoil on arrival');
    assert.equal(pushed._pushRecoilDrop(after + 3500), 0, 'recoil ends after 3 s');
    assert.ok(VERIFIED_CELEBRATION_MS === 5000);
});
