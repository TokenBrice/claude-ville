import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { ChronicleDressingLedger, MonumentRules } from '../../claudeville/src/application/MonumentRules.js';

const require = createRequire(import.meta.url);
const { parseGitEventsFromCommand } = require('../../claudeville/adapters/gitEvents.js');

const rules = new MonumentRules();
const done = { success: true, exitCode: 0, ts: 1_800_000_000_000 };

// The push event the adapter emits for a finished shell command.
function pushed(command, context = done) {
    const events = parseGitEventsFromCommand(command, context).filter(event => event.type === 'push');
    assert.equal(events.length, 1, command);
    return { ...events[0], project: '/repos/claude-ville' };
}

test('a verified push of a release tag plants one release stone', () => {
    for (const command of [
        'git push origin tag v1.2.0',
        'git push origin refs/tags/v1.2.0',
        'git push origin v1.2.0:refs/tags/v1.2.0',
        'git push origin v1.2.0',
        'git tag v1.2.0 && git push origin v1.2.0',
        'git tag -a v1.2.0 -m "Release 1.2.0" && git push origin v1.2.0',
        'git push origin main v1.2.0',
    ]) {
        const stone = rules.classify(pushed(command));
        assert.equal(stone?.kind, 'release', command);
        assert.equal(stone.district, 'harbor');
        assert.equal(stone.label, 'v1.2.0');
        assert.equal(stone.dedupKey, 'release:/repos/claude-ville:v1.2.0');
    }
    assert.equal(rules.classify(pushed('git push origin 2.0.0-rc.1'))?.label, '2.0.0-rc.1');
    // A tag the chain created may be a looser version than a bare refspec.
    assert.equal(rules.classify(pushed('git tag v2.0 && git push origin v2.0'))?.label, 'v2.0');
    assert.equal(rules.classify({ type: 'push', targetRef: 'refs/tags/2.0.1', status: 'completed' })?.label, '2.0.1');
    assert.equal(rules.classify({ type: 'push', targetRef: 'v3.1.4', success: true })?.label, 'v3.1.4');
});

test('the adapter marks a push tagged by the same chain or a refs/tags destination', () => {
    assert.equal(pushed('git tag v1.2.0 && git push origin v1.2.0').tag, 'v1.2.0');
    assert.equal(pushed('git tag -s -m "cut" v1.2.0 HEAD; git push origin v1.2.0').tag, 'v1.2.0');
    assert.equal(pushed('git push origin HEAD:refs/tags/v1.2.0').tag, 'v1.2.0');
    assert.equal(pushed('git push origin tag v1.2.0').tag, 'v1.2.0');
    assert.equal(pushed('git push origin v1.2.0').tag, undefined);
    assert.equal(pushed('git tag -d v1.2.0 && git push origin v1.2.0').tag, undefined);
    assert.equal(pushed('git tag -l v1.2.0 && git push origin v1.2.0').tag, undefined);
    assert.equal(pushed('git tag v1.2.0 && git push origin main').tag, undefined);
});

test('failed, unverified, dry-run, deleted and local tags are not releases', () => {
    const tag = { type: 'push', targetRef: 'refs/tags/v1.2.0' };
    assert.equal(rules.classify({ ...tag, success: false }), null);
    assert.equal(rules.classify({ ...tag, exitCode: 1 }), null);
    assert.equal(rules.classify(tag), null);
    assert.equal(rules.classify({ ...tag, success: true, dryRun: true }), null);
    assert.equal(rules.classify(pushed('git push --delete origin refs/tags/v1.2.0')), null);
    assert.equal(rules.classify(pushed('git push origin :refs/tags/v1.2.0')), null);
    assert.equal(rules.classify({ type: 'tag', tag: 'v1.2.0', success: true }), null);
    assert.equal(rules.classify(pushed('git push origin tag v1.2.0', { success: false, exitCode: 1 })), null);
    assert.equal(rules.classify(pushed('git tag v1.2.0 && git push origin v1.2.0', { success: false, exitCode: 1 })), null);
    assert.equal(rules.classify({ type: 'push', targetRef: 'v1.2.0', refspecs: ['v1.2.0'] }), null);
    assert.equal(rules.classify(pushed('git push --delete origin v1.2.0')), null);
});

test('a branch push is never a release, even one named like a version', () => {
    for (const command of [
        'git push origin main',
        'git push origin 1.2-maint',
        'git push origin v2.0',
        'git push origin HEAD:refs/heads/1.2-maint',
        'git push origin HEAD:v1.2.0',
        'git push origin main:1.2.0',
        'git push origin refs/heads/1.2.0',
        'git tag nightly && git push origin nightly',
    ]) {
        assert.equal(rules.classify(pushed(command)), null, command);
    }
    assert.equal(rules.classify({ type: 'push', targetRef: '1.2-maint', success: true }), null);
    assert.equal(rules.classify({ type: 'push', targetRef: 'refs/tags/nightly', success: true }), null);
    // An inferred upstream push targets the pushing branch.
    assert.equal(rules.classify({ type: 'push', targetRef: '1.2.0', branch: '1.2.0', inferred: true, success: true }), null);
});

test('a held release strings its bunting pennant only once its crown reveals it', async () => {
    const ledger = new ChronicleDressingLedger();
    const event = { type: 'push', targetRef: 'refs/tags/v1.2.0', success: true };
    await ledger.note(null, { id: 'r1', kind: 'release' }, event, { hold: true });
    assert.equal(ledger.counts.release, 1);
    assert.equal(ledger.frameFor('harbor', 'bunting', 5), null);
    await ledger.note(null, { id: 'r2', kind: 'release' }, event);
    assert.equal(ledger.frameFor('harbor', 'bunting', 5), 0);
    ledger.reveal(['r1']);
    assert.equal(ledger.frameFor('harbor', 'bunting', 5), 1);
});
