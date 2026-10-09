import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { TravelGait, resolveTravelGait } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { SPEED_RUNGS } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { codexPoseGripped, codexWeaponPose } from '../../claudeville/src/presentation/character-mode/CodexWeaponPose.js';
import { DIRECTIONS, SpriteSheet } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { getModelVisualIdentity } from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

// W8.7 — a villager runs only on an urgent trip at the top speed rung, and
// only when its profile ships a `run` strip. Everything else walks.

const TOP = SPEED_RUNGS[SPEED_RUNGS.length - 1];
const URGENT = Object.freeze({ status: AgentStatus.WORKING, topRung: true, hasRunStrip: true });

test('a WORKING body on its real leg at the top rung with a run strip runs', () => {
    assert.equal(resolveTravelGait(URGENT), TravelGait.RUN);
});

test('a chat approach at the top rung runs whatever the status', () => {
    for (const status of Object.values(AgentStatus)) {
        assert.equal(
            resolveTravelGait({ status, chatApproach: true, topRung: true, hasRunStrip: true }),
            TravelGait.RUN,
            `${status} chat approach`,
        );
    }
});

test('an errand walks even for a WORKING body at the top rung', () => {
    assert.equal(resolveTravelGait({ ...URGENT, errand: true }), TravelGait.WALK);
});

test('every status but WORKING walks its own legs (strolls, queues, wind-downs)', () => {
    for (const status of Object.values(AgentStatus)) {
        if (status === AgentStatus.WORKING) continue;
        assert.equal(resolveTravelGait({ ...URGENT, status }), TravelGait.WALK, status);
        // A stroll or wind-down is a crowd place too; it never runs either.
        assert.equal(resolveTravelGait({ ...URGENT, status, errand: true }), TravelGait.WALK, `${status} crowd leg`);
    }
    assert.equal(resolveTravelGait({ ...URGENT, status: null }), TravelGait.WALK, 'no status');
});

test('a lower rung, a missing strip or a departed body walks', () => {
    assert.equal(resolveTravelGait({ ...URGENT, topRung: false }), TravelGait.WALK);
    assert.equal(resolveTravelGait({ ...URGENT, hasRunStrip: false }), TravelGait.WALK);
    assert.equal(resolveTravelGait({ ...URGENT, departed: true }), TravelGait.WALK);
    assert.equal(resolveTravelGait({ chatApproach: true, topRung: false, hasRunStrip: true }), TravelGait.WALK);
    assert.equal(resolveTravelGait({ chatApproach: true, topRung: true, hasRunStrip: false }), TravelGait.WALK);
    assert.equal(resolveTravelGait(), TravelGait.WALK);
});

// --- AgentSprite wiring ---

const RUN_STRIP = Object.freeze({
    image: {},
    path: 'characters/agent.codex.gpt56sol/actions.png',
    meta: { cell: 92, groups: { run: { rows: [21, 26], hold: 21 } } },
});
const WALK_ONLY_STRIP = Object.freeze({
    image: {},
    meta: { cell: 92, groups: { read: { rows: [0, 3], hold: 3 } } },
});

function walker({ status = AgentStatus.WORKING, speed = TOP, strip = RUN_STRIP, motionScale = 1, ...rest } = {}) {
    return Object.assign(Object.create(AgentSprite.prototype), {
        agent: { id: 'a1', status },
        assets: { getActionStrip: () => strip },
        _spriteIdentity: { spriteId: 'agent.codex.gpt56sol' },
        _crowd: { place: null },
        chatPartner: null,
        _gaitSpeed: speed,
        motionScale,
        moving: true,
        animState: 'walk',
        direction: 2,
        frame: 0,
        walkFrame: 0,
        frameTimer: 0,
        _running: false,
        _strideDistance: 0,
        _stridePhase: 0,
        _stridePhaseStale: false,
        _updateFacingDirection() {},
        ...rest,
    });
}

// Walks `steps` refreshes of `speed` px each and returns the frame per refresh.
function stride(sprite, steps) {
    const frames = [];
    for (let i = 0; i < steps; i++) {
        sprite._advanceWalkAnimation(sprite._gaitSpeed, sprite._gaitSpeed, 0, 16.67, null);
        frames.push(sprite.frame);
    }
    return frames;
}

