// EN-4: endurance churn — the WebGL2 World under continuous session churn.
// A village that keeps receiving and losing agents for minutes on end must
// keep a flat footprint: forced-GC JS heap, DOM nodes, canvases, live
// timers (intervals and timeouts alike), event-bus listeners and live GL
// objects must not climb, and the renderer's RSS must stay within the
// steady-state floor + 150 MB. Slopes and the RSS floor are measured after
// a warm-up that first holds the village's live-agent band for a round and
// then waits for the cache-like counters (canvases, live GL textures,
// buffers, framebuffers, DOM nodes) to hold flat within their allowances
// for two consecutive rounds — bounded caches keep filling for rounds after
// the band settles as new identities arrive (the 2026-11-05 review's
// 10-minute soak showed them plateau), so ramp-up is growth by definition,
// not a leak. The plateau wait is capped at ten extra rounds past the band:
// counters that never settle within the cap fail as never settled — a real
// finding, never a pass. The steady window must hold at least three
// samples: rounds continue past --minutes (a bounded reserve of three extra
// rounds) until it does, else the run fails as too short. Churn rides
// the real client path (the page's own eventBus receives ws:update batches
// built from a session shape the isolated server itself produced — each
// batch a complete roster, since the update contract is a full snapshot),
// never a synthetic stub. Opt-in by design: minutes of wall clock do not
// belong in CI (see scripts/smoke/README.md); not part of
// validate:quick/validate:full.
//
// Usage:
//   node scripts/smoke/endurance-churn.mjs [--minutes=8] [--round-seconds=20]
//       [--seed=7] [--url=http://…] [--out=<dir>] [--headed] [--help]
//
// Promoted from the 2026-11-05 technical review's endurance prototype
// (07-endurance/soak.mjs): same census, deterministic RNG, and assertions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../tests/support/tmp.mjs';
import { launchChromium, gpuLaunchArgs } from './support/chromium.mjs';
import { startIsolatedServer } from './support/isolated-server.mjs';

const USAGE = `usage: node scripts/smoke/endurance-churn.mjs [options]
  --minutes=<n>        churn duration in minutes (default 8)
  --round-seconds=<n>  seconds per churn round (default 20)
  --seed=<n>           deterministic RNG seed (default 7)
  --url=<url>          ClaudeVille URL (default: an isolated server from this checkout)
  --out=<dir>          report directory (default: output/endurance-churn/<stamp>/)
  --headed             show the browser
  --help               this help
`;

function parseArgs(argv) {
    const options = { minutes: 8, roundSeconds: 20, seed: 7, url: null, out: null, headed: false };
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') { process.stdout.write(USAGE); process.exit(0); }
        const match = arg.match(/^--(minutes|round-seconds|seed|url|out)=(.*)$/);
        if (match) {
            const value = match[2];
            if (match[1] === 'minutes' || match[1] === 'round-seconds' || match[1] === 'seed') {
                const parsed = Number(value);
                assert.ok(Number.isFinite(parsed) && parsed > 0, `${arg} must be a positive number`);
                if (match[1] === 'minutes') options.minutes = parsed;
                if (match[1] === 'round-seconds') options.roundSeconds = parsed;
                if (match[1] === 'seed') options.seed = parsed;
            } else if (match[1] === 'url') options.url = value;
            else options.out = value;
            continue;
        }
        if (arg === '--headed') { options.headed = true; continue; }
        throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
    return options;
}

