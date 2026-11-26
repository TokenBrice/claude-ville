import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
    QUOTA_TERRACE_CENTER,
    QUOTA_TERRACE_PROVIDERS,
    QUOTA_TERRACE_SLOTS,
} from '../../claudeville/src/config/scenery.js';
import {
    QUOTA_PILLAR_LEVELS,
    QUOTA_PILLAR_STATES,
    QUOTA_PILLAR_STREAM_PHASES,
    QUOTA_PILLAR_STRIP_ORIGIN,
    QUOTA_PROVIDER_META,
    quotaDrainStep,
    quotaDraining,
    quotaPillarKey,
    quotaPillarReading,
    quotaPillarReadings,
    quotaPillarStateCell,
    quotaPillarStreamCell,
    quotaPillarStripCellCount,
    quotaPillarTooltip,
} from '../../claudeville/src/presentation/character-mode/QuotaTerrace.js';
import { IsleLandmarks, QUOTA_PILLAR_ID, QUOTA_PILLAR_STRIP_ID } from '../../claudeville/src/presentation/character-mode/IsleLandmarks.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { STATUS_VISUALS } from '../../claudeville/src/config/theme.js';
import { hoverPlateLines } from '../../claudeville/src/presentation/shared/WorldHoverPlate.js';
import {
    QUOTA_LEDGER_SEGMENTS,
    QuotaLedgerCard,
    buildQuotaLedgerModel,
    isInQuotaLedgerCard,
} from '../../claudeville/src/presentation/shared/QuotaLedgerCard.js';
import { PROVIDER_PALETTES, bakeStrip, buildAllQuotaTerracePngs } from '../sprites/bake-quota-terrace.mjs';
import { luminance, oklab } from '../sprites/art-analyze.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROPS_DIR = join(ROOT, 'claudeville', 'assets', 'sprites', 'props');
const HOUR = 3_600_000;

function sampleUsage(now = Date.now()) {
    return {
        quota: {
            fiveHour: 0.18,
            sevenDay: 0.38,
            fiveHourResetsAt: now + 2 * HOUR + 15 * 60_000,
            sevenDayResetsAt: now + (3 * 24 + 4) * HOUR,
            highestActiveLimit: {
                kind: 'weekly_all',
                scope: null,
                severity: 'normal',
                usedPercent: 38,
                resetsAt: now + (3 * 24 + 4) * HOUR,
            },
        },
        quotaAvailable: true,
        quotaError: null,
        codex: {
            usedPercent: 44,
            windowMinutes: 10080,
            resetsAt: now + (4 * 24 + 2) * HOUR,
            credits: { balance: 820, hasCredits: true, unlimited: false },
            creditChange: { delta: -12.5, intervalMs: 60_000, ageMs: 120_000 },
            limitReached: false,
            observedAt: now - 5 * 60_000,
        },
        glm: {
            plan: 'Coding Pro',
            weekly: { usedPercent: 12, used: 120, limit: 1000, remaining: 880, resetsAt: new Date(now + (5 * 24 + 1) * HOUR).toISOString() },
            fiveHour: { usedPercent: 4, resetsAt: new Date(now + 3 * HOUR).toISOString() },
            observedAt: now - 2 * 60_000,
            error: null,
        },
        antigravity: {
            source: 't3-cache',
            geminiWeekly: { usedPercent: 26, resetsAt: new Date(now + 2 * 24 * HOUR).toISOString() },
            sharedWeekly: { usedPercent: 12, resetsAt: new Date(now + 2 * 24 * HOUR).toISOString() },
            geminiFiveHour: { usedPercent: 7, resetsAt: new Date(now + 4 * HOUR).toISOString() },
            sharedFiveHour: { usedPercent: 3, resetsAt: new Date(now + 4 * HOUR).toISOString() },
            observedAt: now - 60_000,
            error: null,
        },
    };
}

// ─── 1. 4-Provider Weekly State Mapping & Hover Copy ─────────────────────────