test('the sprite runs only on an urgent top-rung leg of a profile with a run strip', () => {
    assert.equal(walker()._runGaitDue(), true);
    assert.equal(walker({ speed: SPEED_RUNGS[SPEED_RUNGS.length - 2] })._runGaitDue(), false, 'lower rung');
    assert.equal(walker({ strip: WALK_ONLY_STRIP })._runGaitDue(), false, 'strip without a run group');
    assert.equal(walker({ strip: null })._runGaitDue(), false, 'no strip');
    assert.equal(walker({ _crowd: { place: { role: 'errand' } } })._runGaitDue(), false, 'errand');
    assert.equal(walker({ status: AgentStatus.IDLE, speed: SPEED_RUNGS[0] })._runGaitDue(), false, 'stroll');
    assert.equal(walker({ status: AgentStatus.IDLE, chatPartner: {} })._runGaitDue(), true, 'chat approach');
    assert.equal(walker({ agent: { id: 'a1', status: AgentStatus.WORKING, isDeparted: true } })._runGaitDue(), false, 'departed');
});

test('a run turns one frame per 9 px of travel; a walk one per 4.5 px', () => {
    const run = walker({ _running: true });
    const runFrames = stride(run, 36);
    assert.equal(run._running, true);
    // 1.5 px per refresh: 6 refreshes per run frame, the six-frame cycle in 36.
    assert.deepEqual([...new Set(runFrames)], [0, 1, 2, 3, 4, 5]);
    for (let f = 0; f < 6; f++) assert.equal(runFrames.filter((x) => x === f).length, 6, `run frame ${f}`);

    const walk = walker({ strip: WALK_ONLY_STRIP });
    const walkFrames = stride(walk, 36);
    assert.equal(walk._running, false);
    for (let f = 0; f < 6; f++) assert.equal(walkFrames.filter((x) => x === f).length, 6, `walk frame ${f} (two cycles)`);
    // Zero phase: the frame turns on the refresh that completes 4.5 px.
    assert.deepEqual(walkFrames.slice(0, 6), [0, 0, 1, 1, 1, 2]);
});

test('without a run strip the walk cycle is identical at every rung', () => {
    for (const speed of SPEED_RUNGS) {
        const plain = walker({ strip: null, speed });
        const noRunGroup = walker({ strip: WALK_ONLY_STRIP, speed });
        assert.deepEqual(stride(plain, 48), stride(noRunGroup, 48), `rung ${speed}`);
    }
});

test('a run sets off on walk frames and starts after two walk cycles, keeping the frame index', () => {
    const sprite = walker();
    // 1.5 px per refresh: 35 refreshes (52.5 px) stay on the walk lattice.
    const setOff = stride(sprite, 35);
    assert.equal(sprite._running, false, 'the start of a leg walks');
    assert.deepEqual(setOff, stride(walker({ strip: null }), 35));
    assert.equal(sprite.frame, 5);
    assert.equal(sprite._actionStripPose(null, 'agent.codex.gpt56sol'), null, 'no run row while setting off');
    // The 36th refresh completes 54 px: the run picks up on the same index.
    sprite._advanceWalkAnimation(TOP, TOP, 0, 16.67, null);
    assert.equal(sprite._running, true);
    assert.equal(sprite.frame, 5, 'the run picks up on the same frame index');
});

test('a trailing walker whose rung drops or holds every few hundred ms never runs', () => {
    const sprite = walker();
    for (let cycle = 0; cycle < 8; cycle++) {
        sprite._gaitSpeed = TOP;
        stride(sprite, 24); // 36 px on the top rung
        assert.equal(sprite._running, false, `cycle ${cycle} top-rung burst`);
        sprite._gaitSpeed = SPEED_RUNGS[1]; // the follow rung
        stride(sprite, 6);
        assert.equal(sprite._running, false, `cycle ${cycle} follow rung`);
    }
    // A rung drop ends a run the same refresh.
    sprite._gaitSpeed = TOP;
    stride(sprite, 40);
    assert.equal(sprite._running, true);
    sprite._gaitSpeed = SPEED_RUNGS[3];
    stride(sprite, 1);
    assert.equal(sprite._running, false);
    assert.equal(sprite._runEntryPx, 0);
});

test('the run pose reads the run row for the stride frame; a walk keeps the walk sheet', () => {
    const sprite = walker({ compositor: null, _running: true });
    stride(sprite, 13); // run frame 2
    const pose = sprite._actionStripPose(null, 'agent.codex.gpt56sol');
    assert.equal(pose.group, 'run');
    assert.deepEqual(pose.cell, { sx: 2 * 92, sy: 23 * 92, sw: 92, sh: 92 });

    const walk = walker({ strip: WALK_ONLY_STRIP });
    stride(walk, 13);
    assert.equal(walk._actionStripPose(null, 'agent.codex.gpt56sol'), null, 'walk falls back to the base sheet');
});

test('reduced motion never runs: the body holds its idle frame and no run row', () => {
    const sprite = walker({ motionScale: 0, _running: true, frame: 3, actionStripGroup: () => null });
    sprite._advanceWalkAnimation(TOP, TOP, 0, 16.67, null);
    assert.equal(sprite._running, false);
    assert.equal(sprite.animState, 'idle');
    assert.equal(sprite.frame, 0);
    assert.equal(sprite._actionStripPose(null, 'agent.codex.gpt56sol'), null);
});

