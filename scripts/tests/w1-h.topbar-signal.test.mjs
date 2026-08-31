import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { connectionReasonText } from '../../claudeville/src/presentation/shared/TopBar.js';
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
