import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const codex = require('../../claudeville/adapters/codex.js');
const {
    readTurnTracker,
    clearTurnTrackerCache,
    foldTurnTracker,
    METADATA_BACKSCAN_CHUNK_BYTES,
    MAX_METADATA_BACKSCAN_BYTES,
} = codex._test;

// Reference oracle matching the original backward-window specification:
// inspect at most the trailing `maxBytes` of the file, drop any partial
// trailing line after the last `\n`, drop any leading fragment when
// `startOffset > 0`, start from the newest complete `task_started` line (if
// any), and fold chronologically once.
function referenceReadTurnTracker(filePath, maxBytes = MAX_METADATA_BACKSCAN_BYTES) {
    const raw = fs.readFileSync(filePath);
    const startOffset = Math.max(0, raw.length - maxBytes);
    const slice = raw.subarray(startOffset);
    const lastNewline = slice.lastIndexOf(10);
    let state = { boundary: null, question: null };
    if (lastNewline < 0) return state;

    const lines = slice.subarray(0, lastNewline + 1).toString('utf-8').split('\n');
    if (startOffset > 0) lines.shift();
    let startIndex = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"task_started"')) continue;
        try {
            const entry = JSON.parse(line);
            if (entry?.type === 'event_msg' && entry.payload?.type === 'task_started') {
                startIndex = i;
                break;
            }
        } catch { /* ignore malformed */ }
    }
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
            state = foldTurnTracker(state, JSON.parse(line));
        } catch { /* ignore malformed */ }
    }
    return state;
}

function makeTempDir(t, prefix = 'cv-p3-codex-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function eventLine(iso, type, extra = {}) {
    return JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type, ...extra } });
}

function fillerLine(iso, bytes = 900) {
    return JSON.stringify({
        timestamp: iso,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c', output: 'a'.repeat(bytes) },
    });
}

function questionLine(iso, name = 'request_user_input_async', note = '') {
    return JSON.stringify({
        timestamp: iso,
        type: 'response_item',
        payload: { type: 'function_call', name, arguments: JSON.stringify({ note }) },
    });
}

