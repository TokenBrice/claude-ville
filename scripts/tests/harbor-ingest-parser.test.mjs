import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';
import { git, isolateGitConfig } from './support/harbor-ingest.mjs';

isolateGitConfig(test);
const require = createRequire(import.meta.url);
const { parseGitEventsFromCommand } = require('../../claudeville/adapters/gitEvents.js');

const root = fs.realpathSync(makeTempDir('claudeville-harbor-parser-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const project = path.join(root, 'repo');
fs.mkdirSync(project);
git(project, 'init', '-q', '-b', 'work');
git(project, 'commit', '-q', '--allow-empty', '-m', 'base');
git(project, 'tag', 'v1.2.3');

let sourceCounter = 0;
function parse(command, extra = {}) {
  sourceCounter++;
  return parseGitEventsFromCommand(command, {
    provider: 'claude',
    sessionId: 'parser-session',
    sourceId: `tool-${sourceCounter}`,
    ts: 1_700_000_000_000 + sourceCounter * 1000,
    project,
    ...extra,
  });
}

function brief(event) {
  const parts = [event.branch ? `${event.type}:${event.branch}` : event.type];
  if (event.force) parts.push(`force=${event.force}`);
  if (event.deleted) parts.push('deleted');
  if (event.tagsOnly) parts.push('tagsOnly');
  if (event.tag) parts.push(`tag=${event.tag}`);
  return parts.join(' ');
}

const cases = [
  ['echo "git commit -m x"', []],
  ['printf "%s\\n" "run git push later"', []],
  ['bash -c "git commit -m wrapped"', ['commit:work']],
  ["sh -lc 'git push origin main'", ['push:main']],
  ['env GIT_AUTHOR_NAME=x git commit -m envprefixed', ['commit:work']],
  ['GIT_AUTHOR_NAME=x git commit -m assign', ['commit:work']],
  ['time git push origin main', ['push:main']],
  ['timeout 60 git push origin main', ['push:main']],
  ['timeout -s KILL 60 git push origin main', ['push:main']],
  ['command git push origin main', ['push:main']],
  ['command -v git', []],
  ['nice -n 5 git push origin main', ['push:main']],
  ['sudo git push origin main', ['push:main']],
  ['/usr/bin/git commit -m absolute', ['commit:work']],
  ['(cd sub && git push origin main)', ['push:main']],
  ['git -c user.name=x commit -m dashc', ['commit:work']],
  ['git commit --amend --no-edit', ['commit:work']],
  ['git commit -am "quick fix"', ['commit:work']],
  ['git push 2>&1 | tail -5', ['push:work']],
  ['git push origin main 2>&1 | tail -5', ['push:main']],
  ['git push -u origin HEAD', ['push:work']],
  ['git push origin HEAD:main', ['push:work']],
  ['git push --force-with-lease origin feat', ['push:feat force=lease']],
  ['git push -f', ['push:work force=true']],
  ['git push origin +feat', ['push:feat force=true']],
  ['git push --dry-run origin main', []],
  ['git push -n origin main', []],
  ['git push origin --tags', ['push tagsOnly']],
  ['git push origin v1.2.3', ['push tagsOnly tag=v1.2.3']],
  ['git push origin refs/tags/v9', ['push tagsOnly tag=v9']],
  ['git push --follow-tags', ['push:work']],
  ['git tag -a v2 -m rel && git push origin v2', ['push tagsOnly tag=v2']],
  ['git push origin --delete old', ['push:old deleted']],
  ['git push origin :old', ['push:old deleted']],
  ['git push \\\n  origin main', ['push:main']],
  ['git push origin main > /dev/null', ['push:main']],
  ['git push origin main >/dev/null 2>&1', ['push:main']],
  ['git merge --no-ff feature', []],
  ['git pull --rebase', ['pull:work']],
  ['gh pr create --title t --body "b"', ['pr']],
  ['gh pr merge 12 --squash', ['pr']],
  ['git log --grep="git push"', []],
  ['git commit -m "msg; git push"', ['commit:work']],
  ['git stash push -m wip', []],
  ['git push origin main; git push origin main', ['push:main', 'push:main']],
  ['git commit --dry-run -m x', []],
  ['git commit --short', []],
  ['git commit --porcelain', []],
  ['git commit -m "fix -h handling"', ['commit:work']],
  ['git commit -m "--dry-run"', ['commit:work']],
  ['git commit -m x -- --dry-run', ['commit:work']],
  ['git push --repo=origin', ['push:work']],
  ['git push origin main --no-verify -o ci.skip', ['push:main']],
  ['npm test && git commit -m "x" && git push', ['commit:work', 'push:work']],
  ['git commit --allow-empty -m x && git commit --allow-empty -m x', ['commit:work', 'commit:work']],
  ["cat <<'EOF'\ngit commit -m fake\nEOF", []],
  ["cat <<EOF > notes.md\ngh release create v1\ngit push origin main\nEOF\ngit push origin work", ['push:work']],
  ["git commit -F - <<'EOF'\ndon't break\ngit push origin main\nEOF", ['commit:work']],
  ['git push origin feature:main', ['push:feature']],
  ['git push origin main feature', ['push:main']],
];

for (const [command, expected] of cases) {
  test(`parser: ${JSON.stringify(command).slice(0, 80)}`, () => {
    assert.deepEqual(parse(command).map(brief), expected);
  });
}

test('push refs keep source/destination pairs and select by source', () => {
  const [pair] = parse('git push origin feature:main');
  assert.deepEqual(pair.refs.map(({ src, dst }) => ({ src, dst })), [{ src: 'feature', dst: 'main' }]);
  const [multi] = parse('git push origin main feature');
  assert.deepEqual(multi.refs.map(({ src, dst }) => ({ src, dst })), [
    { src: 'main', dst: 'main' },
    { src: 'feature', dst: 'feature' },
  ]);
  const [head] = parse('git push -u origin HEAD');
  assert.deepEqual(head.refs.map(({ src, dst }) => ({ src, dst })), [{ src: 'work', dst: 'work' }]);
  assert.equal(head.branch, 'work');
  const [piped] = parse('git push origin main 2>&1 | tail -3');
  assert.deepEqual(piped.refspecs, ['main']);
});

test('per-event cwd follows cd, subshells and git -C', () => {
  const [subshell] = parse('(cd sub && git push origin main)');
  assert.equal(subshell.cwd, path.join(project, 'sub'));
  const [chained] = parse('cd ../other && git commit -m other-repo');
  assert.equal(chained.cwd, path.join(root, 'other'));
  const [dashC] = parse('git -C /elsewhere commit -m dashC');
  assert.equal(dashC.cwd, '/elsewhere');
  const events = parse('(cd sub && git commit -m inner) && git commit -m outer');
  assert.deepEqual(events.map((event) => event.cwd), [path.join(project, 'sub'), project]);
  const [workdir] = parse('git commit -m tool-workdir', { cwd: path.join(project, 'nested') });
  assert.equal(workdir.cwd, path.join(project, 'nested'));
});

test('commit subjects come from -am, repeated -m and heredoc bodies', () => {
  assert.equal(parse('git commit -am "quick fix"')[0].label, 'quick fix');
  assert.equal(parse('git commit -m "first" -m "body"')[0].label, 'first');
  assert.equal(parse("git commit -m \"$(cat <<'EOF'\nFix the thing\n\nCo-Authored-By: X <x@y>\nEOF\n)\"")[0].label, 'Fix the thing');
  assert.equal(parse("git commit -F - <<'EOF'\ndon't break\ngit push origin main\nEOF")[0].label, "don't break");
});

test('commit evidence: failures, nothing-to-commit and hook rejections emit no ship', () => {
  assert.deepEqual(parse('git commit -m x', {
    exitCode: 1, success: false, output: 'On branch work\nnothing to commit, working tree clean\n',
  }), []);
  assert.deepEqual(parse('git commit -m x', {
    success: false, output: 'Exit code 1\npre-commit hook failed: lint errors\n',
  }), []);
  assert.deepEqual(parse('git commit -m x', { output: 'nothing added to commit but untracked files present' }), []);
  const [created] = parse('git commit -m x', { exitCode: 0, success: true, output: '[work 1a2b3c4] x\n 1 file changed\n' });
  assert.equal(created.sha, '1a2b3c4');
  assert.equal(created.branch, 'work');
  assert.equal(created.success, true);
  assert.equal(created.attribution, 'observed');
  const [detached] = parse('git commit -m x', { exitCode: 0, success: true, output: '[detached HEAD 9f8e7d6] x\n' });
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, undefined);
  assert.equal(detached.sha, '9f8e7d6');
});

test('a quiet commit takes its sha from a follow-up git log or rev-parse', () => {
  const [logged] = parse('git add -A && git commit -qm "Ship it" && git log --oneline -1; git status --short', {
    exitCode: 0, success: true, output: 'abc1234 (HEAD -> work) Ship it\n M notes.md\n',
  });
  assert.equal(logged.sha, 'abc1234');
  assert.equal(logged.success, true);
  const [parsed] = parse('git commit -q -m "Quiet" && git rev-parse --short HEAD', {
    exitCode: 0, success: true, output: 'def5678\n',
  });
  assert.equal(parsed.sha, 'def5678');
  const [unrelated] = parse('git commit -qm "Mine" && git log --oneline -1', {
    exitCode: 0, success: true, output: '1111111 Someone else\n',
  });
  assert.equal(unrelated.sha, undefined);
});

test('chain exit semantics: the call status belongs to the segment that ran last', () => {
  const [deployFailed] = parse('git commit -m x && npm run deploy', {
    exitCode: 1, success: false, output: '[work abc1234] x\n 1 file changed\nnpm ERR! deploy failed\n',
  });
  assert.equal(deployFailed.type, 'commit');
  assert.notEqual(deployFailed.success, false);
  assert.equal(deployFailed.sha, 'abc1234');

  assert.deepEqual(parse('git commit -m x && git push', {
    exitCode: 1, success: false, output: 'husky - pre-commit hook exited with code 1\n',
  }), []);
  assert.deepEqual(parse('npm test && git commit -m x && git push', {
    exitCode: 1, success: false, output: '1 failing test\n',
  }), []);

  const [laundered] = parse('git push origin main || true', {
    exitCode: 0,
    success: true,
    output: 'To /tmp/remote.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'/tmp/remote.git\'\n',
  });
  assert.equal(laundered.success, false);
  assert.equal(laundered.status, 'rejected');
  assert.match(laundered.reason, /rejected|failed to push/);
  assert.equal(laundered.refs[0].status, 'rejected');

  const [pushed, later] = parse('git push origin main && git commit --allow-empty -m later', {
    exitCode: 0, success: true, output: 'To /tmp/remote.git\n   1111111..2222222  main -> main\n[work 3333333] later\n',
  });
  assert.equal(pushed.type, 'push');
  assert.equal(later.type, 'commit');
  assert.ok(later.ts > pushed.ts, 'a later segment gets a later sub-timestamp');
  assert.equal(pushed.success, true);
  assert.equal(pushed.refs[0].status, 'ok');

  const [noisy] = parse('npm test && git push origin main', {
    exitCode: 0, success: true, output: 'Promise rejected as expected\n✓ 12 tests\nTo /tmp/remote.git\n   1111111..2222222  main -> main\n',
  });
  assert.equal(noisy.success, true);
  assert.equal(noisy.status, 'success');
  assert.doesNotMatch(noisy.stderr || '', /Promise rejected/);
});

test('identical segments in one call are distinct events; ids stay stable across re-parses', () => {
  const context = { provider: 'claude', sessionId: 'stable', sourceId: 'tool-stable', ts: 1_700_000_100_000, project };
  const first = parseGitEventsFromCommand('git commit --allow-empty -m x && git commit --allow-empty -m x', context);
  const second = parseGitEventsFromCommand('git commit --allow-empty -m x && git commit --allow-empty -m x', context);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].id, first[1].id);
  assert.deepEqual(first.map((event) => event.id), second.map((event) => event.id));
});

