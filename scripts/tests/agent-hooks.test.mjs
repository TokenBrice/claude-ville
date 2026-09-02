import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookPath = path.join(repoRoot, 'scripts/agent-hooks/claude-hook.cjs');

function run(mode, input, options = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [hookPath, mode], {
    cwd: repoRoot,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 1000,
    ...options
  });
  return { ...result, elapsed: performance.now() - started };
}

function bash(command) {
  return { hook_event_name: 'PreToolUse', cwd: repoRoot, tool_name: 'Bash', tool_input: { command } };
}

const deniedCommands = [
  ['git reset --hard HEAD~1', 'git reset'],
  ['git reset --merge ORIG_HEAD', 'git reset'],
  ['sudo env CI=1 git -C "a directory" reset --keep HEAD', 'git reset'],
  ['git checkout -- "path with spaces.js"', 'git checkout'],
  ['git checkout main -- src/app.js', 'git checkout'],
  ['git restore src/app.js', 'git restore'],
  ['git restore --staged --worktree src/app.js', 'git restore'],
  ['git clean -f', 'git clean'],
  ['git clean -d', 'git clean'],
  ['git clean -x', 'git clean'],
  ['git clean -X', 'git clean'],
  ['git stash drop', 'git stash'],
  ['git stash clear', 'git stash'],
  ['rm -rf node_modules/.cache', 'recursive forced removal'],
  ['rm -R --force "directory with spaces"', 'recursive forced removal'],
  ['kill 123', 'kill'],
  ['env SIGNAL=TERM pkill node', 'pkill'],
  ['sudo killall node', 'killall'],
  ['lsof -ti :4000 | xargs kill', 'process lookup pipeline'],
  ['fuser 4000/tcp | xargs -r kill', 'process lookup pipeline']
];

test('guard denies every destructive command class with the required message', async (t) => {
  for (const [command, reason] of deniedCommands) {
    await t.test(command, () => {
      const result = run('guard', bash(command));
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^claudeville-hook: blocked .*${reason}.*; AGENTS\\.md Git Hygiene forbids this — ask the operator\\.\\n$`));
    });
  }
});

test('guard allows documented safe cases and produces no output', () => {
  for (const command of [
    'git restore --staged "path with spaces.js"',
    'git clean -nfd',
    'git clean --dry-run -fdx',
    'git checkout main',
    'rm -r build',
    'printf "%s\\n" "quoted value"'
  ]) {
    const result = run('guard', bash(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
    assert.equal(result.stderr, '', command);
  }
});

test('all modes fail open on malformed input', () => {
  for (const mode of ['session', 'guard', 'check-js', 'ingest']) {
    const result = run(mode, '{not json');
    assert.equal(result.status, 0, mode);
  }
});

test('check-js reports syntax failures without blocking', () => {
  const result = run('check-js', {
    cwd: repoRoot,
    tool_input: { file_path: 'scripts/tests/agent-hooks.test.mjs' }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');

  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'claudeville-hook-'));
  try {
    writeFileSync(path.join(fixtureDir, 'invalid.js'), 'const = broken;\n');
    const invalid = run('check-js', {
      cwd: fixtureDir,
      tool_input: { file_path: 'invalid.js' }
    });
    assert.equal(invalid.status, 0);
    assert.match(invalid.stderr, /SyntaxError/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('session prints repository status, package version, and maintained-server warning', () => {
  const result = run('session', { cwd: repoRoot, hook_event_name: 'SessionStart', tool_input: {} });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ClaudeVille v\d+\.\d+\.\d+/);
  assert.match(result.stdout, /maintained server: http:\/\/localhost:4000 \(do not start\/stop\)/);
});

test('each hook mode completes under 200 ms across ten runs', () => {
  const fixtures = {
    session: { cwd: repoRoot, hook_event_name: 'SessionStart', tool_input: {} },
    guard: bash('git status --short'),
    'check-js': { cwd: repoRoot, tool_input: { file_path: 'scripts/agent-hooks/claude-hook.cjs' } },
    ingest: { cwd: repoRoot, tool_input: {} }
  };
  for (const [mode, fixture] of Object.entries(fixtures)) {
    for (let runNumber = 1; runNumber <= 10; runNumber += 1) {
      const result = run(mode, fixture);
      assert.equal(result.status, 0, `${mode} run ${runNumber}`);
      assert.ok(result.elapsed < 200, `${mode} run ${runNumber} took ${result.elapsed.toFixed(1)} ms`);
    }
  }
});
