#!/usr/bin/env node
// The audio probe: a LOCAL maintainer gate (not part of validate:quick or
// CI). See scripts/audio/README.md "The probe".
//
//   npm run audio:probe
//   node scripts/audio/probe.mjs [--only a,b] [--jobs N] [--seed N] [--out dir]
//                                [--no-worklets] [--update [--ref-rev REV]] [--soak [--soak-seconds N]]
//
// Default: the gate at PLAN_STAGE (lib/checks.mjs; criteria owned by a later
// wave print DEFER and never fail) on the virtual clock (HAR-1: the shipped
// controller rendered on an OfflineAudioContext, sample-identical per seed)
// plus the Wave-0 checks on the live app. Checks (PASS/FAIL/INFO lines; any
// FAIL exits 1):
//   scenes       S2 scene targets (Loudness.js) at the standard step: anchor,
//                village busy, Town band, rain, storm, resting; HAR-5 stems
//   margins      cue lanes (needs-you, error, limit, routine, scenery, the
//                three outcome tiers) over the village (no music), music,
//                rain and storm beds: median of 3 placements in the full S2
//                window, the band rule and urgent limiter GR ≤ 3 dB; the
//                Minor outcome ≥ 3 LU under routine
//   limiter      a +12 dBFS burst → the worklet's LIMITER_CEILING_DBFS (+0.1)
//                and ≤ −1 dBTP, the native fallback ≤ −0.9 dBFS; static gain
//                0 ± 0.2 dB on both
//   switch       must-never 12: preset switch hole/bump ≤ 3 dB, both ways
//   ducks        ducked time ≤ 5 % per bus (village busy, Town band)
//   avsync       HAR-12: published note and accent times vs heard onsets;
//                the release crown's accent vs its peal note (± 15 ms)
//   determinism  two renders of one scene agree within 0.2 LU
//   baseline     scene and margin numbers within tolerance of the committed
//                baselines/scenes.json (--update rewrites it); drift only —
//                a baseline never passes a target that failed
//   transport    2.1: Transport diagnostics over 10 min (underruns 0,
//                horizons), exactly one timer places sound, tick cost
//   pause        2.1: 120 s hidden → nothing starts while suspended, the
//                first second after resume ≤ steady rate + 1, same piece
//   air          2.4: IR T60 at 1/4 kHz day and night, D/R at d = 0 / 1,
//                urgent wet re dry, what the air adds to the program
//   noise        2.5: texture autocorrelation, bed ICC, mono fold, lanes
//                on one pool buffer ≥ 5 s apart, the pool's budget
//   bank         2.6: resident bytes vs MEMORY_BUDGET, bake slices ≤ 5 ms
//   sequencer    2.3: every piece vs its Wave-1 reference render
//                (baselines/sequencer-wave1.json; --update --ref-rev REV
//                re-renders it from REV's tree): identical onsets, ≤ 0.5 LU
//   discrim      3.1–3.5 (S1): every cue voice governor-free — signal vs
//                every other voice ≥ 2/3, urgent pairwise ≥ 2/3, outcomes
//                vs needs-you, no quick same-pitch opening outside signals
//   ladder       3.3: 61 min sound off per family (D6 schedule, S7 caps,
//                Toast captions), acknowledgement, held trim (sound on),
//                hidden-tab wakes within 60 s
//   cluster      SIG-10: six same-tick raises within +1 LU of one call
//   heldnote     3.3: band rise at W = 1 and 15, beating, bed − 8 LU,
//                absent under music, in Town band and signals-only
//   outcomes     3.4: push, exit 0 silence, failure cap, turn done, dispatch,
//                return, release; a Dashboard fixture
//   captions     3.8 (HAR-13): caption/sound parity per caption setting,
//                both presets, sound on and off
//   honesty      must-never 3 (a wait audible while it lasts) and 13
//                (phase-locked urgent bells, stale-data sound)
//   lint, routing, away (+ resume), ceremony   the Wave-0 checks (live app)
//   continuity   2.1: blur 3 s → focus keeps the Town band piece and level
//   fps          2.4: app frame total p95, sound on vs off (realtime)
// --soak: the realtime app session instead (SCN-9, 10 min, both presets);
// see lib/soak.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStaticServer, AUDIO_DIR } from './lib/server.mjs';
import { writeWavFloat } from './lib/analyze.mjs';
import { BACKGROUND_ARGS, DEFAULT_SEED, HARNESS_CHROME_ARGS } from './lib/capture.mjs';
import { fmt, signed } from './lib/format.mjs';
import {
    BASELINE_TOLERANCE, CROWN_SYNC_MS, CUE_STRATUM, HELD_NOTE, ISLAND_AIR, LADDER, NOISE_LIMITS, PLAN_STAGE, compareBaseline, expectedLadder, heldNoteRise,
    beatingDepthDb, judgeAirT60, judgeBank, judgeCaptionParity, judgeCluster, judgeDiscrimination, judgeDuckedTime, judgeHeldTrim, judgeLadder, judgeLane,
    judgeSceneTargets, judgeSequencer, judgeTransport, judgeWakes, median, noiseLaneConflicts, onsetNear, waitAudibleWindows,
} from './lib/checks.mjs';
import {
    AIR_CUE_SCENE, CAPTION_SETTINGS, DASHBOARD_SCENE, GALLERY_VOICES, HELD_ANSWER_SEC, HELD_OPEN_SEC, LADDER_OPEN_SEC, LADDER_SECONDS, LADDER_TRIM_SCENE,
    LONG_WAIT_SCENE, LONG_WAIT_SECONDS, MARGIN_BEDS, MARGIN_LANES, OUTCOME_SCENE, STALE_SCENE, TEXTURE_SCENES, TRANSPORT_SCENE,
    VILLAGE_DRY_SCENE, WAKE_SCENE, captionScene, clusterScene, galleryScene, heldNoteScene, hiddenScene, ladderSilentScene,
} from './lib/scenes.mjs';
import {
    captionRows, clusterRow, crownRow, galleryRows, heldNoteRows, heldWhileMusic, ladderCalls, ladderCaptioned, ladderTrimRows, laneEvents, wakeRows,
} from './lib/probe-wave3.mjs';
import { renderSilent } from './lib/virtual.mjs';
import { discriminationMatrix } from './metrics/discrim.mjs';
import {
    avSyncRows, duckRows, limiterUnitRows, makeRenderer, marginRows, renderLimiterUnit, sceneLevelMap,
    sceneMetrics, sceneSpec, stemReport, switchRows,
} from './lib/probe-virtual.mjs';
import {
    airRows, arrivalDrRows, bedRows, loadPieces, pauseRows, referenceServer, renderAir, sequencerRow, textureRows, transportRows, urgentWetRows,
} from './lib/probe-wave2.mjs';
import {
    appBusyUnit, appCeremonyUnit, appContinuityUnit, appFrameCostUnit, judgeBusy, judgeCeremony, judgeContinuity, judgeFrameCost, lintUnits,
} from './lib/probe-app.mjs';
import { runSoak } from './lib/soak.mjs';
import { LIMITER_CEILING_DBFS, LOUDNESS_TARGETS, MEMORY_BUDGET, PROGRAM_TRIM_DB, STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';

const APP_CHROME_ARGS = ['--autoplay-policy=user-gesture-required', ...BACKGROUND_ARGS];
const BASELINE_FILE = path.join(AUDIO_DIR, 'baselines/scenes.json');
const SEQUENCER_FILE = path.join(AUDIO_DIR, 'baselines/sequencer-wave1.json');
// The Wave-1 commit: the reference the sequencer must reproduce.
const SEQUENCER_REFERENCE_REV = 'f4a71e3';
const DETERMINISM_LU = 0.2;
const AV_SYNC = { medianAbsMs: 20, p95AbsMs: 40 };
const SWITCH_LIMIT_DB = 3;
// 1.1: a +12 dBFS burst leaves the native fallback at or under this.
const FALLBACK_MAX_DBFS = -0.9;

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
const JOBS = Math.max(1, Number(args.jobs || 2));
const SEED = args.seed != null ? Number(args.seed) : DEFAULT_SEED;
const NO_WORKLETS = Boolean(args['no-worklets']);
const UPDATE = Boolean(args.update);
const VIRTUAL_CHECKS = ['scenes', 'margins', 'limiter', 'switch', 'ducks', 'avsync', 'determinism', 'baseline', 'transport', 'pause', 'air', 'noise', 'bank', 'sequencer', 'discrim', 'ladder', 'cluster', 'heldnote', 'outcomes', 'captions', 'honesty'];
const APP_CHECKS = ['lint', 'routing', 'away', 'ceremony', 'continuity', 'fps'];
const ALL_CHECKS = [...VIRTUAL_CHECKS, ...APP_CHECKS];
const ONLY = args.only ? String(args.only).split(',').map(s => s.trim()) : ALL_CHECKS;
for (const name of ONLY) if (!ALL_CHECKS.includes(name)) throw new Error(`unknown check "${name}" (known: ${ALL_CHECKS.join(', ')})`);
const OUT = args.out ? path.resolve(String(args.out)) : null;
const has = name => ONLY.includes(name);

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
// A criterion gated in a later wave (checks.mjs GATED_FROM): measured and
// printed, never a failure until PLAN_STAGE reaches `wave`.
function defer(check, wave, detail) {
    results.push({ check, pass: null, deferred: wave, detail });
    console.log(`${stamp()} DEFER ${check}  ${detail} [gated from Wave ${wave}; stage ${PLAN_STAGE}]`);
}
function outcome(check, result, detail, wave) {
    if (result === 'DEFER') defer(check, wave, detail);
    else verdict(check, result === 'PASS', detail);
}
const reporter = { seed: SEED, only: ONLY, out: OUT, verdict, info, log };

// Numbers kept in the baseline, keyed `scene:<name>` / `margin:<bed>:<lane>`.
const summary = {};

// With --out, every rendered scene's program is kept as a WAV.
const kept = new Set();
function keep(name, r) {
    if (!OUT || kept.has(name)) return;
    kept.add(name);
    fs.mkdirSync(OUT, { recursive: true });
    writeWavFloat(path.join(OUT, `scene-${name.replace(/[^\w-]+/g, '-')}.wav`), r.program.L, r.program.R, r.sr);
}

// --------------------------------------------------------- virtual units ----
const SCENE_TARGET_NAMES = ['anchor', 'villageBusy', 'townBand', 'rain', 'storm', 'resting'];

function virtualUnits(render, browser, baseUrl) {
    const units = [];
    const scene = async (name) => {
        const r = await render(name, sceneSpec(name));
        keep(name, r);
        return r;
    };
    const wantScenes = has('scenes') || has('baseline');
    if (wantScenes) {
        units.push({
            name: 'scenes (anchor, village busy, Town band, rain, storm, resting)',
            async run() {
                const measured = {};
                for (const name of SCENE_TARGET_NAMES) {
                    const r = await scene(name);
                    const m = sceneMetrics(r);
                    if (r.stems.music && name === 'townBand') {
                        m.bandStemStMax = stemReport(r).stems.music.stMax;
                    }
                    measured[name] = m;
                    summary[`scene:${name}`] = { lufsI: m.lufsI, stMax: m.stMax };
                    info('scenes', `${name}: LUFS-I ${fmt(m.lufsI)}, ST max ${fmt(m.stMax)}, LRA ${fmt(m.lra)} LU, TP ${fmt(m.truePeakDbtp)} dBTP${m.grMaxDb != null ? `, limiter GR max ${fmt(m.grMaxDb)} dB` : ''} (${m.limiterKind}, rendered ${fmt(m.renderMs / 1000)} s); errors ${r.errors.length}${r.errors.length ? `: ${r.errors.slice(0, 2).join(' | ')}` : ''}`);
                }
                if (!has('scenes')) return;
                for (const row of judgeSceneTargets(measured)) outcome('scenes', row.outcome, `${row.scene}: ${row.detail}`, row.gatedFrom);
                const busy = await scene('villageBusy');
                const stems = stemReport(busy);
                info('scenes', `HAR-5 stems, village busy (LUFS-I at the output; share of program energy): ${Object.entries(stems.stems).map(([k, v]) => `${k} ${fmt(v.lufsI)} (${signed(v.shareOfProgramDb)} dB)`).join(', ')}`);
                const lm = sceneLevelMap(busy);
                info('scenes', `village busy level map: 2–5 kHz ${fmt(lm.presenceSharePct)} % of K-weighted energy, S/M ${fmt(lm.sideMidDB)} dB, corr ${fmt(lm.corr, 2)}, mono fold ${fmt(lm.monoLossLU)} LU, laptop ${fmt(lm.speakerLossLU)} LU`);
            },
        });
    }
    if (has('margins') || has('baseline')) {
        for (const bedName of Object.keys(MARGIN_BEDS)) {
            units.push({
                name: `margins over ${bedName}`,
                async run() {
                    const r = await scene(`margin:${bedName}`);
                    const rows = marginRows(r, bedName);
                    const medians = {};
                    for (const lane of MARGIN_LANES) {
                        const placements = rows.filter(x => x.lane === lane);
                        const j = judgeLane(lane, MARGIN_BEDS[bedName].bed, placements, { probeBed: bedName });
                        medians[lane] = j.margin;
                        summary[`margin:${bedName}:${lane}`] = { margin: j.margin };
                        if (!has('margins')) continue;
                        const win = `${j.window.min != null ? `≥ ${signed(j.window.min, 0)}` : ''}${j.window.min != null && j.window.max != null ? ', ' : ''}${j.window.max != null ? `≤ ${signed(j.window.max, 0)}` : ''}`;
                        const each = placements.map(p => signed(p.margin)).join(' / ');
                        const trims = placements.map(p => signed(p.trimDb)).join(' / ');
                        const extra = j.gr != null ? `; ${MARGIN_BEDS[bedName].bed === 'music' ? `presence rise ${fmt(j.band)} dB` : `${fmt(j.band, 0)} bands ≥ +6 dB`}, GR ${fmt(j.gr)} dB` : '';
                        const why = j.failures.map(f => (f.gatedFrom > PLAN_STAGE ? `${f.what} (Wave ${f.gatedFrom})` : f.what)).join(', ');
                        outcome('margins', j.outcome, `${lane} over ${bedName}: median ${signed(j.margin)} LU (${each}; cue trims ${trims} dB, ${j.n} admitted), want ${win}${extra}${why ? ` — ${why}` : ''}`, Math.max(...j.failures.map(f => f.gatedFrom), 0));
                    }
                    // S2: a Minor outcome also sits ≥ 3 LU under the routine cue.
                    if (has('margins')) {
                        const under = medians.outcomeMinor != null && medians.routine != null ? medians.routine - medians.outcomeMinor : null;
                        verdict('margins', under != null && under >= 3, `outcome Minor under routine over ${bedName}: ${fmt(under)} LU (turn done ${signed(medians.outcomeMinor)} vs arrival ${signed(medians.routine)}); want ≥ 3`);
                    }
                    if (r.errors.length) info('margins', `${bedName}: page errors: ${r.errors.slice(0, 3).join(' | ')}`);
                },
            });
        }
    }
    if (has('limiter')) {
        for (const noWorklets of [false, true]) {
            units.push({
                name: `limiter unit (${noWorklets ? 'fallback' : 'worklet'})`,
                async run() {
                    const u = await renderLimiterUnit(browser, baseUrl, { seed: SEED, noWorklets });
                    const m = limiterUnitRows(u);
                    const want = noWorklets ? 'fallback' : 'worklet';
                    // The worklet holds LIMITER_CEILING_DBFS (sample peak) and so
                    // −1 dBTP; the fallback is an emergency path held to 1.1's
                    // −0.9 dBFS sample peak only.
                    const ceilingOk = noWorklets
                        ? m.burstOutDbfs <= FALLBACK_MAX_DBFS
                        : m.burstOutDbfs <= LIMITER_CEILING_DBFS + 0.1 && m.burstOutDbtp <= LOUDNESS_TARGETS.ceiling.truePeakDbtp;
                    const wantPeak = noWorklets
                        ? `≤ ${FALLBACK_MAX_DBFS} dBFS`
                        : `≤ ${fmt(LIMITER_CEILING_DBFS + 0.1, 1)} dBFS and ≤ ${LOUDNESS_TARGETS.ceiling.truePeakDbtp} dBTP`;
                    verdict('limiter', m.limiterKind === want && ceilingOk && Math.abs(m.staticGainDb) <= 0.2,
                        `${m.limiterKind} (asked ${want}): burst ${signed(m.burstInDbfs)} dBFS in → ${fmt(m.burstOutDbfs, 2)} dBFS out (TP ${fmt(m.burstOutDbtp, 2)} dBTP), want ${wantPeak}; static gain ${signed(m.staticGainDb, 2)} dB at −20 dBFS, want 0 ± 0.2`);
                },
            });
        }
    }
    if (has('switch')) {
        units.push({
            name: 'preset switch',
            async run() {
                const r = await scene('presetSwitch');
                const rows = switchRows(r);
                if (rows.length < 2) verdict('switch', false, `expected 2 switches, saw ${rows.length}`);
                for (const row of rows) {
                    if (row.holeDb == null) { verdict('switch', false, `${row.label} at ${fmt(row.t)} s: not measurable`); continue; }
                    verdict('switch', row.holeDb <= SWITCH_LIMIT_DB && row.bumpDb <= SWITCH_LIMIT_DB,
                        `${row.label} at ${fmt(row.t)} s: old ${fmt(row.oldLufs)} → new ${fmt(row.newLufs)} LUFS-M; hole ${fmt(row.holeDb)} dB, bump ${fmt(row.bumpDb)} dB (switch window M ${fmt(row.minDuring)}…${fmt(row.maxDuring)}); want ≤ ${SWITCH_LIMIT_DB} dB each`);
                }
            },
        });
    }
    if (has('ducks')) {
        units.push({
            name: 'ducked time',
            async run() {
                for (const name of ['villageBusy', 'townBand']) {
                    const r = await scene(name);
                    const d = duckRows(r);
                    const j = judgeDuckedTime(d.fractions);
                    const pct = Object.entries(d.fractions).map(([k, v]) => `${k} ${fmt(100 * v)} %`).join(', ');
                    verdict('ducks', j.pass && d.windows > 0, `${name} (${r.meta.seconds} s, ${d.windows} duck windows, ${d.cancelled} cancelled): ${pct}; want ≥ 1 window and ≤ ${fmt(100 * j.budget, 0)} % per bus`);
                }
            },
        });
    }
    if (has('avsync')) {
        units.push({
            name: 'AV sync',
            async run() {
                const r = await scene('avSync');
                const a = avSyncRows(r);
                const line = (s) => `${s.n} notes, ${s.missed} unheard, median |err| ${fmt(s.medianAbsMs)} ms, p95 ${fmt(s.p95AbsMs)} ms (signed median ${signed(s.medianMs)} ms)`;
                verdict('avsync', a.notes.n > 0 && a.notes.missed === 0 && a.notes.medianAbsMs <= AV_SYNC.medianAbsMs && a.notes.p95AbsMs <= AV_SYNC.p95AbsMs,
                    `published vs heard: ${line(a.notes)}; want median ≤ ${AV_SYNC.medianAbsMs}, p95 ≤ ${AV_SYNC.p95AbsMs}`);
                verdict('avsync', a.accents.n > 0 && a.accents.missed === 0 && a.accents.medianAbsMs <= AV_SYNC.medianAbsMs && a.accents.p95AbsMs <= AV_SYNC.p95AbsMs,
                    `accent vs heard carrying note: ${line(a.accents)}; carrying note − accent ${a.accentVsPublishedMs.join(', ')} ms`);
                info('avsync', `cue score: ${r.meta.cueScore.published} published, ${r.meta.cueScore.anchored} anchored, ${r.meta.cueScore.snapped} snapped, ${r.meta.cueScore.dropped} dropped`);
            },
        });
    }
    if (has('determinism')) {
        units.push({
            name: 'determinism',
            async run() {
                for (const name of ['anchor', 'villageBusy']) {
                    const a = await scene(name);
                    const b = await render(`${name}#2`, sceneSpec(name));
                    const ma = sceneMetrics(a);
                    const mb = sceneMetrics(b);
                    let maxDiff = 0;
                    const n = Math.min(a.program.L.length, b.program.L.length);
                    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(a.program.L[i] - b.program.L[i]), Math.abs(a.program.R[i] - b.program.R[i]));
                    const d = Math.abs(ma.lufsI - mb.lufsI);
                    verdict('determinism', d <= DETERMINISM_LU, `${name}: LUFS-I ${fmt(ma.lufsI, 2)} vs ${fmt(mb.lufsI, 2)} (Δ ${fmt(d, 3)} LU), max sample Δ ${maxDiff.toExponential(2)}; want Δ ≤ ${DETERMINISM_LU} LU`);
                }
            },
        });
    }
    units.push(...wave2Units(render, browser, baseUrl, scene));
    units.push(...wave3Units(render, browser, baseUrl));
    return units;
}

