// The probe's --soak (SCN-9): the full app on an isolated server (?sim=1,
// renderer on) records ten real-time minutes of a busy village in each
// preset that sounds — Signals and the Town band, the SCN session fixtures
// (fixtures/scn-plans.mjs) played through the sim driver, sound enabled by a
// real TopBar click — and reports the session metrics
// (metrics/session-metrics.mjs), the music bus's ducked time, and the
// renderer's AV-sync lag from the cue score's own diagnostics (HAR-12:
// drawn accent frame vs published note). Two soaks agree when integrated
// loudness is within 1 LU, music-on within ±3 points and re-heard within
// ±5 points (0.8b); `--update` records this soak as baselines/soak.json.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { AUDIO_DIR } from './server.mjs';
import { loudness, writeWavFloat } from './analyze.mjs';
import { BACKGROUND_ARGS, clockToIndex, newHarnessPage, pullPcm } from './capture.mjs';
import { duckedTime, median, percentile } from './checks.mjs';
import { fmt, signed } from './format.mjs';
import { startIsolatedServer } from '../../smoke/support/isolated-server.mjs';
import { PLANS } from '../fixtures/scn-plans.mjs';
import { sessionMetrics } from '../metrics/session-metrics.mjs';
import { DUCKED_TIME_BUDGET } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';

export const SOAK_PLANS = ['scn-session-signals-10min', 'scn-session-bgm-10min'];
const SOAK_BASELINE = path.join(AUDIO_DIR, 'baselines/soak.json');
export const SOAK_AGREEMENT = Object.freeze({ lufsI: 1, musicOnPct: 3, reheardPct: 5 });
const CHROME_ARGS = ['--autoplay-policy=no-user-gesture-required', ...BACKGROUND_ARGS];

