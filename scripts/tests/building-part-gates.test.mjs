import test from 'node:test';
import assert from 'node:assert/strict';

import { assignRoomSlots } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { BuildingPartGates } from '../../claudeville/src/presentation/character-mode/BuildingPartGates.js';

const lantern = (room) => ({ frames: 4, staticFrame: 0, loopFrom: 1, fps: 6, gate: `room.taskboard.${room}` });

function gatesFor(workingIds, { motion = true, timeMs = 0 } = {}) {
    const slots = assignRoomSlots({ workingIds, rooms: 2 });
    const gates = new BuildingPartGates();
    gates.update({
        workingIdsByType: new Map([['taskboard', new Set(workingIds)]]),
        roomSlotsByType: new Map([['taskboard', slots]]),
        timeMs,
        motion,
    });
    return gates;
}

test('a room-gated part burns only for the worker holding that room: N workers light min(N, rooms)', () => {
    for (const [ids, lit] of [[[], 0], [['a'], 1], [['a', 'b'], 2], [['a', 'b', 'c'], 2]]) {
        const gates = gatesFor(ids);
        const burning = [0, 1].filter((k) => gates.frameFor('taskboard', `lantern${k}`, lantern(k)) > 0);
        assert.equal(burning.length, lit, `${ids.length} worker(s)`);
    }
});

test('a single worker lights room 0, not the building-wide work gate', () => {
    const gates = gatesFor(['a']);
    assert.equal(gates.isOpen('room.taskboard.0'), true);
    assert.equal(gates.isOpen('room.taskboard.1'), false);
    assert.equal(gates.isOpen('work.taskboard'), true);
});