test('v0.69 E2: all 4 providers map weekly quota, expired windows, errors, and LIMIT cleanly', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0);
    const usage = sampleUsage(now);
    const readings = quotaPillarReadings(usage, now);

    assert.deepEqual(
        QUOTA_TERRACE_PROVIDERS.map((p) => [p, quotaPillarKey(readings[p]), readings[p].leftPercent]),
        [
            ['claude', 'l4', 62],
            ['codex', 'l3', 56],
            ['glm', 'l5', 88],
            ['antigravity', 'l4', 74],
        ],
    );

    // Expired reset timestamps read as unknown, never fake 0% or 100%.
    const expired = {
        quota: { sevenDay: 0.4, sevenDayResetsAt: now - 1000 },
        codex: { usedPercent: 40, resetsAt: now - 1000, limitReached: false },
        glm: { weekly: { usedPercent: 20, resetsAt: new Date(now - 1000).toISOString() } },
        antigravity: { geminiWeekly: { usedPercent: 20, resetsAt: new Date(now - 1000).toISOString() } },
    };
    for (const p of QUOTA_TERRACE_PROVIDERS) {
        assert.equal(quotaPillarReading(p, expired, now).state, 'unknown', `${p} expired -> unknown`);
    }

    // 401/403 auth errors shroud the affected provider only.
    assert.equal(quotaPillarReading('claude', { ...usage, quotaError: { status: 401 } }, now).state, 'unknown');
    assert.equal(quotaPillarReading('glm', { ...usage, glm: { ...usage.glm, error: { status: 403 } } }, now).state, 'unknown');
    assert.equal(quotaPillarReading('antigravity', { ...usage, antigravity: { ...usage.antigravity, error: { status: 401 } } }, now).state, 'unknown');

    // Limit seals for Codex/GLM/Antigravity; Claude reports no enforcement (l0, never limit).
    assert.equal(quotaPillarKey(quotaPillarReading('claude', { quota: { sevenDay: 1 } }, now)), 'l0');
    assert.equal(quotaPillarKey(quotaPillarReading('codex', { codex: { usedPercent: 80, limitReached: true } }, now)), 'limit');
    assert.equal(quotaPillarKey(quotaPillarReading('glm', { glm: { weekly: { usedPercent: 100 } } }, now)), 'limit');
    assert.equal(quotaPillarKey(quotaPillarReading('antigravity', { antigravity: { geminiWeekly: { usedPercent: 100 } } }, now)), 'limit');
});

test('v0.69 E2: every pillar tooltip stays strictly <= 2 lines with zero hoverPlateLines folding overflow', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0);
    const cases = [
        sampleUsage(now),
        null,
        {
            quotaError: { status: 401, at: now },
            codex: { usedPercent: 100, limitReached: true, resetsAt: now + 3 * HOUR },
            glm: { weekly: { usedPercent: 100, resetsAt: now + 5 * HOUR }, error: { status: 429 } },
            antigravity: { geminiWeekly: { usedPercent: 100, resetsAt: now + 12 * HOUR }, sharedWeekly: { usedPercent: 80 } },
        },
    ];
    for (const payload of cases) {
        for (const provider of QUOTA_TERRACE_PROVIDERS) {
            const raw = quotaPillarTooltip(provider, payload, now);
            const rawLines = raw.split('\n');
            assert.equal(rawLines.length, 2, `${provider} tooltip must be exactly 2 lines: ${JSON.stringify(raw)}`);
            assert.deepEqual(hoverPlateLines(raw), rawLines, `${provider} tooltip must pass hoverPlateLines untouched`);
        }
    }
});

// ─── 2. Per-Pillar Pixel-Alpha Hit Testing ───────────────────────────────────