// ------------------------------------------------------------ Wave 2 units ----
const siteLine = rows => rows.map(t => `${t.site} ×${t.starts}${t.first?.length && !/Transport\.js/.test(t.site) ? ` [first ${t.first.map(f => `${f.k}@${f.t}s`).join(', ')}]` : ''}${t.callers?.length ? ` (via ${t.callers.slice(0, 2).join(', ')})` : ''}`).join('; ') || 'none';

function wave2Units(render, browser, baseUrl, scene) {
    const units = [];
    if (has('transport')) {
        units.push({
            name: 'transport (10 min village, both presets)',
            async run() {
                const r = await render('transport', TRANSPORT_SCENE);
                const t = transportRows(r);
                const j = judgeTransport(t.diag, t.timers);
                const procs = j.processes.map(p => `${p.name} ${fmt(p.maxAheadSec, 2)}/${p.limit} s${p.dropped ? ` (${p.dropped} dropped)` : ''}`).join(', ') || 'none registered';
                verdict('transport', j.pass, `underruns ${t.diag?.underruns ?? '—'}, late dropped ${t.diag?.lateDropped ?? '—'}; committed ahead per process: ${procs}; Transport tick ${j.tick ? `${j.tick.fired} ticks, p95 ${fmt(j.tick.p95Ms, 3)} ms, max ${fmt(j.tick.maxMs, 2)} ms (real main-thread time)` : 'never seen'}; app timers that started continuous sources: ${siteLine(j.soundSites)}${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}; want 0 underruns, ≤ 1.5 s ahead (work ≤ 0.35 s), exactly one timer (Transport.js), tick p95 ≤ 0.5 ms and max ≤ 2 ms`);
                const other = t.timers.filter(x => (x.site === 'harness' || x.site === 'untimed') && x.starts > 0);
                const cues = t.timers.filter(x => x.cueStarts > 0).map(x => `${x.site} ×${x.cueStarts}`).join('; ') || 'none';
                info('transport', `${t.startCount} source starts; discrete cue voices (exempt) by timer site: ${cues}; continuous sources outside app timers (harness actions, the 2 Hz atmosphere pump, the enable): ${siteLine(other)}; transport lateness p95 ${fmt(t.diag?.tickLatenessP95, 1)} ms on the virtual clock (steps of 10.7 ms), max stall ${fmt(t.diag?.maxStallMs, 1)} ms; page errors ${t.errors.length}${t.errors.length ? `: ${t.errors.slice(0, 2).join(' | ')}` : ''}`);
                const slow = t.timers.filter(x => x.maxMs > 2 && !/Transport\.js/.test(x.site)).map(x => `${x.site} max ${fmt(x.maxMs, 1)} ms`);
                if (slow.length) info('transport', `other timers over 2 ms: ${slow.join(', ')}`);
            },
        });
    }
    if (has('pause')) {
        for (const mode of ['ambient', 'bgm']) {
            units.push({
                name: `pause in place (${mode}, 120 s hidden)`,
                async run() {
                    const r = await render(`hidden:${mode}`, hiddenScene(mode));
                    const p = pauseRows(r);
                    const samePiece = mode !== 'bgm' || (p.pieceBefore != null && p.pieceBefore === p.pieceAfter);
                    verdict('pause', p.suspendedAt != null && p.resumedAt != null && p.pass && samePiece,
                        `${mode}: hidden at ${fmt(p.hideT)} s (audio) → context suspended at ${fmt(p.suspendedAt, 2)} s, shown ${p.hiddenSec} s later → running again at audio ${fmt(p.resumedAt, 2)} s (clock frozen while suspended); ${p.suspended} source(s) started while suspended, ${p.smeared} smeared; onsets in the first second ${p.firstWindow} vs steady ${fmt(p.steadyPerSec, 2)}/s; piece ${p.pieceBefore ?? '—'} → ${p.pieceAfter ?? '—'}; want 0 while suspended, first second ≤ steady + 1${mode === 'bgm' ? ', the same piece' : ''}`);
                },
            });
        }
    }
    if (has('air') || has('bank')) {
        units.push({
            name: 'Island Air unit (IRs, D/R)',
            async run() {
                const u = await renderAir(browser, baseUrl, { seed: SEED });
                const a = airRows(u);
                wave2.air = a;
                if (!has('air')) return;
                for (const phase of ['day', 'night']) {
                    const t = a.t60[phase];
                    const j = judgeAirT60(phase, t || {});
                    verdict('air', Boolean(t) && j.pass, `${phase} IR: T60 1 kHz ${fmt(t?.t60_1000, 2)} s, 4 kHz ${fmt(t?.t60_4000, 2)} s (ratio ${fmt(j.ratio, 2)}); want ${j.want.min}–${j.want.max} s and ratio ≤ ${ISLAND_AIR.hfRatioMax}`);
                }
                const place = x => (x.placed ? `pan ${fmt(x.placed.pan, 2)}, gain ${fmt(x.placed.gain, 2)}, LP ${fmt(x.placed.lowpassHz, 0)} Hz, air ${fmt(x.placed.air, 3)}` : 'unplaced');
                info('air', `raw place() sends on the world bus (8 ms burst through connectVoice): ${a.dr.map(x => `d = ${x.d} D/R ${signed(x.drDb)} dB (${place(x)})`).join('; ')} — the gate is the cue path below`);
                if (a.errors.length) info('air', `unit page errors: ${a.errors.slice(0, 3).join(' | ')}`);
            },
        });
    }
    if (has('air')) {
        units.push({
            name: 'Island Air in the mix (urgent wet, program)',
            async run() {
                const r = await render('airCue', AIR_CUE_SCENE);
                for (const row of arrivalDrRows(r)) {
                    const ok = row.drDb != null && (row.d === 0 ? row.drDb >= ISLAND_AIR.drNearMinDb : row.drDb <= ISLAND_AIR.drFarMaxDb);
                    verdict('air', ok, `arrival at d = ${row.d} through CueKit: D/R ${row.drDb == null ? 'no arrival scheduled' : `${signed(row.drDb)} dB`} (cue sum vs air return over 4.4 s); want ${row.d === 0 ? `≥ +${ISLAND_AIR.drNearMinDb}` : `≤ +${ISLAND_AIR.drFarMaxDb}`}`);
                }
                const wet = urgentWetRows(r);
                const worst = wet.length && wet.every(w => Number.isFinite(w.wetDb)) ? Math.max(...wet.map(w => w.wetDb)) : null;
                verdict('air', worst != null && worst <= ISLAND_AIR.urgentWetMaxDb, `needs-you wet re dry: ${wet.map(w => signed(w.wetDb)).join(' / ') || 'no cue'} dB (— = a silent dry or wet tap); want ≤ ${ISLAND_AIR.urgentWetMaxDb} each`);
                const withAir = sceneMetrics(await scene('villageBusy'));
                const dry = await render('villageBusy:dry', VILLAGE_DRY_SCENE);
                const without = sceneMetrics(dry);
                const d = withAir.lufsI - without.lufsI;
                verdict('air', dry.meta.airOff === true && d <= ISLAND_AIR.programMaxLu, `village busy with air ${fmt(withAir.lufsI, 2)} vs without ${fmt(without.lufsI, 2)} LUFS-I: air adds ${signed(d, 2)} LU${dry.meta.airOff ? '' : ' (air sends not found)'}; want ≤ +${ISLAND_AIR.programMaxLu}`);
            },
        });
    }
    if (has('noise') || has('bank')) {
        units.push({
            name: 'noise textures, bed and lanes',
            async run() {
                const renders = {};
                for (const [name, t] of Object.entries(TEXTURE_SCENES)) renders[`texture:${name}`] = await render(`texture:${name}`, t.spec);
                for (const name of ['anchor', 'rain', 'storm', 'villageBusy']) renders[name] = await scene(name);
                wave2.noiseBank = renders.rain.meta.diagnostics?.bank ?? null;
                wave2.busyBank = renders.villageBusy.meta.diagnostics?.bank ?? null;
                wave2.bakeTimers = Object.values(renders).flatMap(r => r.meta.timers);
                if (!has('noise')) return;
                for (const [name, t] of Object.entries(TEXTURE_SCENES)) {
                    const r = renders[`texture:${name}`];
                    const x = textureRows(r, t.stem);
                    if (!Number.isFinite(x.lufsI) || x.lufsI < -110) { info('noise', `${name}: silent on the ${t.stem} stem (layer absent or at 0), not judged`); continue; }
                    verdict('noise', x.peak.r < NOISE_LIMITS.autocorrMax, `${name} texture: autocorrelation peak ${fmt(x.peak.r, 3)} at ${fmt(x.peak.lagS, 2)} s over 0.5–20 s lags (stem ${fmt(x.lufsI)} LUFS-I, ICC ${fmt(x.icc, 2)}); want < ${NOISE_LIMITS.autocorrMax}`);
                }
                for (const name of ['anchor', 'rain']) {
                    const b = bedRows(renders[name]);
                    verdict('noise', b.worldIcc >= NOISE_LIMITS.icc.min && b.worldIcc <= NOISE_LIMITS.icc.max, `${name} world bed ICC ${fmt(b.worldIcc, 3)} on 60 s; want ${NOISE_LIMITS.icc.min}–${NOISE_LIMITS.icc.max}`);
                }
                for (const name of ['anchor', 'rain', 'villageBusy']) {
                    const b = bedRows(renders[name]);
                    verdict('noise', b.monoLossLU <= NOISE_LIMITS.monoLossMaxLu, `${name} program mono fold loss ${fmt(b.monoLossLU, 2)} LU; want ≤ ${NOISE_LIMITS.monoLossMaxLu}`);
                }
                let lanes = 0;
                let pairs = 0;
                const conflicts = [];
                for (const [name, r] of Object.entries(renders)) {
                    if (!r.meta.starts) continue;
                    const c = noiseLaneConflicts(r.meta.starts, { minSepSec: NOISE_LIMITS.laneSepSec, end: r.meta.warmup + r.meta.seconds });
                    lanes += c.lanes;
                    pairs += c.pairs;
                    conflicts.push(...c.conflicts.map(x => `${name}: buffer ${x.buf} lanes from ${fmt(x.a, 1)} s and ${fmt(x.b, 1)} s ${fmt(x.closestSec, 2)} s apart at ${fmt(x.at, 1)} s`));
                }
                verdict('noise', lanes > 0 && conflicts.length === 0, `${lanes} pool lanes, ${pairs} concurrent pairs on one buffer across ${Object.keys(renders).filter(k => renders[k].meta.starts).length} scenes; ${conflicts.length} read within ${NOISE_LIMITS.laneSepSec} s${conflicts.length ? `: ${conflicts.slice(0, 3).join('; ')}` : ''}; want 0 (and ≥ 1 lane read)`);
                const pool = wave2.noiseBank?.byClient?.noise;
                verdict('noise', Number.isFinite(pool) && pool <= MEMORY_BUDGET.noise, `noise pool resident ${Number.isFinite(pool) ? `${fmt(pool / 1048576, 2)} MiB` : 'unreported'}; want ≤ ${fmt(MEMORY_BUDGET.noise / 1048576, 1)} MiB`);
            },
        });
    }
    if (has('sequencer')) {
        units.push({
            name: 'sequencer equivalence (every piece vs Wave 1)',
            async run() {
                if (UPDATE && (args['ref-rev'] || !fs.existsSync(SEQUENCER_FILE))) await renderSequencerReference(browser, String(args['ref-rev'] || SEQUENCER_REFERENCE_REV));
                if (!fs.existsSync(SEQUENCER_FILE)) { verdict('sequencer', false, `no ${path.relative(process.cwd(), SEQUENCER_FILE)}; run --only sequencer --update`); return; }
                const ref = JSON.parse(fs.readFileSync(SEQUENCER_FILE, 'utf8'));
                for (const p of await loadPieces()) {
                    const want = ref.pieces[p.key];
                    if (!want) { verdict('sequencer', false, `${p.key}: no Wave-1 reference`); continue; }
                    const cur = sequencerRow(await render(`sequencer:${p.key}`, p.spec), p);
                    const j = judgeSequencer(want, cur);
                    const mm = j.onsets.firstMismatch;
                    verdict('sequencer', j.pass, `${p.key} (pinned by ${cur.pinned ?? '—'}): ${j.onsets.curCount} onsets vs ${j.onsets.refCount}, max Δ ${fmt(j.onsets.maxDeltaMs, 3)} ms${mm ? `, first mismatch #${mm.index} (${mm.ref ?? '—'} vs ${mm.cur ?? '—'} s)` : ''}; LUFS-I ${fmt(cur.lufsI, 2)} vs ${fmt(want.lufsI, 2)} (${signed(j.lufsDelta, 2)} LU); want identical onsets and ≤ 0.5 LU${cur.errors.length ? `; page errors: ${cur.errors.slice(0, 2).join(' | ')}` : ''}`);
                }
            },
        });
    }
    return units;
}

// ------------------------------------------------------------ Wave 3 units ----
const URGENT_LABELS = ['needs you', 'error', 'rate limit'];
const lufs = v => (Number.isFinite(v) ? fmt(v) : '—');

function wave3Units(render, browser, baseUrl) {
    const units = [];
    const renderOff = (key, spec) => (wave3.silent[key] ||= renderSilent(browser, baseUrl, spec, { seed: SEED }));
    if (has('discrim')) {
        units.push({
            name: 'discrim (every cue voice, governor-free)',
            async run() {
                const r = await render('gallery', galleryScene());
                const rows = galleryRows(r);
                const ok = rows.filter(x => !x.missing);
                const missing = rows.filter(x => x.missing).map(x => x.label);
                const pitched = ok.filter(x => x.pitchSource === 'published').length;
                verdict('discrim', missing.length === 0, `${ok.length}/${rows.length} gallery voices sounded${missing.length ? ` (silent: ${missing.join(', ')})` : ''}; pitches from the published scores for ${pitched}, measured at onsets for ${ok.length - pitched}; want every voice`);
                for (const x of ok) {
                    const f = x.features;
                    info('discrim', `${x.label} [${x.stratum}]: ${x.notes.map(n => `${n.ms}:${n.name ?? '·'}`).join(' ')}; brightness ${fmt(f.bright, 2)}, strike ${fmt(f.strike)} dB, ring ${fmt(f.ring, 2)} s, M-max ${lufs(x.momentaryMaxLufs)} LUFS at the output`);
                }
                const stratum = Object.fromEntries(ok.map(x => [x.label, x.stratum]));
                const family = Object.fromEntries(ok.map(x => [x.label, x.family ?? x.label]));
                const signals = ok.filter(x => x.stratum === 'signal').map(x => x.features);
                const others = ok.filter(x => x.stratum !== 'signal').map(x => x.features);
                const signalsOnly = new Set(ok.filter(x => x.signalsOnly).map(x => x.label));
                const matrix = discriminationMatrix(signals, others)
                    .filter(m => family[m.signal] !== family[m.other])
                    .filter(m => !signalsOnly.has(m.signal) || stratum[m.other] === 'signal');
                const j = judgeDiscrimination(matrix, { stratum, urgent: URGENT_LABELS, needsYou: 'needs you' });
                verdict('discrim', j.rows > 0 && j.below === 0, `signal vs every other cue voice: ${j.rows} pairs, ${j.three} × 3/3, ${j.two} × 2/3, ${j.below} below 2/3${j.failures.length ? `: ${j.failures.slice(0, 8).join('; ')}` : ''}; want every pair ≥ 2/3 (S1)`);
                const urgent = matrix.filter(m => URGENT_LABELS.includes(m.signal) && URGENT_LABELS.includes(m.other));
                verdict('discrim', urgent.length === 6 && urgent.every(m => m.n >= 2), `needs-you / error / limit pairwise: ${urgent.map(m => `${m.signal} vs ${m.other} ${m.n}/3 (${m.dims.join('+') || 'none'})`).join('; ') || 'not rendered'}; want each ≥ 2/3 (3.2)`);
                const outcomes = matrix.filter(m => m.signal === 'needs you' && stratum[m.other] === 'outcome');
                verdict('discrim', outcomes.length > 0 && j.outcomeShort.length === 0, `every outcome vs needs-you: ${outcomes.length} outcomes, ${j.outcomeFull} × 3/3${j.outcomeNot3.length ? ` (under 3/3: ${j.outcomeNot3.join('; ')})` : ''}${j.outcomeShort.length ? `; below 2/3: ${j.outcomeShort.join('; ')}` : ''}; want ≥ 2/3 (3.4's 3/3 is unreachable for a single strike against the ship's bell's flat opening; checks.mjs DISCRIM_LIMITS)`);
                const quick = ok.filter(x => x.quickPair).map(x => `${x.label} (${x.notes.slice(0, 2).map(n => `${n.ms}:${n.name}`).join(' ')})`);
                verdict('discrim', quick.length === 0, `non-signal cues opening with a quick same-pitch pair (< 1 s on one pitch; the ship's bell's figure): ${quick.length ? quick.join(', ') : 'none'}; want none (S1)`);
                // S1: signal pitches and rhythm are fixed, the same by day and night.
                const signalVoices = GALLERY_VOICES.filter(v => v.stratum === 'signal');
                const night = galleryRows(await render('gallery:night', galleryScene(signalVoices, { night: true })), signalVoices);
                const moved = night.map((n) => {
                    const d = ok.find(x => x.label === n.label);
                    if (!d || n.missing) return `${n.label}: not sounded`;
                    const same = d.notes.length === n.notes.length && d.notes.every((x, i) => x.ms === n.notes[i].ms && x.name === n.notes[i].name);
                    return same ? null : `${n.label}: ${d.notes.map(x => `${x.ms}:${x.name}`).join(' ')} → ${n.notes.map(x => `${x.ms}:${x.name}`).join(' ')}`;
                }).filter(Boolean);
                verdict('discrim', moved.length === 0, `signal voices by night vs day (${night.length}): ${moved.length ? moved.join('; ') : 'identical notes and times'}; want the same (S1: fixed pitches, never phase-dependent)`);
                const quoting = matrix.filter(m => m.sameOpening).map(m => `${m.signal} ~ ${m.other}`);
                info('discrim', `same opening interval on the same pitch class (quotes the call): ${quoting.join(', ') || 'none'}`);
                if (r.errors.length) info('discrim', `page errors: ${r.errors.slice(0, 3).join(' | ')}`);
            },
        });
    }
    if (has('ladder')) {
        for (const family of ['needsYou', 'errors', 'quota']) {
            units.push({
                name: `ladder (${family}, sound off, 61 min)`,
                async run() {
                    const r = await renderOff(`ladder:${family}`, ladderSilentScene(family));
                    const calls = ladderCalls(r.meta);
                    const expected = expectedLadder(family, LADDER_SECONDS - LADDER_OPEN_SEC).map(e => ({ ...e, atSec: e.atSec + LADDER_OPEN_SEC }));
                    const j = judgeLadder(calls, expected);
                    const captioned = ladderCaptioned(r.meta, calls);
                    const line = xs => xs.map(c => `L${c.level}@${fmt(c.atSec / 60, 2)}m`).join(' ') || 'none';
                    verdict('ladder', j.pass && calls.length > 0 && captioned === calls.length && !r.meta.contextCreated,
                        `${family}, sound off: calls ${line(calls)}; expected ${line(expected)}${j.missing.length ? `; missing ${line(j.missing)}` : ''}${j.extra.length ? `; unexpected ${line(j.extra)}` : ''}; reminders ≥ ${fmt(j.minGapSec, 0)} s apart, ${j.perHour} in the busiest hour (≤ ${LADDER.perHour}); ${captioned}/${calls.length} captioned by Toast (auto); AudioContext ${r.meta.contextCreated ? 'created' : 'never created'}; want the D6 schedule, S7 caps, every call captioned`);
                    if (r.errors.length) info('ladder', `${family}: page errors: ${r.errors.slice(0, 3).join(' | ')}`);
                },
            });
        }
        units.push({
            name: 'ladder (acknowledged, sound off)',
            async run() {
                const ackAt = LADDER_OPEN_SEC + 200;
                const r = await renderOff('ladder:ack', ladderSilentScene('needsYou', { ackAt, seconds: ackAt + 620 }));
                const calls = ladderCalls(r.meta);
                const quiet = calls.filter(c => c.atSec > ackAt && c.atSec < ackAt + 600);
                const before = calls.filter(c => c.atSec <= ackAt);
                verdict('ladder', before.length === 2 && quiet.length === 0, `acknowledged at ${fmt(ackAt / 60, 2)} min: ${before.length} calls before (want L1 + L2), ${quiet.length} in the 10 min after${quiet.length ? ` (${quiet.map(c => `L${c.level}@${fmt(c.atSec / 60, 2)}m`).join(' ')})` : ''}; want 0 (SIG-2 acknowledgement)`);
            },
        });
        units.push({
            name: 'ladder (sound on, held trim)',
            async run() {
                const r = await render('ladder:trim', LADDER_TRIM_SCENE);
                const calls = ladderTrimRows(r);
                const j = judgeHeldTrim(calls);
                verdict('ladder', j.pass, `Village, sound on: ${calls.map(c => `L${c.level} ${signed(c.margin)} LU (trim ${signed(c.trimDb)} dB, GR ${fmt(c.grDb)} dB)`).join(', ') || 'no calls'}; L2 ${fmt(j.l2UnderL1Lu)} LU under L1, trims spread ${fmt(j.trimSpreadDb, 2)} dB${j.failures.length ? ` — ${j.failures.join(', ')}` : ''}; want L2 ≥ 4 LU under L1, one trim held, L3 GR ≤ ${LOUDNESS_TARGETS.ceiling.urgentGrMaxDb} dB`);
            },
        });
        units.push({
            name: 'ladder (hidden tab, sound on, wakes)',
            async run() {
                const r = await render('ladder:hidden', WAKE_SCENE);
                const w = wakeRows(r);
                const due = [120, 360, 900].map(x => r.meta.warmup + LADDER_OPEN_SEC + x);
                const j = judgeWakes(due, w.rows.filter(x => x.heard).map(x => x.wall));
                verdict('ladder', j.pass, `hidden from ${WAKE_SCENE.actions.find(a => a.visibility === 'hidden').at} s: ${j.rows.map(x => `due ${fmt((x.due - r.meta.warmup) / 60, 2)}m → ${x.heard != null ? `heard +${fmt(x.lagSec, 1)} s` : 'not heard'}`).join(', ')}; reminders scheduled ${w.rows.length} (cue-stem peaks ${w.rows.map(x => fmt(x.peakDb)).join(' / ') || '—'} dBFS), context resumed ${w.wakes}× / suspended ${w.suspensions}×; want each within 60 s of its time`);
                if (r.errors.length) info('ladder', `hidden: page errors: ${r.errors.slice(0, 3).join(' | ')}`);
            },
        });
    }
    if (has('cluster') || has('honesty')) {
        for (const family of ['needsYou', 'errors']) {
            units.push({
                name: `cluster (${family}: one raise vs six same-tick)`,
                async run() {
                    const one = clusterRow(await render(`cluster:${family}:1`, clusterScene(1, family)), family);
                    const six = clusterRow(await render(`cluster:${family}:6`, clusterScene(6, family)), family);
                    wave3.cluster[family] = six;
                    if (!has('cluster')) return;
                    const j = judgeCluster({ oneMaxLufs: one.mMaxLufs, manyMaxLufs: six.mMaxLufs, agents: six.agents, captionedAgents: six.captioned });
                    verdict('cluster', j.pass && six.grDb <= LOUDNESS_TARGETS.ceiling.urgentGrMaxDb,
                        `${family}, six same-tick raises: M-max ${lufs(six.mMaxLufs)} vs one call ${lufs(one.mMaxLufs)} LUFS (${signed(j.overLu)} LU); ${six.sounding} sounding score(s) (the lead and ${six.flock} flock strike(s)); captions ${six.captioned.length}/${six.agents.length} agents${j.missing.length ? ` (missing ${j.missing.join(', ')})` : ''}; GR ${fmt(six.grDb)} dB (one call ${fmt(one.grDb)} dB); want ≤ +1 LU over one call, every agent captioned, GR ≤ ${LOUDNESS_TARGETS.ceiling.urgentGrMaxDb} dB`);
                },
            });
        }
    }
    if (has('heldnote')) {
        for (const working of [1, 15]) {
            units.push({
                name: `heldnote (W = ${working})`,
                async run() {
                    const r = await render(`held:${working}`, heldNoteScene({ working }));
                    const h = heldNoteRows(r, { openSec: HELD_OPEN_SEC, answerSec: HELD_ANSWER_SEC });
                    const rise = heldNoteRise(h.programBand, h.open, h.answer);
                    const beat = beatingDepthDb(h.heldBandDb);
                    const levelOk = h.underBedLu != null && Math.abs(h.underBedLu - HELD_NOTE.underBedLu) <= HELD_NOTE.levelTolLu;
                    verdict('heldnote', rise.pass, `W = ${working}: 270–310 Hz on the program ${fmt(rise.preDb)} dB before the wait; +${HELD_NOTE.riseDb} dB reached ${rise.riseAtSec != null ? `${fmt(rise.riseAtSec, 1)} s` : 'never'} after it opened (held ${signed(rise.heldRiseDb)} dB), back within ${HELD_NOTE.backTolDb} dB ${rise.backAtSec != null ? `${fmt(rise.backAtSec, 1)} s` : 'never'} after the answer; want ≤ ${HELD_NOTE.riseWithinSec} s and ≤ ${HELD_NOTE.backWithinSec} s (states ${[...new Set(h.snapshots)].join('→') || '—'})`);
                    verdict('heldnote', beat != null && beat <= HELD_NOTE.beatingMaxDb, `W = ${working}: beating depth of the held D (270–310 Hz on the held stem, 0.1 s hop) ${fmt(beat, 2)} dB over the steady wait; want ≤ ${HELD_NOTE.beatingMaxDb}`);
                    verdict('heldnote', levelOk, `W = ${working}: held note ${lufs(h.heldLufs)} vs bed ${lufs(h.bedLufs)} LUFS-S (stems, same staging): ${signed(h.underBedLu)} LU; want ${HELD_NOTE.underBedLu} ± ${HELD_NOTE.levelTolLu}`);
                    if (r.errors.length) info('heldnote', `W = ${working}: page errors: ${r.errors.slice(0, 3).join(' | ')}`);
                },
            });
        }
        units.push({
            name: 'heldnote absent (music, Town band, signals only)',
            async run() {
                const open = r => r.meta.warmup + HELD_OPEN_SEC;
                const music = await render('held:music', heldNoteScene({ working: 4, music: { piece: 'hearthfire', level: 0.6 }, answerAt: null, seconds: 50 }));
                const m = heldWhileMusic(music, open(music));
                verdict('heldnote', m != null && m.seconds > 0 && m.stMaxOut <= HELD_NOTE.absentMaxLufs, `Village under music: held stem ST max ${lufs(m?.stMaxOut)} LUFS at the output over ${m?.seconds ?? 0} s of music after the wait opened; want music playing and ≤ ${HELD_NOTE.absentMaxLufs}`);
                for (const [key, spec, label] of [['held:bgm', heldNoteScene({ working: 4, mode: 'bgm', answerAt: null, seconds: 40 }), 'Town band'], ['held:signals', heldNoteScene({ working: 4, signals: true, answerAt: null, seconds: 40 }), 'signals only (blurred)']]) {
                    const r = await render(key, spec);
                    const h = heldNoteRows(r, { openSec: HELD_OPEN_SEC, answerSec: null });
                    verdict('heldnote', h.heldStMaxOut != null && h.heldStMaxOut <= HELD_NOTE.absentMaxLufs, `${label}: held stem ST max ${lufs(h.heldStMaxOut)} LUFS at the output while the wait is open; want ≤ ${HELD_NOTE.absentMaxLufs} (absent)`);
                }
            },
        });
    }
    if (has('outcomes') || has('avsync')) {
        units.push({
            name: 'outcomes (World fixture, Dashboard fixture)',
            async run() {
                const r = await render('outcomes', OUTCOME_SCENE);
                wave3.crown = crownRow(r, onsetNear);
                if (has('avsync')) {
                    const c = wave3.crown;
                    verdict('avsync', c != null && c.publishedMs != null && Math.abs(c.publishedMs) <= CROWN_SYNC_MS, `release crown (HAR-12): peal note ${c?.index ?? '—'} published ${c?.publishedMs != null ? `${signed(c.publishedMs, 1)} ms` : '—'} from the crown's accent, heard ${c?.heardMs != null ? `${signed(c.heardMs, 1)} ms` : '—'}; want the published note within ±${CROWN_SYNC_MS} ms`);
                }
                if (!has('outcomes')) return;
                const w = r.meta.warmup;
                const push = laneEvents(r, 'push');
                const pushNotes = push.scores.filter(s => !s.silent).flatMap(s => s.notes).length;
                const pushCaption = (r.meta.captions || []).some(c => c.cueKind === 'push' && push.cues.some(p => Math.abs(p.t - c.wall) < 1));
                verdict('outcomes', push.cues.length === 1 && pushNotes > 0 && pushCaption, `outcome:verified {push} → ${push.cues.length} push cue(s) "${push.cues[0]?.label ?? ''}", ${pushNotes} published note(s), Toast caption ${pushCaption ? 'shown' : 'missing'} (auto, sound on); want one cue with notes and its caption`);
                const quiet = r.meta.cues.filter(c => c.t >= w + 12 && c.t < w + 25);
                verdict('outcomes', quiet.length === 0, `10 × exit 0: ${quiet.length} cue(s) in the 13 s after (${quiet.map(c => c.kind).join(', ') || 'none'}); want silence`);
                const failed = laneEvents(r, 'toolFailed');
                verdict('outcomes', failed.cues.length >= 1 && failed.cues.length <= 2, `10 non-zero exits from one agent in 60 s → ${failed.cues.length} toolFailed cue(s) (${failed.cues.map(c => `"${c.label}"`).join(', ')}); want 1–2`);
                for (const lane of ['turnDone', 'dispatch', 'subagentReturn', 'release']) {
                    const e = laneEvents(r, lane, { withinSec: 5 });
                    verdict('outcomes', e.cues.length === 1 && e.scores.some(s => !s.silent), `World: ${lane} → ${e.cues.length} cue(s)${e.cues[0] ? ` "${e.cues[0].label}"` : ''}, ${e.scores.filter(s => !s.silent).length} sounding score(s); want one`);
                }
                const d = await render('outcomes:dashboard', DASHBOARD_SCENE);
                for (const lane of ['turnDone', 'subagentReturn']) {
                    const e = laneEvents(d, lane, { withinSec: 5 });
                    verdict('outcomes', e.cues.length === 1 && e.scores.some(s => !s.silent), `Dashboard (agent:* transitions only): ${lane} → ${e.cues.length} cue(s)${e.cues[0] ? ` "${e.cues[0].label}"` : ''}; want one`);
                }
                const errs = [...r.errors, ...d.errors];
                if (errs.length) info('outcomes', `page errors: ${errs.slice(0, 3).join(' | ')}`);
            },
        });
    }
    if (has('captions')) {
        for (const mode of ['ambient', 'bgm']) {
            for (const soundOn of [true, false]) {
                units.push({
                    name: `captions (${mode}, sound ${soundOn ? 'on' : 'off'})`,
                    async run() {
                        const spec = captionScene(mode, { soundOn });
                        const meta = soundOn ? (await render(`captions:${mode}`, spec)).meta : (await renderOff(`captions:${mode}`, spec)).meta;
                        const rows = captionRows(meta, { settings: CAPTION_SETTINGS, soundOn });
                        const j = judgeCaptionParity(rows);
                        const kinds = [...new Set(rows.map(x => x.kind))];
                        const unplayed = kinds.filter(k => !rows.some(x => x.kind === k && x.played));
                        const shownBy = CAPTION_SETTINGS.map(s => `${s} ${rows.filter(x => x.setting === s && x.shown).length}`).join(', ');
                        verdict('captions', j.pass, `${mode}, sound ${soundOn ? 'on' : 'off'}: ${kinds.length - unplayed.length}/${kinds.length} kinds played${unplayed.length ? ` (not played: ${unplayed.join(', ')})` : ''}; captions shown per setting: ${shownBy}; ${j.failures.length} parity failure(s)${j.failures.length ? `: ${j.failures.slice(0, 6).join('; ')}` : ''}; want captions exactly per S6/3.8 (HAR-13)`);
                        if (!soundOn && mode === 'ambient') {
                            const leaked = rows.filter(x => x.setting === 'auto' && x.shown && CUE_STRATUM[x.kind] !== 'signal').map(x => x.kind);
                            verdict('captions', leaked.length === 0, `sound off, default setting: outcome or scenery captions shown: ${leaked.join(', ') || 'none'}; want none (3.8)`);
                        }
                    },
                });
            }
        }
    }
    if (has('honesty')) {
        units.push({
            name: 'honesty (must-never 3 and 13)',
            async run() {
                const r = await render('honesty:long-wait', LONG_WAIT_SCENE);
                const h = heldNoteRows(r, { openSec: HELD_OPEN_SEC, answerSec: LONG_WAIT_SECONDS - 12 });
                const a = waitAudibleWindows(h.programBand, h.open, h.answer);
                verdict('honesty', a.pass, `must-never 3: a ${fmt((h.answer - h.open) / 60, 1)}-min wait in Village with no music — the held note's band over the level before the wait in every 10 s window: worst ${signed(a.worstRiseDb)} dB over ${a.rows.length} windows; want ≥ +${HELD_NOTE.riseDb} throughout`);
                const clusters = Object.values(wave3.cluster);
                const locked = clusters.flatMap(c => c.phaseLocked);
                verdict('honesty', clusters.length === 2 && locked.length === 0, `must-never 13 (SIG-10): phase-locked urgent bells among six same-tick needs-you and six errors: ${clusters.length < 2 ? 'not measured' : locked.length ? locked.map(p => `${p.kind} ${p.a}/${p.b} ×${p.hits}`).join(', ') : 'none'}; want none`);
                const s = await render('honesty:stale', STALE_SCENE);
                const sounding = s.meta.scheduled.filter(x => !x.silent && ['summons', 'distress', 'reminder'].includes(x.kind));
                const hs = heldNoteRows(s, { openSec: 5, answerSec: null });
                const captions = s.meta.cues.filter(c => ['summons', 'distress', 'reminder'].includes(c.kind)).length;
                verdict('honesty', sounding.length === 0 && hs.heldStMaxOut <= HELD_NOTE.absentMaxLufs, `must-never 13 (SIG-9): stale agents raising a needs-you and an error → ${sounding.length} sounding signal score(s), held stem ST max ${lufs(hs.heldStMaxOut)} LUFS at the output (${captions} caption(s)); want no sound`);
            },
        });
    }
    return units;
}

// Wave-3 numbers shared between units (the cluster render feeds must-never 13).
const wave3 = { silent: {}, cluster: {} };

// Wave-2 numbers shared between units (bank reads the air and noise renders).
const wave2 = {};

function judgeBankRows() {
    const sliceSites = (wave2.bakeTimers || []).concat(wave2.air?.timers || []).filter(t => /SampleBank\.js/.test(t.site));
    const sliceMax = sliceSites.length ? Math.max(...sliceSites.map(t => t.maxMs ?? 0)) : null;
    const slices = sliceSites.reduce((n, t) => n + t.fired, 0);
    for (const [label, stats] of [['after the air bake (engine unit)', wave2.air?.bank], ['village busy (3 min)', wave2.busyBank]]) {
        if (stats === undefined) continue;
        const j = judgeBank(stats, sliceMax);
        const clients = j.clients.map(c => `${c.name} ${fmt(c.bytes / 1048576, 2)}/${c.budget != null ? fmt(c.budget / 1048576, 1) : '—'} MiB`).join(', ');
        verdict('bank', j.pass, `${label}: resident ${stats ? fmt(stats.residentBytes / 1048576, 2) : '—'} MiB of ${fmt(MEMORY_BUDGET.totalBytes / 1048576, 0)} (${clients || 'no clients'}); ${stats?.bakes ?? '—'} bakes, ${stats?.evictions ?? '—'} evictions, ${stats?.pending ?? '—'} pending; bake slices ${slices} timed on the virtual clock, max ${fmt(sliceMax, 2)} ms real${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}; want each client and the total within MEMORY_BUDGET, slices ≤ 5 ms`);
    }
}

// The Wave-1 reference: every piece rendered from `rev`'s tree (exported,
// read-only) with the same pinned draws, written to baselines/.
async function renderSequencerReference(browser, rev) {
    const ref = await referenceServer(rev);
    try {
        const render = makeRenderer(browser, ref.server.baseUrl, { seed: SEED, noWorklets: NO_WORKLETS });
        const pieces = {};
        for (const p of await loadPieces(ref.root)) {
            const row = sequencerRow(await render(p.key, p.spec), p);
            if (!row.onsets.length) throw new Error(`reference ${p.key}: no music onsets (pinned by ${row.pinned}); ${row.errors.slice(0, 2).join(' | ')}`);
            pieces[p.key] = { preset: p.preset, piece: p.piece, loopSec: p.loopSec, seconds: p.spec.seconds, lufsI: Number(row.lufsI.toFixed(3)), onsets: row.onsets };
            info('sequencer', `reference ${p.key} from ${rev}: ${row.onsets.length} onsets, LUFS-I ${fmt(row.lufsI, 2)} (pinned by ${row.pinned})`);
        }
        const doc = {
            note: 'Wave-1 reference for the sequencer-equivalence check (scripts/audio/probe.mjs `sequencer`): every shipped piece rendered from the Wave-1 tree on the virtual clock with every random draw pinned to 0.5; onsets are the distinct scheduled start times of every source reaching the music bus, relative to the piece\'s first, and LUFS-I is the program over the song (Village) or first loop (Town band). Regenerate only from the Wave-1 commit: `node scripts/audio/probe.mjs --only sequencer --update --ref-rev f4a71e3`.',
            rev, generatedAt: new Date().toISOString().slice(0, 10), programTrimDb: PROGRAM_TRIM_DB, pieces,
        };
        fs.mkdirSync(path.dirname(SEQUENCER_FILE), { recursive: true });
        fs.writeFileSync(SEQUENCER_FILE, `${JSON.stringify(doc)}\n`);
        info('sequencer', `wrote ${path.relative(process.cwd(), SEQUENCER_FILE)} (${Object.keys(pieces).length} pieces from ${rev})`);
    } finally {
        await ref.close();
    }
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
                verdict(unit.check || 'probe', false, `${unit.name}: ${e.stack || e.message || e}`);
            }
        }
    });
    await Promise.all(workers);
}

