import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TopBar, usageCoverage, connectionReasonText } from '../../claudeville/src/presentation/shared/TopBar.js';
import {
    DEFAULT_STALE_AFTER_MS,
    initialVillageState,
    LinkState,
    linkStatusText,
} from '../../claudeville/src/application/VillageState.js';
test('connection reasons expose only bounded operator copy', () => {
    const codes = [
        'connection-refused',
        'socket-closed',
        'initial-sync-failed',
        'message-invalid',
        'delta-baseline-mismatch',
        'patch-failed',
        'poll-timeout',
        'session-poll-failed',
        'poll-failed',
        'watcher-unavailable',
        'unknown-normalized-code',
    ];
    for (const code of codes) {
        const copy = connectionReasonText(code);
        assert.equal(copy.includes('/'), false, `${code} produced path-like copy`);
        assert.equal(copy.includes('Error:'), false, `${code} produced stack-like copy`);
        assert.equal(copy.includes('undefined'), false, `${code} produced an undefined value`);
    }
    assert.equal(
        connectionReasonText('unknown-normalized-code'),
        'Connection interrupted; ClaudeVille will keep retrying locally.',
    );
});

test('connection labels require a snapshot and age into stale', () => {
    const now = 2_000_000;
    const syncing = initialVillageState();
    assert.equal(linkStatusText(syncing, now), 'SYNCING');

    const fresh = {
        ...syncing,
        link: {
            ...syncing.link,
            state: LinkState.LIVE,
            lastSnapshotAt: now - 1000,
        },
    };
    assert.equal(linkStatusText(fresh, now), 'LIVE');

    const stale = {
        ...fresh,
        link: {
            ...fresh.link,
            lastSnapshotAt: now - DEFAULT_STALE_AFTER_MS - 1,
        },
    };
    assert.match(linkStatusText(stale, now), /^STALE \/ last seen \d+s ago$/);
});

test('every concrete topbar class emitted by TopBar has a stylesheet rule', async () => {
    const source = await readFile(
        new URL('../../claudeville/src/presentation/shared/TopBar.js', import.meta.url),
        'utf8',
    );
    const css = await readFile(
        new URL('../../claudeville/css/topbar.css', import.meta.url),
        'utf8',
    );
    const classes = new Set(source.match(/topbar__[A-Za-z0-9_-]+/g) || []);
    classes.delete('topbar__spend-section--');
    for (const kind of ['projects', 'providers']) {
        classes.add(`topbar__spend-section--${kind}`);
    }

    const missing = [...classes]
        .filter(className => !css.includes(`.${className}`))
        .sort();
    assert.deepEqual(missing, []);
});


test('suspended FPS is hidden while genuine numeric zero remains an error', () => {
    const classes = new Set();
    const fps = { hidden: false, classList: { remove: value => classes.delete(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value) } };
    const bar = { els: { fps } };
    for (const value of [null, undefined, '', '60', NaN]) {
        TopBar.prototype.renderFps.call(bar, value);
        assert.equal(fps.hidden, true, String(value));
    }
    TopBar.prototype.renderFps.call(bar, 0);
    assert.equal(fps.textContent, '0 FPS');
    assert.equal(classes.has('topbar__fps--danger'), true);
    TopBar.prototype.renderFps.call(bar, 60);
    assert.equal(fps.hidden, false);
    assert.equal(fps.textContent, '60 FPS');
    assert.equal(classes.has('topbar__fps--danger'), false);
});

test('usage coverage distinguishes observed zero, partial counts and unavailable billing', () => {
    assert.deepEqual(usageCoverage([
        { tokens: { input: 0, output: 0, availability: 'observed' } },
        { tokens: { input: 20, availability: 'partial' } },
        { tokens: { contextWindow: 100, availability: 'unavailable' } },
    ]), { observed: 1, partial: 1, unavailable: 1 });
});

test('needs-you status stays separate from generic waiting and hides when empty', () => {
    let stats = { working: 4, idle: 2, waiting: 0, needsYou: 1 };
    const bar = {
        world: { getStats: () => stats },
        els: { working: {}, idle: {}, waiting: {}, needsYou: {} },
        _unknownModelSeenToday() {}, _renderSpend() {}, _renderActivityRail() {},
    };
    TopBar.prototype.render.call(bar);
    assert.equal(bar.els.waiting.textContent, 0);
    assert.equal(bar.els.needsYou.textContent, '1 NEEDS YOU');
    assert.equal(bar.els.needsYou.hidden, false);
    stats = { ...stats, waiting: 1, needsYou: 0 };
    TopBar.prototype.render.call(bar);
    assert.equal(bar.els.waiting.textContent, 1);
    assert.equal(bar.els.needsYou.hidden, true);
});