// Deterministic churn: mulberry32 (the review's benchmark RNG).
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── in-page census init (runs before app scripts) ─────────────────────────
// Live timers (setInterval/setTimeout bookkeeping) and live GL objects
// (wrapped WebGL2 prototype methods), both from the review's prototype.
const INIT = () => {
    const live = new Map();
    const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout;
    window.setInterval = function (fn, ms, ...r) { const id = si.call(window, fn, ms, ...r); live.set(`i${id}`, { k: 'interval', ms }); return id; };
    window.clearInterval = function (id) { live.delete(`i${id}`); return ci.call(window, id); };
    window.setTimeout = function (fn, ms, ...r) { let id = null; const w = typeof fn === 'function' ? function (...a) { live.delete(`t${id}`); return fn.apply(this, a); } : fn; id = st.call(window, w, ms, ...r); live.set(`t${id}`, { k: 'timeout', ms }); return id; };
    window.clearTimeout = function (id) { live.delete(`t${id}`); return ct.call(window, id); };
    window.__enTimers = () => { let iv = 0, to = 0; for (const v of live.values()) { if (v.k === 'interval') iv++; else to++; } return { total: live.size, intervals: iv, timeouts: to }; };
    window.__enErrors = [];
    window.addEventListener('error', e => window.__enErrors.push(String(e.message).slice(0, 200)));
    window.addEventListener('unhandledrejection', e => window.__enErrors.push('rej: ' + String(e.reason?.message || e.reason).slice(0, 200)));
    window.__gl = { texLive: 0, texCreated: 0, texDeleted: 0, bufLive: 0, bufCreated: 0, bufDeleted: 0, fboLive: 0, fboCreated: 0, fboDeleted: 0, uploadedBytes: 0, uploads: 0, progLive: 0, programs: 0, ctxLost: 0 };
    const wrap = (proto, name, after) => { const orig = proto[name]; proto[name] = function (...a) { const r = orig.apply(this, a); try { after(r, a, this); } catch { } return r; }; };
    if (window.WebGL2RenderingContext) {
        const P = WebGL2RenderingContext.prototype;
        wrap(P, 'createTexture', r => { if (r) { window.__gl.texLive++; window.__gl.texCreated++; } });
        wrap(P, 'deleteTexture', (_r, a) => { if (a[0]) { window.__gl.texLive--; window.__gl.texDeleted++; } });
        wrap(P, 'createBuffer', r => { if (r) { window.__gl.bufLive++; window.__gl.bufCreated++; } });
        wrap(P, 'deleteBuffer', (_r, a) => { if (a[0]) { window.__gl.bufLive--; window.__gl.bufDeleted++; } });
        wrap(P, 'createFramebuffer', r => { if (r) { window.__gl.fboLive++; window.__gl.fboCreated++; } });
        wrap(P, 'deleteFramebuffer', (_r, a) => { if (a[0]) { window.__gl.fboLive--; window.__gl.fboDeleted++; } });
        wrap(P, 'createProgram', r => { if (r) { window.__gl.progLive++; window.__gl.programs++; } });
        wrap(P, 'deleteProgram', (_r, a) => { if (a[0]) window.__gl.progLive--; });
        // texImage2D/texSubImage2D each have two overloads; the dimensions and
        // the format/type pair sit in different argument slots, and in the
        // short overloads format/type are GL enums, not sizes — take the dims
        // from the source there. Bytes per texel come from that pair (the GL
        // enum values read off the context interface): the renderer uploads
        // RGBA8 (4 B), float RGBA32F radiance (16 B), RGBA16F (8 B) and the
        // single/dual-channel R8/RG8/R16UI texture pages, so a flat 4 B per
        // texel under-counts the float paths fourfold. Unknown pairs keep
        // the RGBA8 assumption.
        const E = WebGL2RenderingContext;
        const texelBytes = new Map([
            [`${E.RGBA}:${E.UNSIGNED_BYTE}`, 4],
            [`${E.RGBA}:${E.HALF_FLOAT}`, 8],
            [`${E.RGBA}:${E.FLOAT}`, 16],
            [`${E.RED}:${E.UNSIGNED_BYTE}`, 1],
            [`${E.RED}:${E.FLOAT}`, 4],
            [`${E.RG}:${E.UNSIGNED_BYTE}`, 2],
            [`${E.RED_INTEGER}:${E.UNSIGNED_SHORT}`, 2],
        ]);
        const countUpload = (dims, format, type) => {
            if (dims && Number.isFinite(dims.w) && Number.isFinite(dims.h)) {
                window.__gl.uploadedBytes += dims.w * dims.h * (texelBytes.get(`${format}:${type}`) ?? 4);
                window.__gl.uploads++;
            }
        };
        const sourceDims = source => {
            const w = source?.width, h = source?.height;
            return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
        };
        wrap(P, 'texImage2D', (_r, a) => countUpload(
            a.length >= 9 ? { w: a[3], h: a[4] } : sourceDims(a[5]),
            a.length >= 9 ? a[6] : a[3],
            a.length >= 9 ? a[7] : a[4],
        ));
        wrap(P, 'texSubImage2D', (_r, a) => countUpload(
            a.length >= 9 ? { w: a[4], h: a[5] } : sourceDims(a[6]),
            a.length >= 9 ? a[6] : a[4],
            a.length >= 9 ? a[7] : a[5],
        ));
    }
    const ols = window.OffscreenCanvas;
    window.__offscreen = { created: 0 };
    if (ols) { const O = ols; window.OffscreenCanvas = function (w, h, ...r) { window.__offscreen.created++; return new O(w, h, ...r); }; window.OffscreenCanvas.prototype = O.prototype; }
};

