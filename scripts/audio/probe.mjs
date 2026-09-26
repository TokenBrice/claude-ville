#!/usr/bin/env node
// The Wave-0 audio probe: a LOCAL maintainer gate (not part of
// validate:quick or CI). Realtime, headless Chromium; see
// scripts/audio/README.md "The Wave-0 probe".
//
//   npm run audio:probe
//   node scripts/audio/probe.mjs [--jobs N] [--seed N] [--only lint,routing,away,ceremony,report] [--out dir]
//
// Checks (each prints PASS/FAIL with its numbers; any FAIL exits 1):
//   lint      envelope-hazard lint (HAR-4) over every cue kind, the night
//             crickets layer, a BGM night piece and a BGM → ambient switch
//   routing   must-never 2: errored → `distress`, rate limited → `limit`,
//             never `summons`, in both event orders and through the live producers
//   away      must-never 4: after a real TopBar enable, a needs-you while
//             blurred and while hidden sounds (≥ the needs-you lane minimum
//             over the preceding bed window when the bed is closed);
//             must-never 5: blur→focus and hide→show run again within 1 s
//   ceremony  must-never 6: the team-gather fixture yields exactly one council
//   report    (not gated) program LUFS-I / true peak of 30 s of a busy day,
//             and the tap's audio-thread skips
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStaticServer, AUDIO_DIR } from './lib/server.mjs';
import { analyze, loudness, writeWavFloat } from './lib/analyze.mjs';
import { buildTargets } from './lib/targets.mjs';
import {
    BACKGROUND_ARGS, DEFAULT_SEED, HARNESS_CHROME_ARGS,
    newHarnessPage, openHarness, pullPcm, readHazards,
} from './lib/capture.mjs';
import { startIsolatedServer } from '../smoke/support/isolated-server.mjs';
import { marginAt, wallTimeline } from './lib/timeline.mjs';
import { AUDIBILITY_WINDOWS } from '../../claudeville/src/presentation/shared/audio/Loudness.js';

const PROBE_APP_JS = fs.readFileSync(path.join(AUDIO_DIR, 'page/probe-app.js'), 'utf8');
// The app checks enable sound the way a person does: a real click, with
// Chromium's default gesture requirement in force.
const APP_CHROME_ARGS = ['--autoplay-policy=user-gesture-required', ...BACKGROUND_ARGS];

const NEEDS_YOU_MIN_LU = AUDIBILITY_WINDOWS.lanes.needsYou.village.min;
// A bed window that is pure silence (context suspended) is scored at the
// floor, so "+10 LU over silence" means the cue clears BS.1770's -70 LUFS
// absolute gate.
const MARGIN = { bedWindowSec: AUDIBILITY_WINDOWS.bedWindowSec, cueWindowSec: 2.5, silenceFloorLufs: -80 };
// A cue bus that peaks below this carried no audible voice.
const CUE_BUS_AUDIBLE_DBFS = -60;
const RESUME_LIMIT_MS = 1000;
const AWAY_SETTLE_MS = 5000;
const AWAY_LISTEN_MS = 3000;
const BUSY_WARMUP_MS = 8000;
const BUSY_SECONDS = 30;
const CEREMONY_WINDOW_MS = 15000;

// ------------------------------------------------------------------ cli ----
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const JOBS = Math.max(1, Number(args.jobs || 1));
const SEED = args.seed != null ? Number(args.seed) : DEFAULT_SEED;
const ALL_CHECKS = ['lint', 'routing', 'away', 'ceremony', 'report'];
const ONLY = args.only ? String(args.only).split(',').map(s => s.trim()) : ALL_CHECKS;
for (const name of ONLY) if (!ALL_CHECKS.includes(name)) throw new Error(`unknown check "${name}" (known: ${ALL_CHECKS.join(', ')})`);
const OUT = args.out ? path.resolve(String(args.out)) : null;

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
const log = (...a) => console.log(stamp(), ...a);
const results = [];
function verdict(check, pass, detail) {
    results.push({ check, pass, detail });
    console.log(`${stamp()} ${pass ? 'PASS' : 'FAIL'}  ${check}  ${detail}`);
}
function info(check, detail) {
    results.push({ check, pass: null, detail });
    console.log(`${stamp()} INFO  ${check}  ${detail}`);
}
const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const signed = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
const shortSite = site => site.replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/g, '').slice(0, 110);

