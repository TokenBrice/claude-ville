import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    resolveClose,
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

test('activity panel closes on agent deselection without re-emitting or moving focus', async () => {
    const source = await readFile(new URL('../../claudeville/src/presentation/shared/ActivityPanel.js', import.meta.url), 'utf8');
    const eventClose = resolveClose({ origin: 'event' });
    assert.deepEqual(eventClose, {
        emit: false,
        stopPolling: true,
        moveFocus: false,
    });
    const handlerStart = source.indexOf('this._onAgentDeselected =');
    const handlerEnd = source.indexOf('this._onAgentUpdated =', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(handler, /this\._onAgentDeselected = \(\) => \{\s*if \(this\._mode === 'agent' && this\.currentAgent\) this\._close\(\{ origin: 'event' \}\);\s*\};/);
    assert.doesNotMatch(handler, /this\.hide\(\)/);
    assert.match(source, /eventBus\.on\('agent:deselected', this\._onAgentDeselected\);/);
    assert.match(source, /eventBus\.off\('agent:deselected', this\._onAgentDeselected\);/);
    assert.match(source, /this\._mode = null;\s*if \(wasAgent && emit\) emitAgentDeselected\(\);/);

    const bus = {
        emissions: 0,
        listeners: [],
        on(listener) {
            this.listeners.push(listener);
        },
        emit() {
            this.emissions++;
            for (const listener of this.listeners) listener();
        },
    };
    let closeCalls = 0;
    bus.on(() => {
        closeCalls++;
        if (eventClose.emit) bus.emit('agent:deselected');
    });
    bus.emit('agent:deselected');
    assert.equal(closeCalls, 1);
    assert.equal(bus.emissions, 1);
});

test('activity panel close initiated by the panel emits once and restores focus after stopping polling', () => {
    const decision = resolveClose({ origin: 'panel' });
    assert.deepEqual(decision, {
        emit: true,
        stopPolling: true,
        moveFocus: true,
    });

    const bus = {
        emissions: 0,
        emit() {
            this.emissions++;
        },
    };
    if (decision.emit) bus.emit('agent:deselected');
    assert.equal(bus.emissions, 1);
});

test('sidebar status dots stop pulsing under reduced motion without viewport media queries', async () => {
    const css = await readFile(new URL('../../claudeville/css/sidebar.css', import.meta.url), 'utf8');
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.sidebar__agent-dot--working,\s*\.sidebar__agent-dot--waiting,\s*\.sidebar__agent-dot--rate_limited,\s*\.sidebar__agent-dot--errored,\s*\.sidebar__agent-dot--waiting_on_user\s*\{\s*animation:\s*none\s*;\s*\}\s*\}/);
    assert.doesNotMatch(css, /@media[^\{]*\b(?:width|min-width|max-width)\b/i);
});