// ── in-page state helpers ─────────────────────────────────────────────────
async function installHelpers(page) {
    await page.evaluate(async () => {
        const { eventBus } = await import('/src/domain/events/DomainEvent.js');
        window.__enBus = eventBus;
        window.__enState = () => {
            const app = window.__claudeVilleApp;
            const r = app?.renderer;
            let listeners = 0; try { for (const s of eventBus.listeners.values()) listeners += s.size; } catch { }
            let agents = 0, departed = 0; try { for (const a of (app?.world?.agents?.values() || [])) { agents++; if (a.isDeparted) departed++; } } catch { }
            return {
                boot: app?._bootState, mode: r?.worldRendererMode, backend: r?.worldBackendReason,
                agents, departed, sprites: r?.agentSprites?.size ?? null,
                busListeners: listeners,
                domNodes: document.getElementsByTagName('*').length,
                canvases: document.querySelectorAll('canvas').length,
                timers: window.__enTimers?.(), gl: window.__gl, offscreen: window.__offscreen?.created,
                heap: performance.memory?.usedJSHeapSize ?? null,
                errors: window.__enErrors.slice(-6),
            };
        };
    });
}

function findBrowserPid() {
    const kids = execFileSync('pgrep', ['-P', String(process.pid)]).toString().trim().split('\n').filter(Boolean);
    for (const k of kids) {
        const args = execFileSync('ps', ['-o', 'args=', '-p', k]).toString();
        if (args.includes('chrome') && !args.includes('--type=')) return k;
    }
    throw new Error('browser pid not found');
}

// Renderer + GPU-process RSS (KB) from /proc via ps, walking browser -> zygote.
// pgrep exits 1 when a process has no children (an idle browser with no
// renderers yet) and ps exits 1 when a process vanished between enumeration
// and the query — both are normal during churn, anything else propagates.
function rendererRssKb(browserPid) {
    const childrenOf = pid => {
        try {
            return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean);
        } catch (error) {
            if (error?.status === 1) return [];
            throw error;
        }
    };
    const psField = (pid, field) => {
        try {
            return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)]).toString();
        } catch (error) {
            if (error?.status === 1) return null;
            throw error;
        }
    };
    let ren = 0, gpu = 0;
    const scan = pid => {
        for (const k of childrenOf(pid)) {
            const args = psField(k, 'args');
            if (args === null) continue;
            const rss = psField(k, 'rss');
            if (rss === null) continue;
            const r = Number(rss.trim());
            if (args.includes('--type=renderer')) ren += r;
            else if (args.includes('--type=gpu-process')) gpu += r;
            else if (args.includes('--type=zygote')) scan(k);
        }
    };
    scan(browserPid);
    return { rendererKb: ren, gpuKb: gpu };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mb = kb => kb / 1024;

// ── session factory ───────────────────────────────────────────────────────
// Built from a session the isolated server itself produced (a real fixture
// transcript through the real adapter), then varied like the review's
// prototype: provider/model rotation, 48 projects (per-identity stores),
// statuses, tool noise, subagents of live mains.
let serial = 0;
const MODELS = [['claude', 'claude-opus-4-8'], ['claude', 'claude-sonnet-4-6'], ['codex', 'gpt-6.1-sol']];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Agent', 'exec_command', 'apply_patch'];
const STATUSES = ['active', 'active', 'active', 'idle', 'completed', 'waiting'];
function makeSession(template, id, nowMs, parent = null) {
    const session = structuredClone(template);
    const [provider, model] = MODELS[serial % MODELS.length];
    const project = `/home/en/p${String(serial % 48).padStart(2, '0')}/repo`;
    serial++;
    Object.assign(session, {
        sessionId: id, provider, model, displayModel: model,
        status: STATUSES[serial % STATUSES.length], lastActivity: nowMs,
        project, repoRoot: project, signalObservedAt: nowMs, pendingSince: null, pendingTool: null,
        lastTool: TOOLS[serial % TOOLS.length], lastToolInput: `${project}/src/file-${serial}.js`,
        lastMessage: `step ${serial}`, name: null, agentName: null, spriteId: undefined,
        parentSessionId: parent, agentType: parent ? 'subagent' : 'main',
        agentId: parent ? `sub-${serial}` : null,
        resident: false, sessionEndedAt: null, turnStartedAt: nowMs - 5000,
    });
    if (session.tokenUsage && typeof session.tokenUsage === 'object') {
        for (const key of Object.keys(session.tokenUsage)) {
            if (typeof session.tokenUsage[key] === 'number') session.tokenUsage[key] = 1000 + serial * 37;
        }
    }
    return session;
}

