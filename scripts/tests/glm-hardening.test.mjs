// Hardening cases for the GLM adapter's reads of the glm-cc-mcp state
// directory. The thread home is the one subtree a jailed agent may write, so
// nothing planted there — links, oversized or non-regular thread metadata, a
// transcript swapped around the checks — may steer a read outside the state
// dir or stall a scan. The journal may roll its bounded tail over live jobs,
// and expired history must not touch the disk on a warm scan. The usage
// dedupe cases cover the Claude readers GLM shares (`claudeTranscript`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
const TID = 'glmth_mvt0aaaa_0000000a';
const SESSION = '11111111-1111-4111-8111-111111111111';

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
    const fill = text => text
        .replaceAll('__PROJECT_SLUG__', slug(project))
        .replaceAll('__WORKTREE_SLUG__', slug(path.join(root, 'worktree')))
        .replaceAll('__PROJECT__', project)
        .replaceAll('__WORKTREE__', path.join(root, 'worktree'))
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
    fs.mkdirSync(project, { recursive: true });
    return { state, project };
}

const NOW = Date.now();
const ROOT = makeTempDir('claudeville-glm-hardening-');
const { state: STATE, project: PROJECT } = materialize(ROOT, NOW);
process.env.CLAUDEVILLE_GLM_STATE_DIR = STATE;
process.env.HOME = ROOT;
delete process.env.GLM_CC_STATE_DIR;
delete process.env.USERPROFILE;

const { GlmAdapter } = require('../../claudeville/adapters/glm.js');
const { claudeTranscript } = require('../../claudeville/adapters/claude.js');

const adapter = new GlmAdapter();
const transcriptOf = () => path.join(STATE, 'threads', TID, 'home', 'projects', slug(PROJECT), `${SESSION}.jsonl`);
const threadFileOf = () => path.join(STATE, 'threads', `${TID}.json`);
const journal = path.join(STATE, 'journal.jsonl');
const SECRET_TEXT = 'synthetic private marker';
const liveThread = () => adapter.getActiveSessions(THRESHOLD_MS).find(session => session.agentId === TID);
const secretRows = () => [
    {
        type: 'assistant', timestamp: new Date(NOW - 1000).toISOString(),
        message: {
            role: 'assistant', id: 'msg_secret', model: 'glm-5.3',
            content: [{ type: 'text', text: SECRET_TEXT }], usage: { input_tokens: 7, output_tokens: 2 },
        },
    },
];
const writeSecretOutside = () => {
    const outside = path.join(ROOT, 'outside-state');
    fs.mkdirSync(outside, { recursive: true });
    const file = path.join(outside, `${SESSION}.jsonl`);
    fs.writeFileSync(file, secretRows().map(row => JSON.stringify(row)).join('\n') + '\n');
    return file;
};
// Swap `file` for a link to `target`, keeping the original aside.
const swapForLink = (file, target) => {
    fs.renameSync(file, `${file}.original`);
    fs.symlinkSync(target, file);
};
const restoreFromLink = (file) => {
    fs.unlinkSync(file);
    fs.renameSync(`${file}.original`, file);
};

test('R1: a symlinked parent directory never serves the transcript it hides', () => {
    assert.ok(adapter.getSessionDetail(`zai-${TID}`, PROJECT).messages.length > 0, 'baseline: the transcript is readable');
    const secret = writeSecretOutside();
    const projectsDir = path.dirname(transcriptOf());
    fs.renameSync(projectsDir, `${projectsDir}-original`);
    fs.symlinkSync(path.dirname(secret), projectsDir);
    try {
        const session = liveThread();
        assert.ok(session, 'the live thread stays a villager');
        assert.equal(session.dialogue, null);
        const detail = adapter.getSessionDetail(`zai-${TID}`, PROJECT);
        assert.deepEqual(detail.messages, []);
        assert.equal(JSON.stringify(detail).includes(SECRET_TEXT), false);
    } finally {
        fs.unlinkSync(projectsDir);
        fs.renameSync(`${projectsDir}-original`, projectsDir);
    }
    assert.ok(adapter.getSessionDetail(`zai-${TID}`, PROJECT).messages.length > 0, 'restored: the transcript is readable again');
});

