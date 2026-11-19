import test from 'node:test';
import assert from 'node:assert/strict';

import { HARNESS_HUES, STATUS_VISUALS, TEAM_HUES } from '../../claudeville/src/config/theme.js';
import { agentTrimAccent, getTeamColor, harnessAccent } from '../../claudeville/src/presentation/shared/TeamColor.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';

// FK-7: a teammate's sash and crew rail wear the colour Claude Code gave it.

const HARNESS_NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

function linear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

function oklab(hex) {
    const [r, g, b] = rgb(hex).map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

const distance = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]));

function contrast(a, b) {
    const lum = (hex) => {
        const [r, g, b2] = rgb(hex).map(linear);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
    };
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('the eight harness colour names map to house hues', () => {
    assert.deepEqual(Object.keys(HARNESS_HUES), HARNESS_NAMES);
    for (const name of HARNESS_NAMES) {
        assert.match(HARNESS_HUES[name], /^#[0-9a-f]{6}$/);
        assert.equal(harnessAccent(name), HARNESS_HUES[name]);
    }
    assert.equal(harnessAccent(' Blue '), HARNESS_HUES.blue);
    assert.equal(new Set(Object.values(HARNESS_HUES)).size, 8);
});

test('unknown or absent harness colours map to nothing', () => {
    for (const value of [null, undefined, '', 'magenta', '#ff0000', 'constructor', 'toString', 42]) {
        assert.equal(harnessAccent(value), null, String(value));
    }
});

test('harness hues keep the painted accent contract, clear of status hues', () => {
    const status = [...new Set(Object.values(STATUS_VISUALS).map((visual) => visual.color))];
    const hues = Object.entries(HARNESS_HUES);
    for (const [name, hex] of hues) {
        const [L, a, b] = oklab(hex);
        assert.ok(L >= 0.58 && L <= 0.76, `${name} lightness ${L}`);
        assert.ok(Math.hypot(a, b) <= 0.105, `${name} chroma`);
        for (const tone of status) assert.ok(distance(hex, tone) >= 0.07, `${name} vs status ${tone}`);
        for (const [other, otherHex] of hues) {
            if (other !== name) assert.ok(distance(hex, otherHex) >= 0.045, `${name} vs ${other}`);
        }
        assert.ok(contrast(hex, '#15100d') >= 4.5, `${name} contrast on --bg-1`);
    }
});

test('the sash prefers the harness colour and keeps the team hash without one', () => {
    assert.equal(agentTrimAccent({ agentColor: 'green', teamName: 'session-lead' }), HARNESS_HUES.green);
    assert.equal(agentTrimAccent({ agentColor: 'green', teamName: null }), HARNESS_HUES.green);
    const hashed = getTeamColor('session-lead').accent;
    assert.ok(TEAM_HUES.includes(hashed));
    assert.equal(agentTrimAccent({ agentColor: null, teamName: 'session-lead' }), hashed);
    assert.equal(agentTrimAccent({ agentColor: 'magenta', teamName: 'session-lead' }), hashed);
    assert.equal(agentTrimAccent({ teamName: null }), null);
    assert.equal(agentTrimAccent(null), null);
    // One team, four teammates, four sashes.
    const sashes = ['blue', 'green', 'yellow', 'purple']
        .map((agentColor) => agentTrimAccent({ agentColor, teamName: 'session-lead' }));
    assert.equal(new Set(sashes).size, 4);
});

test('AgentManager passes agentColor through to the Agent and its updates', () => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const base = { sessionId: 'mate-1', project: '/work/council', turnState: 'working', lastActivity: Date.now(), teamName: 'session-lead' };
    manager.handleWebSocketMessage({ sessions: [{ ...base, agentColor: 'Purple' }, { ...base, sessionId: 'solo-1' }] });
    assert.equal(world.agents.get('mate-1').agentColor, 'purple');
    assert.equal(world.agents.get('solo-1').agentColor, null);
    manager.handleWebSocketMessage({ sessions: [{ ...base, agentColor: 'cyan' }, { ...base, sessionId: 'solo-1' }] });
    assert.equal(world.agents.get('mate-1').agentColor, 'cyan');
});