// ---------------------------------------------------------------- lint ----
// HAR-4's runtime half: a source that starts while the GainNode it feeds
// still sits at its default gain of 1 (init.js). A unit that did not
// exercise its subject proves nothing, so it fails too: no source started,
// an isolated layer below its sounding threshold, or a mode switch that did
// not happen.
async function lintUnits(browser, server) {
    const catalog = buildTargets();
    const byName = name => {
        const t = catalog.find(x => x.name === name);
        if (!t) throw new Error(`catalog target ${name} missing`);
        return t;
    };
    const offline = catalog.filter(t => t.name === 'cue-gallery' || (t.category === 'cues' && t.name.endsWith('-night')));
    const realtime = [
        { ...byName('layer-crickets-night'), warmup: 3, seconds: 12 },
        byName('bgm-night-to-ambient'),
    ];
    const kinds = [...new Set(offline.flatMap(t => t.cues.map(c => c.kind)))];
    const units = [{
        name: `lint offline cues (${kinds.join(', ')})`,
        run: async () => {
            const h = await openHarness(browser, server.baseUrl, SEED);
            try {
                const rows = [];
                for (const t of offline) {
                    await h.page.evaluate(s => window.__har.runOfflineCues(s), t);
                    const voices = await h.page.evaluate(() => window.__harVoiceLog.length);
                    rows.push({ name: t.name, voices, hazards: await readHazards(h.page, { clear: true }) });
                }
                return { rows, errors: h.errors };
            } finally {
                await h.context.close();
            }
        },
    }];
    for (const t of realtime) {
        units.push({
            name: `lint ${t.name}`,
            run: async () => {
                const h = await openHarness(browser, server.baseUrl, SEED);
                try {
                    const res = await h.page.evaluate(s => window.__har.runRealtime(s), t);
                    const voices = await h.page.evaluate(() => window.__harVoiceLog.length);
                    const snap = res.finalSnapshot || {};
                    const covered = [];
                    let exercised = true;
                    if (t.isolate) {
                        const level = snap.levels?.[t.isolate];
                        // The layer's own sounding threshold (CricketsLayer chirrups above 0.03).
                        exercised &&= Number(level) > 0.03;
                        covered.push(`${t.isolate} level ${fmt(Number(level), 2)}`);
                    }
                    const switchTo = (t.actions || []).filter(a => a.mode).at(-1)?.mode;
                    if (switchTo) {
                        exercised &&= snap.mode === switchTo;
                        covered.push(`final mode ${snap.mode ?? '—'} (switched to ${switchTo})`);
                    }
                    return { rows: [{ name: t.name, voices, exercised, covered: covered.join(', '), hazards: await readHazards(h.page) }], errors: h.errors };
                } finally {
                    await h.context.close();
                }
            },
        });
    }
    return units.map(u => ({
        name: u.name,
        async run() {
            const { rows, errors } = await u.run();
            for (const row of rows) {
                const count = row.hazards.reduce((n, hz) => n + hz.count, 0);
                const sites = row.hazards.map(hz => `x${hz.count} ${hz.maxLeadMs} ms ${shortSite(hz.site)}`).join(' | ');
                verdict('lint', count === 0 && row.voices > 0 && row.exercised !== false,
                    `${row.name}: ${count} hazard(s), ${row.voices} sources started${row.covered ? `, ${row.covered}` : ''}${sites ? ` — ${sites}` : ''}`);
            }
            if (errors.length) info('lint', `${u.name}: page errors: ${errors.slice(0, 3).join(' | ')}`);
        },
    }));
}

// ------------------------------------------------------------ app pages ----
async function openApp(browser, server, scenario, hour) {
    const h = await newHarnessPage(browser, SEED, { width: 1440, height: 900 });
    await h.page.addInitScript({ content: PROBE_APP_JS });
    await h.page.goto(`${server.baseUrl}/?sim=1&scenario=${scenario}`, { waitUntil: 'domcontentloaded' });
    await h.page.waitForFunction(() => Boolean(window.__claudeVilleApp?.agentSimulator)
        && Boolean(document.querySelector('#topbarSoundToggle'))
        && Boolean(window.__claudeVilleAtmosphere), null, { timeout: 45000 });
    await h.page.evaluate(() => window.__probe.install());
    await h.page.waitForTimeout(3000);
    await h.page.evaluate(([hr]) => window.__probe.setAtmosphere(hr, 'clear'), [hour]);
    return h;
}

