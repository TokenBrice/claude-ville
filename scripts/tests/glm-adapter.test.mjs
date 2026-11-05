// GLM agents run as headless Claude Code inside the glm-cc-mcp server's
// jails, each thread with its own CLAUDE_CONFIG_DIR, so the server's state
// directory (journal, thread files, the per-thread Claude Code transcript) is
// their only record. These cases replay the synthetic state under
// scripts/adapters/fixtures/glm through the adapter and the registry's
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
const FIXTURES = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'glm');
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

// Claude Code's project directory name for a cwd.
const slug = dir => dir.replace(/[^a-zA-Z0-9]/g, '-');

function materialize(root, now) {
    const state = path.join(root, 'state');
    const project = path.join(root, 'project');
    const worktree = path.join(root, 'worktree');
    const fill = text => text
        .replaceAll('__PROJECT_SLUG__', slug(project))
        .replaceAll('__WORKTREE_SLUG__', slug(worktree))
        .replaceAll('__PROJECT__', project)
        .replaceAll('__WORKTREE__', worktree)
        .replaceAll('__LIVE_PID__', String(process.pid))
        .replaceAll('__LIVE_START__', JSON.stringify(liveStartTime()))
        .replaceAll('__DEAD_PID__', String(DEAD_PID))
        .replace(/__T-(\d+)__/g, (_, seconds) => String(now - Number(seconds) * 1000))
        .replace(/__ISO-(\d+)__/g, (_, seconds) => new Date(now - Number(seconds) * 1000).toISOString());
    const copy = (from, to) => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, fill(entry.name));
            if (entry.isDirectory()) {
                fs.mkdirSync(target, { recursive: true });
                copy(source, target);
                continue;
            }
            fs.writeFileSync(target, fill(fs.readFileSync(source, 'utf8')));
        }
    };
    fs.mkdirSync(state, { recursive: true });
    copy(FIXTURES, state);
    for (const dir of [project, path.join(worktree, 'src')]) fs.mkdirSync(dir, { recursive: true });
    // lane-link's thread home holds a planted link where its transcript goes.
    const linkDir = path.join(state, 'threads', 'glmth_mvt0ffff_00000010', 'home', 'projects', slug(project));
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(
        path.join(state, 'threads', 'glmth_mvt0aaaa_0000000a', 'home', 'projects', slug(project), '11111111-1111-4111-8111-111111111111.jsonl'),
        path.join(linkDir, '66666666-6666-4666-8666-666666666666.jsonl'),
    );
    return { state, project, worktree };
}

const NOW = Date.now();
const ROOT = makeTempDir('claudeville-glm-');
const { state: STATE, project: PROJECT, worktree: WORKTREE } = materialize(ROOT, NOW);
process.env.CLAUDEVILLE_GLM_STATE_DIR = STATE;
process.env.HOME = ROOT;
delete process.env.GLM_CC_STATE_DIR;
delete process.env.USERPROFILE;

const { GlmAdapter } = require('../../claudeville/adapters/glm.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');

const adapter = new GlmAdapter();
const sessions = adapter.getActiveSessions(THRESHOLD_MS);
const byName = name => sessions.find(session => session.agentName === name);

test('the state directory is the provider home, under the z.AI provider', () => {
    assert.equal(adapter.provider, 'zai');
    assert.equal(adapter.name, 'GLM MCP');
    assert.equal(adapter.homeDir, STATE);
    assert.equal(adapter.isAvailable(), true);
});

test('recent threads are villagers; an old one and a forged journal id are not', () => {
    assert.deepEqual(sessions.map(session => session.agentName).sort(), ['lane-a', 'lane-b', 'lane-c', 'lane-d', 'lane-link']);
    assert.ok(sessions.every(session => session.sessionId.startsWith('zai-glmth_')));
    assert.ok(sessions.every(session => session.headless === true && session.agentType === 'main'));
});

