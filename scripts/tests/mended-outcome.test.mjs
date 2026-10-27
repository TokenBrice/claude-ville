// D2 — the Mended Mark: same agent + same tool + same normalized shell
// command fails with a real exit code, then passes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { ChronicleEventKind, ChronicleLog, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../claudeville/src/domain/services/VerifiedOutcome.js';
import { AgentAction, resolveAgentAction } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import { AgentEventStream } from '../../claudeville/src/presentation/character-mode/AgentEventStream.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import {
    MEND_QUIET_MS,
    MEND_WINDOW_MS,
    MendLedger,
    commandSignature,
} from '../../claudeville/src/presentation/character-mode/OutcomeMends.js';

const T0 = 1_800_000_000_000;

function result(id, exitCode, { at = T0, agentId = 'a1', tool = 'Bash', detail = 'npm test', source = 'exit' } = {}) {
    return { id, agentId, tool, detail, exitCode, exitCodeSource: exitCode === null ? null : source, completedAt: at, building: 'taskboard' };
}

test('the command signature keeps what changes the exit code and drops what does not', () => {
    assert.equal(commandSignature('Bash', 'npm test'), 'npm test');
    assert.equal(commandSignature('Bash', '  GIT_CEILING_DIRECTORIES=/x  npm   run validate:quick 2>&1 '), 'npm run validate:quick');
    assert.equal(commandSignature('Bash', 'node --test scripts/tests/a.test.mjs 2>&1 | tail -5'), 'node --test scripts/tests/a.test.mjs | tail -5');
    assert.equal(commandSignature('exec_command', './run-thing'), './run-thing');
    // A search (exit 1 on no match), a read, git (the Harbor's) or a non-shell tool: no mend.
    assert.equal(commandSignature('Bash', 'rg -n foo src'), null);
    assert.equal(commandSignature('Bash', 'cat package.json'), null);
    assert.equal(commandSignature('Bash', 'git push origin main'), null);
    assert.equal(commandSignature('Edit', 'npm test'), null);
    assert.equal(commandSignature('functions.write_stdin', 'npm test'), null);
    // A summary the adapter may have cut (80 characters, no marker) is ambiguous.
    assert.equal(commandSignature('Bash', `node --test ${'x'.repeat(80)}`), null);
    assert.equal(commandSignature('Bash', ''), null);
});

test('fail with a real exit, then pass: one mend', () => {
    const ledger = new MendLedger();
    assert.equal(ledger.observe(result('f', 1)), null);
    const mend = ledger.observe(result('p', 0, { at: T0 + 60_000 }));
    assert.equal(mend.agentId, 'a1');
    assert.equal(mend.signature, 'npm test');
    assert.equal(mend.failedId, 'f');
    assert.equal(mend.failedExit, 1);
    assert.equal(mend.resultId, 'p');
    // The failure is closed: another pass mends nothing.
    assert.equal(ledger.observe(result('p2', 0, { at: T0 + 61_000 })), null);
});

// RG-10 — the adapters strip `cd <dir> &&`, so `cd api && npm test` and
// `cd web && npm test` share the summary `npm test`; their locations differ.
test('the same summary passing in another directory is not a mend', () => {
    const ledger = new MendLedger();
    const at = (location, id, exitCode, offset) => ({ ...result(id, exitCode, { at: T0 + offset }), location });
    assert.equal(ledger.observe(at('aaaa0001', 'api-fail', 1, 0)), null);
    assert.equal(ledger.observe(at('bbbb0002', 'web-pass', 0, 1000)), null, 'web passing never mends api');
    const mend = ledger.observe(at('aaaa0001', 'api-pass', 0, 2000));
    assert.equal(mend?.failedId, 'api-fail', 'api passing in api mends api');
});

test('flag-only and unknown failures never open a mend; unknown never closes one', () => {
    const ledger = new MendLedger();
    ledger.observe(result('flag', 1, { source: 'flag' }));
    assert.equal(ledger.observe(result('pass', 0, { at: T0 + 1000, source: 'flag' })), null, 'an is_error refusal is not a failed command');
    ledger.observe(result('fail', 2));
    assert.equal(ledger.observe(result('unknown', null, { at: T0 + 2000 })), null);
    assert.equal(ledger.openCount, 1, 'an unknown exit leaves the failure open');
    assert.ok(ledger.observe(result('pass2', 0, { at: T0 + 3000 })));
});

test('RG-11: an OMP or Kimi flagged failure mends when the same command passes', () => {
    for (const provider of ['omp', 'kimi']) {
        const ledger = new MendLedger();
        ledger.observe({ ...result('fail', 1, { source: 'flag' }), provider });
        const mend = ledger.observe({ ...result('pass', 0, { at: T0 + 1000, source: 'flag' }), provider });
        assert.ok(mend, `${provider}: its flag is its outcome`);
        assert.equal(mend.failedExit, 1);
    }
    const claude = new MendLedger();
    claude.observe({ ...result('fail', 1, { source: 'flag' }), provider: 'claude' });
    assert.equal(claude.openCount, 0, 'a Claude refusal never opens a mend');
});