test('R1: a transcript swapped for a link after validation fails closed', () => {
    assert.ok(adapter.getSessionDetail(`zai-${TID}`, PROJECT).messages.length > 0, 'baseline: the transcript is readable');
    swapForLink(transcriptOf(), writeSecretOutside());
    try {
        const detail = adapter.getSessionDetail(`zai-${TID}`, PROJECT);
        assert.deepEqual(detail.messages, []);
        assert.equal(JSON.stringify(detail).includes(SECRET_TEXT), false);
        const session = liveThread();
        assert.ok(session);
        assert.equal(session.dialogue, null);
        assert.ok(!session.tokenUsage || session.tokenUsage.availability === 'unavailable');
    } finally {
        restoreFromLink(transcriptOf());
    }
});

// The jailed agent's best case: swap the transcript for a link to private
// data around the reader's own open. That one double swap can still win (a
// known, accepted risk — display only and local); what must never happen is
// the swapped read's content surviving anywhere once its bracket rejects it.
test('R2: oversized thread metadata is rejected without opening it', () => {
    const threadFile = threadFileOf();
    const original = fs.readFileSync(threadFile, 'utf8');
    fs.writeFileSync(threadFile, JSON.stringify({ claude_session: SESSION, cwd: PROJECT, padding: 'x'.repeat(80 * 1024) }));
    let opens = 0;
    const openSync = fs.openSync;
    fs.openSync = function (file, ...args) {
        if (file === threadFile) opens++;
        return openSync.call(fs, file, ...args);
    };
    try {
        const session = liveThread();
        assert.ok(session, 'the live thread stays a villager');
        assert.equal(opens, 0, 'an oversized thread file is never opened');
        assert.equal(session.tokenUsage, null, 'no transcript is placed from rejected metadata');
    } finally {
        fs.openSync = openSync;
        fs.writeFileSync(threadFile, original);
    }
});

// The scan runs in a child process: a blocking read of the FIFO is the very
// defect, and no in-process timeout can interrupt a blocked synchronous call.
test('R2: a FIFO where thread metadata belongs never blocks the scan', { timeout: 20_000 }, async () => {
    const threadFile = threadFileOf();
    const original = fs.readFileSync(threadFile, 'utf8');
    fs.unlinkSync(threadFile);
    execFileSync('mkfifo', [threadFile]);
    try {
        const childScript = `
          const { GlmAdapter } = require(${JSON.stringify(path.join(REPO_ROOT, 'claudeville/adapters/glm.js'))});
          const sessions = new GlmAdapter().getActiveSessions(${THRESHOLD_MS});
          const session = sessions.find(item => item.agentId === ${JSON.stringify(TID)});
          process.stdout.write(session && session.tokenUsage === null ? 'returned' : 'missing');
        `;
        const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '-e', childScript], {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        const done = new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code, signal) => resolve({ code, signal }));
        });
        const outcome = await Promise.race([
            done,
            new Promise(resolve => setTimeout(() => resolve({ code: null, signal: null }), 10_000)),
        ]);
        if (outcome.signal === null && outcome.code === null) child.kill('SIGKILL');
        assert.equal(outcome.code, 0, 'the scan must return instead of blocking on the FIFO');
        assert.equal(out, 'returned', 'the live thread is served without its metadata');
    } finally {
        fs.unlinkSync(threadFile);
        fs.writeFileSync(threadFile, original);
    }
});

test('R2: a symlink where thread metadata belongs is never followed', () => {
    const threadFile = threadFileOf();
    const original = fs.readFileSync(threadFile, 'utf8');
    // Valid metadata outside the state dir: following the link would place the
    // thread's real transcript and report tokens.
    const linkedMetadata = path.join(ROOT, 'linked-metadata.json');
    fs.writeFileSync(linkedMetadata, original);
    fs.renameSync(threadFile, `${threadFile}.original`);
    fs.symlinkSync(linkedMetadata, threadFile);
    try {
        const session = liveThread();
        assert.ok(session, 'the live thread stays a villager');
        assert.equal(session.tokenUsage, null, 'linked metadata places no transcript');
    } finally {
        fs.unlinkSync(threadFile);
        fs.renameSync(`${threadFile}.original`, threadFile);
        fs.unlinkSync(linkedMetadata);
    }
});