// --- Held weapon through the run (W8.7) ---

const MANIFEST = yaml.load(readFileSync(new URL('../../claudeville/assets/sprites/manifest.yaml', import.meta.url), 'utf8'));
const RUN_PROFILES = (MANIFEST.characters || []).filter(entry => entry.actionStrip?.groups?.run);
const RUN_MODELS = { 'agent.codex.gpt56sol': 'gpt-5.6-sol', 'agent.codex.gpt56luna': 'gpt-5.6-luna' };

function runPose(entry, direction, frame) {
    const meta = entry.actionStrip;
    return { group: 'run', cell: { sx: direction * 92, sy: (meta.groups.run.rows[0] + frame) * 92, sw: 92, sh: 92 }, strip: { meta } };
}

test('a run strip whose other poses sheathe the weapon authors the weapon hand for every run cell', () => {
    assert.ok(RUN_PROFILES.length > 0, 'the manifest ships run strips');
    for (const entry of RUN_PROFILES) {
        if (!entry.actionStrip.grip?.sheathe) continue;
        // Without an authored hand the draw parks the weapon on the first run
        // frame and it pops back on the first idle frame.
        assert.ok(codexPoseGripped(entry.id, 'run'), `${entry.id} run rows need poseWrists.run`);
        const [first, last] = entry.actionStrip.groups.run.rows;
        const identity = getModelVisualIdentity(RUN_MODELS[entry.id], 'high', 'codex');
        assert.equal(identity.spriteId, entry.id);
        for (let direction = 0; direction < DIRECTIONS.length; direction++) {
            for (let frame = 0; frame <= last - first; frame++) {
                const pose = runPose(entry, direction, frame);
                const gripFrame = AgentSprite.prototype._poseGripFrame(entry.id, pose);
                assert.equal(gripFrame, frame, `${entry.id}/${DIRECTIONS[direction]}/${frame} is not sheathed`);
                const grip = codexWeaponPose(entry.id, { cell: null, dx: 0, dy: 0, poseGroup: 'run', poseFrame: gripFrame },
                    DIRECTIONS[direction], identity.equipment);
                assert.ok(grip, `${entry.id}/${DIRECTIONS[direction]}/${frame} resolves a hand`);
                assert.ok(Number.isInteger(grip.x) && grip.x > 8 && grip.x < 84, 'hand inside the body cell');
                assert.ok(Number.isInteger(grip.y) && grip.y > 30 && grip.y < 80, 'hand between shoulder and knee');
            }
        }
    }
    // A group without authored hands still parks the weapon.
    const sol = RUN_PROFILES.find(entry => entry.id === 'agent.codex.gpt56sol');
    assert.equal(AgentSprite.prototype._poseGripFrame(sol.id, { ...runPose(sol, 0, 0), group: 'read' }), -1);
});

test('the resident run strip bakes the held weapon around every run cell', () => {
    const calls = [];
    const previousDocument = globalThis.document;
    const ctx = {
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
        drawImage: (_source, sx, sy) => calls.push(`body:${sx / 92}:${sy / 92}`),
    };
    globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
    try {
        const entry = RUN_PROFILES.find(candidate => candidate.id === 'agent.codex.gpt56luna');
        const identity = getModelVisualIdentity('gpt-5.6-luna', 'high', 'codex');
        const sprite = Object.assign(Object.create(AgentSprite.prototype), {
            assets: { assetVersion: 3 },
            spriteSheet: new SpriteSheet(null),
            _getCellContentBounds: () => null,
            _runtimeCodexEquipment: () => identity.equipment,
            _normalizedCodexEquipment: equipment => equipment,
            _drawCodexEquipment(_ctx, _identity, geometry, layer, direction) {
                calls.push(`${layer}:${direction}:${geometry.poseGroup}:${geometry.poseFrame}`);
            },
        });
        const pose = { ...runPose(entry, 0, 0), source: { width: 736 } };
        const strip = sprite._gpuEquippedPoseStrip(identity, pose);
        assert.equal(strip.firstRow, 21);
        assert.ok(strip.pad > 0, 'blade tips overhang the 92px cell');
        assert.equal(calls.length, 8 * 6 * 3);
        assert.deepEqual(calls.slice(0, 3), ['back:s:run:0', 'body:0:21', 'front:s:run:0']);
        assert.deepEqual(calls.slice(-3), ['back:sw:run:5', 'body:7:26', 'front:sw:run:5']);
        assert.equal(sprite._gpuEquippedPoseStrip(identity, pose), strip, 'one bake per strip source');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
