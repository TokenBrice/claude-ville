// DeepSeek agents run inside the deepseek-cc-mcp server, so its state
// directory (journal, per-job transcripts, thread files) is their only
// record. These cases replay the synthetic state under
// scripts/adapters/fixtures/deepseek through the adapter and the registry's
// normalization gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'deepseek');
const THRESHOLD_MS = 2 * 60_000;
// No such pid: the kernel caps pids far below this.
const DEAD_PID = 2147483646;

function liveStartTime() {
    try {
        const stat = fs.readFileSync('/proc/self/stat', 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
        return null;
    }
}

function materialize(root, now) {
    const state = path.join(root, 'state');
    const project = path.join(root, 'project');
    const worktree = path.join(root, 'worktree');
    const fill = text => text
        .replaceAll('__PROJECT__', project)
        .replaceAll('__WORKTREE__', worktree)
        .replaceAll('__LIVE_PID__', String(process.pid))
        .replaceAll('__LIVE_START__', JSON.stringify(liveStartTime()))
        .replaceAll('__DEAD_PID__', String(DEAD_PID))
        .replace(/__T-(\d+)__/g, (_, seconds) => String(now - Number(seconds) * 1000));
    const copy = (from, to) => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(target, { recursive: true });
                copy(source, target);
                continue;
            }
            let text = fill(fs.readFileSync(source, 'utf8'));
            // The server writes threads with a bare JSON.stringify.
            if (path.basename(from) === 'threads') text = JSON.stringify(JSON.parse(text));
            fs.writeFileSync(target, text);
        }
    };
    fs.mkdirSync(state, { recursive: true });
    copy(FIXTURES, state);
    return { state, project, worktree };
}

const NOW = Date.now();
const ROOT = makeTempDir('claudeville-deepseek-');
const { state: STATE, project: PROJECT, worktree: WORKTREE } = materialize(ROOT, NOW);
process.env.CLAUDEVILLE_DEEPSEEK_STATE_DIR = STATE;
process.env.HOME = ROOT;
delete process.env.DEEPSEEK_CC_STATE_DIR;
delete process.env.USERPROFILE;

const { DeepSeekAdapter } = require('../../claudeville/adapters/deepseek.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');

const adapter = new DeepSeekAdapter();
const sessions = adapter.getActiveSessions(THRESHOLD_MS);
const byName = name => sessions.find(session => session.agentName === name);

test('the state directory is the provider home', () => {
    assert.equal(adapter.provider, 'deepseek');
    assert.equal(adapter.homeDir, STATE);
    assert.equal(adapter.isAvailable(), true);
});

test('recent threads are villagers; an old one and a forged journal id are not', () => {
    assert.deepEqual(sessions.map(session => session.agentName).sort(), ['lane-a', 'lane-b', 'lane-c']);
    assert.ok(sessions.every(session => session.sessionId.startsWith('deepseek-dsth_')));
});

test('a continued thread is one villager, running its unlogged call', () => {
    const session = byName('lane-a');
    assert.equal(session.sessionId, 'deepseek-dsth_mvt0aaaa_0000000a');
    assert.equal(session.agentId, 'dsth_mvt0aaaa_0000000a');
    assert.equal(session.agentType, 'main');
    assert.equal(session.project, PROJECT);
    assert.equal(session.model, 'deepseek-flash');
    // The continue job's own settings and prompt; the label carries over.
    assert.equal(session.reasoningEffort, 'max');
    assert.equal(session.lastPrompt, 'Now run the fixture tests.');
    assert.equal(session.turnStartedAt, NOW - 30_000);
    assert.equal(session.turnState, 'tool_pending');
    assert.equal(session.pendingTool, 'Bash');
    assert.equal(session.waitReason, null);
    assert.equal(session.lastTool, 'Bash');
    assert.equal(session.lastToolInput, null);
    assert.equal(session.apiError, null);
    assert.equal(session.lastTurnDurationMs, null);
    // Finished job from the journal plus the running job from its transcript.
    assert.equal(session.tokenUsage.input, 200 + 500);
    assert.equal(session.tokenUsage.cacheRead, 1000 + 1500);
    assert.equal(session.tokenUsage.output, 50 + 40);
    assert.equal(session.tokenUsage.reasoningTokens, 20 + 15);
    assert.equal(session.tokenUsage.reasoningInOutput, true);
    assert.equal(session.tokenUsage.contextWindow, 2000);
    assert.equal(session.tokenUsage.turnCount, 3);
    assert.equal(session.cost.source, 'provider');
    assert.ok(Math.abs(session.cost.usd - 0.013) < 1e-9);
});