test('R5: a live thread survives the journal tail rolling over it', () => {
    assert.ok(liveThread(), 'baseline: the continued thread is live');
    const freshJob = i => ({
        event: 'started', ts: NOW, job_id: `glm_roll${i.toString(36)}_00000001`,
        session_id: `glmth_roll${i.toString(36)}_00000001`, owner_pid: DEAD_PID, cwd: PROJECT,
    });
    fs.appendFileSync(journal, Array.from({ length: 4001 }, (_, i) => `\n${JSON.stringify(freshJob(i))}\n`).join(''));
    const session = liveThread();
    assert.ok(session, 'the live thread survives 4,001 newer journal events');
    assert.equal(session.turnState, 'tool_pending', 'its transcript still reads through the roll');
    const detail = adapter.getSessionDetail(`zai-${TID}`, PROJECT);
    assert.ok(detail.messages.length > 0);
});

test('R5: journal rotation and truncation reset retention safely', () => {
    const original = fs.readFileSync(journal, 'utf8');
    // Rotation: a brand-new journal that names none of the known threads.
    fs.writeFileSync(journal, `\n${JSON.stringify({ event: 'started', ts: Date.now(), job_id: 'glm_rot0_00000002', session_id: 'glmth_rot0_00000002', owner_pid: DEAD_PID, cwd: PROJECT })}\n`);
    assert.ok(liveThread(), 'a live retained thread survives rotation');
    // Truncation to nothing: the window names nothing, retention still holds.
    fs.writeFileSync(journal, '');
    assert.ok(liveThread(), 'an empty journal still scans and retains the live thread');
    // The journal disappearing entirely.
    fs.unlinkSync(journal);
    assert.deepEqual(adapter.getActiveSessions(THRESHOLD_MS), []);
    // And back again.
    fs.writeFileSync(journal, original);
    assert.ok(liveThread(), 'the restored journal rebuilds normally');
});

test('R6: expired completed threads cost no metadata read on a warm scan', () => {
    const historical = [];
    for (let i = 0; i < 600; i++) {
        const suffix = `${i.toString(36)}_000000aa`;
        historical.push({ event: 'started', ts: NOW - 7_200_000, job_id: `glm_hist${suffix}`, session_id: `glmth_hist${suffix}`, owner_pid: DEAD_PID, cwd: PROJECT });
        historical.push({ event: 'finished', ts: NOW - 3_600_000, job_id: `glm_hist${suffix}`, session_id: `glmth_hist${suffix}`, status: 'succeeded' });
        fs.writeFileSync(path.join(STATE, 'threads', `glmth_hist${suffix}.json`), JSON.stringify({ claude_session: SESSION, cwd: PROJECT }));
    }
    const original = fs.readFileSync(journal, 'utf8');
    fs.writeFileSync(journal, historical.map(record => `\n${JSON.stringify(record)}\n`).join(''));
    try {
        adapter.getActiveSessions(THRESHOLD_MS);
        let opens = 0;
        const openSync = fs.openSync;
        fs.openSync = function (file, ...args) {
            if (String(file).includes('glmth_hist')) opens++;
            return openSync.call(fs, file, ...args);
        };
        try {
            const sessions = adapter.getActiveSessions(THRESHOLD_MS);
            assert.equal(opens, 0, 'expired history reads no metadata on a warm scan');
            assert.equal(sessions.some(session => session.agentId.startsWith('glmth_hist')), false);
            assert.ok(sessions.some(session => session.agentId === TID), 'the live thread still reports');
        } finally {
            fs.openSync = openSync;
        }
    } finally {
        fs.writeFileSync(journal, original);
    }
});

// ─── Claude usage dedupe (the readers GLM shares) ───────