function userMessageLine(iso, text) {
    return JSON.stringify({
        timestamp: iso,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
}

test('cold Codex backscan matches reference across split multi-byte UTF-8 at 64 KiB boundary', (t) => {
    const dir = makeTempDir(t);
    const file = path.join(dir, 'split-utf8.jsonl');

    // Place a 4-byte emoji 🚀 and 3-byte em-dash — directly across the chunk boundary
    // inside both a question record and a user reply record, with task_started two chunks back.
    const t0 = '2026-11-27T10:00:00.000Z';
    const t1 = '2026-11-27T10:00:10.000Z';
    const t2 = '2026-11-27T10:00:20.000Z';

    const prefixLines = [
        eventLine(t0, 'task_started'),
        ...Array.from({ length: 80 }, () => fillerLine(t0, 900)),
    ].join('\n') + '\n';

    // Pad so the 4-byte 🚀 (F0 9F 9A 80) straddles a 64 KiB boundary from EOF.
    const tailFiller = Array.from({ length: 65 }, () => fillerLine(t2, 990)).join('\n') + '\n';
    const tailBytes = Buffer.byteLength(tailFiller);
    const neededBeforeTail = METADATA_BACKSCAN_CHUNK_BYTES - (tailBytes % METADATA_BACKSCAN_CHUNK_BYTES);
    const qPrefix = `{"timestamp":"${t1}","type":"response_item","payload":{"type":"function_call","name":"request_user_input_async","arguments":"`;
    const qSuffix = `"}}\n`;
    const emoji = '🚀—日本語';
    const padLen = Math.max(4, neededBeforeTail - Buffer.byteLength(qSuffix) - 2);
    const qLine = qPrefix + 'z'.repeat(16) + emoji + 'p'.repeat(padLen) + qSuffix;

    const fullContent = prefixLines + qLine + tailFiller;
    fs.writeFileSync(file, fullContent, 'utf8');

    // Confirm the file spans multiple 64 KiB chunks.
    assert.ok(fs.statSync(file).size > METADATA_BACKSCAN_CHUNK_BYTES * 2);

    clearTurnTrackerCache();
    const actual = readTurnTracker(file);
    const expected = referenceReadTurnTracker(file);
    assert.deepEqual(actual, expected);
    assert.equal(actual.boundary?.type, 'task_started');
    assert.equal(actual.question?.count, 1);
    assert.equal(actual.question?.since, Date.parse(t1));

    // Now test a split UTF-8 user reply clearing the question across the chunk boundary.
    const replyFile = path.join(dir, 'split-utf8-reply.jsonl');
    const rPrefix = `{"timestamp":"${t2}","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"`;
    const rSuffix = `"}]}}\n`;
    const rLine = rPrefix + 'ok ' + emoji + ' ' + 'q'.repeat(padLen) + rSuffix;
    fs.writeFileSync(replyFile, prefixLines + qLine + rLine + tailFiller, 'utf8');
    clearTurnTrackerCache();
    assert.deepEqual(readTurnTracker(replyFile), referenceReadTurnTracker(replyFile));
    assert.equal(readTurnTracker(replyFile).question, null);
});

test('cold Codex backscan handles partial final lines, warm completion, and exact boundary newlines', (t) => {
    const dir = makeTempDir(t);
    const file = path.join(dir, 'partial-final.jsonl');
    const t0 = '2026-11-27T11:00:00.000Z';
    const t1 = '2026-11-27T11:00:05.000Z';

    // 1. File with no newline at all (partial final line only).
    const startLine = eventLine(t0, 'task_started');
    fs.writeFileSync(file, startLine, 'utf8');
    clearTurnTrackerCache();
    assert.deepEqual(readTurnTracker(file), referenceReadTurnTracker(file));
    assert.deepEqual(readTurnTracker(file), { boundary: null, question: null });

    // 2. Completing the newline via warm append folds the line immediately.
    fs.appendFileSync(file, '\n', 'utf8');
    const afterComplete = readTurnTracker(file);
    assert.deepEqual(afterComplete, referenceReadTurnTracker(file));
    assert.equal(afterComplete.boundary?.type, 'task_started');

    // 3. Large multi-chunk file ending with an unterminated task_complete line.
    const partialTailFile = path.join(dir, 'partial-tail-large.jsonl');
    const body = [
        eventLine(t0, 'task_started'),
        ...Array.from({ length: 90 }, () => fillerLine(t0, 900)),
        questionLine(t1),
    ].join('\n') + '\n';
    const unterminatedEnd = eventLine('2026-11-27T11:00:30.000Z', 'task_complete', { duration_ms: 30_000 });
    fs.writeFileSync(partialTailFile, body + unterminatedEnd, 'utf8');
    clearTurnTrackerCache();
    const coldState = readTurnTracker(partialTailFile);
    assert.deepEqual(coldState, referenceReadTurnTracker(partialTailFile));
    assert.equal(coldState.boundary?.type, 'task_started');
    assert.equal(coldState.question?.count, 1);

    // Warm append finishes the partial line and closes the turn + question.
    fs.appendFileSync(partialTailFile, '\n', 'utf8');
    const warmState = readTurnTracker(partialTailFile);
    assert.deepEqual(warmState, referenceReadTurnTracker(partialTailFile));
    assert.equal(warmState.boundary?.type, 'task_complete');
    assert.equal(warmState.boundary?.lastTurnDurationMs, 30_000);
    assert.equal(warmState.question, null);

    // 4. Single oversized record spanning > 2 chunks (150 KiB line) + exact 64 KiB boundary newline.
    const hugeLineFile = path.join(dir, 'huge-line.jsonl');
    const hugeOutput = fillerLine(t0, 150_000);
    fs.writeFileSync(hugeLineFile, `${eventLine(t0, 'task_started')}\n${hugeOutput}\n${questionLine(t1)}\n`, 'utf8');
    clearTurnTrackerCache();
    assert.deepEqual(readTurnTracker(hugeLineFile), referenceReadTurnTracker(hugeLineFile));

    // 5. Exact 64 KiB boundary newlines (newline at byte 65535 and at byte 65536 from EOF)
    // plus task_started straddling the exact 64 KiB boundary.
    const boundaryFile = path.join(dir, 'exact-64k-boundary.jsonl');
    const startRec = eventLine(t0, 'task_started') + '\n';
    const startLen = Buffer.byteLength(startRec);
    // Construct a record whose trailing '\n' lands at exact offset 65535 (so chunk boundary splits right after '\n').
    const padRecPrefix = `{"timestamp":"${t1}","type":"response_item","payload":{"type":"function_call_output","call_id":"b","output":"`;
    const padRecSuffix = `"}}\n`;
    const exactFillLen = METADATA_BACKSCAN_CHUNK_BYTES - startLen - Buffer.byteLength(padRecPrefix) - Buffer.byteLength(padRecSuffix);
    const padRec = padRecPrefix + 'x'.repeat(exactFillLen) + padRecSuffix;
    assert.equal(Buffer.byteLength(startRec + padRec), METADATA_BACKSCAN_CHUNK_BYTES);
    const qRec = questionLine(t1) + '\n';
    const trailingFill = fillerLine(t1, METADATA_BACKSCAN_CHUNK_BYTES - Buffer.byteLength(qRec) - 100) + '\n';
    fs.writeFileSync(boundaryFile, startRec + padRec + qRec + trailingFill, 'utf8');
    clearTurnTrackerCache();
    assert.deepEqual(readTurnTracker(boundaryFile), referenceReadTurnTracker(boundaryFile));
    assert.equal(readTurnTracker(boundaryFile).boundary?.type, 'task_started');
    assert.equal(readTurnTracker(boundaryFile).question?.count, 1);

    // 6. JSON-escaped token spellings (\uXXXX) for task_started, request_user_input_async, user reply, and task_complete.
    const escapedFile = path.join(dir, 'json-escaped-tokens.jsonl');
    const escapedStart = `{"timestamp":"${t0}","type":"event_msg","payload":{"type":"\\u0074ask_started"}}\n`;
    const escapedQuestion = `{"timestamp":"${t1}","type":"response_item","payload":{"type":"function_call","name":"request_\\u0075ser_input_async","arguments":"{}"}}\n`;
    const escapedFiller = Array.from({ length: 80 }, () => fillerLine(t1, 900)).join('\n') + '\n';
    fs.writeFileSync(escapedFile, escapedStart + escapedFiller + escapedQuestion, 'utf8');
    clearTurnTrackerCache();
    const escapedOpen = readTurnTracker(escapedFile);
    assert.equal(escapedOpen.boundary?.type, 'task_started');
    assert.equal(escapedOpen.boundary?.turnStartedAt, Date.parse(t0));
    assert.equal(escapedOpen.question?.count, 1);

    const escapedReply = `{"timestamp":"2026-11-27T11:00:15.000Z","type":"response_item","payload":{"type":"\\u006dessage","role":"\\u0075ser","content":[{"type":"input_text","text":"go ahead"}]}}\n`;
    const escapedComplete = `{"timestamp":"2026-11-27T11:00:25.000Z","type":"event_msg","payload":{"type":"\\u0074ask_complete","duration_ms":25000}}\n`;
    fs.writeFileSync(escapedFile, escapedStart + escapedFiller + escapedQuestion + escapedReply + escapedComplete, 'utf8');
    clearTurnTrackerCache();
    const escapedDone = readTurnTracker(escapedFile);
    assert.equal(escapedDone.boundary?.type, 'task_complete');
    assert.equal(escapedDone.boundary?.lastTurnDurationMs, 25_000);
    assert.equal(escapedDone.question, null);
});

test('cold Codex backscan matches reference across injected prefixes, multiple turns, rotate/truncate, and retry', (t) => {
    const dir = makeTempDir(t);
    const file = path.join(dir, 'lifecycle.jsonl');
    const t0 = '2026-11-27T12:00:00.000Z';
    const t1 = '2026-11-27T12:00:10.000Z';
    const t2 = '2026-11-27T12:00:20.000Z';
    const t3 = '2026-11-27T12:00:30.000Z';

    // Turn 1 had a question + abort; Turn 2 starts, asks a question, sees an injected
    // <environment_context> message (must NOT clear the question).
    const content = [
        eventLine(t0, 'task_started'),
        questionLine(t0),
        eventLine(t1, 'turn_aborted'),
        ...Array.from({ length: 80 }, () => fillerLine(t1, 900)),
        eventLine(t2, 'task_started'),
        ...Array.from({ length: 80 }, () => fillerLine(t2, 900)),
        questionLine(t3, 'functions.request_user_input_async'),
        userMessageLine(t3, '<environment_context>cwd=/tmp</environment_context>'),
    ].join('\n') + '\n';
    fs.writeFileSync(file, content, 'utf8');
    clearTurnTrackerCache();
    const initial = readTurnTracker(file);
    assert.deepEqual(initial, referenceReadTurnTracker(file));
    assert.equal(initial.boundary?.type, 'task_started');
    assert.equal(initial.boundary?.turnStartedAt, Date.parse(t2));
    assert.equal(initial.question?.count, 1);

    // Truncate in-place (same inode, smaller size) to a turn_aborted rollout.
    const truncated = [
        eventLine(t0, 'task_started'),
        eventLine(t1, 'turn_aborted'),
    ].join('\n') + '\n';
    fs.writeFileSync(file, truncated, 'utf8');
    const afterTruncate = readTurnTracker(file);
    assert.deepEqual(afterTruncate, referenceReadTurnTracker(file));
    assert.equal(afterTruncate.boundary?.type, 'turn_aborted');
    assert.equal(afterTruncate.boundary?.lastTurnDurationMs, null);
    assert.equal(afterTruncate.question, null);

    // Rotate (unlink + recreate with new inode) with a new completed turn.
    fs.unlinkSync(file);
    assert.equal(readTurnTracker(file), null);
    const rotated = [
        eventLine(t2, 'task_started'),
        eventLine(t3, 'task_complete'),
    ].join('\n') + '\n';
    fs.writeFileSync(file, rotated, 'utf8');
    const afterRotate = readTurnTracker(file);
    assert.deepEqual(afterRotate, referenceReadTurnTracker(file));
    assert.equal(afterRotate.boundary?.type, 'task_complete');
    assert.equal(afterRotate.boundary?.lastTurnDurationMs, Date.parse(t3) - Date.parse(t2));

    // Unreadable file + retry recovery (skip chmod assertion when running as root).
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const retryFile = path.join(dir, 'retry.jsonl');
        fs.writeFileSync(retryFile, rotated, 'utf8');
        fs.chmodSync(retryFile, 0o000);
        try {
            clearTurnTrackerCache();
            assert.equal(readTurnTracker(retryFile), null);
            fs.chmodSync(retryFile, 0o600);
            const recovered = readTurnTracker(retryFile);
            assert.deepEqual(recovered, referenceReadTurnTracker(retryFile));
            assert.equal(recovered.boundary?.type, 'task_complete');
        } finally {
            try { fs.chmodSync(retryFile, 0o600); } catch { /* ignore */ }
        }
    }
});

test('a short append read retries the same bytes on the next poll', (t) => {
    const file = path.join(makeTempDir(t), 'append.jsonl');
    fs.writeFileSync(file, eventLine('2026-11-27T12:00:00Z', 'task_started') + '\n');
    const started = readTurnTracker(file);
    fs.appendFileSync(file, eventLine('2026-11-27T12:00:01Z', 'task_complete') + '\n');
    const read = t.mock.method(fs, 'readSync', () => 0);
    assert.equal(readTurnTracker(file), started);
    read.mock.restore();
    assert.equal(readTurnTracker(file).boundary.type, 'task_complete');
});

test('cold Codex backscan scales linearly on an 8 MiB long-turn rollout', (t) => {
    const dir = makeTempDir(t);
    const file = path.join(dir, 'long-turn-8m.jsonl');
    const t0 = '2026-11-27T13:00:00.000Z';
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, `${eventLine(t0, 'task_started')}\n`);
    const lineBuf = Buffer.from(`${fillerLine(t0, 900)}\n`, 'utf8');
    let written = 0;
    const target = 8 * 1024 * 1024;
    while (written < target) {
        fs.writeSync(fd, lineBuf);
        written += lineBuf.length;
    }
    fs.closeSync(fd);

    clearTurnTrackerCache();
    const start = performance.now();
    const state = readTurnTracker(file);
    const elapsedMs = performance.now() - start;

    assert.equal(state.boundary?.type, 'task_started');
    assert.equal(state.boundary?.turnStartedAt, Date.parse(t0));
    assert.equal(state.question, null);
    assert.ok(elapsedMs < 1000, `expected linear 8 MiB cold backscan under 1000 ms, got ${elapsedMs.toFixed(1)} ms`);
});

