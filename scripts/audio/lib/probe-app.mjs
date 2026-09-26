// The probe's live-app and harness checks, kept from Wave 0 (realtime,
// headless Chromium): the HAR-4 envelope lint, must-never 2 (routing),
// 4 and 5 (away and back) and 6 (one council per gathering). The app checks
// run the full app on an isolated server with a real TopBar click.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_DIR } from './server.mjs';
import { loudness, writeWavFloat } from './analyze.mjs';
import { buildTargets } from './targets.mjs';
import { newHarnessPage, openHarness, pullPcm, readHazards } from './capture.mjs';
import { startIsolatedServer } from '../../smoke/support/isolated-server.mjs';
import { marginAt, wallTimeline } from './timeline.mjs';
import { fmt, shortSite, signed } from './format.mjs';
import { AUDIBILITY_WINDOWS } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';
import { energyMeanLufs, frameCostDelta, FRAME_COST_MAX_DELTA_MS, percentile } from './checks.mjs';

const PROBE_APP_JS = fs.readFileSync(path.join(AUDIO_DIR, 'page/probe-app.js'), 'utf8');

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
const CEREMONY_WINDOW_MS = 15000;

// ---------------------------------------------------------------- lint ----
// HAR-4's runtime half: a source that starts while the GainNode it feeds
// still sits at its default gain of 1 (init.js). A unit that did not
// exercise its subject proves nothing, so it fails too: no source started,
// an isolated layer below its sounding threshold, or a mode switch that did
// not happen.
export async function lintUnits(browser, server, { seed, verdict, info }) {
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
            const h = await openHarness(browser, server.baseUrl, seed);
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
                const h = await openHarness(browser, server.baseUrl, seed);
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
async function openApp(browser, server, scenario, hour, seed) {
    const h = await newHarnessPage(browser, seed, { width: 1440, height: 900 });
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

export async function appBusyUnit(browser, { seed, only, log }) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, 'mixed-tools', 10.4, seed);
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

        // Let the bed settle before the checks play over it.
        await h.page.waitForTimeout(BUSY_WARMUP_MS);

        // Must-never 2: bucket routing, both event orders, then the live producers.
        const routing = [
            { id: ids.errAttention, status: 'errored', order: 'attention-first', want: 'distress' },
            { id: ids.errDistress, status: 'errored', order: 'distress-first', want: 'distress' },
            { id: ids.rlAttention, status: 'rate_limited', order: 'attention-first', want: 'limit' },
            { id: ids.rlDistress, status: 'rate_limited', order: 'distress-first', want: 'limit' },
            { id: ids.errLive, status: 'errored', order: 'live', want: 'distress' },
            { id: ids.rlLive, status: 'rate_limited', order: 'live', want: 'limit' },
        ];
        if (only.includes('routing')) {
            for (const r of routing) {
                r.at = await h.page.evaluate(([id, status, order]) => window.__probe.signal(id, status, order), [r.id, r.status, r.order]);
                await h.page.waitForTimeout(1000);
            }
            await h.page.waitForTimeout(3000);
        }

        // Must-never 4 and 5: away and back, three ways.
        const away = [];
        if (only.includes('away')) {
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
        return { ids, names, routing, away, logRows, hazards, snapshot, tap, pcm, errors: h.errors };
    } finally {
        await h.context.close();
        await app.stop();
    }
}

export function judgeBusy(cap, { only, out, verdict, info }) {
    const { tap, pcm, routing, away, logRows, names } = cap;
    const tl = wallTimeline(tap, pcm);
    const toT = wallMs => wallMs / 1000 - tl.wall0;
    const allGaps = tap.gapList || [];

    const cues = logRows.filter(r => r.type === 'cue');
    if (only.includes('routing')) {
        for (const r of routing) {
            const heard = cues.filter(c => c.agentId === r.id && c.wall >= r.at && ['summons', 'distress', 'limit'].includes(c.kind));
            const kinds = heard.map(c => c.kind);
            const pass = kinds.length > 0 && kinds.every(k => k === r.want);
            verdict('routing', pass, `${names[r.id]} ${r.status} (${r.order}): cue-played [${kinds.join(', ') || 'none'}], want ${r.want}${heard.length ? `; caption "${heard[0].label}"` : ''}`);
        }
    }

    if (only.includes('away')) {
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
        if (out) {
            fs.mkdirSync(out, { recursive: true });
            writeWavFloat(path.join(out, 'probe-app-session.wav'), tl.L, tl.R, tl.sr);
        }
    }

    const hz = cap.hazards.reduce((n, x) => n + x.count, 0);
    info('lint', `app session: ${hz} envelope hazard(s)${hz ? ` — ${cap.hazards.map(x => `x${x.count} ${shortSite(x.site)}`).join(' | ')}` : ''}; wakes ${cap.snapshot?.wakeCount ?? '—'}; page errors ${cap.errors.length}${cap.errors.length ? `: ${cap.errors.slice(0, 3).join(' | ')}` : ''}`);
}

export async function appCeremonyUnit(browser, { seed }) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, 'no-agents', 11.3, seed);
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

export function judgeCeremony({ rows }, { verdict }) {
    const gathers = rows.filter(r => r.type === 'team:gather');
    const cues = rows.filter(r => r.type === 'cue');
    const councils = cues.filter(c => c.kind === 'council');
    const others = cues.filter(c => c.kind !== 'council').map(c => `${c.kind} "${c.label}"`);
    const replaced = councils.find(c => c.replaces)?.replaces;
    verdict('ceremony', councils.length === 1,
        `team-gather: ${gathers.length} team:gather, ${councils.length} council cue-played${councils[0] ? ` ("${councils[0].label}")` : ''}${replaced ? `, replaces ${replaced.kind} ×${replaced.count ?? '?'}` : ''}; other cues: ${others.join(', ') || 'none'}; want exactly 1 council`);
}

