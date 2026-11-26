import test from 'node:test';
import assert from 'node:assert/strict';
import { astraWeaponPose } from '../../claudeville/src/presentation/character-mode/AstraWeaponPose.js';
import { codexWeaponPose } from '../../claudeville/src/presentation/character-mode/CodexWeaponPose.js';
import { equipmentLayer } from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { SpriteSheet, DIRECTIONS } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';

test('Astra wrists follow the rendered cell, independently of cape/crest bounds and world scale', () => {
    const sheet = new SpriteSheet(null);
    for (const [state, count] of [['walk', 6], ['idle', 4]]) {
        for (let direction = 0; direction < 8; direction++) {
            for (let frame = 0; frame < count; frame++) {
                const cell = sheet.cell(state, direction, frame);
                const pose = astraWeaponPose({ cell, dx: 0, dy: 0 }, DIRECTIONS[direction], 'worldsplitter');
                assert.ok(pose.x >= 24 && pose.x <= 68 && pose.y >= 44 && pose.y <= 66);
                const scaled = astraWeaponPose({ cell, dx: 100, dy: -50, drawScale: 2,
                    bounds: { minX: 0, maxX: 92, minY: 0, maxY: 92 } }, DIRECTIONS[direction], 'worldsplitter');
                assert.equal(scaled.x, 100 + pose.x * 2);
                assert.equal(scaled.y, -50 + pose.y * 2);
            }
        }
    }
    const pose = frame => astraWeaponPose({ cell: sheet.cell('walk', 2, frame), dx: 0, dy: 0 }, 'e', 'runeblade');
    assert.notDeepEqual(pose(1), pose(4), 'the moving wrist must not stay at one estimated position');
    assert.equal(astraWeaponPose({ dx: 0, dy: 0 }, 'e', 'runeblade'), null);
});

test('the active GPU weapon layer uses the same authored wrist as the Canvas frame', t => {
    const previous = globalThis.document;
    t.after(() => { globalThis.document = previous; });
    const calls = [];
    globalThis.document = { createElement: () => {
        const canvas = {};
        canvas.getContext = () => ({ canvas, drawImage() {}, getImageData(_x,_y,w,h) {
            const data = new Uint8ClampedArray(w*h*4);
            data[3] = 255;
            return { data };
        } });
        return canvas;
    } };
    const identity = { spriteId: 'agent.codex.gpt6astra' };
    const sprite = { direction: 2, _runtimeCodexEquipment: () => 'runeblade',
        _drawCodexEquipment(ctx, identity, geometry, layer) {
            calls.push([geometry.cell, layer, astraWeaponPose(geometry, 'e', 'runeblade')]);
        },
    };
    const g = { cell: new SpriteSheet(null).cell('walk', 2, 4), dx:30, dy:25, drawScale:1 };
    const front = equipmentLayer(sprite, identity, g, 'front');
    assert.equal(equipmentLayer(sprite, identity, g, 'front'), front);
    assert.equal(front.source.width, 1);
    assert.equal(front.source.height, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], g.cell);
    assert.equal(calls[0][1], 'front');
    assert.ok(calls[0][2]);
});

test('Astra hides the far hand with its blade; unprofiled sprites keep their fallback poses', () => {
    const sprite = Object.create(AgentSprite.prototype);
    sprite.assets = { has: () => true };
    const calls = [];
    sprite._drawCodexAssetEquipment = (ctx, asset, geometry, direction, part) => {
        calls.push({ part, grip: geometry.authoredGrip });
    };
    const geometry = { cell: { sy: 552 }, dx: 0, dy: 0,
        bounds: { minX: 20, maxX: 70, minY: 20, maxY: 75 }, drawScale: 1 };
    const identity = { spriteId: 'agent.codex.gpt6astra', equipment: 'runeblade', codexHeavyGearBaked: true };
    sprite._drawCodexEquipment(null, identity, geometry, 'back', 'e');
    assert.deepEqual(calls.map(call => call.part), ['asset', 'hands']);
    assert.ok(calls.every(call => call.grip.behindBody));
    calls.length = 0;
    sprite._drawCodexEquipment(null, identity, geometry, 'front', 'e');
    assert.equal(calls.length, 0, 'no floating hand may be stamped over the torso');
    sprite._drawCodexEquipment(null, { ...identity, spriteId: 'agent.codex.unprofiled' }, geometry, 'front', 's');
    assert.deepEqual(calls.map(call => call.part), ['asset', 'hands']);
    assert.ok(calls.every(call => call.grip === null));
});

test('the second Astra body carries the halberd on its own measured wrists', () => {
    const sheet = new SpriteSheet(null);
    for (const [state, count] of [['walk', 6], ['idle', 4]]) {
        for (let direction = 0; direction < 8; direction++) {
            for (let frame = 0; frame < count; frame++) {
                const geometry = { cell: sheet.cell(state, direction, frame), dx: 0, dy: 0 };
                const pose = codexWeaponPose('agent.codex.gpt6astra.b', geometry, DIRECTIONS[direction], 'worldsplitter');
                assert.ok(pose, `${state} ${DIRECTIONS[direction]} #${frame} needs a grip`);
                assert.ok(pose.x >= 20 && pose.x <= 70 && pose.y >= 44 && pose.y <= 66);
            }
        }
    }
    const idleS = { cell: sheet.cell('idle', 0, 0), dx: 0, dy: 0 };
    assert.notDeepEqual(
        codexWeaponPose('agent.codex.gpt6astra.b', idleS, 's', 'worldsplitter'),
        codexWeaponPose('agent.codex.gpt6astra', idleS, 's', 'worldsplitter'),
        'the .b body must not borrow the first body\'s wrists',
    );
});

test('both Astra bodies keep Worldsplitter in hand across all 8 directions of their run strip', () => {
    for (const spriteId of ['agent.codex.gpt6astra', 'agent.codex.gpt6astra.b']) {
        for (const direction of DIRECTIONS) {
            for (let frame = 0; frame < 6; frame++) {
                const pose = codexWeaponPose(spriteId, { cell: null, dx: 0, dy: 0, poseGroup: 'run', poseFrame: frame }, direction, 'worldsplitter');
                assert.ok(pose, `${spriteId} run ${direction}#${frame} needs a grip`);
                assert.equal(pose.angle, -0.35, 'running halberd leans forward like walk');
                assert.ok(pose.x > 8 && pose.x < 84 && pose.y > 30 && pose.y < 80);
            }
        }
    }
});