test('a different command, tool or agent passing never mends', () => {
    const ledger = new MendLedger();
    ledger.observe(result('f', 1));
    assert.equal(ledger.observe(result('p1', 0, { detail: 'npm run build' })), null);
    assert.equal(ledger.observe(result('p2', 0, { tool: 'exec_command' })), null);
    assert.equal(ledger.observe(result('p3', 0, { agentId: 'a2' })), null);
    assert.equal(ledger.observe(result('p4', 0, { detail: 'npm test | tail -3' })), null);
    assert.ok(ledger.observe(result('p5', 0, { detail: 'CI=1 npm test' })), 'an env prefix is the same command');
});

test('old failures expire, a flaky loop mends once per quiet window, memory is bounded', () => {
    const ledger = new MendLedger({ openLimit: 4 });
    ledger.observe(result('old', 1));
    assert.equal(ledger.observe(result('late', 0, { at: T0 + MEND_WINDOW_MS + 1 })), null);

    ledger.observe(result('f1', 1, { at: T0 }));
    assert.ok(ledger.observe(result('p1', 0, { at: T0 + 1000 })));
    ledger.observe(result('f2', 1, { at: T0 + 2000 }));
    assert.equal(ledger.observe(result('p2', 0, { at: T0 + 3000 })), null, 'quiet after a mend');
    ledger.observe(result('f3', 1, { at: T0 + 1000 + MEND_QUIET_MS }));
    assert.ok(ledger.observe(result('p3', 0, { at: T0 + 2000 + MEND_QUIET_MS })));

    for (let i = 0; i < 10; i++) ledger.observe(result(`b${i}`, 1, { detail: `./step-${i}` }));
    assert.equal(ledger.openCount, 4);
    ledger.forgetAgent('a1');
    assert.equal(ledger.openCount, 0);
});

function claudeSession(lastResults) {
    return {
        sessions: [{
            sessionId: 'mend-agent',
            provider: 'claude',
            project: '/work/mends',
            status: 'active',
            turnState: 'working',
            lastActivity: Date.now(),
            lastTool: 'Bash',
            lastToolInput: 'npm test',
            lastResults,
        }],
    };
}

test('the stream mends live results: chit to stone, celebrate pose, Chronicle line', async (t) => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const stream = new AgentEventStream(world);
    const buildings = new Map([['taskboard', { position: { tileX: 10, tileY: 10 }, width: 4, height: 4, entrance: { tileX: 12, tileY: 13 } }]]);
    const activity = new LandmarkActivity({ world: { buildings } });
    const records = [];
    const log = new ChronicleLog({ store: { async put(_s, record) { records.push(record); }, async queryRange() { return []; } } }).start();
    const mends = [];
    const outcomes = [];
    const offs = [
        eventBus.on('outcome:mended', mend => mends.push(mend)),
        eventBus.on(VERIFIED_OUTCOME_EVENT, outcome => outcomes.push(outcome)),
    ];
    t.after(async () => {
        offs.forEach(off => off());
        stream.dispose();
        activity.dispose();
        await log.stop();
    });

    const now = Date.now();
    const fail = { id: 'claude:mend:f', tool: 'Bash', detail: 'npm test', exitCode: 1, exitCodeSource: 'exit', durationMs: 900, completedAt: now, source: 'transcript' };
    const pass = { ...fail, id: 'claude:mend:p', exitCode: 0, completedAt: now + 5 };
    manager.handleWebSocketMessage(claudeSession([fail]));
    const broken = activity.items.get('outcome:claude:mend:f');
    assert.equal(broken?.failed, true);
    assert.equal(broken.building, 'taskboard');

    manager.handleWebSocketMessage(claudeSession([pass, fail]));
    assert.equal(mends.length, 1);
    assert.equal(mends[0].signature, 'npm test');
    assert.equal(activity.items.has('outcome:claude:mend:f'), false, 'the broken chit gives way');
    const mended = activity.items.get('outcome:claude:mend:p');
    assert.equal(mended.failed, false);
    assert.equal(mended.detail, 'mended');
    assert.ok(Number.isFinite(mended.mendedAt));

    const outcome = outcomes.find(item => item.kind === 'mended');
    assert.equal(outcome.agentId, 'mend-agent');
    const agent = world.agents.get('mend-agent');
    assert.equal(resolveAgentAction(agent, { now: outcome.at + 1000 }), AgentAction.CELEBRATE);
    assert.notEqual(resolveAgentAction(agent, { now: outcome.at + 6000 }), AgentAction.CELEBRATE);

    // A replayed poll mends nothing again.
    manager.handleWebSocketMessage(claudeSession([pass, fail]));
    assert.equal(mends.length, 1);

    await log.flush();
    const line = records.find(record => record.kind === ChronicleEventKind.MENDED);
    assert.equal(line.label, 'npm test');
    assert.equal(line.failedExit, 1);
    assert.equal(summarizeDay(records).mends, 1);
});

test('a reload never mends a failure it did not watch', (t) => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const now = Date.now();
    const fail = { id: 'claude:reload:f', tool: 'Bash', detail: 'npm test', exitCode: 1, exitCodeSource: 'exit', durationMs: 900, completedAt: now - 60_000, source: 'transcript' };
    manager.handleWebSocketMessage(claudeSession([fail]));
    const stream = new AgentEventStream(world);
    const mends = [];
    const off = eventBus.on('outcome:mended', mend => mends.push(mend));
    t.after(() => { off(); stream.dispose(); });
    const pass = { ...fail, id: 'claude:reload:p', exitCode: 0, completedAt: now + 5 };
    manager.handleWebSocketMessage(claudeSession([pass, fail]));
    assert.equal(mends.length, 0);
});