// ------------------------------------------------------ Wave 2 (realtime) ----
// 2.1: blur 3 s → focus in the Town band: the piece is unchanged and, by
// 0.3 s after focus, the momentary level is within 6 dB of the 3 s before
// the blur.
const CONTINUITY = { blurMs: 3000, afterMs: 1500, settleMs: 9000, levelDb: 6, withinSec: 0.3 };

export async function appContinuityUnit(browser, { seed }) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, 'mixed-tools', 10.4, seed);
    try {
        await enableSound(h);
        await h.page.evaluate(() => window.__probe.setMode('bgm'));
        await h.page.waitForTimeout(CONTINUITY.settleMs);
        const ep = await h.page.evaluate(o => window.__probe.blurFocus(o), CONTINUITY);
        const tap = await h.page.evaluate(() => window.__harTap.collect());
        const pcm = await pullPcm(h.page, tap.frames * 2);
        return { ep, tap, pcm, errors: h.errors };
    } finally {
        await h.context.close();
        await app.stop();
    }
}

export function judgeContinuity({ ep, tap, pcm, errors }, { verdict }) {
    const tl = wallTimeline(tap, pcm);
    const toT = wallMs => wallMs / 1000 - tl.wall0;
    const { momentaryCurve } = loudness(tl.L, tl.R, tl.sr);
    const blurT = toT(ep.blurAt);
    const focusT = toT(ep.focusAt);
    const pre = energyMeanLufs(momentaryCurve.filter(([t]) => t >= blurT - 3 && t < blurT).map(([, v]) => v));
    const at = momentaryCurve.find(([t]) => t >= focusT + CONTINUITY.withinSec)?.[1] ?? null;
    const dDb = Number.isFinite(pre) && Number.isFinite(at) ? at - pre : null;
    const name = np => (np ? `${np.piece ?? np.song ?? '?'} bar ${np.bar ?? '?'}` : 'nothing');
    const same = ep.before?.piece != null && ep.before.piece === ep.after?.piece;
    verdict('continuity', same && dDb != null && Math.abs(dDb) <= CONTINUITY.levelDb,
        `Town band, blur ${CONTINUITY.blurMs / 1000} s → focus: ${name(ep.before)} → ${name(ep.during)} → ${name(ep.after)}; momentary ${fmt(at)} LUFS at focus + ${CONTINUITY.withinSec} s vs ${fmt(pre)} before the blur (${signed(dDb)} dB); context ${ep.contextState}; want the same piece and within ${CONTINUITY.levelDb} dB${errors.length ? `; page errors: ${errors.slice(0, 2).join(' | ')}` : ''}`);
}

// 2.4: the world benchmark's app frame total (update + render, the
// `appTotalMs` samples of __claudeVillePerf's frame profile) with sound on
// vs off, in alternating segments so drift hits both. The two sound-off
// segments measure the host's own noise: when they disagree by more than
// the limit itself, the delta is reported as INFO, not judged.
const FRAME_COST = { segmentMs: 15000, settleMs: 3000, scenario: 'perf-12-agents' };

export async function appFrameCostUnit(browser, { seed }) {
    const app = await startIsolatedServer();
    const h = await openApp(browser, app, FRAME_COST.scenario, 12, seed);
    try {
        const segment = async () => {
            await h.page.waitForTimeout(FRAME_COST.settleMs);
            await h.page.evaluate(() => window.__probe.startFrames());
            await h.page.waitForTimeout(FRAME_COST.segmentMs);
            return h.page.evaluate(() => window.__probe.stopFrames());
        };
        const off1 = await segment();
        await enableSound(h);
        const on1 = await segment();
        await h.page.click('#topbarSoundToggle');
        const off2 = await segment();
        await h.page.click('#topbarSoundToggle');
        await h.page.evaluate(() => window.__probe.enableWait(15000));
        const on2 = await segment();
        return { off1, off2, on1, on2, errors: h.errors };
    } finally {
        await h.context.close();
        await app.stop();
    }
}

export function judgeFrameCost({ off1, off2, on1, on2, errors }, { verdict, info }) {
    const d = frameCostDelta([...on1, ...on2], [...off1, ...off2]);
    const noise = Math.abs((percentile(off1, 0.95) ?? NaN) - (percentile(off2, 0.95) ?? NaN));
    const line = `app frame total p95 sound on ${fmt(d.onP95, 3)} ms vs off ${fmt(d.offP95, 3)} ms (Δ ${signed(d.delta, 3)} ms; ${on1.length + on2.length} / ${off1.length + off2.length} frames); off-vs-off p95 ${fmt(noise, 3)} ms`;
    if (!(off1.length && on1.length)) { verdict('fps', false, `no frame profile samples (window.__claudeVillePerf.startFrameProfile); ${errors.slice(0, 2).join(' | ')}`); return; }
    if (!(noise < FRAME_COST_MAX_DELTA_MS - 1e-9)) info('fps', `${line} — the two sound-off segments already differ by the ${FRAME_COST_MAX_DELTA_MS} ms limit or more (the page clock resolves 0.1 ms), so the delta is not judged; re-run on a quiet host`);
    else verdict('fps', d.pass, `${line}; want Δ ≤ ${FRAME_COST_MAX_DELTA_MS} ms`);
}