// The real TopBar enable: one click on the sound chip.
async function enableSound(h) {
    await h.page.click('#topbarSoundToggle');
    const ms = await h.page.evaluate(() => window.__probe.enableWait(15000));
    if (ms == null) {
        const snap = await h.page.evaluate(() => window.__probe.snapshot());
        throw new Error(`sound did not start after the TopBar click (contextState ${snap?.contextState}, running ${snap?.running}, enabled ${snap?.enabled})`);
    }
    return ms;
}

async function appBusyUnit(browser) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, 'mixed-tools', 10.4);
    try {
        // Probe-owned agents, added before sound is on so their arrivals do
        // not land inside any measured window.
        const ids = {
            errAttention: 'probe-err-a', errDistress: 'probe-err-b', errLive: 'probe-err-live',
            rlAttention: 'probe-rl-a', rlDistress: 'probe-rl-b', rlLive: 'probe-rl-live',
            blur: 'probe-wait-blur', signals: 'probe-wait-signals', hidden: 'probe-wait-hidden',
        };
        const names = { 'probe-err-a': 'Ash', 'probe-err-b': 'Birch', 'probe-err-live': 'Cedar', 'probe-rl-a': 'Dune', 'probe-rl-b': 'Elm', 'probe-rl-live': 'Fir', 'probe-wait-blur': 'Gorse', 'probe-wait-signals': 'Heath', 'probe-wait-hidden': 'Ivy' };
        await h.page.evaluate((specs) => window.__probe.addAgents(specs), Object.values(ids).map((id, i) => ({
            id, name: names[id], provider: i % 2 ? 'codex' : 'claude', status: 'working',
            currentTool: 'Read', currentToolInput: 'file_path=/README.md', position: { tileX: 14 + i, tileY: 22 + (i % 3) },
        })));
        await h.page.waitForTimeout(1500);

        const enableMs = await enableSound(h);
        log(`app: sound running ${enableMs.toFixed(0)} ms after the TopBar click`);

        // Busy day, the reported scene (the warmup also settles the bed the
        // later checks play over).
        await h.page.waitForTimeout(BUSY_WARMUP_MS);
        const busyStart = await h.page.evaluate(() => performance.now());
        if (ONLY.includes('report')) await h.page.waitForTimeout(BUSY_SECONDS * 1000);
        const busyEnd = await h.page.evaluate(() => performance.now());

        // Must-never 2: bucket routing, both event orders, then the live producers.
        const routing = [
            { id: ids.errAttention, status: 'errored', order: 'attention-first', want: 'distress' },
            { id: ids.errDistress, status: 'errored', order: 'distress-first', want: 'distress' },
            { id: ids.rlAttention, status: 'rate_limited', order: 'attention-first', want: 'limit' },
            { id: ids.rlDistress, status: 'rate_limited', order: 'distress-first', want: 'limit' },
            { id: ids.errLive, status: 'errored', order: 'live', want: 'distress' },
            { id: ids.rlLive, status: 'rate_limited', order: 'live', want: 'limit' },
        ];
        if (ONLY.includes('routing')) {
            for (const r of routing) {
                r.at = await h.page.evaluate(([id, status, order]) => window.__probe.signal(id, status, order), [r.id, r.status, r.order]);
                await h.page.waitForTimeout(1000);
            }
            await h.page.waitForTimeout(3000);
        }

        // Must-never 4 and 5: away and back, three ways.
        const away = [];
        if (ONLY.includes('away')) {
            for (const [how, agentId] of [['blur', ids.blur], ['blur-signals', ids.signals], ['hidden', ids.hidden]]) {
                away.push(await h.page.evaluate(o => window.__probe.away(o), {
                    how, agentId, settleMs: AWAY_SETTLE_MS, listenMs: AWAY_LISTEN_MS, returnTimeoutMs: 3000,
                }));
                await h.page.waitForTimeout(3000);
            }
        }

        const logRows = await h.page.evaluate(() => window.__probe.log);
        const hazards = await readHazards(h.page);
        const snapshot = await h.page.evaluate(() => window.__probe.snapshot());
        const tap = await h.page.evaluate(() => window.__harTap.collect());
        const pcm = await pullPcm(h.page, tap.frames * 2);
        return { ids, names, routing, away, logRows, hazards, snapshot, tap, pcm, busyStart, busyEnd, errors: h.errors };
    } finally {
        await h.context.close();
        await app.stop();
    }
}