test('a continued thread is one villager, read from its Claude Code transcript', () => {
    const session = byName('lane-a');
    assert.equal(session.sessionId, 'zai-glmth_mvt0aaaa_0000000a');
    assert.equal(session.agentId, 'glmth_mvt0aaaa_0000000a');
    assert.equal(session.project, PROJECT);
    // The continue job's own settings and prompt; the label carries over.
    assert.equal(session.model, 'glm-5.3');
    assert.equal(session.reasoningEffort, 'max');
    assert.equal(session.lastPrompt, 'Now run the fixture tests.');
    assert.equal(session.turnStartedAt, NOW - 30_000);
    assert.equal(session.turnState, 'tool_pending');
    assert.equal(session.pendingTool, 'Bash');
    assert.equal(session.waitReason, null);
    assert.equal(session.lastTool, 'Bash');
    assert.equal(session.lastToolInput, 'npm test');
    assert.equal(session.apiError, null);
    assert.equal(session.dialogue.kind, 'intent');
    assert.equal(session.dialogue.text, 'Run the fixture tests');
});

test('a message split over several records counts its usage once', () => {
    const usage = byName('lane-a').tokenUsage;
    assert.equal(usage.input, 100 + 50 + 80);
    assert.equal(usage.cacheRead, 0 + 100 + 150);
    assert.equal(usage.output, 20 + 10 + 15);
    assert.equal(usage.turnCount, 3);
    assert.equal(usage.contextWindow, 80 + 150);
});

test('normalization gives the z.AI identity and a registry cost estimate', () => {
    const session = normalizeSession(byName('lane-a'));
    assert.equal(session.provider, 'zai');
    assert.equal(session.spriteId, 'agent.zai.glm');
    assert.equal(session.headless, true);
    // Claude Code prices a model it does not know; that figure is dropped.
    assert.equal(session.cost.source, 'estimate');
    assert.equal(session.cost.rateMatch, 'glm-5-3');
    assert.equal(session.cost.unknownModel, false);
});

test('a failed job in a worktree closes its turn in error', () => {
    const session = byName('lane-b');
    assert.equal(session.project, WORKTREE);
    assert.equal(session.turnState, 'awaiting_input');
    assert.equal(session.awaitingSince, NOW - 60_000);
    assert.deepEqual(session.apiError, { kind: 'quota_exhausted', status: null, at: NOW - 60_000 });
    assert.equal(session.lastTurnDurationMs, 30_000);
    assert.equal(session.lastPrompt, 'Fix the off-by-one in src/a.js.');
    assert.deepEqual(session.workingSet.map(item => [item.path, item.op]), [['src/a.js', 'write']]);
});

test('an unfinished job whose server is gone is unknown, prompted by its mission', () => {
    const session = byName('lane-c');
    assert.equal(session.turnState, 'unknown');
    assert.equal(session.model, 'glm-5.3-flash');
    assert.equal(session.lastPrompt, 'Summarize the open issues in this repository.');
    assert.equal(session.tokenUsage, null);
});

test('a cancelled job ends its turn without an error', () => {
    const session = byName('lane-d');
    assert.equal(session.turnState, 'awaiting_input');
    assert.equal(session.apiError, null);
});

test('a link planted where a transcript belongs is never read', () => {
    const session = byName('lane-link');
    // Live, with nothing readable yet: the server says it works.
    assert.equal(session.turnState, 'working');
    assert.equal(session.tokenUsage, null);
    assert.equal(session.lastTool, null);
    assert.equal(session.lastPrompt, null);
});

test('detail reads the thread transcript', () => {
    const detail = adapter.getSessionDetail('zai-glmth_mvt0aaaa_0000000a', PROJECT);
    assert.deepEqual(detail.toolHistory.map(item => item.tool), ['Read', 'Bash']);
    assert.ok(detail.messages.some(item => item.role === 'assistant' && item.text === 'The README describes the fixture.'));
    assert.equal(detail.tokenUsage.input, 230);
    const missing = adapter.getSessionDetail('zai-glmth_mvt0zzzz_000000ff', PROJECT);
    assert.deepEqual(missing.toolHistory, []);
});

test('watch paths cover the journal and running transcripts only', () => {
    const paths = adapter.getWatchPaths({ sessions });
    assert.deepEqual(paths.filter(item => item.kind === 'discovery').map(item => item.path).sort(), [STATE, path.join(STATE, 'journal.jsonl')].sort());
    assert.deepEqual(paths.filter(item => item.kind === 'transcript').map(item => item.sessionId), ['zai-glmth_mvt0aaaa_0000000a']);
});