test('v0.69 E2: per-pillar pixel-alpha hit testing ignores transparent pixels and isolates each pillar', (t) => {
    const pillarPng = PNG.sync.read(readFileSync(join(PROPS_DIR, 'prop.quotaPillar.png')));
    const prevDoc = globalThis.document;
    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                drawImage() {},
                getImageData: () => ({ data: pillarPng.data }),
            }),
        }),
    };
    t.after(() => { globalThis.document = prevDoc; });

    const host = {
        motionScale: 1,
        motionTimeMs: 0,
        assets: {
            getDims: () => ({ w: pillarPng.width, h: pillarPng.height }),
            getAnchor: () => [16, 60],
            get: (id) => (id === QUOTA_PILLAR_ID ? pillarPng : null),
        },
    };
    const landmarks = new IsleLandmarks(host);
    landmarks.buildSprites();
    landmarks.setUsage(sampleUsage());

    for (const provider of QUOTA_TERRACE_PROVIDERS) {
        const sprite = landmarks.getQuotaPillar(provider);
        const bounds = landmarks.quotaPillarWorldBounds(sprite);
        // Center shaft pixel (local 16, 34) is opaque -> hits this exact pillar.
        const hit = landmarks.hitTestQuotaPillar(bounds.left + 16, bounds.top + 34);
        assert.equal(hit, sprite, `opaque shaft hits ${provider}`);
        // Top-left transparent corner pixel (local 0, 0) -> misses!
        const corner = landmarks.hitTestQuotaPillar(bounds.left, bounds.top);
        assert.equal(corner, null, `transparent corner misses ${provider}`);
    }
});

// ─── 3. QuotaLedgerCard Pure Model + DOM Lifecycle + Renderer Integration ────

function makeFakeDom() {
    class FakeEl {
        constructor(tag) {
            this.tagName = tag.toUpperCase();
            this.className = '';
            this.textContent = '';
            this.children = [];
            this.parentElement = null;
            this.dataset = {};
            this.attrs = {};
            this.style = {
                setProperty(k, v) { this[k] = v; },
            };
            this.listeners = new Map();
            this.tabIndex = 0;
            this.focused = false;
            this.isConnected = false;
            this.offsetWidth = 344;
            this.offsetHeight = 320;
        }
        setAttribute(k, v) { this.attrs[k] = String(v); }
        getAttribute(k) { return this.attrs[k] ?? null; }
        addEventListener(type, fn) {
            const list = this.listeners.get(type) || [];
            list.push(fn);
            this.listeners.set(type, list);
        }
        removeEventListener(type, fn) {
            const list = this.listeners.get(type) || [];
            this.listeners.set(type, list.filter((f) => f !== fn));
        }
        dispatch(type, event = {}) {
            const ev = { target: this, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...event };
            for (const fn of [...(this.listeners.get(type) || [])]) fn(ev);
            return ev;
        }
        append(...nodes) {
            for (const n of nodes) {
                n.parentElement = this;
                this._setConnected(n, this.isConnected);
                this.children.push(n);
            }
        }
        replaceChildren(...nodes) {
            for (const c of this.children) this._setConnected(c, false);
            this.children = [];
            this.append(...nodes);
        }
        _setConnected(node, flag) {
            node.isConnected = flag;
            for (const c of node.children || []) this._setConnected(c, flag);
        }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
                this.parentElement = null;
            }
            this._setConnected(this, false);
        }
        contains(el) {
            if (!el) return false;
            let cur = el;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentElement;
            }
            return false;
        }
        closest(selector) {
            const cls = selector.startsWith('.') ? selector.slice(1) : '';
            let cur = this;
            while (cur) {
                if (cls && cur.className.split(/\s+/).includes(cls)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        focus() {
            this.focused = true;
            doc.activeElement = this;
        }
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 1280, height: 800 };
        }
        findAll(predicate, out = []) {
            if (predicate(this)) out.push(this);
            for (const c of this.children) c.findAll(predicate, out);
            return out;
        }
    }

    const host = new FakeEl('div');
    host.isConnected = true;
    const doc = {
        documentElement: { dataset: {} },
        activeElement: null,
        createElement: (tag) => new FakeEl(tag),
    };
    return { doc, host, FakeEl };
}