function judgeBaseline() {
    const current = Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, x]) => [m, Number.isFinite(x) ? Number(x.toFixed(2)) : null]))]));
    if (UPDATE) {
        const previous = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;
        const merged = { ...(previous?.summary || {}), ...current };
        const doc = {
            note: 'Reviewed baseline for scripts/audio/probe.mjs (virtual clock). Regenerate with `node scripts/audio/probe.mjs --update` after a reviewed audio change; the plan re-baselines at the end of Waves 1, 4 and 6.',
            generatedAt: new Date().toISOString().slice(0, 10),
            seed: SEED, programTrimDb: PROGRAM_TRIM_DB, standardVolumeStep: STANDARD_VOLUME_STEP,
            tolerance: BASELINE_TOLERANCE, summary: merged,
        };
        fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
        fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
        for (const row of compareBaseline(current, previous?.summary)) {
            info('baseline', `${row.key} ${row.metric}: ${fmt(row.baseline, 2)} → ${fmt(row.current, 2)} (${signed(row.delta, 2)})`);
        }
        info('baseline', `wrote ${path.relative(process.cwd(), BASELINE_FILE)} (${Object.keys(current).length} rows updated)`);
        return;
    }
    if (!fs.existsSync(BASELINE_FILE)) {
        verdict('baseline', false, `no ${path.relative(process.cwd(), BASELINE_FILE)}; run with --update and review it`);
        return;
    }
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    if (base.programTrimDb !== PROGRAM_TRIM_DB) info('baseline', `baseline taken at PROGRAM_TRIM_DB ${base.programTrimDb}, tree has ${PROGRAM_TRIM_DB}`);
    const rows = compareBaseline(current, base.summary, base.tolerance || BASELINE_TOLERANCE);
    for (const row of rows) {
        if (!row.pass) verdict('baseline', false, `${row.key} ${row.metric}: ${fmt(row.current, 2)} vs baseline ${fmt(row.baseline, 2)} (${signed(row.delta, 2)}), want within ±${row.tolerance}`);
    }
    const drift = rows.length ? Math.max(...rows.map(r => Math.abs(r.delta))) : null;
    verdict('baseline', rows.length > 0 && rows.every(r => r.pass), `${rows.length} numbers vs ${path.relative(process.cwd(), BASELINE_FILE)} (${base.generatedAt}); largest drift ${fmt(drift, 2)} (drift only: the targets are judged above)`);
}

