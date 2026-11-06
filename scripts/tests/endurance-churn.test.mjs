// EN-4 regression guards for the endurance churn smoke (scripts/smoke/
// endurance-churn.mjs), browser-free: the shipped main() runs in a vm with a
// fake clock over the real AgentManager and World, so warm-up (agent band
// plus the cache-counter plateau), the steady-state sample minimum and the
// slope verdicts are exercised end to end; the in-page census INIT runs
// against a fake WebGL2 context to check upload byte accounting per
// format/type.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';

const SOURCE = fs.readFileSync(new URL('../smoke/endurance-churn.mjs', import.meta.url), 'utf8');
const argsAndRng = SOURCE.slice(SOURCE.indexOf('function parseArgs('), SOURCE.indexOf('// ── in-page census init'));
const factory = SOURCE.slice(SOURCE.indexOf('let serial = 0;'), SOURCE.indexOf('function requestJson('));
const mainBody = SOURCE.slice(SOURCE.indexOf('async function main()'), SOURCE.indexOf('\nawait main();'));

// The reviewer's probe harness: fake page/CDP over the real AgentManager;
// `leak` grows heap/RSS/timer timeouts per round (never the cache counters,
// whose plateau warm-up now waits for), `pool.{canvases,tex}` add a growing
// cache counter per round to drive the plateau rule, and `clockSkewMs`
// inflates every sleep so the measurement reserve can be starved
// deterministically.
async function runChurn({ seed = 7, minutes = 3, leak = false, pool = null, clockSkewMs = 0 } = {}) {
    let now = 1800000000000;
    let round = 0;
    let report;
    let failure;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const state = () => ({
        boot: 'ready', mode: 'webgl', agents: world.agents.size,
        departed: [...world.agents.values()].filter(a => a.isDeparted).length,
        sprites: world.agents.size, errors: [],
        domNodes: 100, canvases: 2 + (pool?.canvases?.(round) ?? 0),
        timers: { intervals: 5, timeouts: leak ? round * 20 : 0 }, busListeners: 5,
        gl: { texLive: 10 + (pool?.tex?.(round) ?? 0), bufLive: 2, fboLive: 2, progLive: 2 },
    });
    const window = {
        __enState: state,
        __enBus: { emit(type, message) {
            if (message.sessions.length) round++;
            manager.handleWebSocketMessage(message);
            // Complete-roster snapshots must never strand or drop a villager.
            const expected = new Set(message.sessions.filter(s => !s.sessionEndedAt).map(s => s.sessionId));
            for (const id of expected) assert.equal(world.agents.get(id)?.isDeparted, false, `${id} accidentally departed`);
            for (const agent of world.agents.values()) if (!expected.has(agent.id)) assert.ok(agent.isDeparted);
        } },
    };
    const cdp = { async send(cmd) { return cmd === 'Runtime.getHeapUsage' ? { usedSize: (20 + (leak ? round * 20 : 0)) * 1048576 } : {}; } };
    const page = {
        async evaluate(fn, arg) { return vm.runInNewContext(`(${fn})`, { window, Date: { now: () => now } })(arg); },
        async goto() {}, async waitForFunction() {}, on() {},
    };
    const context = { async addInitScript() {}, async newPage() { return page; }, async newCDPSession() { return cdp; } };
    class FakeDate extends Date { static now() { return now; } }
    const sandbox = {
        assert, path, URL, structuredClone, Date: FakeDate, console: { log() {} }, USAGE: '', INIT() {},
        process: { argv: ['node', 'endurance', `--seed=${seed}`, `--minutes=${minutes}`, '--url=http://127.0.0.1:1234', '--out=/scratch'] },
        fs: { mkdirSync() {}, writeFileSync(_p, body) { report = JSON.parse(body); } },
        requestJson: async () => ({ sessions: [{ sessionId: 'endurance-template', provider: 'claude', status: 'active', turnState: 'active', lastActivity: now }] }),
        launchChromium: async () => ({ async newContext() { return context; }, async close() {} }),
        installHelpers: async () => {}, gpuLaunchArgs: () => [], findBrowserPid: () => 123,
        rendererRssKb: () => ({ rendererKb: (500 + (leak ? round * 200 : 0)) * 1024, gpuKb: 0 }),
        sleep: async ms => { now += ms + clockSkewMs; }, mb: kb => kb / 1024,
    };
    try {
        await vm.runInNewContext(`${argsAndRng}\n${factory}\n${mainBody}\nmain()`, sandbox);
    } catch (error) {
        failure = error.message;
    } finally {
        manager.destroy?.();
    }
    return { failure, report };
}

