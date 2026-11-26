import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { STATUS_VISUALS } from '../../claudeville/src/config/theme.js';
import {
    CALM_GROUND_AURA,
    CALM_GROUND_HEX,
    GROUND_AURA,
    GROUND_SIGNAL_STATUSES,
    STATUS_AURA,
    drawCrowdClusterAuras,
    drawCrowdClusterBadges,
} from '../../claudeville/src/presentation/character-mode/CrowdClusterOverlay.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { TopBar, soundSliderFill } from '../../claudeville/src/presentation/shared/TopBar.js';
import { SOUND_STEP_MAX } from '../../claudeville/src/presentation/shared/SoundSettings.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function hexToRgbString(hex) {
    const value = parseInt(String(hex).replace(/^#/, ''), 16);
    return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function recordingCtx() {
    const fills = [];
    const ctx = {
        globalAlpha: 1,
        fillStyle: '',
        font: '',
        textAlign: '',
        textBaseline: '',
        save() {},
        restore() {},
        translate() {},
        scale() {},
        setTransform() {},
        getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
        fillRect() { fills.push(this.fillStyle); },
        fillText() {},
        measureText(text) { return { width: String(text).length * 8 }; },
    };
    return { ctx, fills };
}

test('W0-A: STATUS_AURA derives every status hue directly from STATUS_VISUALS (theme.js)', () => {
    for (const [status, visual] of Object.entries(STATUS_VISUALS)) {
        const aura = STATUS_AURA[status];
        assert.ok(aura, `STATUS_AURA missing '${status}'`);
        assert.equal(
            aura.fill,
            `rgba(${hexToRgbString(visual.color)}, 1)`,
            `STATUS_AURA.${status}.fill must match STATUS_VISUALS.${status}.color (${visual.color})`,
        );
    }

    // Regression guards against stale v0.67.2 hardcoded sky-blue waiting & orange rate_limited.
    assert.notEqual(STATUS_AURA[AgentStatus.WAITING_ON_USER].fill, 'rgba(111, 179, 217, 1)');
    assert.notEqual(STATUS_AURA[AgentStatus.WAITING].fill, 'rgba(111, 179, 217, 1)');
    assert.notEqual(STATUS_AURA[AgentStatus.RATE_LIMITED].fill, 'rgba(251, 146, 60, 1)');
    assert.equal(STATUS_AURA[AgentStatus.WAITING_ON_USER].fill, 'rgba(232, 212, 77, 1)');
    assert.equal(STATUS_AURA[AgentStatus.RATE_LIMITED].fill, 'rgba(240, 106, 224, 1)');
    assert.equal(STATUS_AURA[AgentStatus.WORKING].fill, 'rgba(121, 217, 117, 1)');
    assert.equal(STATUS_AURA[AgentStatus.ERRORED].fill, 'rgba(224, 108, 91, 1)');
    assert.equal(STATUS_AURA[AgentStatus.WAITING].fill, 'rgba(223, 140, 63, 1)');
    assert.equal(STATUS_AURA[AgentStatus.IDLE].fill, 'rgba(134, 191, 224, 1)');

    // Behavioral check: canvas auras & pips paint with canonical STATUS_VISUALS hues.
    const crowdStats = {
        clusters: [
            {
                id: '5,5',
                tileX: 20,
                tileY: 20,
                count: 4,
                dominantStatus: AgentStatus.WAITING_ON_USER,
                statuses: {
                    [AgentStatus.WAITING_ON_USER]: 2,
                    [AgentStatus.RATE_LIMITED]: 1,
                    [AgentStatus.WORKING]: 1,
                },
            },
        ],
    };
    const ground = recordingCtx();
    drawCrowdClusterAuras(ground.ctx, { crowdStats });
    assert.ok(
        ground.fills.includes(STATUS_AURA[AgentStatus.WAITING_ON_USER].fill),
        'ground aura draws waiting_on_user in canonical yellow',
    );

    const world = tileToWorld(20, 20);
    const sprites = new Map([
        ['a1', { agent: { id: 'a1', status: AgentStatus.WORKING }, x: world.x, y: world.y }],
    ]);
    const overlay = recordingCtx();
    drawCrowdClusterBadges(overlay.ctx, { crowdStats, agentSprites: sprites, zoom: 1 });
    assert.ok(overlay.fills.includes(STATUS_AURA[AgentStatus.WAITING_ON_USER].fill), 'pip draws needs-you yellow');
    assert.ok(overlay.fills.includes(STATUS_AURA[AgentStatus.RATE_LIMITED].fill), 'pip draws rate-limited orchid');
    assert.ok(overlay.fills.includes(STATUS_AURA[AgentStatus.WORKING].fill), 'pip draws working green');
});

test('W0-A: zero bitmap font-style: italic declarations remain in modal.css or any stylesheet', () => {
    const cssDir = path.join(REPO_ROOT, 'claudeville/css');
    const modalCss = fs.readFileSync(path.join(cssDir, 'modal.css'), 'utf8');
    assert.equal(/font-style\s*:\s*italic\b/i.test(modalCss), false, 'modal.css must not set font-style: italic');

    const offenders = fs.readdirSync(cssDir)
        .filter(name => name.endsWith('.css'))
        .filter(name => /font-style\s*:\s*italic\b/i.test(fs.readFileSync(path.join(cssDir, name), 'utf8')));
    assert.deepEqual(offenders, [], 'no CSS file may request synthetic italic on bitmap faces');
});

test('W0-A: Sound Popover range slider and buttons unify with Keep brass/gold tokens in topbar.css', () => {
    const topbarCss = fs.readFileSync(path.join(REPO_ROOT, 'claudeville/css/topbar.css'), 'utf8');

    const volIdx = topbarCss.indexOf('.topbar__sound-vol {');
    assert.ok(volIdx >= 0, '.topbar__sound-vol rule exists');
    const volSection = topbarCss.slice(volIdx, volIdx + 1400);

    // Matches .settings-range 2px track + 8x8 gold-hi thumb + seam outline + focus ring.
    assert.match(volSection, /\.topbar__sound-vol::-webkit-slider-runnable-track\s*\{[^}]*height:\s*2px;/s);
    assert.match(volSection, /\.topbar__sound-vol::-webkit-slider-runnable-track\s*\{[^}]*var\(--gold\)[^}]*var\(--line-2\)/s);
    assert.match(volSection, /\.topbar__sound-vol::-moz-range-track\s*\{[^}]*height:\s*2px;/s);
    assert.match(volSection, /\.topbar__sound-vol::-webkit-slider-thumb\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;[^}]*background:\s*var\(--gold-hi\);[^}]*var\(--seam\)/s);
    assert.match(volSection, /\.topbar__sound-vol::-moz-range-thumb\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;[^}]*background:\s*var\(--gold-hi\);[^}]*var\(--seam\)/s);
    assert.match(volSection, /\.topbar__sound-vol:focus-visible\s*\{[^}]*var\(--cv-focus\)/s);

    // Old clunky 4px recessed track + 8x12 grey thumb is gone.
    assert.equal(/\.topbar__sound-vol::-webkit-slider-thumb\s*\{[^}]*height:\s*12px;/s.test(volSection), false);
    assert.equal(/\.topbar__sound-vol::-webkit-slider-thumb\s*\{[^}]*background:\s*var\(--ink-2\);/s.test(volSection), false);

    // Sound popover action buttons carry Keep bevel + brass hover highlight.
    const actionIdx = topbarCss.indexOf('.topbar__sound-panel .topbar__sound-action {');
    assert.ok(actionIdx >= 0, '.topbar__sound-action rule exists');
    const actionSection = topbarCss.slice(actionIdx, actionIdx + 700);
    assert.match(actionSection, /var\(--line-2\)/);
    assert.match(actionSection, /var\(--seam\)/);
    assert.match(actionSection, /var\(--brass\)/);
});