test('the branch is frozen at first observation', () => {
  const context = { provider: 'claude', sessionId: 'freeze', sourceId: 'tool-freeze', ts: 1_700_000_200_000, project };
  const [before] = parseGitEventsFromCommand('git push', context);
  assert.equal(before.branch, 'work');
  git(project, 'checkout', '-q', '-b', 'later-branch');
  try {
    const [after] = parseGitEventsFromCommand('git push', context);
    assert.equal(after.id, before.id);
    assert.equal(after.branch, 'work');
    const [fresh] = parseGitEventsFromCommand('git push', { ...context, sourceId: 'tool-freeze-2' });
    assert.equal(fresh.branch, 'later-branch');
  } finally {
    git(project, 'checkout', '-q', 'work');
  }
});

test('stderr is capped and identity fields are present', () => {
  const output = `${'x'.repeat(10_000)}\nTo /tmp/remote.git\n   1111111..2222222  work -> work\n`;
  const [push] = parse('git push', { exitCode: 0, success: true, output });
  assert.ok((push.stderr || '').length <= 2048);
  assert.equal(push.repoRoot, project);
  assert.equal(push.checkout, project);
  assert.deepEqual(push.worktree, { name: 'repo', path: project, isMain: true });
  assert.equal(push.cwd, project);
  assert.equal(push.project, project);
});

test('events without completion data keep a lower confidence', () => {
  const [unknown] = parse('git push origin main');
  assert.ok(unknown.confidence <= 0.85);
  assert.equal(unknown.success, undefined);
  const [known] = parse('git push origin main', { exitCode: 0, success: true });
  assert.ok(known.confidence >= 0.95);
});