test('late warm-up no longer passes vacuously: the reserve buys a third sample and growth is rejected', async () => {
    // Both documented false passes — warm-up ending on the final round. The
    // cache counters plateau at once (leak grows only heap/RSS/timeouts), so
    // the run reaches the slope window and the heap climb is rejected there.
    for (const { seed, minutes } of [{ seed: 1, minutes: 3 }, { seed: 66690, minutes: 8 }]) {
        const leak = await runChurn({ seed, minutes, leak: true });
        assert.match(leak.failure, /climbed/, `seed ${seed} passed with synthetic growth`);
        assert.match(leak.failure, /forced-GC JS heap/);
    }
});

test('a flat late-warm-up run still passes; the slope window opens at the cache plateau', async () => {
    // Seed 7 holds the agent band at round 7 of 9: the plateau rule extends
    // warm-up two flat rounds (8, 9) and the reserve buys the two further
    // samples the steady window needs; every verdict stays flat.
    const flat = await runChurn({ seed: 7, minutes: 3 });
    assert.equal(flat.failure, undefined);
    assert.equal(flat.report.churn.bandAtRound, 7);
    assert.equal(flat.report.churn.steadyAtRound, 9);
    assert.equal(flat.report.churn.cacheWaitRounds, 2);
    assert.equal(flat.report.churn.rounds, 11);
    assert.equal(flat.report.churn.reservedRounds, 2);
    assert.ok(flat.report.slopes.every(s => s.delta === 0));
});

test('a pool that grows past the band and then plateaus passes', async () => {
    // Live GL textures fill +4 a round (above the 3 allowance) through
    // round 10, then the bounded pool is full: warm-up extends past the band
    // (and past --minutes) to the plateau at round 12, and the slope window
    // that opens there is flat.
    const pool = await runChurn({ seed: 7, minutes: 3, pool: { tex: r => Math.min(r, 10) * 4 } });
    assert.equal(pool.failure, undefined);
    assert.equal(pool.report.churn.bandAtRound, 7);
    assert.equal(pool.report.churn.steadyAtRound, 12);
    assert.equal(pool.report.churn.cacheWaitRounds, 5);
    const tex = pool.report.slopes.find(s => s.metric === 'live GL textures');
    assert.equal(tex.delta, 0);
});

test('a pool that keeps growing within its per-round allowance still fails the slope', async () => {
    // +3 textures a round is flat within the 3 allowance on every transition,
    // so warm-up ends at the plateau — and the slope check must still reject
    // growth a bounded pool would never show.
    const slow = await runChurn({ seed: 7, minutes: 3, pool: { tex: r => r * 3 } });
    assert.match(slow.failure, /climbed/);
    assert.match(slow.failure, /live GL textures/);
});

test('a pool that never settles within the cap fails as never settled', async () => {
    // +4 textures a round outruns the allowance on every transition: ten
    // extra rounds after the band held, the run fails with the counter
    // evidence instead of measuring a window it knows is growing.
    const never = await runChurn({ seed: 7, minutes: 3, pool: { tex: r => r * 4 } });
    assert.match(never.failure, /never settled/);
    assert.match(never.failure, /live GL textures 38→78/);
});

test('the seed-7 long-run control still rejects growth', async () => {
    const control = await runChurn({ seed: 7, minutes: 8, leak: true });
    assert.match(control.failure, /climbed/);
});

test('a starved measurement reserve fails as an insufficient-samples duration error', async () => {
    // Every sleep eats two extra minutes, so the steady round lands just
    // before --minutes ends and the reserve cap arrives before a third
    // sample: the run must fail as too short, not measure a vacuous window.
    const starved = await runChurn({ seed: 7, minutes: 16.6666667, clockSkewMs: 120000 });
    assert.match(starved.failure, /insufficient steady-state samples/);
    assert.match(starved.failure, /raise --minutes/);
});

