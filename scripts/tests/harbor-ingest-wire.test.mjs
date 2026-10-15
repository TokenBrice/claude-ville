import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compactGitEventsForWire } = require('../../claudeville/adapters/gitEvents.js');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/harbor-wire-v1.json', import.meta.url), 'utf8'));
const events = new Map(fixture.events.map((event) => [event.id, event]));
const byCase = (name) => {
  const event = events.get(fixture.cases[name]);
  assert.ok(event, `fixture case ${name}`);
  return event;
};

// Rehydrates compactGitEventsForWire output the way the client does.
function decodeWire(payload) {
  const tables = new Map(payload.gitEventStringTables.map(([fieldIndex, values]) => [fieldIndex, values]));
  const decoded = new Map();
  for (const [id, row] of Object.entries(payload.gitEventsById)) {
    const [masks, ...values] = row;
    const event = {};
    let cursor = 0;
    payload.gitEventFields.forEach((field, fieldIndex) => {
      const mask = masks[Math.floor(fieldIndex / 30)];
      if (!(Math.floor(mask / (2 ** (fieldIndex % 30))) % 2)) return;
      const value = values[cursor++];
      event[field] = tables.has(fieldIndex) ? tables.get(fieldIndex)[value] : value;
    });
    decoded.set(id, event);
  }
  return decoded;
}

test('the wire fixture covers every contract row', () => {
  assert.equal(fixture.contract, 'harbor-wire-v1');
  const attached = new Set(fixture.sessions.flatMap((session) => session.gitEvents.map((event) => event.id)));
  assert.deepEqual([...attached].sort(), [...events.keys()].sort(), 'events lists each attached event once');
  for (const session of fixture.sessions) {
    assert.ok(session.repoRoot, `${session.sessionId} carries repoRoot`);
    assert.deepEqual(Object.keys(session.worktree).sort(), ['isMain', 'name', 'path']);
  }
  assert.ok(fixture.sessions.some((session) => session.project.endsWith('/pkg/app') && session.repoRoot !== session.project),
    'a subdirectory session resolves to its repository');
  assert.ok(fixture.sessions.some((session) => session.worktree.isMain === false), 'a linked worktree session');

  for (const event of events.values()) {
    assert.ok(event.id && event.type && event.project && event.repoRoot, event.id);
    if (event.observed) {
      assert.ok(event.cwd && event.checkout, `${event.id} observed identity`);
      assert.deepEqual(Object.keys(event.worktree).sort(), ['isMain', 'name', 'path']);
    }
    if (event.type === 'push' && event.refs) {
      for (const ref of event.refs) assert.deepEqual(Object.keys(ref).filter((key) => key !== 'sha' && key !== 'tag').sort(), ['dst', 'src', 'status']);
    }
    if (event.type === 'push') assert.notEqual(event.branch, 'HEAD');
  }

  const observed = byCase('observedCommit');
  assert.match(observed.sha, /^[0-9a-f]{7,40}$/);
  assert.equal(observed.attribution, 'observed');
  assert.equal(observed.success, true);
  assert.equal(byCase('worktreeObservedCommit').worktree.isMain, false);

  const scanned = byCase('scannedCommitWithCoAuthors');
  assert.equal(scanned.attribution, 'scanned');
  assert.deepEqual(Object.keys(scanned.author).sort(), ['email', 'name']);
  assert.ok(scanned.coAuthors.length > 0);
  assert.match(scanned.sha, /^[0-9a-f]{40}$/);
  assert.equal(byCase('scannedWorktreeCommit').worktree.isMain, false);

  for (const name of ['subdirectoryPushWithLandedShas', 'headPushWithLandedShas', 'transitionPush']) {
    const push = byCase(name);
    assert.ok(push.landedShas.length > 0, name);
    assert.ok(push.landedShas.every((sha) => /^[0-9a-f]{40}$/.test(sha)), name);
  }
  assert.equal(byCase('headPushWithLandedShas').branch, 'feat-a');
  assert.equal(byCase('transitionPush').synthetic, 'transition');
  assert.equal(byCase('tagsOnlyPush').tagsOnly, true);
  assert.equal(byCase('singleTagPush').tag, 'v1.0.1');
  assert.deepEqual(byCase('singleTagPush').refs.map(({ src, tag }) => [src, tag]), [['refs/tags/v1.0.1', true]]);
  assert.equal(byCase('deletedPush').deleted, true);
  const rejected = byCase('rejectedPush');
  assert.equal(rejected.success, false);
  assert.ok(rejected.reason && rejected.reason.length <= 200);
  const pair = byCase('refspecPairPush');
  assert.deepEqual(pair.refs.map(({ src, dst }) => [src, dst]), [['feat-a', 'main']]);
  assert.equal(pair.branch, 'feat-a');
  assert.ok(byCase('scannedCommitWithBranches').branches.includes(byCase('scannedCommitWithBranches').branch));
  const detached = byCase('detachedCommit');
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);
  const ghost = byCase('rewrittenGhost');
  assert.ok(ghost.oldIds.length > 0);
  assert.ok(!events.has(ghost.oldIds[0]), 'a retired ghost observation is not on the wire');
  for (const event of events.values()) {
    if (event.attribution !== 'scanned' && event.type !== 'rewritten') continue;
    assert.ok(Number.isInteger(event.scanSeq) && event.scanSeq > 0, `${event.id} scanSeq`);
    assert.ok(event.scannedAt > 0, `${event.id} scannedAt`);
    assert.equal(typeof event.branchesComplete, 'boolean', `${event.id} branchesComplete`);
  }
  const rewritten = byCase('rewritten');
  assert.ok(rewritten.oldShas.length > 0);
  assert.deepEqual(Object.keys(rewritten.replacements[0]).sort(), ['newSha', 'oldSha']);
});

test('compactGitEventsForWire carries every contract field through the wire', () => {
  const payload = compactGitEventsForWire(fixture.sessions);
  const decoded = decodeWire(JSON.parse(JSON.stringify(payload)));
  payload.sessions.forEach((session, index) => {
    const original = fixture.sessions[index];
    assert.equal(session.repoRoot, original.repoRoot);
    assert.deepEqual(session.worktree, original.worktree);
    assert.equal(session.gitEvents.length, original.gitEvents.length);
  });
  const decodedById = new Map([...decoded.values()].map((event) => [event.id, event]));
  for (const event of events.values()) {
    assert.deepEqual(decodedById.get(event.id), event, event.id);
  }
});