test('W0-A: Shift+D and Shift+O toggle debug overlays only in World mode and through shortcutBlocked; Shift+P does not', () => {
    const calls = [];
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer._worldModeActive = true;
    renderer._toggleDebugOverlay = (method) => {
        calls.push(method);
        return Promise.resolve(true);
    };

    const makeDoc = ({ modalOpen = false, popoverOpen = false } = {}) => ({
        getElementById: id => (id === 'modalOverlay' ? { getAttribute: () => (modalOpen ? 'false' : 'true') } : null),
        querySelector: () => (popoverOpen ? {} : null),
    });
    const keyEvent = (code, { tagName = 'BODY', shiftKey = true, repeat = false, isContentEditable = false, ...rest } = {}) => ({
        code,
        shiftKey,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat,
        target: { tagName, isContentEditable },
        ...rest,
    });

    // Shift+D and Shift+O fire cleanly in World mode with no blockers.
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD'), { doc: makeDoc() }), true);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO'), { doc: makeDoc() }), true);
    assert.deepEqual(calls, ['toggle', 'togglePathDebug']);

    // Shift+P is freed for Postcard Studio and MUST NOT toggle path debug.
    calls.length = 0;
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyP'), { doc: makeDoc() }), false);
    assert.deepEqual(calls, []);

    // Typing capital D or O in inputs / editable elements is blocked.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD', { tagName }), { doc: makeDoc() }), false, tagName);
        assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO', { tagName }), { doc: makeDoc() }), false, tagName);
    }
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD', { tagName: 'DIV', isContentEditable: true }), { doc: makeDoc() }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO', { tagName: 'DIV', isContentEditable: true }), { doc: makeDoc() }), false);

    // Blocked under open modal, open auto popover, key repeat, extra modifiers, and Dashboard mode.
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD'), { doc: makeDoc({ modalOpen: true }) }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO'), { doc: makeDoc({ modalOpen: true }) }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD'), { doc: makeDoc({ popoverOpen: true }) }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO'), { doc: makeDoc({ popoverOpen: true }) }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD', { repeat: true }), { doc: makeDoc() }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO', { ctrlKey: true }), { doc: makeDoc() }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD', { metaKey: true }), { doc: makeDoc() }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO', { altKey: true }), { doc: makeDoc() }), false);

    renderer._worldModeActive = false;
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyD'), { doc: makeDoc() }), false);
    assert.equal(renderer._handleDebugShortcut(keyEvent('KeyO'), { doc: makeDoc() }), false);
    assert.deepEqual(calls, [], 'no blocked event may toggle debug overlays');

    // Source contract check: no KeyP -> togglePathDebug binding remains.
    const isoSource = fs.readFileSync(
        path.join(REPO_ROOT, 'claudeville/src/presentation/character-mode/IsometricRenderer.js'),
        'utf8',
    );
    assert.equal(/KeyP[^\n]*togglePathDebug/.test(isoSource), false, 'Shift+P must not be bound to togglePathDebug');
    assert.match(isoSource, /import\s*\{\s*shortcutBlocked\s*\}\s*from\s*['"]\.\.\/shared\/ShortcutGuard\.js['"]/);
});

