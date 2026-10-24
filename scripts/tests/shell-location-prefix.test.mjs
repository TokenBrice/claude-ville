// SM-1: a bounded tool-input summary keeps the command, not the directory.
//
// Agents prefix most shell calls with an absolute `cd <dir> &&`; a 60-character
// summary of that is only the directory, so the world placed the call at
// Command as a generic "run". The adapters strip the location hop before
// truncating, and the classifier then sees what the call actually does.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { classifyTool } from '../../claudeville/src/domain/services/ToolIdentity.js';

const require = createRequire(import.meta.url);
const { stripShellLocationPrefix, summarizeToolInput } = require('../../claudeville/adapters/shared.js');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'claude');

test('leading cd hops and git -C flags are dropped; everything else is kept', () => {
    assert.equal(stripShellLocationPrefix('cd /abs/repo && npm test'), 'npm test');
    assert.equal(stripShellLocationPrefix('cd /abs/repo; sed -n 1,40p src/a.js'), 'sed -n 1,40p src/a.js');
    assert.equal(stripShellLocationPrefix('cd "/path with spaces" && cd sub; rg -n foo'), 'rg -n foo');
    assert.equal(stripShellLocationPrefix('cd /abs/repo\nnode --test a.test.mjs'), 'node --test a.test.mjs');
    assert.equal(stripShellLocationPrefix('git -C /abs/repo log --oneline -3'), 'git log --oneline -3');
    assert.equal(stripShellLocationPrefix('cd /x && git -C ../y status && git -C "/z w" diff'), 'git status && git diff');
    // A cd that is not a leading hop, or a lone cd, is the command itself.
    assert.equal(stripShellLocationPrefix('npm test && cd /tmp && ls'), 'npm test && cd /tmp && ls');
    assert.equal(stripShellLocationPrefix('cd /abs/repo'), 'cd /abs/repo');
    assert.equal(stripShellLocationPrefix('cd /abs/repo && '), 'cd /abs/repo && ');
    assert.equal(stripShellLocationPrefix('legit -C x'), 'legit -C x');
    assert.equal(stripShellLocationPrefix(null), null);
});

test('the summary strips before it truncates, for command fields only', () => {
    const command = `cd /home/someone/Documents/projects/a-rather-long-repository-name && npm run verify:render`;
    assert.equal(summarizeToolInput({ command }, { maxLength: 60 }), 'npm run verify:render');
    assert.equal(summarizeToolInput({ cmd: 'cd /x; pytest -q' }, { maxLength: 60 }), 'pytest -q');
    // Paths are not commands.
    assert.equal(summarizeToolInput({ file_path: 'cd /x; y' }, { maxLength: 60, basenameFields: [] }), 'cd /x; y');
});

test('Claude publishes the stripped command as lastToolInput and tool history detail', () => {
    const root = makeTempDir('claudeville-shell-prefix-');
    try {
        const project = path.join(root, 'work', 'prefix');
        fs.mkdirSync(project, { recursive: true });
        const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(
            path.join(root, '.claude', 'history.jsonl'),
            `${JSON.stringify({ sessionId: 'prefix-main', project, timestamp: Date.now(), model: 'claude-sonnet-4-5' })}\n`,
        );
        fs.copyFileSync(path.join(FIXTURE_ROOT, 'shell-prefix.jsonl'), path.join(projectDir, 'prefix-main.jsonl'));
        const script = `
            const { ClaudeAdapter } = require('./claudeville/adapters/claude');
            const adapter = new ClaudeAdapter();
            const session = adapter.getActiveSessions(60 * 60 * 1000).find(s => s.sessionId === 'prefix-main');
            const detail = adapter.getSessionDetail('prefix-main', ${JSON.stringify(project)});
            process.stdout.write(JSON.stringify({ input: session.lastToolInput, history: detail.toolHistory.map(t => t.detail) }));
            adapter.shutdown();
        `;
        const { input, history } = JSON.parse(execFileSync(process.execPath, ['-e', script], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: root, USERPROFILE: root },
            encoding: 'utf8',
        }));
        assert.equal(input, 'npm test');
        assert.deepEqual(history, ['git status --short', 'npm test']);
        assert.equal(classifyTool('Bash', input).building, 'taskboard');
        assert.equal(classifyTool('Bash', history[0]).building, 'harbor');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