// ── in-page census: upload bytes per format/type ──────────────────────────
const GL_ENUMS = {
    RGBA: 0x1908, RED: 0x1903, RG: 0x8227, RED_INTEGER: 0x8D94,
    UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, HALF_FLOAT: 0x140B, FLOAT: 0x1406,
};
test('upload accounting charges bytes per format/type, not a flat 4 per texel', () => {
    class GL {}
    for (const name of ['createTexture', 'texImage2D', 'texSubImage2D']) GL.prototype[name] = function () {};
    Object.assign(GL, GL_ENUMS);
    const window = { setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, addEventListener() {}, WebGL2RenderingContext: GL };
    const init = SOURCE.slice(SOURCE.indexOf('const INIT = () => {'), SOURCE.indexOf('\n};', SOURCE.indexOf('const INIT = () => {')) + 3);
    vm.runInNewContext(`${init}; INIT()`, { window, WebGL2RenderingContext: GL });
    const gl = new GL();
    const checkUpload = (label, name, args, expected) => {
        const before = window.__gl.uploadedBytes;
        gl[name](...args);
        const delta = window.__gl.uploadedBytes - before;
        assert.equal(delta, expected, `${label} counted ${delta}, expected ${expected}`);
    };
    // RGBA8 across all four overloads (canvas sources and sized data).
    checkUpload('RGBA8 texImage2D long', 'texImage2D', [3553, 0, GL.RGBA, 10, 20, 0, GL.RGBA, GL.UNSIGNED_BYTE, null], 800);
    checkUpload('RGBA8 texImage2D short', 'texImage2D', [3553, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, { width: 10, height: 20 }], 800);
    checkUpload('RGBA8 texSubImage2D long', 'texSubImage2D', [3553, 0, 7, 9, 10, 20, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(800)], 800);
    checkUpload('RGBA8 texSubImage2D short', 'texSubImage2D', [3553, 0, 7, 9, GL.RGBA, GL.UNSIGNED_BYTE, { width: 10, height: 20 }], 800);
    // The float radiance path (GroundRadiance.js): 16 B per texel.
    checkUpload('RGBA32F texSubImage2D', 'texSubImage2D', [3553, 0, 0, 0, 10, 20, GL.RGBA, GL.FLOAT, new Float32Array(800)], 3200);
    checkUpload('RGBA32F texImage2D', 'texImage2D', [3553, 0, 0x881F, 10, 20, 0, GL.RGBA, GL.FLOAT, new Float32Array(800)], 3200);
    // RGBA16F (GroundRadiance's offscreen radiance texture): 8 B per texel.
    checkUpload('RGBA16F texImage2D', 'texImage2D', [3553, 0, 0x881A, 10, 20, 0, GL.RGBA, GL.HALF_FLOAT, null], 1600);
    // Single/dual-channel texture pages (GpuWorldRenderer TEXTURE_FORMATS).
    checkUpload('R8 texImage2D', 'texImage2D', [3553, 0, 0x8229, 10, 20, 0, GL.RED, GL.UNSIGNED_BYTE, new Uint8Array(200)], 200);
    checkUpload('R8 texSubImage2D', 'texSubImage2D', [3553, 0, 0, 0, 10, 20, GL.RED, GL.UNSIGNED_BYTE, new Uint8Array(200)], 200);
    checkUpload('R32F texImage2D', 'texImage2D', [3553, 0, 0x822E, 10, 20, 0, GL.RED, GL.FLOAT, new Float32Array(200)], 800);
    checkUpload('RG8 texSubImage2D', 'texSubImage2D', [3553, 0, 0, 0, 10, 20, GL.RG, GL.UNSIGNED_BYTE, new Uint8Array(400)], 400);
    checkUpload('R16UI texSubImage2D', 'texSubImage2D', [3553, 0, 0, 0, 10, 20, GL.RED_INTEGER, GL.UNSIGNED_SHORT, new Uint16Array(200)], 400);
});