function judgeBusy(cap) {
    const { tap, pcm, routing, away, logRows, names } = cap;
    const tl = wallTimeline(tap, pcm);
    const toT = wallMs => wallMs / 1000 - tl.wall0;
    const allGaps = tap.gapList || [];

    if (ONLY.includes('report')) {
        const a = Math.max(0, Math.round(toT(cap.busyStart) * tl.sr));
        const b = Math.min(tl.L.length, Math.round(toT(cap.busyEnd) * tl.sr));
        const { metrics } = analyze(tl.L.subarray(a, b), tl.R.subarray(a, b), tl.sr);
        const inWindow = tl.chunks.filter(c => c.start >= cap.busyStart / 1000 && c.start <= cap.busyEnd / 1000);
        const f0 = inWindow[0]?.frame ?? 0;
        const f1 = inWindow.length ? inWindow[inWindow.length - 1].frame + inWindow[inWindow.length - 1].frames : 0;
        const gaps = allGaps.filter(([at]) => at >= f0 && at <= f1);
        info('report', `busy day (mixed-tools, 10:24 clear, ${BUSY_SECONDS} s): LUFS-I ${fmt(metrics.loudness.integratedLUFS)}, TP ${fmt(metrics.peak.truePeakDBTP)} dBTP, ST max ${fmt(metrics.loudness.shortTermMaxLUFS)}, capture.gaps ${gaps.length} (${gaps.reduce((n, [, lost]) => n + Math.max(0, lost), 0)} frames) in window, ${allGaps.length} in session`);
        if (OUT) {
            fs.mkdirSync(OUT, { recursive: true });
            writeWavFloat(path.join(OUT, 'probe-busy-day.wav'), tl.L.subarray(a, b), tl.R.subarray(a, b), tl.sr);
        }
    }

    const cues = logRows.filter(r => r.type === 'cue');
    if (ONLY.includes('routing')) {
        for (const r of routing) {
            const heard = cues.filter(c => c.agentId === r.id && c.wall >= r.at && ['summons', 'distress', 'limit'].includes(c.kind));
            const kinds = heard.map(c => c.kind);
            const pass = kinds.length > 0 && kinds.every(k => k === r.want);
            verdict('routing', pass, `${names[r.id]} ${r.status} (${r.order}): cue-played [${kinds.join(', ') || 'none'}], want ${r.want}${heard.length ? `; caption "${heard[0].label}"` : ''}`);
        }
    }

    if (ONLY.includes('away')) {
        const { momentaryCurve } = loudness(tl.L, tl.R, tl.sr);
        for (const ep of away) {
            const cue = cues.find(c => c.agentId === ep.agentId && c.kind === 'summons' && c.wall >= ep.summonsAt);
            const at = cue ? toT(cue.wall) : toT(ep.summonsAt);
            const m = marginAt(momentaryCurve, at, MARGIN);
            const bedClosed = ep.how !== 'blur';
            const nums = `margin ${signed(m.margin)} LU (cue M max ${fmt(m.cueMax)} LUFS over bed ${Number.isFinite(m.bed) ? `${fmt(m.bed)} LUFS` : 'silence'}), cue bus peak ${fmt(ep.cueBusPeakDb)} dBFS, context ${ep.stateBefore}→${ep.stateDuring}, wakes ${ep.wakeCount ?? '—'}`;
            if (!cue) {
                verdict('away', false, `${ep.how}: no summons cue-played for ${names[ep.agentId]}; ${nums}`);
            } else if (bedClosed) {
                // Bed closed (signals-only background, hidden tab): the call
                // must stand the needs-you lane minimum over what was playing.
                verdict('away', m.margin >= NEEDS_YOU_MIN_LU, `${ep.how}: needs-you ${nums}; want ≥ +${NEEDS_YOU_MIN_LU} LU`);
            } else {
                // D3: a blurred window keeps the full mix, so the call plays
                // over the bed; must-never 4 asks that it sounds. Its margin
                // over the bed is must-never 1, gated from Wave 1 (1.3).
                const sounded = ep.cueBusPeakDb != null && ep.cueBusPeakDb >= CUE_BUS_AUDIBLE_DBFS && ep.stateDuring === 'running';
                verdict('away', sounded, `${ep.how} (full mix kept, D3): needs-you ${nums}; want cue bus ≥ ${CUE_BUS_AUDIBLE_DBFS} dBFS with the context running (margin is must-never 1, gated from 1.3)`);
            }
            const back = ep.how === 'hidden' ? 'hide→show' : 'blur→focus';
            const ms = ep.resumed.contextMs;
            verdict('resume', ms != null && ms <= RESUME_LIMIT_MS,
                `${ep.how} ${back}: context running after ${ms == null ? 'never (3 s)' : `${ms.toFixed(0)} ms`}, director after ${ep.resumed.directorMs == null ? 'never (3 s)' : `${ep.resumed.directorMs.toFixed(0)} ms`}; want ≤ ${RESUME_LIMIT_MS} ms`);
        }
        if (OUT) {
            fs.mkdirSync(OUT, { recursive: true });
            writeWavFloat(path.join(OUT, 'probe-app-session.wav'), tl.L, tl.R, tl.sr);
        }
    }

    const hz = cap.hazards.reduce((n, x) => n + x.count, 0);
    info('report', `app session: ${hz} envelope hazard(s)${hz ? ` — ${cap.hazards.map(x => `x${x.count} ${shortSite(x.site)}`).join(' | ')}` : ''}; wakes ${cap.snapshot?.wakeCount ?? '—'}; page errors ${cap.errors.length}${cap.errors.length ? `: ${cap.errors.slice(0, 3).join(' | ')}` : ''}`);
}