async function captureSession(browser, planName, { seed, seconds, log }) {
    const plan = PLANS[planName];
    const length = seconds ?? plan.seconds;
    const actions = plan.actions().filter(a => a.t < length);
    const server = await startIsolatedServer();
    const h = await newHarnessPage(browser, seed, { width: 1440, height: 900 });
    try {
        const { page } = h;
        await page.goto(`${server.baseUrl}/?sim=1&scenario=${plan.scenario}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.__claudeVilleApp?.agentSimulator) && Boolean(document.querySelector('#topbarSoundToggle')) && Boolean(window.__claudeVilleAtmosphere), null, { timeout: 45000 });
        await page.waitForTimeout(4000);
        await page.evaluate(async ({ hour, weather }) => {
            const { eventBus } = await import('/src/domain/events/DomainEvent.js');
            window.__claudeVilleAtmosphere.setHour(hour);
            window.__claudeVilleAtmosphere.setWeather(weather);
            const ctxT = () => { const c = [...(window.__harTap?.taps?.keys?.() || [])][0]; return c ? c.currentTime : null; };
            const scn = window.__scn = { log: [], state: [], ducks: [], ctxT };
            eventBus.on('audio:cue-played', p => scn.log.push({ ct: ctxT(), type: 'audio:cue-played', kind: p?.kind ?? null, agentId: p?.agentId ?? null }));
        }, { hour: plan.hour, weather: plan.weather });

        // The real enable (7.1): the note's first-ever click opens the SOUND
        // panel's presets; the plan's preset is picked there.
        await page.click('#topbarSoundToggle');
        await page.locator('#soundPanel').waitFor({ state: 'visible', timeout: 10000 });
        await page.click(`#soundPresets [role="radio"][data-preset="${plan.mode === 'bgm' ? 'townBand' : 'signals'}"]`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => { const a = window.__claudevilleAudio?.(); return a?.contextState === 'running' && a?.running === true; }, null, { timeout: 20000 });
        // Ducked time: every window the engine is asked for.
        await page.evaluate(() => {
            const engine = window.__claudeVilleApp.topBar.audio.engine;
            const scn = window.__scn;
            const duck = engine.duck.bind(engine);
            engine.duck = (opts = {}) => {
                const entry = { from: opts.from, until: opts.until, attack: opts.attack, release: opts.release, depths: { ...(opts.depths || {}) }, cancelledAt: null };
                scn.ducks.push(entry);
                const token = duck(opts);
                if (token?.cancel) {
                    const cancel = token.cancel.bind(token);
                    token.cancel = () => { if (entry.cancelledAt == null) entry.cancelledAt = engine.now(); return cancel(); };
                }
                return token;
            };
        });
        const startCt = await page.evaluate(() => window.__scn.ctxT());
        log(`soak ${planName}: sound on (${plan.mode}); ${actions.length} actions over ${length} s`);
        const endCt = await page.evaluate(async ({ acts, seconds: secs }) => {
            const scn = window.__scn;
            const sim = window.__claudeVilleApp.agentSimulator;
            const start = performance.now();
            const stateTimer = setInterval(() => {
                const s = window.__claudevilleAudio?.();
                if (s) scn.state.push({ ct: scn.ctxT(), state: s.state, mode: s.mode, running: s.running, nowPlaying: s.nowPlaying });
            }, 1000);
            const fire = (a) => {
                try {
                    if (a.step) sim._applyStep(a.step);
                    else if (a.add) sim._addAgent(a.add);
                    else if (a.remove) sim._removeAgent(a.remove);
                    else if (a.hour != null) window.__claudeVilleAtmosphere.setHour(a.hour);
                    else if (a.weather) window.__claudeVilleAtmosphere.setWeather(a.weather);
                } catch { /* a fixture step the sim refuses */ }
            };
            for (const a of acts) setTimeout(() => fire(a), Math.max(0, a.t * 1000 - (performance.now() - start)));
            await new Promise(r => setTimeout(r, secs * 1000));
            clearInterval(stateTimer);
            return scn.ctxT();
        }, { acts: actions, seconds: length });
        const result = await page.evaluate(async () => {
            const { cueScoreDiagnostics } = await import('/src/presentation/shared/audio/CueScore.js');
            return { log: window.__scn.log, state: window.__scn.state, ducks: window.__scn.ducks, cueScore: cueScoreDiagnostics() };
        });
        const tap = await page.evaluate(() => window.__harTap.collect());
        const pcm = await pullPcm(page, tap.frames * 2);
        return { plan, planName, length, startCt, endCt, result, tap, pcm, errors: h.errors };
    } finally {
        await h.context.close();
        await server.stop();
    }
}

function analyzeSession(cap) {
    const { tap, pcm, result } = cap;
    const sr = tap.sampleRate;
    const a = Math.max(0, clockToIndex(tap, cap.startCt));
    const b = Math.min(tap.frames, clockToIndex(tap, cap.endCt));
    const L = pcm.L.subarray(a, b);
    const R = pcm.R.subarray(a, b);
    const rel = ct => (clockToIndex(tap, ct) - a) / sr;
    const timeline = result.log.filter(e => e.ct != null).map(e => ({ ...e, t: rel(e.ct) }));
    const state = result.state.filter(s => s.ct != null).map(s => ({ ...s, t: rel(s.ct) }));
    const lou = loudness(L, R, sr);
    const session = sessionMetrics(L, R, sr, { state, timeline });
    // Only the music bus ducks (AudioEngine DUCKED_BUSES); under Signals nothing does.
    const ducks = duckedTime(result.ducks, cap.startCt, cap.endCt, { buses: ['music'] });
    const lags = result.cueScore?.lags || [];
    const gaps = (tap.gapList || []).filter(([at]) => at / sr >= cap.startCt && at / sr <= cap.endCt);
    return {
        seconds: L.length / sr, L, R, sr,
        lufsI: lou.integrated, lra: lou.lra, stMax: lou.shortTermMax,
        musicOnPct: session.music.onPct, reheardPct: session.repetition.dejaHeardPct,
        silenceBelow60Pct: session.silence.below60Pct, cuesPerHour: session.cues.perHour,
        ducks, duckWindows: result.ducks.length,
        avLag: { n: lags.length, medianMs: median(lags), p95Ms: percentile(lags, 0.95) },
        gaps: gaps.length,
    };
}

export async function runSoak({ seed, out, verdict, info, log, seconds, update }) {
    const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    const measured = {};
    try {
        for (const planName of SOAK_PLANS) {
            const cap = await captureSession(browser, planName, { seed, seconds, log });
            const m = analyzeSession(cap);
            measured[planName] = m;
            info('soak', `${planName}: ${fmt(m.seconds, 0)} s, LUFS-I ${fmt(m.lufsI)}, ST max ${fmt(m.stMax)}, LRA ${fmt(m.lra)} LU; music on ${fmt(m.musicOnPct)} %, re-heard ${fmt(m.reheardPct)} %, below −60 LUFS-M ${fmt(m.silenceBelow60Pct)} %, cues ${m.cuesPerHour}/h; capture gaps ${m.gaps}; page errors ${cap.errors.length}`);
            info('soak', `${planName}: HAR-12 renderer lag (drawn accent − published note) median ${fmt(m.avLag.medianMs)} ms, p95 ${fmt(m.avLag.p95Ms)} ms over ${m.avLag.n} notes`);
            const worst = Math.max(...Object.values(m.ducks));
            // The budget is a share of an hour; a shortened smoke only reports it.
            (seconds == null ? verdict.bind(null, 'soak', worst <= DUCKED_TIME_BUDGET) : info.bind(null, 'soak'))(`${planName}: ducked time ${Object.entries(m.ducks).map(([k, v]) => `${k} ${fmt(100 * v)} %`).join(', ')} over ${m.duckWindows} windows; want ≤ ${fmt(100 * DUCKED_TIME_BUDGET, 0)} % per bus`);
            if (out) {
                fs.mkdirSync(out, { recursive: true });
                writeWavFloat(path.join(out, `${planName}.wav`), m.L, m.R, m.sr);
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
    const rows = Object.fromEntries(Object.entries(measured).map(([k, m]) => [k, { lufsI: Number(m.lufsI.toFixed(2)), musicOnPct: m.musicOnPct, reheardPct: m.reheardPct, seconds: Math.round(m.seconds) }]));
    if (update) {
        fs.mkdirSync(path.dirname(SOAK_BASELINE), { recursive: true });
        fs.writeFileSync(SOAK_BASELINE, `${JSON.stringify({ note: 'Reviewed realtime soak baseline (scripts/audio/probe.mjs --soak --update).', generatedAt: new Date().toISOString().slice(0, 10), seed, agreement: SOAK_AGREEMENT, plans: rows }, null, 2)}\n`);
        info('soak', `wrote ${path.relative(process.cwd(), SOAK_BASELINE)}`);
        return;
    }
    if (!fs.existsSync(SOAK_BASELINE)) {
        info('soak', `no ${path.relative(process.cwd(), SOAK_BASELINE)} to agree with; record one with --soak --update`);
        return;
    }
    const base = JSON.parse(fs.readFileSync(SOAK_BASELINE, 'utf8')).plans;
    for (const [planName, cur] of Object.entries(rows)) {
        const b = base[planName];
        if (!b) continue;
        if (b.seconds !== cur.seconds) { info('soak', `${planName}: baseline is ${b.seconds} s, this soak ${cur.seconds} s — not compared`); continue; }
        const d = { lufsI: cur.lufsI - b.lufsI, musicOnPct: (cur.musicOnPct ?? 0) - (b.musicOnPct ?? 0), reheardPct: (cur.reheardPct ?? 0) - (b.reheardPct ?? 0) };
        verdict('soak', Math.abs(d.lufsI) <= SOAK_AGREEMENT.lufsI && Math.abs(d.musicOnPct) <= SOAK_AGREEMENT.musicOnPct && Math.abs(d.reheardPct) <= SOAK_AGREEMENT.reheardPct,
            `${planName} vs baseline: LUFS-I ${signed(d.lufsI, 2)} LU, music on ${signed(d.musicOnPct)} pt, re-heard ${signed(d.reheardPct)} pt; want within ${SOAK_AGREEMENT.lufsI} LU / ${SOAK_AGREEMENT.musicOnPct} / ${SOAK_AGREEMENT.reheardPct}`);
    }
}