// ---------------------------------------------------------------- main ----
async function main() {
    if (args.soak) {
        await runSoak({ ...reporter, seconds: args['soak-seconds'] != null ? Number(args['soak-seconds']) : null, update: UPDATE });
        return finish();
    }
    let server = null;
    let harnessBrowser = null;
    let appBrowser = null;
    const harness = async () => (harnessBrowser ||= await chromium.launch({ headless: true, args: HARNESS_CHROME_ARGS }));
    const appB = async () => (appBrowser ||= await chromium.launch({ headless: true, args: APP_CHROME_ARGS }));
    try {
        server = await startStaticServer();
        const units = [];
        if (VIRTUAL_CHECKS.some(has)) {
            const browser = await harness();
            const render = makeRenderer(browser, server.baseUrl, { seed: SEED, noWorklets: NO_WORKLETS });
            for (const u of virtualUnits(render, browser, server.baseUrl)) units.push({ ...u, check: u.name.split(' ')[0] });
            log(`virtual clock: seed ${SEED}, PROGRAM_TRIM_DB ${PROGRAM_TRIM_DB}, standard step ${STANDARD_VOLUME_STEP}${NO_WORKLETS ? ', worklets disabled (native fallbacks)' : ''}`);
        }
        await pool(units, JOBS);
        if (has('baseline')) judgeBaseline();
        if (has('bank')) judgeBankRows();
        const appUnits = [];
        if (['routing', 'away'].some(has)) {
            appUnits.push({ name: 'app busy day (routing, away)', check: 'app', run: async () => judgeBusy(await appBusyUnit(await appB(), reporter), reporter) });
        }
        if (has('ceremony')) {
            appUnits.push({ name: 'app team-gather (ceremony)', check: 'ceremony', run: async () => judgeCeremony(await appCeremonyUnit(await appB(), reporter), reporter) });
        }
        if (has('continuity')) {
            appUnits.push({ name: 'app blur → focus (continuity)', check: 'continuity', run: async () => judgeContinuity(await appContinuityUnit(await appB(), reporter), reporter) });
        }
        if (has('fps')) {
            appUnits.push({ name: 'app frame cost, sound on vs off (fps)', check: 'fps', run: async () => judgeFrameCost(await appFrameCostUnit(await appB(), reporter), reporter) });
        }
        if (has('lint')) {
            for (const u of await lintUnits(await harness(), server, reporter)) appUnits.push({ ...u, check: 'lint' });
        }
        // The realtime units run after the renders so render CPU never
        // competes with a live audio thread.
        await pool(appUnits, 1);
    } finally {
        await harnessBrowser?.close().catch(() => {});
        await appBrowser?.close().catch(() => {});
        await server?.close();
    }
    return finish();
}

function finish() {
    const failed = results.filter(r => r.pass === false);
    const passed = results.filter(r => r.pass === true);
    const deferred = results.filter(r => r.deferred != null);
    if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'probe-report.json'), JSON.stringify({ seed: SEED, planStage: PLAN_STAGE, jobs: JOBS, only: ONLY, soak: Boolean(args.soak), seconds: (Date.now() - t0) / 1000, programTrimDb: PROGRAM_TRIM_DB, targets: LOUDNESS_TARGETS, summary, results }, null, 2));
    }
    console.log(`\naudio:probe ${failed.length ? 'FAILED' : 'passed'} at plan stage ${PLAN_STAGE}: ${passed.length} pass, ${failed.length} fail, ${deferred.length} deferred in ${((Date.now() - t0) / 1000).toFixed(0)} s (seed ${SEED}, --jobs ${JOBS}${args.soak ? ', --soak' : ''})`);
    for (const f of failed) console.log(`  FAIL ${f.check}: ${f.detail}`);
    for (const d of deferred) console.log(`  DEFER ${d.check} (Wave ${d.deferred}): ${d.detail}`);
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