const usageRow = (id, usage) => ({
    type: 'assistant', timestamp: new Date(NOW - 1000).toISOString(),
    message: {
        role: 'assistant', id, model: 'glm-5.3',
        content: [{ type: 'text', text: 'synthetic' }], usage,
    },
});
const tokenUsageOf = rows => {
    const file = path.join(ROOT, `usage-${tokenUsageOf.count = (tokenUsageOf.count || 0) + 1}.jsonl`);
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return claudeTranscript.tokenUsage(file);
};

test('R3: a repeated message id keeps the fields its usage omits', () => {
    const usage = tokenUsageOf([
        usageRow('msg_a', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }),
        usageRow('msg_a', { output_tokens: 25 }),
    ]);
    assert.equal(usage.totalInput, 100, 'an omitted input keeps its counted value');
    assert.equal(usage.cacheRead, 50, 'an omitted cache read keeps its counted value');
    assert.equal(usage.totalOutput, 25, 'a restated output replaces its counted value');
    assert.equal(usage.turnCount, 1);
});

test('R4: interleaved message repeats still count once', () => {
    const usage = tokenUsageOf([
        usageRow('msg_a', { input_tokens: 100, output_tokens: 20 }),
        usageRow('msg_b', { input_tokens: 50, output_tokens: 10 }),
        usageRow('msg_a', { input_tokens: 100, output_tokens: 25 }),
    ]);
    assert.equal(usage.totalInput, 150);
    assert.equal(usage.totalOutput, 35, 'each message counts once, its latest values');
    assert.equal(usage.turnCount, 2);
});

test('usage repeats still replace, never add, across the GLM fixture shape', () => {
    const usage = tokenUsageOf([
        usageRow('msg_a', { input_tokens: 100, output_tokens: 20 }),
        usageRow('msg_a', { input_tokens: 100, output_tokens: 20 }),
    ]);
    assert.equal(usage.totalInput, 100);
    assert.equal(usage.totalOutput, 20);
    assert.equal(usage.turnCount, 1);
});

// ─── Reviewer regressions: lifecycle, raced reads, retention ──

// A second thread of our own making, so the fixture thread's assertions stay
// untouched: a live job, valid metadata, and whatever transcript the case
// under test chooses to leave on disk.
const TID2 = 'glmth_race0000_00000009';
const row = (id, text) => JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: {
        role: 'assistant', id, model: 'glm-5.3',
        content: [{ type: 'text', text }], usage: { input_tokens: 7, output_tokens: 2 },
    },
});
const thread2Dir = () => path.join(STATE, 'threads', TID2, 'home', 'projects', slug(PROJECT));
const transcript2 = () => path.join(thread2Dir(), `${SESSION}.jsonl`);
const registerThread2 = () => {
    fs.appendFileSync(journal, `\n${JSON.stringify({
        event: 'started', ts: Date.now(), job_id: 'glm_race0000_00000009',
        session_id: TID2, owner_pid: process.pid, cwd: PROJECT,
    })}\n`);
    fs.writeFileSync(path.join(STATE, 'threads', `${TID2}.json`), JSON.stringify({ claude_session: SESSION, cwd: PROJECT }));
};
const detail2 = () => adapter.getSessionDetail(`zai-${TID2}`, PROJECT);

test('a transcript created after the first poll is discovered, and a replacement one rebinding', () => {
    registerThread2();
    assert.deepEqual(detail2().messages, [], 'no transcript yet: nothing to read');
    fs.mkdirSync(thread2Dir(), { recursive: true });
    fs.writeFileSync(transcript2(), row('msg_c1', 'created after initial poll') + '\n');
    assert.equal(detail2().messages[0].text, 'created after initial poll');
    // A replacement file (a new inode) is itself legitimate when it validates.
    fs.renameSync(transcript2(), `${transcript2()}.old`);
    fs.writeFileSync(transcript2(), row('msg_c2', 'valid replacement transcript') + '\n');
    assert.equal(detail2().messages[0].text, 'valid replacement transcript');
});