test('v0.69 E2: QuotaLedgerCard builds 4-provider model, opens/refreshes/closes on Esc, handles mobile profile, and leaks zero listeners', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const prevDoc = globalThis.document;
    const prevHtmlEl = globalThis.HTMLElement;
    const { doc, host, FakeEl } = makeFakeDom();
    globalThis.document = doc;
    globalThis.HTMLElement = FakeEl;
    t.after(() => {
        globalThis.document = prevDoc;
        globalThis.HTMLElement = prevHtmlEl;
    });

    const now = Date.now();
    const usage = sampleUsage(now);
    const model = buildQuotaLedgerModel(usage, { now, activeProvider: 'glm' });
    assert.equal(model.rows.length, 4);
    assert.equal(model.rows.find((r) => r.provider === 'glm').selected, true);
    assert.equal(model.rows.find((r) => r.provider === 'claude').segments, QUOTA_LEDGER_SEGMENTS);
    assert.equal(model.rows.find((r) => r.provider === 'claude').accent, '#977bb5', 'Claude uses unified lavender-plum accent');
    assert.equal(model.rows.find((r) => r.provider === 'antigravity').weeklyTitle, 'Antigravity Weekly');
    assert.equal(model.rows.find((r) => r.provider === 'antigravity').subRows.some((s) => s.label === '3P shared'), true);

    // Non-zero segment floor: 3% left still lights 1 of 12 segments.
    const sliverModel = buildQuotaLedgerModel({ ...usage, glm: { weekly: { usedPercent: 97 } } }, { now });
    assert.equal(sliverModel.rows.find((r) => r.provider === 'glm').lit, 1);

    const trigger = new FakeEl('button');
    trigger.isConnected = true;
    doc.activeElement = trigger;

    let closedCount = 0;
    const card = new QuotaLedgerCard({ host, onClose: () => { closedCount++; } });
    card.open(model, { activeProvider: 'glm', focus: true });
    assert.equal(card.isOpen, true);
    assert.equal(isInQuotaLedgerCard(card.el), true);
    assert.equal(card.el.focused, true);

    // 4 provider rows rendered with 12-segment gauges each.
    const rows = card.el.findAll((n) => n.className.includes('quota-ledger-card__row '));
    assert.equal(rows.length, 4);
    const gauges = card.el.findAll((n) => n.className === 'quota-ledger-card__gauge');
    assert.equal(gauges.length, 4);
    for (const g of gauges) assert.equal(g.children.length, 12);

    // Desktop positioning sets inline left/top and respects full-terrace avoidBounds;
    // mobile profile clears them for CSS bottom sheet.
    card.setAvoidBounds({ left: 100, top: 120, right: 360, bottom: 280 });
    card.position({ x: 360, y: 200 }, []);
    assert.ok(Number.parseInt(card.el.style.left, 10) >= 360, 'card sits clear to the right of the full 4-pillar terrace');
    assert.ok(card.el.style.top.endsWith('px'));
    // When near the right viewport edge, flips cleanly to the left of the entire terrace.
    card.setAvoidBounds({ left: 900, top: 120, right: 1160, bottom: 280 });
    card.position({ x: 1160, y: 200 }, []);
    assert.ok(Number.parseInt(card.el.style.left, 10) + card.el.offsetWidth <= 900, 'card flips left of full terrace when right edge is tight');
    doc.documentElement.dataset.cvProfile = 'mobile';
    card.position({ x: 200, y: 240 }, []);
    assert.equal(card.el.style.left, '');
    assert.equal(card.el.style.top, '');
    doc.documentElement.dataset.cvProfile = '';

    // Live 1 Hz subscriptions registered while open, refreshed cleanly without leak.
    assert.ok(card._elapsedUnsubs.length > 0, 'live 1 Hz countdown subscriptions active');
    const updated = buildQuotaLedgerModel({ ...usage, glm: { ...usage.glm, weekly: { usedPercent: 50, resetsAt: usage.glm.weekly.resetsAt } } }, { now, activeProvider: 'glm' });
    card.refresh(updated);
    const glmPct = card.el.findAll((n) => n.className === 'quota-ledger-card__pct')[2];
    assert.equal(glmPct.textContent, '50% left');

    // Escape closes card, clears all 1 Hz subscriptions, and restores focus.
    const esc = card.el.dispatch('keydown', { key: 'Escape' });
    assert.equal(esc.stopped, true);
    assert.equal(card.isOpen, false);
    assert.equal(card._elapsedUnsubs.length, 0);
    assert.equal(closedCount, 1);
    assert.equal(doc.activeElement, trigger);
});