test('W0 council: actionable crowds pool in exact STATUS_VISUALS hues; calm crowds pool in warm brass while pips keep their hues', () => {
    // Every actionable/attention status tints the ground in its exact
    // STATUS_VISUALS hue (no stale v0.67.2 sky blue or orange).
    assert.deepEqual([...GROUND_SIGNAL_STATUSES].sort(), [
        AgentStatus.ERRORED, AgentStatus.RATE_LIMITED, AgentStatus.WAITING, AgentStatus.WAITING_ON_USER,
    ].sort());
    const expected = {
        [AgentStatus.WAITING_ON_USER]: '#e8d44d',
        [AgentStatus.ERRORED]: '#e06c5b',
        [AgentStatus.RATE_LIMITED]: '#f06ae0',
        [AgentStatus.WAITING]: '#df8c3f',
    };
    for (const [status, hex] of Object.entries(expected)) {
        assert.equal(STATUS_VISUALS[status].color.toLowerCase(), hex, `${status} keeps its canonical hue`);
        assert.equal(GROUND_AURA[status], STATUS_AURA[status], `${status} ground aura is the STATUS_VISUALS aura`);
        assert.equal(GROUND_AURA[status].fill, `rgba(${hexToRgbString(hex)}, 1)`);
        for (const stale of ['rgba(111, 179, 217, 1)', 'rgba(91, 150, 190, 1)', 'rgba(251, 146, 60, 1)', 'rgba(234, 88, 12, 1)']) {
            assert.notEqual(GROUND_AURA[status].fill, stale, `${status} ground fill is not a stale hue`);
            assert.notEqual(GROUND_AURA[status].stroke, stale, `${status} ground rim is not a stale hue`);
        }
    }

    // Calm crowds (working, idle, completed, chatting) share one deliberate
    // warm neutral brass ground, never their own green/sky/parchment.
    assert.equal(CALM_GROUND_HEX, '#c8b58a');
    assert.equal(CALM_GROUND_AURA.fill, 'rgba(200, 181, 138, 1)');
    for (const status of Object.keys(STATUS_VISUALS).filter((key) => !GROUND_SIGNAL_STATUSES.includes(key))) {
        assert.equal(GROUND_AURA[status], CALM_GROUND_AURA, `${status} pools in calm brass`);
        assert.notEqual(GROUND_AURA[status].fill, STATUS_AURA[status].fill, `${status} ground is not its pip hue`);
    }
    for (const status of [AgentStatus.WORKING, AgentStatus.IDLE, AgentStatus.COMPLETED]) {
        assert.equal(GROUND_AURA[status], CALM_GROUND_AURA, `${status} is calm`);
    }

    // Behaviour: the ground pass paints the cluster's ground aura; the
    // standard's pips still paint every status in its STATUS_VISUALS hue.
    const cluster = (dominantStatus, statuses) => ({
        clusters: [{ id: '5,5', tileX: 20, tileY: 20, count: 4, dominantStatus, statuses }],
    });
    const calm = cluster(AgentStatus.WORKING, { [AgentStatus.WORKING]: 3, [AgentStatus.IDLE]: 1 });
    const calmGround = recordingCtx();
    drawCrowdClusterAuras(calmGround.ctx, { crowdStats: calm });
    assert.ok(calmGround.fills.includes(CALM_GROUND_AURA.fill), 'a working crowd pools in brass');
    assert.ok(calmGround.fills.includes(CALM_GROUND_AURA.stroke), 'with a brass dotted rim');
    assert.ok(!calmGround.fills.includes(STATUS_AURA[AgentStatus.WORKING].fill), 'no green-on-green ground pool');
    const calmBadge = recordingCtx();
    drawCrowdClusterBadges(calmBadge.ctx, { crowdStats: calm, agentSprites: new Map(), zoom: 1 });
    assert.ok(calmBadge.fills.includes(STATUS_AURA[AgentStatus.WORKING].fill), 'the working pip stays green');
    assert.ok(calmBadge.fills.includes(STATUS_AURA[AgentStatus.IDLE].fill), 'the idle pip stays sky');
    assert.ok(!calmBadge.fills.includes(CALM_GROUND_AURA.fill), 'pips never wear the ground brass');

    for (const status of GROUND_SIGNAL_STATUSES) {
        const ground = recordingCtx();
        drawCrowdClusterAuras(ground.ctx, { crowdStats: cluster(status, { [status]: 3, [AgentStatus.WORKING]: 1 }) });
        assert.ok(ground.fills.includes(STATUS_AURA[status].fill), `${status} pools in its own hue`);
        assert.ok(!ground.fills.includes(CALM_GROUND_AURA.fill), `${status} never pools in brass`);
    }
});