function requestJson(port, pathname) {
    return new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(5000, () => request.destroy(new Error('request timeout')));
        request.on('error', reject);
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = options.out || path.join('output', 'endurance-churn', stamp);
    const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
    const random = mulberry32(options.seed);

    let home = null;
    let server = null;
    let browser = null;
    const samples = [];
    const churn = { rounds: 0, arrived: 0, departed: 0, uniqueIds: 0, maxLiveAgents: 0, bandAtRound: null, steadyAtRound: null, cacheWaitRounds: 0, reservedRounds: 0 };

    async function sample(page, cdp, browserPid, tSeconds) {
        await cdp.send('HeapProfiler.collectGarbage').catch(() => { });
        const heapForced = await cdp.send('Runtime.getHeapUsage').catch(() => null);
        const state = await page.evaluate(() => window.__enState());
        const rss = rendererRssKb(browserPid);
        const sampleRow = {
            t: tSeconds, round: churn.rounds, ...state,
            heapForced: heapForced?.usedSize ?? null,
            rssRendererKb: rss.rendererKb, rssGpuKb: rss.gpuKb,
        };
        samples.push(sampleRow);
        log(`t=${tSeconds}s round=${churn.rounds} agents=${state.agents} sprites=${state.sprites} `
            + `heap=${(sampleRow.heapForced / 1048576).toFixed(1)}MB rss=${mb(rss.rendererKb).toFixed(0)}MB `
            + `gpu=${mb(rss.gpuKb).toFixed(0)}MB tex=${state.gl?.texLive} buf=${state.gl?.bufLive} `
            + `uploaded=${((state.gl?.uploadedBytes || 0) / 1048576).toFixed(0)}MB dom=${state.domNodes} `
            + `timers=${state.timers?.total}(${state.timers?.intervals}iv) listeners=${state.busListeners}`);
        return sampleRow;
    }

    try {
        // Isolated server (or a given URL) plus one real fixture session the
        // adapters produce, fetched over the real API as the churn template.
        let baseUrl = options.url;
        let port = null;
        if (!baseUrl) {
            home = makeTempDir('claudeville-endurance-');
            const project = path.join(home, 'work', 'demo');
            const projectDir = path.join(home, '.claude', 'projects', project.replace(/\//g, '-'));
            fs.mkdirSync(project, { recursive: true });
            fs.mkdirSync(projectDir, { recursive: true });
            fs.appendFileSync(path.join(home, '.claude', 'history.jsonl'), `${JSON.stringify({
                sessionId: 'endurance-template', project, timestamp: Date.now(), display: 'endurance template',
            })}\n`);
            fs.appendFileSync(path.join(projectDir, 'endurance-template.jsonl'), `${JSON.stringify({
                type: 'assistant', timestamp: new Date().toISOString(),
                message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'template' }] },
            })}\n`);
            server = await startIsolatedServer({ home });
            baseUrl = server.baseUrl;
            port = server.port;
        } else {
            port = Number(new URL(baseUrl).port);
        }
        log(`server on ${baseUrl}`);

        let template = null;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const payload = await requestJson(port, '/api/sessions').catch(() => null);
            template = payload?.sessions?.find(s => s.sessionId === 'endurance-template')
                || payload?.sessions?.[0] || null;
            if (template) break;
            await sleep(500);
        }
        assert.ok(template, 'the fixture session never appeared on /api/sessions; churn needs a real session shape to vary');
        log(`churn template: provider=${template.provider} status=${template.status}`);

        browser = await launchChromium({
            headless: !options.headed,
            args: ['--no-sandbox', '--enable-precise-memory-info', ...gpuLaunchArgs()],
        });
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        await context.addInitScript(INIT);
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 200)));
        const cdp = await context.newCDPSession(page);
        await cdp.send('HeapProfiler.enable');
        await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForFunction(
            () => ['ready', 'failed'].includes(window.__claudeVilleApp?._bootState),
            null,
            { timeout: 120_000 },
        );
        await installHelpers(page);
        const boot = await page.evaluate(() => window.__enState());
        assert.equal(boot.boot, 'ready', `the World failed to boot (${boot.backend || 'no reason recorded'})`);
        assert.equal(boot.mode, 'webgl', `the World came up as ${boot.mode || 'unknown'} (${boot.backend || 'no reason'}); this smoke needs the WebGL2 backend`);

        const browserPid = findBrowserPid();
        const startedAt = Date.now();
        await sleep(5000);
        await sample(page, cdp, browserPid, 0); // boot baseline, evidence only

        // Churn loop: arrivals, subagents of live mains, departures, refreshes.
        // Each round emits the complete surviving roster — `ws:update` carries a
        // full snapshot, so an incomplete batch would mark the omitted survivors
        // departed and revive them a round later (only the chosen entries are
        // refreshed; the rest keep their current payload).
        let liveIds = [];
        const roster = new Map();
        let nextId = 1;
        const seen = new Set();
        const endAt = Date.now() + options.minutes * 60_000;
        const roundMs = options.roundSeconds * 1000;
        // Slope metrics and their allowances (single source for both the
        // plateau rule and the slope verdicts); the flagged entries are the
        // cache-like counters whose pools keep filling for rounds after the
        // agent band settles, so warm-up also waits for them (below).
        const flatMetrics = [
            ['forced-GC JS heap (MB)', s => s.heapForced / 1048576, 10, false],
            ['DOM nodes', s => s.domNodes, 200, true],
            ['canvases', s => s.canvases, 1, true],
            ['live timers (intervals)', s => s.timers?.intervals ?? 0, 3, false],
            ['live timers (timeouts)', s => s.timers?.timeouts ?? 0, 3, false],
            ['event-bus listeners', s => s.busListeners, 3, false],
            ['live GL textures', s => s.gl?.texLive ?? 0, 3, true],
            ['live GL buffers', s => s.gl?.bufLive ?? 0, 3, true],
            ['live GL framebuffers', s => s.gl?.fboLive ?? 0, 3, true],
            ['live GL programs', s => s.gl?.progLive ?? 0, 3, false],
        ];
        const cacheMetrics = flatMetrics
            .filter(([, , , cache]) => cache)
            .map(([label, pick, allowance]) => ({ label, pick, allowance }));
        // Warm-up: a flat-slope check is only meaningful at steady state — the
        // review's 2-minute run went 1 → 9 agents and read the ramp-up as leaks.
        // Arrivals pause at the target band (10 live) so departures keep the
        // village churning around it, and the slope window and RSS floor open
        // only after the band holds (≥ 8 live agents) for a round AND the
        // cache-like counters have been flat within their allowances for two
        // consecutive rounds: steady state means the counters have plateaued,
        // not just the agent band.
        const targetLive = 10;
        const steadyBand = 8;
        const plateauRoundsNeeded = 2;
        const cacheWaitCap = 10; // extra rounds past the band to reach the plateau
        let bandRounds = 0;
        let bandHeld = false;
        let plateauRounds = 0;
        let steady = false;
        let steadyIndex = -1;
        let rssFloorKb = null;
        // Warm-up can finish on the final round, leaving a one-sample slope
        // window: both median thirds then read that same sample and the RSS
        // maximum equals its floor, so every growth check would pass
        // vacuously. Rounds therefore continue past --minutes — first the
        // plateau wait (within its cap), then a reserve for the steady
        // window — until it holds at least three samples, within a hard cap
        // of the cache-wait rounds plus three extra ones; past that the run
        // fails as too short instead of measuring nothing.
        const minSteadySamples = 3;
        const hardEndAt = endAt + (cacheWaitCap + minSteadySamples) * roundMs + 30_000;
        const needsCacheWait = () => bandHeld && !steady && churn.cacheWaitRounds < cacheWaitCap && Date.now() < hardEndAt;
        const needsReserve = () => steady && samples.length - steadyIndex < minSteadySamples && Date.now() < hardEndAt;
        while (Date.now() < endAt || needsCacheWait() || needsReserve()) {
            if (Date.now() >= endAt) churn.reservedRounds++;
            const now = Date.now();
            const arrivals = liveIds.length >= targetLive
                ? 0
                : Math.min(targetLive - liveIds.length, 1 + Math.floor(random() * 3));
            const batch = [];
            for (let i = 0; i < arrivals; i++) {
                const isSub = liveIds.length > 2 && random() < 0.33;
                const parent = isSub ? liveIds[Math.floor(random() * liveIds.length)].id : null;
                const id = `en-${nextId++}`;
                seen.add(id);
                const session = makeSession(template, id, now, parent);
                roster.set(id, session);
                batch.push(session);
                liveIds.push({ id, born: now });
                churn.arrived++;
            }
            if (random() < 0.6) {
                const n = Math.min(liveIds.length - 4, 1 + Math.floor(random() * 2));
                for (const gone of liveIds.splice(0, Math.max(0, n))) {
                    const session = makeSession(template, gone.id, now);
                    session.status = 'ended';
                    session.sessionEndedAt = now - 2000;
                    roster.delete(gone.id);
                    batch.push(session);
                    churn.departed++;
                }
            }
            for (const live of liveIds) {
                if (random() < 0.5) roster.set(live.id, makeSession(template, live.id, now));
            }
            batch.push(...liveIds.map(live => roster.get(live.id)));
            await page.evaluate(
                sessions => window.__enBus.emit('ws:update', { type: 'update', sessions, timestamp: Date.now() }),
                batch,
            );
            churn.rounds++;
            churn.uniqueIds = seen.size;
            await sleep(Math.max(0, roundMs - (Date.now() - now)));
            const state = await page.evaluate(() => window.__enState());
            const liveAgents = state.agents - state.departed;
            churn.maxLiveAgents = Math.max(churn.maxLiveAgents, liveAgents);
            await sample(page, cdp, browserPid, Math.round((Date.now() - startedAt) / 1000));
            if (!steady && !bandHeld) {
                bandRounds = liveAgents >= steadyBand ? bandRounds + 1 : 0;
                if (bandRounds >= 2) {
                    bandHeld = true;
                    churn.bandAtRound = churn.rounds;
                    log(`agent band held (${liveAgents} live) after round ${churn.rounds}; waiting for the cache counters to plateau (≤ ${cacheWaitCap} extra rounds)`);
                }
            } else if (!steady) {
                churn.cacheWaitRounds++;
                const previous = samples[samples.length - 2];
                const current = samples[samples.length - 1];
                const grown = cacheMetrics
                    .filter(({ pick, allowance }) => pick(current) - pick(previous) > allowance)
                    .map(({ label }) => label);
                plateauRounds = grown.length ? 0 : plateauRounds + 1;
                if (plateauRounds >= plateauRoundsNeeded) {
                    steady = true;
                    steadyIndex = samples.length - 1;
                    rssFloorKb = samples[steadyIndex].rssRendererKb;
                    churn.steadyAtRound = churn.rounds;
                    log(`steady state: cache counters flat for ${plateauRoundsNeeded} rounds, ${churn.cacheWaitRounds} rounds after the band held at round ${churn.bandAtRound}; slope window and RSS floor start here`);
                } else if (churn.cacheWaitRounds >= cacheWaitCap) {
                    const bandSample = samples[samples.length - 1 - churn.cacheWaitRounds];
                    const detail = cacheMetrics.map(({ label, pick }) => `${label} ${pick(bandSample)}→${pick(current)}`).join(', ');
                    assert.ok(
                        false,
                        `the cache counters never settled: ${churn.cacheWaitRounds} rounds after the agent band held (round ${churn.bandAtRound}) — ${detail} — never flat within their allowances for ${plateauRoundsNeeded} consecutive rounds; a pool that never stops filling is a real finding, never a pass`,
                    );
                }
            }
        }
        assert.ok(bandHeld, `the village never held ${steadyBand} live agents for a round; raise --minutes or --round-seconds`);
        assert.ok(steady, `warm-up never finished: the cache counters were still unsettled when the measurement clock ran out (band held at round ${churn.bandAtRound}, waited ${churn.cacheWaitRounds} of ${cacheWaitCap} rounds); raise --minutes or --round-seconds`);
        const steadySamples = samples.length - steadyIndex;
        assert.ok(
            steadySamples >= minSteadySamples,
            `insufficient steady-state samples: warm-up ended at round ${churn.steadyAtRound} of ${churn.rounds} with only ${steadySamples} of the ${minSteadySamples} required samples; raise --minutes or --round-seconds`,
        );
        const slopeSamples = samples.slice(steadyIndex);

        // Drain: everyone leaves; then the settled page is re-sampled.
        await page.evaluate(() => window.__enBus.emit('ws:update', { type: 'update', sessions: [], timestamp: Date.now() }));
        await sleep(15_000);
        const drained = await sample(page, cdp, browserPid, Math.round((Date.now() - startedAt) / 1000));

        // ── assertions ──────────────────────────────────────────────────────
        assert.equal(pageErrors.length, 0, `page errors during churn: ${pageErrors.slice(0, 3).join(' | ')}`);
        assert.equal(drained.errors.length, 0, `in-page errors during churn: ${drained.errors.join(' | ')}`);
        assert.ok(churn.rounds >= 5, `only ${churn.rounds} churn rounds ran; raise --minutes`);
        assert.ok(churn.arrived >= 10, `only ${churn.arrived} arrivals; the village never really churned`);
        assert.ok(churn.maxLiveAgents >= 4, `the World held at most ${churn.maxLiveAgents} agents; churn never reached the village`);
        assert.equal(drained.mode, 'webgl', `the World lost its backend mid-run (${drained.mode || 'unknown'})`);

        // Flat slopes at steady state: median of the last third of the slope
        // window may exceed the median of its first third by at most the
        // per-metric allowance. A leak that outruns the allowance fails here
        // however slowly it grows.
        const median = numbers => {
            const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
            return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        };
        const thirds = Math.max(1, Math.floor(slopeSamples.length / 3));
        const first = slopeSamples.slice(0, thirds);
        const last = slopeSamples.slice(-thirds);
        const slopes = [];
        for (const [label, pick, allowance] of flatMetrics) {
            const from = median(first.map(pick));
            const to = median(last.map(pick));
            const delta = Number((to - from).toFixed(2));
            slopes.push({ metric: label, first: from, last: to, delta, allowance });
            assert.ok(
                delta <= allowance,
                `${label} climbed from ${from} to ${to} (Δ ${delta} > allowance ${allowance}): a leak, not flat churn`,
            );
        }

        // Renderer RSS: bounded by the steady-state floor + 150 MB at every
        // sample of the slope window (the floor sits after warm-up, so the
        // one-time cost of populating the village is not read as growth).
        const rssMaxKb = Math.max(...slopeSamples.map(s => s.rssRendererKb));
        assert.ok(
            rssMaxKb <= rssFloorKb + 150 * 1024,
            `renderer RSS peaked at ${mb(rssMaxKb).toFixed(0)} MB, steady floor ${mb(rssFloorKb).toFixed(0)} MB + 150 MB budget exceeded`,
        );

        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
            startedAt: new Date(startedAt).toISOString(),
            minutes: options.minutes, roundSeconds: options.roundSeconds, seed: options.seed,
            url: baseUrl, churn, rssFloorKb, rssMaxKb, slopes, samples,
        }, null, 1));
        log(`endurance churn passed: ${churn.rounds} rounds (band at ${churn.bandAtRound}, cache plateau at ${churn.steadyAtRound} after ${churn.cacheWaitRounds} wait rounds), `
            + `${churn.arrived} arrivals, ${churn.departed} departures, `
            + `${churn.uniqueIds} unique ids, max ${churn.maxLiveAgents} live agents; `
            + `renderer RSS ${mb(rssFloorKb).toFixed(0)}→${mb(rssMaxKb).toFixed(0)} MB (budget steady floor+150 MB); report in ${outDir}`);
    } finally {
        try { await browser?.close(); } catch { /* best effort */ }
        try { await server?.stop(); } catch { /* best effort */ }
        if (home) fs.rmSync(home, { recursive: true, force: true });
    }
}

await main();