test('a raced read is rejected and purged from every shared cache', () => {
    const secret = writeSecretOutside();
    // Pad the safe transcript with spaces to the outside file's exact size, so
    // a restored file matches the identity the raced read would have cached,
    // and only content can tell them apart — the poisoning shape from the
    // review.
    const safe = fs.readFileSync(transcript2(), 'utf8');
    const secretSize = fs.statSync(secret).size;
    fs.writeFileSync(transcript2(), safe.padEnd(secretSize, ' '));
    const openSync = fs.openSync;
    let swapped = false;
    fs.openSync = function (file, flags, ...args) {
        if (file !== transcript2() || flags !== 'r'
            || !new Error().stack.includes('scanTranscriptRangeSync')) {
            return openSync.call(fs, file, flags, ...args);
        }
        swapped = true;
        fs.renameSync(transcript2(), `${transcript2()}.safe`);
        fs.symlinkSync(secret, transcript2());
        return openSync.call(fs, file, flags, ...args);
    };
    try {
        const first = detail2();
        assert.equal(swapped, true, 'the readers open the validated path itself');
        assert.equal(first.tokenUsage.availability, 'unavailable', 'the bracket rejects the swapped read');
        assert.equal(JSON.stringify(first).includes(SECRET_TEXT), false);
    } finally {
        fs.openSync = openSync;
    }
    // The swap is still in place here: restore the real file, whose identity
    // matches what the rejected read had cached — only the synchronous purge
    // keeps that content out of every later read.
    fs.unlinkSync(transcript2());
    fs.renameSync(`${transcript2()}.safe`, transcript2());
    const second = detail2();
    assert.ok(second.messages.length > 0, 'the restored transcript is read from scratch');
    assert.equal(JSON.stringify(second).includes(SECRET_TEXT), false);
    const session = adapter.getActiveSessions(THRESHOLD_MS).find(item => item.agentId === TID2);
    assert.ok(session);
    assert.equal(JSON.stringify(session).includes(SECRET_TEXT), false);
    fs.writeFileSync(transcript2(), safe);
});

test('a transcript rejected at initial validation is purged before it can poison a later read', () => {
    // The warm read caches a transcript whose identity — same inode, size and
    // mtime — the restored file below matches exactly.
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.writeFileSync(transcript2(), `${JSON.stringify(usageRow('msg_reject', { input_tokens: 111, output_tokens: 2 }))}\n`);
    fs.utimesSync(transcript2(), stamp, stamp);
    assert.equal(detail2().tokenUsage.totalInput, 111, 'baseline: the warm transcript is read');
    // The transcript is swapped for a link: initial validation rejects the
    // pathname itself, and that rejection must purge it — readTranscript's
    // brackets never run for a rejected target.
    swapForLink(transcript2(), writeSecretOutside());
    try {
        assert.deepEqual(detail2().messages, [], 'the planted link is never read');
    } finally {
        restoreFromLink(transcript2());
    }
    // The original inode returns with the size and mtime the cached aggregate
    // remembers; only the synchronous purge keeps the stale usage from being
    // served as though the rejection never happened.
    fs.writeFileSync(transcript2(), `${JSON.stringify(usageRow('msg_reject', { input_tokens: 999, output_tokens: 2 }))}\n`);
    fs.utimesSync(transcript2(), stamp, stamp);
    assert.equal(detail2().tokenUsage.totalInput, 999, 'a rejected target leaves nothing cached behind');
});

test('a finish record that rolls out of the tail still retires its job', () => {
    assert.ok(adapter.getActiveSessions(THRESHOLD_MS).find(item => item.agentId === TID2), 'baseline: the thread is live');
    // The job finishes an hour ago, then 4,001 newer events roll every record
    // of it out of the bounded tail before the next scan runs.
    const finishedAt = Date.now() - 3_600_000;
    fs.appendFileSync(journal, [
        `\n${JSON.stringify({ event: 'finished', ts: finishedAt, job_id: 'glm_race0000_00000009', session_id: TID2, status: 'succeeded' })}\n`,
        ...Array.from({ length: 4001 }, (_, i) => `\n${JSON.stringify({
            event: 'started', ts: Date.now(), job_id: `glm_retire${i.toString(36)}_00000003`,
            session_id: `glmth_retire${i.toString(36)}_00000003`, owner_pid: DEAD_PID, cwd: PROJECT,
        })}\n`),
    ].join(''));
    assert.equal(
        adapter.getActiveSessions(THRESHOLD_MS).find(item => item.agentId === TID2),
        undefined,
        'the finished job is retired even though its records left the tail',
    );
});

