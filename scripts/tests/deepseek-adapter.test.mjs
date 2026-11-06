// DeepSeek agents run inside the deepseek-cc-mcp server, so its state
// directory (journal, per-job transcripts, thread files) is their only
// record. These cases replay the synthetic state under
// scripts/adapters/fixtures/deepseek through the adapter and the registry's
// normalization gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// ─── Hostile state files ─────────────────────────────────
//
// The deepseek-cc-mcp sandbox keeps agents from writing the state dir, so a
// stray FIFO, symlink or oversized file is not an attack here — but whatever
// a misbehaving local process leaves behind must never stall a scan, and the
// adapter must not read through a link outside the dir. The FIFO cases run
// in a child process with a watchdog: the failure mode is an open that never
// returns, which would hang the test run itself.

const HOSTILE_JOB_ID = 'ds_hostile1_00000001';
const HOSTILE_THREAD_ID = 'dsth_hostile1_00000001';
const ADAPTER_PATH = path.join(REPO_ROOT, 'claudeville', 'adapters', 'deepseek.js');

function hostileState(now) {
    const state = makeTempDir('claudeville-deepseek-hostile-');
    fs.mkdirSync(path.join(state, 'jobs', HOSTILE_JOB_ID), { recursive: true });
    fs.mkdirSync(path.join(state, 'threads'), { recursive: true });
    const line = (event, extra) => `\n${JSON.stringify({
        event,
        job_id: HOSTILE_JOB_ID,
        ts: now - 60_000,
        ...extra,
    })}\n`;
    fs.writeFileSync(path.join(state, 'journal.jsonl'),
        line('queued', { thread_id: HOSTILE_THREAD_ID, label: 'hostile', cwd: '/tmp/project' })
        + line('started', {
            session_id: HOSTILE_THREAD_ID,
            ts: now - 59_000,
            owner_pid: process.pid,
            owner_start: liveStartTime(),
            model: 'deepseek-flash',
        }));
    return state;
}

function writeHostileTranscript(state) {
    fs.writeFileSync(path.join(state, 'jobs', HOSTILE_JOB_ID, 'transcript.jsonl'),
        `${JSON.stringify({
            type: 'model',
            t_ms: 5,
            prompt_tokens: 100,
            cache_hit: 0,
            output_tokens: 10,
            reasoning_tokens: 0,
            cost_usd: 0.001,
            tools: [],
        })}\n`);
}

function mkfifo(file) {
    return spawnSync('mkfifo', [file], { encoding: 'utf8' }).status === 0;
}

// One scan in a child process: spawnSync's timeout kills a child that blocks
// on a FIFO open, so the assert reports the hang instead of joining it. The
// optional prelude runs before the scan (the swap race cases patch fs there).
function scanInChild(state, prelude = '') {
    const script = `
        ${prelude}
        const { DeepSeekAdapter } = require(${JSON.stringify(ADAPTER_PATH)});
        const sessions = new DeepSeekAdapter().getActiveSessions(${THRESHOLD_MS});
        console.log(JSON.stringify(sessions.map(session => ({
            name: session.agentName,
            prompt: session.lastPrompt,
            message: session.lastMessage,
            dialogue: session.dialogue && session.dialogue.text,
            tool: session.lastTool,
            turns: session.tokenUsage.turnCount,
        }))));
    `;
    return spawnSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, CLAUDEVILLE_DEEPSEEK_STATE_DIR: state },
        encoding: 'utf8',
        timeout: 15_000,
    });
}

// The adapter resolves its state dir at require time, so each in-process
// case re-requires it against the hostile dir (module caches reset with it).
function adapterFor(state) {
    process.env.CLAUDEVILLE_DEEPSEEK_STATE_DIR = state;
    delete require.cache[require.resolve(ADAPTER_PATH)];
    return new (require(ADAPTER_PATH).DeepSeekAdapter)();
}

