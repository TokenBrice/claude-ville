import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    shouldFocusActivityPanel,
    shouldHandleActivityPanelEscape,
} from '../../claudeville/src/presentation/shared/ActivityPanel.js';

test('activity panel requests focus only for keyboard-origin selection', () => {
    assert.equal(shouldFocusActivityPanel('pointer'), false);
    assert.equal(shouldFocusActivityPanel('keyboard'), true);
});

test('activity panel Escape yields to a modal', () => {
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: true,
        popoverOpen: false,
    }), false);
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: false,
        popoverOpen: false,
    }), true);
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: false,
        popoverOpen: true,
    }), false);
});

test('sidebar status dots stop pulsing under reduced motion without viewport media queries', async () => {
    const css = await readFile(new URL('../../claudeville/css/sidebar.css', import.meta.url), 'utf8');
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.sidebar__agent-dot--working,\s*\.sidebar__agent-dot--waiting,\s*\.sidebar__agent-dot--rate_limited,\s*\.sidebar__agent-dot--errored,\s*\.sidebar__agent-dot--waiting_on_user\s*\{\s*animation:\s*none\s*;\s*\}\s*\}/);
    assert.doesNotMatch(css, /@media[^\{]*\b(?:width|min-width|max-width)\b/i);
});