// ─── Reviewer regressions: journal cursor ───────────────

// A burst far larger than one bounded fold: the terminal record sits past the
// first 4 MiB chunk and past the bounded tail, so only unchanged-key polls
// that keep draining the backlog can ever consume it.
test('a journal burst larger than one fold still drains until the terminal record lands', () => {
    const TID3 = 'glmth_burst000_0000000b';
    fs.appendFileSync(journal, `\n${JSON.stringify({
        event: 'started', ts: Date.now(), job_id: 'glm_burst000_0000000b',
        session_id: TID3, owner_pid: process.pid, cwd: PROJECT,
    })}\n`);
    const burstTranscript = path.join(STATE, 'threads', TID3, 'home', 'projects', slug(PROJECT), `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(burstTranscript), { recursive: true });
    fs.writeFileSync(path.join(STATE, 'threads', `${TID3}.json`), JSON.stringify({ claude_session: SESSION, cwd: PROJECT }));
    fs.writeFileSync(burstTranscript, row('msg_b1', 'burst thread transcript') + '\n');
    const present = () => adapter.getActiveSessions(THRESHOLD_MS).some(session => session.agentId === TID3);
    assert.ok(present(), 'baseline: the burst thread is live');
    const frame = record => `\n${JSON.stringify(record)}\n`;
    const noise = (count, start) => Array.from({ length: count }, (_, i) => frame({
        event: 'started', ts: NOW, job_id: `glm_burstn${i + start}_0000000c`,
        session_id: `glmth_burstn${i + start}_0000000c`, owner_pid: DEAD_PID, cwd: PROJECT,
        label: 'x'.repeat(900),
    })).join('');
    fs.appendFileSync(journal, noise(5000)
        + frame({ event: 'finished', ts: Date.now() - 3_600_000, job_id: 'glm_burst000_0000000b', session_id: TID3, status: 'succeeded' })
        + noise(5000, 5000));
    const polls = [present(), present(), present(), present()];
    assert.equal(polls[0], true, 'the first bounded fold has not yet reached the buried record');
    assert.equal(polls[3], false, 'unchanged-key polls keep folding while complete unread records remain');
});

// Cursor and guard cases need the adapter's very first fold, so each runs in
// its own child process against its own state directory.
const runChildProbe = (script, stateDir) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '-e', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, CLAUDEVILLE_GLM_STATE_DIR: stateDir, HOME: path.dirname(stateDir) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
});

const childSetup = (stateDir, tid) => `
  const fs = require('node:fs');
  const path = require('node:path');
  const state = ${JSON.stringify(stateDir)};
  const tid = ${JSON.stringify(tid)};
  const sid = '11111111-1111-4111-8111-111111111111';
  const project = ${JSON.stringify(PROJECT)};
  const transcript = path.join(state, 'threads', tid, 'home', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(state, 'threads', tid + '.json'), JSON.stringify({ claude_session: sid, cwd: project }));
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', id: 'm', model: 'glm-5.3', content: [{ type: 'text', text: 'live' }], usage: { input_tokens: 7, output_tokens: 2 } } }) + '\\n');
  const frame = record => '\\n' + JSON.stringify(record) + '\\n';
  const journal = path.join(state, 'journal.jsonl');
  const { GlmAdapter } = require(${JSON.stringify(path.join(REPO_ROOT, 'claudeville/adapters/glm.js'))});
  const adapter = new GlmAdapter();
  const present = () => adapter.getActiveSessions(120000).some(session => session.agentId === tid);
`;

test('the initial cursor parks at the last complete newline, so a torn finish still lands', { timeout: 30_000 }, async () => {
    const stateDir = path.join(ROOT, 'torn-state');
    const script = childSetup(stateDir, 'glmth_torn000_0000000d') + `
  const start = { event: 'started', ts: Date.now(), job_id: 'glm_torn000_0000000d', session_id: tid, owner_pid: process.pid, cwd: project };
  const finish = JSON.stringify({ event: 'finished', ts: Date.now() - 3600000, job_id: 'glm_torn000_0000000d', session_id: tid, status: 'succeeded' });
  fs.writeFileSync(journal, frame(start) + '\\n' + finish.slice(0, 80));
  const initial = present();
  fs.appendFileSync(journal, finish.slice(80) + '\\n' + Array.from({ length: 4001 }, (_, i) => frame({
      event: 'started', ts: Date.now(), job_id: 'glm_tornn' + i + '_0000000e',
      session_id: 'glmth_tornn' + i + '_0000000e', owner_pid: 2147483646, cwd: project,
  })).join(''));
  const polls = [present(), present(), present(), present()];
  process.stdout.write(JSON.stringify({ initial, polls }));
`;
    const { code, out, err } = await runChildProbe(script, stateDir);
    assert.equal(code, 0, `the child probe must exit cleanly: ${err}`);
    const result = JSON.parse(out);
    assert.equal(result.initial, true, 'the live thread is present before its torn finish completes');
    assert.equal(result.polls[3], false, 'the completed finish is consumed once its closing newline arrives');
});

test('a same-inode prefix rewrite is caught by the guard and re-consumed from the start', { timeout: 30_000 }, async () => {
    const stateDir = path.join(ROOT, 'rewrite-state');
    const script = childSetup(stateDir, 'glmth_guard000_0000000f') + `
  const start = { event: 'started', ts: Date.now(), job_id: 'glm_guard000_0000000f', session_id: tid, owner_pid: process.pid, cwd: project };
  const finish = { event: 'finished', ts: Date.now() - 3600000, job_id: 'glm_guard000_0000000f', session_id: tid, status: 'succeeded' };
  fs.writeFileSync(journal, frame(start) + frame({ padding: 'initial'.repeat(500) }));
  const liveBefore = present();
  fs.appendFileSync(journal, frame({ event: 'noise' }));
  const liveAfterAppend = present();
  // Rewrite the existing prefix on the same inode without shrinking it; the
  // finish record lands before the old cursor and outside the bounded tail.
  fs.writeFileSync(journal, frame(start) + frame(finish) + Array.from({ length: 4001 }, (_, i) => frame({
      event: 'started', ts: Date.now(), job_id: 'glm_guardn' + i + '_00000010',
      session_id: 'glmth_guardn' + i + '_00000010', owner_pid: 2147483646, cwd: project,
  })).join(''));
  const afterRewrite = present();
  process.stdout.write(JSON.stringify({ liveBefore, liveAfterAppend, afterRewrite }));
`;
    const { code, out, err } = await runChildProbe(script, stateDir);
    assert.equal(code, 0, `the child probe must exit cleanly: ${err}`);
    const result = JSON.parse(out);
    assert.equal(result.liveBefore, true);
    assert.equal(result.liveAfterAppend, true, 'a normal append keeps the live thread');
    assert.equal(result.afterRewrite, false, 'the rewritten prefix fails the guard and recovery re-consumes the finish');
});

// ─── Reviewer regressions: invalidated async transcript scans ──

// A scan task belongs to the cache record it was scheduled for. Invalidation
// bumps the old record's generation and deletes it, and a re-created record
// starts over at generation 0 — so generation numbers alone cannot keep an
// invalidated scan (active or still queued) from matching the replacement
// record and publishing invalidated data into it. Both cases need the async
// threshold lowered before claude.js loads, so each runs in its own child
// process with its own transcript.
const scanProbeSetup = stateDir => `
  const fs = require('node:fs');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  process.env.CLAUDEVILLE_TRANSCRIPT_ASYNC_THRESHOLD_BYTES = '65536';
  const { claudeTranscript, ClaudeAdapter } = require(${JSON.stringify(path.join(REPO_ROOT, 'claudeville/adapters/claude.js'))});
  fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
  const file = path.join(${JSON.stringify(stateDir)}, 'transcript.jsonl');
  const row = value => JSON.stringify({ type: 'assistant', message: {
    role: 'assistant', id: 'm', model: 'glm-5.3',
    content: [{ type: 'text', text: String(value) }],
    usage: { input_tokens: value, output_tokens: 2 },
  } }) + '\\n';
  // Exact millisecond timestamps survive the rewrites below.
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  const streams = [];
  const original = fs.createReadStream;
  fs.createReadStream = function (name, options) {
    if (name !== file) return original.call(fs, name, options);
    const stream = new EventEmitter();
    stream.destroy = () => {};
    streams.push({ stream, end: options.end });
    return stream;
  };
  const tick = () => new Promise(setImmediate);
  const finish = () => {
    fs.createReadStream = original;
    new ClaudeAdapter().shutdown();
  };
`;

test('an invalidated active transcript scan cannot publish into the re-created record', { timeout: 30_000 }, async () => {
    const stateDir = path.join(ROOT, 'scan-active-state');
    const script = scanProbeSetup(stateDir) + `
  (async () => {
    fs.writeFileSync(file, row(111) + ' '.repeat(70000));
    fs.utimesSync(file, stamp, stamp);
    const oldBytes = fs.readFileSync(file);
    claudeTranscript.tokenUsage(file);
    await tick();
    streams[0].stream.emit('data', oldBytes);
    claudeTranscript.invalidate(file);
    fs.writeFileSync(file, row(999) + ' '.repeat(70000));
    fs.utimesSync(file, stamp, stamp);
    claudeTranscript.tokenUsage(file);
    // The replacement record restarts at generation 0, so its first scan is
    // generation 1 — the very generation the invalidated task still carries.
    streams[0].stream.emit('end');
    const invalidated = claudeTranscript.tokenUsage(file);
    await tick();
    streams[1].stream.emit('data', fs.readFileSync(file));
    streams[1].stream.emit('end');
    const replacement = claudeTranscript.tokenUsage(file);
    process.stdout.write(JSON.stringify({
      invalidated: invalidated.availability,
      replacement: replacement.totalInput,
      streams: streams.length,
    }));
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(finish);
`;
    const { code, out, err } = await runChildProbe(script, stateDir);
    assert.equal(code, 0, `the child probe must exit cleanly: ${err}`);
    const result = JSON.parse(out);
    assert.equal(result.invalidated, 'unavailable', 'the invalidated active scan publishes nothing');
    assert.equal(result.replacement, 999, 'the replacement record still completes its own scan');
    assert.equal(result.streams, 2);
});

test('an invalidated queued transcript scan is never started for the re-created record', { timeout: 30_000 }, async () => {
    const stateDir = path.join(ROOT, 'scan-queued-state');
    const script = scanProbeSetup(stateDir) + `
  (async () => {
    fs.writeFileSync(file, row(111) + ' '.repeat(70000));
    fs.utimesSync(file, stamp, stamp);
    const oldSize = fs.statSync(file).size;
    // The first scan is still queued (setImmediate has not run) when the
    // record it belongs to is invalidated and the path's record re-created.
    claudeTranscript.tokenUsage(file);
    claudeTranscript.invalidate(file);
    fs.writeFileSync(file, row(999) + ' '.repeat(75000));
    fs.utimesSync(file, stamp, stamp);
    claudeTranscript.tokenUsage(file);
    await tick();
    const ends = streams.map(item => item.end);
    streams[0].stream.emit('data', fs.readFileSync(file));
    streams[0].stream.emit('end');
    const published = claudeTranscript.tokenUsage(file);
    process.stdout.write(JSON.stringify({
      ends,
      count: streams.length,
      oldSize,
      newSize: fs.statSync(file).size,
      published: published.totalInput,
    }));
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(finish);
`;
    const { code, out, err } = await runChildProbe(script, stateDir);
    assert.equal(code, 0, `the child probe must exit cleanly: ${err}`);
    const result = JSON.parse(out);
    assert.notEqual(result.oldSize, result.newSize, 'the two targets must be distinguishable');
    assert.deepEqual(result.ends, [result.newSize - 1],
        'only the replacement record\'s scan runs; the invalidated task never starts');
    assert.equal(result.published, 999, 'the replacement record publishes its own scan');
});