test('a FIFO in place of the journal yields an empty scan, not a hang', (t) => {
    const state = hostileState(Date.now());
    fs.unlinkSync(path.join(state, 'journal.jsonl'));
    if (!mkfifo(path.join(state, 'journal.jsonl'))) return t.skip('mkfifo not available');
    const result = scanInChild(state);
    assert.equal(result.status, 0, `scan hung or failed: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), []);
});

test('FIFOs in the per-session paths never hang the scan and read as absent', (t) => {
    const state = hostileState(Date.now());
    const fifoFiles = [
        path.join(state, 'threads', `${HOSTILE_THREAD_ID}.json`),
        path.join(state, 'jobs', HOSTILE_JOB_ID, 'transcript.jsonl'),
        path.join(state, 'jobs', HOSTILE_JOB_ID, 'mission.txt'),
    ];
    if (!fifoFiles.every(file => mkfifo(file))) return t.skip('mkfifo not available');
    const result = scanInChild(state);
    assert.equal(result.status, 0, `scan hung or failed: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), [{
        name: 'hostile',
        prompt: null,
        message: null,
        dialogue: null,
        tool: null,
        turns: 0,
    }]);
});

test('symlinked thread, transcript and mission files are not read', () => {
    const state = hostileState(Date.now());
    const outside = makeTempDir('claudeville-deepseek-outside-');
    fs.writeFileSync(path.join(outside, 'thread.json'), JSON.stringify({
        messages: [{ role: 'assistant', content: 'outside answer', reasoning_content: 'outside thinking' }],
    }));
    fs.writeFileSync(path.join(outside, 'transcript.jsonl'), `${JSON.stringify({
        type: 'model',
        t_ms: 3,
        prompt_tokens: 900,
        cache_hit: 0,
        output_tokens: 90,
        reasoning_tokens: 9,
        cost_usd: 0.5,
        tools: ['Bash', 'Read'],
    })}\n`);
    fs.writeFileSync(path.join(outside, 'mission.txt'), 'outside mission');
    fs.symlinkSync(path.join(outside, 'thread.json'), path.join(state, 'threads', `${HOSTILE_THREAD_ID}.json`));
    fs.symlinkSync(path.join(outside, 'transcript.jsonl'), path.join(state, 'jobs', HOSTILE_JOB_ID, 'transcript.jsonl'));
    fs.symlinkSync(path.join(outside, 'mission.txt'), path.join(state, 'jobs', HOSTILE_JOB_ID, 'mission.txt'));

    const [session] = adapterFor(state).getActiveSessions(THRESHOLD_MS);
    assert.equal(session.agentName, 'hostile');
    assert.equal(session.lastPrompt, null);
    assert.equal(session.lastMessage, null);
    assert.equal(session.dialogue, null);
    assert.equal(session.observedSources.assistantText, false);
    assert.equal(session.lastTool, null);
    assert.equal(session.pendingTool, null);
    assert.equal(session.tokenUsage.turnCount, 0);
});

test('a thread file beyond the size cap is not read', () => {
    const state = hostileState(Date.now());
    writeHostileTranscript(state);
    // A sparse file with a real assistant message in the tail window: if the
    // adapter read it, the message would surface; the cap must refuse the open.
    const file = path.join(state, 'threads', `${HOSTILE_THREAD_ID}.json`);
    const body = JSON.stringify({ messages: [{ role: 'assistant', content: 'big file answer' }] });
    const size = 64 * 1024 * 1024 + 1;
    const fd = fs.openSync(file, 'w');
    try {
        fs.ftruncateSync(fd, size);
        fs.writeSync(fd, body, size - body.length);
    } finally {
        fs.closeSync(fd);
    }

    const [session] = adapterFor(state).getActiveSessions(THRESHOLD_MS);
    assert.equal(session.agentName, 'hostile');
    assert.equal(session.lastMessage, null);
    assert.equal(session.dialogue, null);
    assert.equal(session.observedSources.assistantText, false);
    // The valid transcript is still read: rejection is per file, not global.
    assert.equal(session.tokenUsage.turnCount, 1);
});