test('v0.69 E2: clicking a pillar opens QuotaLedgerCard; outside click, Escape, and mode switch close it cleanly', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const prevDoc = globalThis.document;
    const prevHtmlEl = globalThis.HTMLElement;
    const { doc, host, FakeEl } = makeFakeDom();
    globalThis.document = doc;
    globalThis.HTMLElement = FakeEl;
    t.after(() => {
        globalThis.document = prevDoc;
        globalThis.HTMLElement = prevHtmlEl;
    });

    const codexPillar = { id: QUOTA_PILLAR_ID, provider: 'codex', x: -304, y: 164 };
    const usage = sampleUsage();
    let usageVer = 1;
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        _worldModeActive: true,
        canvas: { parentElement: host },
        camera: { worldToScreen: (x, y) => ({ x: x + 500, y: y + 100 }), stopFollow() {} },
        agentSprites: new Map(),
        buildingRenderer: { hitTest: () => null },
        harborTraffic: { hitTestShip: () => null },
        isleLandmarks: {
            hitTestQuotaPillar: (x, y) => (Math.abs(x - codexPillar.x) < 16 && Math.abs(y - codexPillar.y) < 40 ? codexPillar : null),
            quotaTerraceAnchor: () => ({ x: codexPillar.x, y: codexPillar.y - 34 }),
            usageSnapshot: () => ({ usage, version: usageVer }),
            setUsage() { usageVer++; },
        },
        _invalidateIdleFrame() {},
        setTheatreMode() {},
        setReadLock() {},
        _clearCouncilFocus() {},
        _stopLoop() {},
        _suspendWorldModeResources() {},
    });

    // Click Codex pillar -> opens QuotaLedgerCard focused on codex.
    renderer._handleClick(codexPillar.x, codexPillar.y);
    assert.equal(renderer._quotaLedgerCard?.isOpen, true);
    assert.equal(renderer._quotaLedgerProvider, 'codex');

    // Clicking empty ground closes the card.
    renderer._handleClick(500, 500);
    assert.equal(renderer._quotaLedgerCard?.isOpen, false);

    // Re-open, then switch to Dashboard (setWorldModeActive(false)) -> tears down cleanly.
    renderer._handleClick(codexPillar.x, codexPillar.y);
    assert.equal(renderer._quotaLedgerCard?.isOpen, true);
    renderer.setWorldModeActive(false);
    assert.equal(renderer._quotaLedgerCard?.isOpen, false);
});

// ─── 4. Baker Determinism & Sidecar Hygiene ──────────────────────────────────