class FakeStyle {
    constructor() { this.props = new Map(); this.writes = 0; }
    getPropertyValue(name) { return this.props.get(name) || ''; }
    setProperty(name, value) { this.writes++; this.props.set(name, String(value)); }
}

function fakeNode(extra = {}) {
    const attributes = new Map();
    return {
        hidden: false,
        textContent: '',
        style: new FakeStyle(),
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
        setAttribute: (name, value) => attributes.set(name, String(value)),
        ...extra,
    };
}

test('W0 council: TopBar sets the sound volume slider --fill so the Chromium track paints its gold share', () => {
    // The formula is fluid (thumb-centre on a track of any width), clamped 0..1.
    assert.equal(soundSliderFill(0), 'calc(4px + (100% - 8px) * 0)');
    assert.equal(soundSliderFill(SOUND_STEP_MAX), 'calc(4px + (100% - 8px) * 1)');
    assert.equal(soundSliderFill(SOUND_STEP_MAX * 0.7), 'calc(4px + (100% - 8px) * 0.7)');
    assert.equal(soundSliderFill(-3), soundSliderFill(0));
    assert.equal(soundSliderFill(SOUND_STEP_MAX * 4), soundSliderFill(SOUND_STEP_MAX));
    assert.equal(soundSliderFill(Number.NaN), soundSliderFill(0));

    // topbar.css consumes --fill on the WebKit track (Firefox keeps
    // ::-moz-range-progress), and TopBar never hardcodes a track width.
    const topbarCss = fs.readFileSync(path.join(REPO_ROOT, 'claudeville/css/topbar.css'), 'utf8');
    assert.match(topbarCss, /\.topbar__sound-vol::-webkit-slider-runnable-track\s*\{[^}]*var\(--fill/s);
    assert.match(topbarCss, /\.topbar__sound-vol::-moz-range-progress\s*\{[^}]*var\(--gold\)/s);
    const topbarSource = fs.readFileSync(path.join(REPO_ROOT, 'claudeville/src/presentation/shared/TopBar.js'), 'utf8');
    assert.match(topbarSource, /setStyleProperty\(slider\.input, '--fill', soundSliderFill\(step\)\)/);
    assert.equal(/--fill[^\n]*88px/.test(topbarSource), false, 'no fixed-width track math');

    // Sync path: rendering the popover writes the view's volume step.
    const input = fakeNode({ type: 'range', value: '0' });
    const volume = { row: fakeNode(), input, value: fakeNode() };
    const topbar = {
        _soundEls: {
            radios: {}, volume,
            now: fakeNode(), note: fakeNode(), preview: fakeNode(), hush: fakeNode(), actions: fakeNode(),
        },
        _soundView: { preset: 'townBand', volumeStep: 7 },
        _renderSoundPresets: TopBar.prototype._renderSoundPresets,
    };
    TopBar.prototype._renderSoundPanel.call(topbar);
    assert.equal(input.value, '7');
    assert.equal(input.style.getPropertyValue('--fill'), 'calc(4px + (100% - 8px) * 0.7)');
    const writes = input.style.writes;
    TopBar.prototype._renderSoundPanel.call(topbar);
    assert.equal(input.style.writes, writes, 'an unchanged step writes no style');

    // Input path: dragging the slider moves the fill live.
    const steps = [];
    topbar._withAudio = (fn) => fn({ setVolumeStep: (step) => steps.push(step) });
    input.value = '3';
    TopBar.prototype._onSoundSliderInput.call(topbar, input);
    assert.equal(input.style.getPropertyValue('--fill'), 'calc(4px + (100% - 8px) * 0.3)');
    input.value = '0';
    TopBar.prototype._onSoundSliderInput.call(topbar, input);
    assert.equal(input.style.getPropertyValue('--fill'), 'calc(4px + (100% - 8px) * 0)');
    assert.deepEqual(steps, [3, 0]);
});