async function appCeremonyUnit(browser) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, 'no-agents', 11.3);
    try {
        await enableSound(h);
        await h.page.waitForTimeout(6000);
        const startedAt = await h.page.evaluate(() => window.__probe.restartScenario('team-gather'));
        await h.page.waitForTimeout(CEREMONY_WINDOW_MS);
        const rows = (await h.page.evaluate(() => window.__probe.log)).filter(r => r.wall >= startedAt);
        return { rows, errors: h.errors };
    } finally {
        await h.context.close();
        await app.stop();
    }
}

function judgeCeremony({ rows }) {
    const gathers = rows.filter(r => r.type === 'team:gather');
    const cues = rows.filter(r => r.type === 'cue');
    const councils = cues.filter(c => c.kind === 'council');
    const others = cues.filter(c => c.kind !== 'council').map(c => `${c.kind} "${c.label}"`);
    const replaced = councils.find(c => c.replaces)?.replaces;
    verdict('ceremony', councils.length === 1,
        `team-gather: ${gathers.length} team:gather, ${councils.length} council cue-played${councils[0] ? ` ("${councils[0].label}")` : ''}${replaced ? `, replaces ${replaced.kind} ×${replaced.count ?? '?'}` : ''}; other cues: ${others.join(', ') || 'none'}; want exactly 1 council`);
}

// ---------------------------------------------------------------- pool ----
async function pool(units, jobs) {
    let next = 0;
    const workers = Array.from({ length: Math.min(jobs, units.length) }, async () => {
        while (next < units.length) {
            const unit = units[next++];
            log(`start ${unit.name}`);
            try {
                await unit.run();
            } catch (e) {
                verdict(unit.check || 'probe', false, `${unit.name}: ${e.message || e}`);
            }
        }
    });
    await Promise.all(workers);
}

// ---------------------------------------------------------------- main ----
async function main() {
    let server = null;
    let harnessBrowser = null;
    let appBrowser = null;
    const harness = async () => (harnessBrowser ||= await chromium.launch({ headless: true, args: HARNESS_CHROME_ARGS }));
    const appB = async () => (appBrowser ||= await chromium.launch({ headless: true, args: APP_CHROME_ARGS }));
    try {
        const units = [];
        if (ONLY.some(c => ['routing', 'away', 'report'].includes(c))) {
            units.push({ name: 'app busy day (report, routing, away)', check: 'app', run: async () => judgeBusy(await appBusyUnit(await appB())) });
        }
        if (ONLY.includes('ceremony')) {
            units.push({ name: 'app team-gather (ceremony)', check: 'ceremony', run: async () => judgeCeremony(await appCeremonyUnit(await appB())) });
        }
        if (ONLY.includes('lint')) {
            server = await startStaticServer();
            for (const u of await lintUnits(await harness(), server)) units.push({ ...u, check: 'lint' });
        }
        await pool(units, JOBS);
    } finally {
        await harnessBrowser?.close().catch(() => {});
        await appBrowser?.close().catch(() => {});
        await server?.close();
    }

    const failed = results.filter(r => r.pass === false);
    const passed = results.filter(r => r.pass === true);
    if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'probe-report.json'), JSON.stringify({ seed: SEED, jobs: JOBS, only: ONLY, seconds: (Date.now() - t0) / 1000, results }, null, 2));
    }
    console.log(`\naudio:probe ${failed.length ? 'FAILED' : 'passed'}: ${passed.length} pass, ${failed.length} fail in ${((Date.now() - t0) / 1000).toFixed(0)} s (seed ${SEED}, --jobs ${JOBS})`);
    for (const f of failed) console.log(`  FAIL ${f.check}: ${f.detail}`);
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