test('v0.69 E2: bake-quota-terrace.mjs --check passes, zero semi-alpha, emissive strictly on crown off strip', () => {
    execFileSync(process.execPath, ['scripts/sprites/bake-quota-terrace.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });

    const outputs = buildAllQuotaTerracePngs();
    for (const { name, png } of outputs) {
        if (name.endsWith('.emissive.png')) continue;
        let semi = 0;
        for (let i = 3; i < png.data.length; i += 4) {
            if (png.data[i] !== 0 && png.data[i] !== 255) semi++;
        }
        assert.equal(semi, 0, `${name} must have zero semi-alpha pixels`);
    }

    // Pillar emissive sidecar stays strictly inside the crown lantern (y < stripOriginY)
    // and never touches the recessed quota gauge channel.
    const pillar = PNG.sync.read(readFileSync(join(PROPS_DIR, 'prop.quotaPillar.png')));
    const emissive = PNG.sync.read(readFileSync(join(PROPS_DIR, 'prop.quotaPillar.emissive.png')));
    let lit = 0;
    for (let y = 0; y < emissive.height; y++) {
        for (let x = 0; x < emissive.width; x++) {
            const i = (y * emissive.width + x) * 4;
            if (emissive.data[i + 3] === 0) continue;
            lit++;
            assert.ok(y < QUOTA_PILLAR_STRIP_ORIGIN[1], `emissive pixel (${x},${y}) must stay above gauge strip (y < ${QUOTA_PILLAR_STRIP_ORIGIN[1]})`);
            assert.equal(pillar.data[i + 3], 255, `emissive pixel (${x},${y}) must sit inside opaque pillar art`);
        }
    }
    assert.ok(lit >= 12 && lit <= 32, `crown lantern emissive pocket has ${lit} lit texels`);

    // Strip emissive sidecar lights lit crystal courses, peak, and LIMIT seal,
    // while keeping l0 and unknown completely dark (0 lit texels).
    const strip = PNG.sync.read(readFileSync(join(PROPS_DIR, 'prop.quotaPillarStrip.png')));
    const stripEm = PNG.sync.read(readFileSync(join(PROPS_DIR, 'prop.quotaPillarStrip.emissive.png')));
    assert.deepEqual([stripEm.width, stripEm.height], [strip.width, strip.height]);
    const cellEmissiveCount = (cell) => {
        let count = 0;
        for (let ly = 0; ly < 48; ly++) {
            for (let lx = 0; lx < 16; lx++) {
                const i = (ly * stripEm.width + cell * 16 + lx) * 4;
                if (stripEm.data[i + 3] > 0) count++;
            }
        }
        return count;
    };
    const cellMeanLuma = (cell, y0 = 7, y1 = 36) => {
        let sum = 0;
        let n = 0;
        for (let ly = y0; ly <= y1; ly++) {
            for (let lx = 4; lx <= 11; lx++) {
                const i = (ly * strip.width + cell * 16 + lx) * 4;
                if (strip.data[i + 3] === 0) continue;
                sum += luminance(strip.data[i], strip.data[i + 1], strip.data[i + 2]);
                n++;
            }
        }
        return n ? sum / n : 0;
    };
    for (const provider of QUOTA_TERRACE_PROVIDERS) {
        assert.equal(cellEmissiveCount(quotaPillarStateCell(provider, 'l0')), 0, `${provider} l0 stays dark at night`);
        assert.equal(cellEmissiveCount(quotaPillarStateCell(provider, 'unknown')), 0, `${provider} unknown stays dark at night`);
        assert.ok(cellEmissiveCount(quotaPillarStateCell(provider, 'l3')) > 60, `${provider} l3 crystals glow at night`);
        assert.ok(cellEmissiveCount(quotaPillarStateCell(provider, 'limit')) > 20, `${provider} limit seal glows softly at night`);
        // Unknown shroud must stay strictly inset inside recess (lx=3..12, ly=7..36) and darker than l1 lit course.
        const unkCell = quotaPillarStateCell(provider, 'unknown');
        for (let ly = 6; ly < 48; ly++) {
            for (let lx = 0; lx < 16; lx++) {
                if (lx >= 3 && lx <= 12 && ly >= 7 && ly <= 36) continue;
                const i = (ly * strip.width + unkCell * 16 + lx) * 4;
                assert.equal(strip.data[i + 3], 0, `${provider} unknown shroud must not overflow recess at (${lx},${ly})`);
            }
        }
        const unkLuma = cellMeanLuma(unkCell, 8, 35);
        const l1Luma = cellMeanLuma(quotaPillarStateCell(provider, 'l1'), 31, 35);
        assert.ok(unkLuma < l1Luma * 0.65, `${provider} unknown shroud (${unkLuma.toFixed(3)}) must be clearly darker than l1 (${l1Luma.toFixed(3)})`);
    }

    // OKLab Tier-B contract: every stop of every provider palette has chroma <= 0.105
    // and distance >= 0.07 from every Tier-A STATUS_VISUALS hue.
    const statusLabs = ['working', 'waiting', 'waiting_on_user', 'errored', 'rate_limited', 'idle'].map((k) => {
        const h = STATUS_VISUALS[k].color;
        return [k, oklab(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16))];
    });
    for (const [provider, pal] of Object.entries(PROVIDER_PALETTES)) {
        for (const [stop, rgb] of Object.entries(pal)) {
            const lab = oklab(rgb[0], rgb[1], rgb[2]);
            const chroma = Math.hypot(lab[1], lab[2]);
            assert.ok(chroma <= 0.105, `${provider}.${stop} OKLab chroma ${chroma.toFixed(4)} must be <= 0.105`);
            for (const [statusName, slab] of statusLabs) {
                const dist = Math.hypot(lab[0] - slab[0], lab[1] - slab[1], lab[2] - slab[2]);
                assert.ok(dist >= 0.07, `${provider}.${stop} OKLab dE ${dist.toFixed(4)} from ${statusName} must be >= 0.07`);
            }
        }
    }
    assert.equal(QUOTA_PROVIDER_META.claude.accent, '#977bb5');
    assert.equal(QUOTA_PROVIDER_META.antigravity.weeklyTitle, 'Antigravity Weekly');
});

// ─── 5. N-Provider Extensibility ─────────────────────────────────────────────

test('v0.69 E2: adding a 5th provider works end-to-end across readings, drain, strip cells, baker, and ledger', () => {
    const five = [...QUOTA_TERRACE_PROVIDERS, 'deepseek'];
    const now = Date.UTC(2026, 10, 26, 12, 0);
    const usage = {
        ...sampleUsage(now),
        deepseek: { weekly: { usedPercent: 30, resetsAt: new Date(now + 4 * 24 * HOUR).toISOString() } },
    };

    const readings = quotaPillarReadings(usage, now, five);
    assert.equal(readings.deepseek.state, 'level');
    assert.equal(readings.deepseek.level, 4); // 70% left -> l4

    let drain = quotaDrainStep(null, readings, now, five);
    drain = quotaDrainStep(drain, quotaPillarReadings({ ...usage, deepseek: { weekly: { usedPercent: 35 } } }, now + 5000, five), now + 5000, five);
    assert.equal(quotaDraining(drain, 'deepseek', now + 5000), true);

    assert.equal(quotaPillarStripCellCount(five), 5 * (QUOTA_PILLAR_STATES.length + QUOTA_PILLAR_LEVELS * QUOTA_PILLAR_STREAM_PHASES));
    assert.equal(quotaPillarStateCell('deepseek', 'l4', five), 4 * QUOTA_PILLAR_STATES.length + QUOTA_PILLAR_STATES.indexOf('l4'));
    assert.equal(
        quotaPillarStreamCell('deepseek', 4, 2, five),
        5 * QUOTA_PILLAR_STATES.length + (4 * QUOTA_PILLAR_LEVELS + 3) * QUOTA_PILLAR_STREAM_PHASES + 2,
    );

    const fiveStrip = bakeStrip(five);
    assert.equal(fiveStrip.width, 16 * quotaPillarStripCellCount(five));
    assert.equal(fiveStrip.height, 48);

    const ledger = buildQuotaLedgerModel(usage, { now, activeProvider: 'deepseek', providers: five });
    assert.equal(ledger.rows.length, 5);
    assert.equal(ledger.rows[4].provider, 'deepseek');
    assert.equal(ledger.rows[4].leftPercent, 70);
    assert.equal(ledger.rows[4].selected, true);

    // Center & slot sanity check.
    assert.deepEqual(QUOTA_TERRACE_CENTER, { tileX: 1.0, tileY: 10.0 });
    assert.equal(QUOTA_TERRACE_SLOTS.length, 4);
});