test('server refreshWatchPaths uses the Linux watcher TTL when the watcher set is unchanged', (t) => {
    if (process.platform !== 'linux') {
        t.skip('Linux-only /proc/self/fdinfo diagnostic TTL test');
        return;
    }
    const server = require('../../claudeville/server.js');
    const {
        refreshWatchPaths,
        getLinuxWatchers,
        resetLinuxWatchSampleAt,
        constants: { LINUX_WATCH_SAMPLE_INTERVAL_MS },
    } = server._watcherTest;
    const dirA = makeTempDir(t, 'cv-p3-watch-a-');
    const dirB = makeTempDir(t, 'cv-p3-watch-b-');

    t.after(() => {
        refreshWatchPaths([]);
    });

    const descriptorA = { path: dirA, type: 'directory', provider: 'codex', priority: 1, scopes: ['active'] };
    const descriptorB = { path: dirB, type: 'directory', provider: 'codex', priority: 1, scopes: ['active'] };

    resetLinuxWatchSampleAt(0);
    refreshWatchPaths([descriptorA]);
    const afterAdd = getLinuxWatchers().sampledAt;
    assert.ok(Number.isFinite(afterAdd) && afterAdd > 0);

    // Advance the clock slightly (within TTL) via a fresh call with the exact same watcher set.
    const pinAt = Date.now() - 500;
    resetLinuxWatchSampleAt(pinAt);
    refreshWatchPaths([descriptorA]);
    assert.equal(
        getLinuxWatchers().sampledAt,
        afterAdd,
        'unchanged watcher set inside TTL must not re-scan /proc/self/fdinfo',
    );

    // Adding a watcher forces an immediate resample even inside the TTL.
    refreshWatchPaths([descriptorA, descriptorB]);
    const afterSecondAdd = getLinuxWatchers().sampledAt;
    assert.ok(afterSecondAdd >= pinAt, 'watcher set change must force an immediate Linux watcher count sample');

    // Removing a watcher also forces an immediate resample.
    const pinBeforeRemove = Date.now() - 250;
    resetLinuxWatchSampleAt(pinBeforeRemove);
    refreshWatchPaths([descriptorA]);
    const afterRemove = getLinuxWatchers().sampledAt;
    assert.ok(afterRemove >= pinBeforeRemove, 'watcher removal must force an immediate Linux watcher count sample');

    // Once the TTL expires, an unchanged refresh resamples on schedule.
    resetLinuxWatchSampleAt(Date.now() - LINUX_WATCH_SAMPLE_INTERVAL_MS - 50);
    const beforeExpired = getLinuxWatchers().sampledAt;
    refreshWatchPaths([descriptorA]);
    assert.ok(
        getLinuxWatchers().sampledAt >= beforeExpired,
        'expired TTL must allow periodic Linux watcher resampling',
    );
});