test('speech is the last assistant message, found past quoted JSON in a tool result', () => {
    const session = byName('lane-a');
    assert.equal(session.dialogue.kind, 'thinking');
    assert.equal(session.dialogue.source, 'deepseek.reasoning');
    assert.equal(session.dialogue.text, 'Check the scripts in package.json before running the tests.');
    assert.equal(session.observedSources.thinkingPlaintext, true);
    // That message wrote no prose; an earlier job's answer is not current.
    assert.equal(session.lastMessage, null);
    assert.equal(session.observedSources.assistantText, false);
});

test('a failed job ends its turn in error, naming its last call without the cd hop', () => {
    const session = byName('lane-b');
    assert.equal(session.turnState, 'awaiting_input');
    assert.equal(session.awaitingSince, NOW - 10_000);
    assert.deepEqual(session.apiError, { kind: 'api_error', status: null, at: NOW - 10_000 });
    assert.equal(session.lastTurnDurationMs, 80_000);
    assert.equal(session.lastActivity, NOW - 10_000);
    assert.equal(session.lastTool, 'Bash');
    assert.equal(session.lastToolInput, 'npm test');
    assert.equal(session.lastMessage, 'Partial report.');
    assert.equal(session.dialogue.kind, 'assistant');
    assert.equal(session.tokenUsage.input, 100);
    assert.equal(session.tokenUsage.cacheRead, 300);
});

test('a job whose server is gone reads unknown, not working', () => {
    const session = byName('lane-c');
    assert.equal(session.turnState, 'unknown');
    assert.equal(session.pendingTool, null);
    assert.equal(session.lastTool, null);
});

test('the registry resolves the DeepSeek Flash identity at its effort', () => {
    const session = normalizeSession(byName('lane-a'));
    assert.equal(session.provider, 'deepseek');
    assert.equal(session.displayModel, 'DS Flash max');
    assert.equal(session.spriteId, 'agent.deepseek.flash.xhigh');
    assert.equal(session.cost.source, 'provider');
});

test('detail lists calls across the thread with workspace-relative paths', () => {
    const detail = adapter.getSessionDetail('deepseek-dsth_mvt0aaaa_0000000a', PROJECT);
    assert.deepEqual(detail.toolHistory.map(row => [row.tool, row.detail]), [
        ['Read', 'src/fixture.js'],
        ['Read', 'package.json'],
    ]);
    assert.deepEqual(detail.messages.map(row => [row.role, row.text]), [
        ['user', 'Summarize the fixture module.'],
        ['assistant', 'Fixture summary.'],
        ['user', 'Now run the fixture tests.'],
    ]);
    assert.equal(detail.tokenUsage.turnCount, 3);

    const worktreeDetail = adapter.getSessionDetail('deepseek-dsth_mvt0bbbb_0000000c', PROJECT);
    assert.deepEqual(worktreeDetail.toolHistory.map(row => row.detail), ['src/fixture.js', 'npm test']);
    assert.ok(!worktreeDetail.toolHistory.some(row => row.detail.includes(WORKTREE)));

    assert.deepEqual(adapter.getSessionDetail('deepseek-dsth_mvt0zzzz_0000000f', PROJECT).toolHistory, []);
});

test('watch paths cover the journal and the transcripts of unfinished jobs', () => {
    const watched = adapter.getWatchPaths({ sessions })
        .map(entry => [entry.type, entry.kind, path.relative(STATE, entry.path) || '.'])
        .sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
    assert.deepEqual(watched, [
        ['directory', 'discovery', '.'],
        ['file', 'discovery', 'journal.jsonl'],
        ['file', 'transcript', 'jobs/ds_mvt0aaab_0000000b/transcript.jsonl'],
        ['file', 'transcript', 'jobs/ds_mvt0cccc_0000000d/transcript.jsonl'],
    ]);
});
