import test from 'node:test';
import assert from 'node:assert/strict';

import { resultBuilding } from '../../claudeville/src/presentation/character-mode/AgentEventStream.js';
import { homeDistrictFor, updateHomeDistrictContext } from '../../claudeville/src/presentation/character-mode/HomeDistrict.js';

const worker = (extra = {}) => ({
    id: 'chit-worker', sessionId: 'chit-worker', status: 'working', projectPath: '/work/chits', ...extra,
});

// AG-3 follow-up: an outcome lands where the body worked the call.
test('an unrecognized shell outcome lands in the home district, not at Command', () => {
    const agent = worker();
    const home = homeDistrictFor(agent);
    assert.equal(resultBuilding(agent, { tool: 'Bash', detail: 'echo ready' }), home);
    // Recognized commands and orchestration keep their own buildings.
    assert.equal(resultBuilding(agent, { tool: 'Bash', detail: 'npm test' }), 'taskboard');
    assert.equal(resultBuilding(agent, { tool: 'Edit', detail: 'src/index.js' }), 'forge');
    assert.equal(resultBuilding(agent, { tool: 'SendMessage', detail: 'lane-04' }), 'command');
    assert.equal(resultBuilding(agent, { tool: null, detail: null }), null);
});

test('unknown shell calls never pull a project home toward Command', () => {
    const now = 1_800_000_000_000;
    const sprites = Array.from({ length: 6 }, (_, i) => ({
        agent: { id: `sh-${i}`, sessionId: `sh-${i}`, projectPath: '/work/shell-heavy', currentTool: 'Bash', currentToolInput: `./run-thing-${i}` },
    }));
    updateHomeDistrictContext(sprites, now);
    const homes = [];
    for (let i = 0; i < 64; i++) homes.push(homeDistrictFor({ id: `probe-${i}`, sessionId: `probe-${i}`, projectPath: '/work/shell-heavy' }, { now }));
    // Seven work districts share 64 homes evenly (about 9 each); a Command
    // bias from six shell calls (weight 5 against 1) would take about half.
    const atCommand = homes.filter(type => type === 'command').length;
    assert.ok(new Set(homes).size > 3);
    assert.ok(atCommand < 20, `${atCommand} of 64 homes at Command`);
});