test('a thread file swapped for a symlink after lstat is not read', (t) => {
    if (!fs.constants.O_NOFOLLOW) return t.skip('O_NOFOLLOW not supported');
    const state = hostileState(Date.now());
    writeHostileTranscript(state);
    const outside = makeTempDir('claudeville-deepseek-outside-');
    const externalFile = path.join(outside, 'outside-thread.json');
    const outsideBody = JSON.stringify({
        messages: [{ role: 'assistant', content: 'outside answer', reasoning_content: 'outside thinking' }],
    });
    fs.writeFileSync(externalFile, outsideBody);
    const threadFile = path.join(state, 'threads', `${HOSTILE_THREAD_ID}.json`);
    // Same byte length as the outside file: a redirected read would use the
    // lstat size, and a shorter placeholder would truncate the outside
    // message into an unparseable window that hides the leak.
    fs.writeFileSync(threadFile, ' '.repeat(Buffer.byteLength(outsideBody)));
    // Swap the path for a symlink in the gap between openStateFile's lstat
    // and its open: without O_NOFOLLOW and the dev/ino check the open follows
    // the link and the outside file's answer would surface.
    const originalLstat = fs.lstatSync;
    let swapped = false;
    fs.lstatSync = function (file, ...args) {
        const stat = originalLstat.call(this, file, ...args);
        if (file === threadFile && !swapped) {
            swapped = true;
            fs.unlinkSync(threadFile);
            fs.symlinkSync(externalFile, threadFile);
        }
        return stat;
    };
    try {
        const [session] = adapterFor(state).getActiveSessions(THRESHOLD_MS);
        assert.equal(session.agentName, 'hostile');
        assert.equal(session.lastMessage, null);
        assert.equal(session.dialogue, null);
        assert.equal(session.observedSources.assistantText, false);
        assert.equal(session.observedSources.thinkingPlaintext, false);
        // The untouched transcript is still read: rejection is per file.
        assert.equal(session.tokenUsage.turnCount, 1);
    } finally {
        fs.lstatSync = originalLstat;
    }
});

test('a transcript swapped for a FIFO after its check cannot stall the scan', (t) => {
    const state = hostileState(Date.now());
    writeHostileTranscript(state);
    const replacement = path.join(makeTempDir('claudeville-deepseek-fifo-'), 'replacement');
    if (!mkfifo(replacement)) return t.skip('mkfifo not available');
    // Swap the transcript for a FIFO after the adapter's regular-file check
    // but before the shared reader opens it, while handing the reader the
    // stale regular-file stat: a plain 'r' open would block the scan forever.
    const transcript = path.join(state, 'jobs', HOSTILE_JOB_ID, 'transcript.jsonl');
    const prelude = `
        const fs = require('node:fs');
        const transcript = ${JSON.stringify(transcript)};
        const originalLstat = fs.lstatSync;
        const originalStat = fs.statSync;
        let checked = false;
        let swapped = false;
        fs.lstatSync = function (file, ...args) {
            const stat = originalLstat.call(this, file, ...args);
            if (file === transcript) checked = true;
            return stat;
        };
        fs.statSync = function (file, ...args) {
            const stat = originalStat.call(this, file, ...args);
            if (file === transcript && checked && !swapped) {
                swapped = true;
                fs.renameSync(${JSON.stringify(replacement)}, transcript);
                console.error('transcript replaced by FIFO after the regular-file check');
            }
            return stat;
        };
    `;
    const result = scanInChild(state, prelude);
    // A blocked scan dies on the spawn timeout instead of exiting 0.
    assert.equal(result.status, 0, `scan hung or failed: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), [{
        name: 'hostile',
        prompt: null,
        message: null,
        dialogue: null,
        tool: null,
        turns: 0,
    }]);
});
