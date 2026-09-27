#!/usr/bin/env node
// The audio probe: a LOCAL maintainer gate (not part of validate:quick or
// CI). See scripts/audio/README.md "The probe".
//
//   npm run audio:probe
//   node scripts/audio/probe.mjs [--only a,b] [--jobs N] [--seed N] [--out dir]
//                                [--no-worklets] [--update] [--soak [--soak-seconds N]]
//
// Default: the gate at PLAN_STAGE (lib/checks.mjs; criteria owned by a later
// wave print DEFER and never fail) on the virtual clock (HAR-1: the shipped
// controller rendered on an OfflineAudioContext, identical per seed to within
// the renderer's jitter)
// plus the Wave-0 checks on the live app. The presets are Signals (the
// attention voices over silence) and the Town band. Checks (PASS/FAIL/INFO
// lines; any FAIL exits 1; WARN flags a finding that is not a verdict):
//   scenes       S2's Town band row (Loudness.js) at the standard step, the
//                band stem's ST max; HAR-5 stems and the level map
//   margins      cue lanes (needs-you, error, limit, routine, scenery, the
//                three outcome tiers) over the Town band, the busy band (Isle
//                and Chip; urgent lanes) and the Signals bed (the no-music
//                bed: urgent lanes, ceiling exempt over its silence): median
//                of 3 placements in the full S2 window, the band rule and
//                urgent limiter GR ≤ 3 dB; the Minor outcome ≥ 3 LU under
//                routine
//   limiter      a +12 dBFS burst → the worklet's LIMITER_CEILING_DBFS (+0.1)
//                and ≤ −1 dBTP, the native fallback ≤ −0.9 dBFS; static gain
//                0 ± 0.2 dB on both
//   switch       must-never 12: Signals ↔ Town band over the 0.8 s fade —
//                out: no bump, faded ≥ 20 dB by its end, silent, no click;
//                in: no bump, the band heard by the fade's end
//   ducks        ducked time ≤ 5 % of the music bus (Town band busy)
//   avsync       HAR-12: published notes vs heard onsets; each accent's
//                carrying note at the accent or moved ≤ 60 ms onto the
//                band's grid (S4), heard there; the release crown's accent
//                vs its peal note (± 15 ms)
//   determinism  two renders of one scene agree within 0.2 LU (Town band,
//                Signals)
//   baseline     scene and margin numbers within tolerance of the committed
//                baselines/scenes.json (--update rewrites it); drift only —
//                a baseline never passes a target that failed
//   transport    2.1: Transport diagnostics over 10 min (underruns 0,
//                horizons), exactly one timer places sound, tick cost
//   pause        2.1: 120 s hidden → nothing starts while suspended, the
//                first second after resume ≤ steady rate + 1, same piece
//   air          2.4: IR T60 at 1/4 kHz day and night, D/R at d = 0 / 1,
//                urgent wet re dry, what the air adds to the Town band
//   bank         2.6: resident bytes vs MEMORY_BUDGET, bake slices ≤ 5 ms
//   discrim      3.1–3.5 (S1): every cue voice governor-free — signal vs
//                every other voice ≥ 2/3, urgent pairwise ≥ 2/3, outcomes
//                vs needs-you, no quick same-pitch opening outside signals
//   ladder       3.3: 61 min sound off per family (D6 schedule, S7 caps,
//                Toast captions), acknowledgement, held trim (sound on, in
//                Signals and over the Town band), hidden-tab wakes within 60 s
//   cluster      SIG-10: six same-tick raises within +1 LU of one call
//   outcomes     3.4: push, exit 0 silence, failure cap, turn done, dispatch,
//                return, release; a Dashboard fixture
//   captions     3.8 (HAR-13): caption/sound parity per caption setting,
//                both presets, sound on and off
//   honesty      must-never 13 (phase-locked urgent bells, stale-data sound)
//   quietmix     5.6 (D3): blur in the Town band −3 dB, focus restores in ≤ 1 s
//   musicstems   6.1–6.3, 6.5: every piece (PIECES) day and night, Isle and
//                Chip, in its own arrangement; isleband, nightmusic and score
//                read the same stem matrix
//   townband, percussion, signals, awaken, listening   Waves 6–7 (below)
//   lint, routing, away (+ resume), ceremony   the Wave-0 checks (live app)
//   continuity   2.1: blur 3 s → focus keeps the Town band piece and level
//   fps          2.4: app frame total p95, sound on vs off (realtime)
//   awakening, captionprobe   7.4 / 3.8 through the real TopBar (live app)
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
    BASELINE_TOLERANCE, BUSY_BAND_ERROR_BAND_RULE, CROWN_SYNC_MS, CUE_STRATUM, ISLAND_AIR, LADDER, PLAN_STAGE,
    compareBaseline, energyMeanLufs, expectedLadder, judgeAirT60, judgeBank, judgeCaptionParity, judgeCluster, judgeDiscrimination,
    judgeDuckedTime, judgeHeldTrim, judgeLadder, judgeLane, judgeSceneTargets, judgeTransport, judgeWakes, median, onsetNear,
    QUIET_MIX_LIMITS, judgeQuietMix, quietStemRow,
    MUSIC_LIMITS, arrangementSwitch, bandStep, breathsPerWindow, earlyReturns, judgeIsleArm, judgeStemBalance, laneWindow,
    loopsPerPieceHour, nightDarker, spearman,
    WAVE7_LIMITS, SWITCH_LIMITS,
} from './lib/checks.mjs';
import {
    AIR_CUE_SCENE, CAPTION_MODES, CAPTION_SETTINGS, DASHBOARD_SCENE, GALLERY_VOICES, LADDER_OPEN_SEC, LADDER_SECONDS, LADDER_TRIM_BAND_SCENE,
    LADDER_TRIM_SCENE, MARGIN_BEDS, OUTCOME_SCENE, STALE_SCENE, TOWN_DRY_SCENE, TRANSPORT_SCENE,
    WAKE_SCENE, captionScene, clusterScene, galleryScene, hiddenScene, ladderSilentScene, marginKeys, marginLanes, marginVoices,
    QUIET_MIX, quietMixScene,
    PERCUSSION_SEGMENTS, RAIN_SWITCH_AT, TOWN_SESSION, WAIT_CADENCE, musicStemScene, percussionScene, rainSwitchScene,
    townSessionScene, waitCadenceScene,
    AWAKEN, AWAKEN_SCENE, SIGNALS_ANSWER_AT, outputBusyScene, outputScene, signalsScene, softenScene,
} from './lib/scenes.mjs';
import {
    captionRows, clusterRow, crownRow, galleryRows, ladderCalls, ladderCaptioned, ladderTrimRows, laneEvents, wakeRows,
} from './lib/probe-wave3.mjs';
import { renderSilent, renderVirtual } from './lib/virtual.mjs';
import { discriminationMatrix } from './metrics/discrim.mjs';
import {
    avSyncRows, bandLevelDb, duckRows, levelDiffCurve, limiterUnitRows, makeRenderer, marginRows, outputGainDb, renderLimiterUnit, sceneLevelMap,
    sceneMetrics, sceneSpec, stemReport, switchRows,
} from './lib/probe-virtual.mjs';
import {
    airRows, arrivalDrRows, pauseRows, renderAir, transportRows, urgentWetRows,
} from './lib/probe-wave2.mjs';
import {
    appAwakeningUnit, appBusyUnit, appCaptionUnit, appCeremonyUnit, appContinuityUnit, appFrameCostUnit, judgeAwakening, judgeBusy, judgeCaption, judgeCeremony,
    judgeContinuity, judgeFrameCost, lintUnits,
} from './lib/probe-app.mjs';
import {
    bandRows, armRow, dutyOf, nodesPerNoteRow, noteRows, percussionPerBar, seatLufs, seatPairs, stopLevels, visitRows,
} from './lib/probe-wave6.mjs';
import { awakenRows, outputRow, signalsRows, softenRow, toneRow } from './lib/probe-wave7.mjs';
import { townBandHours } from './lib/music-sim.mjs';
import {
    cueClash, identicalRenditionGap, motifStatements, parallelPerfects, phraseReheard, range, renditions, seatLine, tonalReheard,
} from './score-analyzer.mjs';
import { loudness } from './lib/analyze.mjs';
import { marginAt } from './lib/timeline.mjs';
import { sessionMetrics } from './metrics/session-metrics.mjs';
import { runSoak } from './lib/soak.mjs';
import { PIECES, PLAYLISTS } from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';
import { voicingFor } from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { AUDIBILITY_WINDOWS, LIMITER_CEILING_DBFS, LOUDNESS_TARGETS, MEMORY_BUDGET, PROGRAM_TRIM_DB, STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { SIGNALS_FADE_SEC } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { BODY_SNAP_SEC } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';

const APP_CHROME_ARGS = ['--autoplay-policy=user-gesture-required', ...BACKGROUND_ARGS];
const BASELINE_FILE = path.join(AUDIO_DIR, 'baselines/scenes.json');
const DETERMINISM_LU = 0.2;
const AV_SYNC = { medianAbsMs: 20, p95AbsMs: 40 };
const SWITCH_ROWS_WANTED = 2;
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
const VIRTUAL_CHECKS = ['scenes', 'margins', 'limiter', 'switch', 'ducks', 'avsync', 'determinism', 'baseline', 'transport', 'pause', 'air', 'bank', 'discrim', 'ladder', 'cluster', 'outcomes', 'captions', 'honesty', 'quietmix', 'musicstems', 'isleband', 'nightmusic', 'score', 'townband', 'percussion', 'signals', 'awaken', 'listening'];
const APP_CHECKS = ['lint', 'routing', 'away', 'ceremony', 'continuity', 'fps', 'awakening', 'captionprobe'];
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
// A finding that is not a verdict on the gate (e.g. renderer nondeterminism).
function warn(check, detail) {
    results.push({ check, pass: null, warn: true, detail });
    console.log(`${stamp()} WARN  ${check}  ${detail}`);
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
const SCENE_TARGET_NAMES = ['townBand'];

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
            name: 'scenes (Town band)',
            async run() {
                const measured = {};
                for (const name of SCENE_TARGET_NAMES) {
                    const r = await scene(name);
                    const m = sceneMetrics(r);
                    if (r.stems.music) m.bandStemStMax = stemReport(r).stems.music.stMax;
                    measured[name] = m;
                    summary[`scene:${name}`] = { lufsI: m.lufsI, stMax: m.stMax };
                    info('scenes', `${name}: LUFS-I ${fmt(m.lufsI)}, ST max ${fmt(m.stMax)}, LRA ${fmt(m.lra)} LU, TP ${fmt(m.truePeakDbtp)} dBTP${m.grMaxDb != null ? `, limiter GR max ${fmt(m.grMaxDb)} dB` : ''} (${m.limiterKind}, rendered ${fmt(m.renderMs / 1000)} s); errors ${r.errors.length}${r.errors.length ? `: ${r.errors.slice(0, 2).join(' | ')}` : ''}`);
                }
                if (!has('scenes')) return;
                for (const row of judgeSceneTargets(measured)) outcome('scenes', row.outcome, `${row.scene}: ${row.detail}`, row.gatedFrom);
                const busy = await scene('townBand');
                const stems = stemReport(busy);
                info('scenes', `HAR-5 stems, Town band busy (LUFS-I at the output; share of program energy): ${Object.entries(stems.stems).map(([k, v]) => `${k} ${fmt(v.lufsI)} (${signed(v.shareOfProgramDb)} dB)`).join(', ')}`);
                const lm = sceneLevelMap(busy);
                info('scenes', `Town band busy level map: 2–5 kHz ${fmt(lm.presenceSharePct)} % of K-weighted energy, S/M ${fmt(lm.sideMidDB)} dB, corr ${fmt(lm.corr, 2)}, mono fold ${fmt(lm.monoLossLU)} LU, laptop ${fmt(lm.speakerLossLU)} LU`);
            },
        });
    }
    // Uncached one-off renders: each is reduced to numbers inside its unit,
    // so its PCM never outlives it.
    const renderOnce = async (key, spec) => {
        const r = await renderVirtual(browser, baseUrl, { ...spec, name: key, noWorklets: NO_WORKLETS }, { seed: SEED });
        keep(key, r);
        return r;
    };
    // HAR-3: each lane over each probe bed from its own render (the bed
    // under a placement depends on the cues before it; lib/scenes.mjs
    // marginScene), reduced to its rows and, over the band, the band each
    // placement meets; shared by margins and townband.
    // A lane's other voices (MARGIN_VOICES: council, departure, the hour
    // bell) render apart; the hour bell one placement per render (its 55-min
    // cooldown).
    const laneMemo = new Map();
    const bandBefore = (r, rows) => rows.filter(x => Number.isFinite(x.at)).map((x) => {
        const m = r.stems.music;
        const lou = loudness(m.L.subarray(Math.round((x.at - 3) * r.sr), Math.round(x.at * r.sr)), m.R.subarray(Math.round((x.at - 3) * r.sr), Math.round(x.at * r.sr)), r.sr);
        return energyMeanLufs(lou.momentaryCurve.map(([, v]) => v)) + outputGainDb(r);
    });
    const marginRender = (bedName, lane, key) => {
        if (!laneMemo.has(key)) {
            laneMemo.set(key, renderOnce(key, sceneSpec(key)).then(r => ({
                rows: marginRows(r, bedName), errors: r.errors,
                // The band each placement meets: the music stem's energy mean
                // over the 3 s before its onset, at the output.
                bandLufs: MARGIN_BEDS[bedName].bed === 'music' && r.stems.music ? bandBefore(r, marginRows(r, bedName)) : [],
            })));
        }
        return laneMemo.get(key);
    };
    const marginLane = async (bedName, lane, voice = marginVoices(lane)[0]) => {
        const parts = [];
        for (const key of marginKeys(bedName, lane, voice)) parts.push(await marginRender(bedName, lane, key));
        return { rows: parts.flatMap(x => x.rows), errors: parts.flatMap(x => x.errors), bandLufs: parts.flatMap(x => x.bandLufs).filter(Number.isFinite) };
    };
    // Each lane's default voice (the rows the other checks share).
    const marginBed = async (bedName, lanes = marginLanes(bedName)) => {
        const each = [];
        for (const lane of lanes) each.push(await marginLane(bedName, lane));
        return { rows: each.flatMap(x => x.rows), errors: each.flatMap(x => x.errors), bandLufs: each.flatMap(x => x.bandLufs) };
    };
    if (has('margins') || has('baseline')) {
        for (const bedName of Object.keys(MARGIN_BEDS)) {
            units.push({
                name: `margins over ${bedName}`,
                async run() {
                    const lanes = marginLanes(bedName);
                    const ctx = MARGIN_BEDS[bedName].bed;
                    const { rows, errors, bandLufs } = await marginBed(bedName);
                    for (const lane of lanes) {
                        const voices = marginVoices(lane);
                        for (const voice of voices) {
                            const own = voice === voices[0];
                            const placements = own ? rows.filter(x => x.lane === lane) : (await marginLane(bedName, lane, voice)).rows;
                            // S2 at closure: the error over a busy Town band clears ≥ +5 dB of presence.
                            const bandRule = MARGIN_BEDS[bedName].busy && lane === 'error' ? BUSY_BAND_ERROR_BAND_RULE : undefined;
                            const j = judgeLane(lane, ctx, placements, { probeBed: bedName, ceilingExempt: Boolean(MARGIN_BEDS[bedName].silent), ...(bandRule ? { bandRule } : {}) });
                            summary[own ? `margin:${bedName}:${lane}` : `margin:${bedName}:${lane}:${voice}`] = { margin: j.margin };
                            if (!has('margins')) continue;
                            const win = `${j.window.min != null ? `≥ ${signed(j.window.min, 0)}` : ''}${j.window.min != null && j.window.max != null ? ', ' : ''}${j.window.max != null ? `≤ ${signed(j.window.max, 0)}` : ''}`;
                            const each = placements.map(p => signed(p.margin)).join(' / ');
                            const trims = placements.map(p => signed(p.trimDb)).join(' / ');
                            const extra = j.gr != null ? `; ${ctx === 'music' ? `presence rise ${fmt(j.band)} dB (≥ ${(bandRule ?? AUDIBILITY_WINDOWS.urgentBandRule).overMusic.minRiseDb})` : `${fmt(j.band, 0)} bands ≥ +6 dB`}, GR ${fmt(j.gr)} dB` : '';
                            const why = j.failures.map(f => (f.gatedFrom > PLAN_STAGE ? `${f.what} (Wave ${f.gatedFrom})` : f.what)).join(', ');
                            const name = voices.length > 1 ? `${lane} (${voice})` : lane;
                            outcome('margins', j.outcome, `${name} over ${bedName}: median ${signed(j.margin)} LU (${each}; cue trims ${trims} dB, ${j.n} admitted), want ${win}${extra}${why ? ` — ${why}` : ''}`, Math.max(...j.failures.map(f => f.gatedFrom), 0));
                        }
                    }
                    // S2: a Minor outcome also sits ≥ 3 LU under the routine cue,
                    // both as the cue's own level over the bed stems.
                    if (has('margins') && lanes.includes('outcomeMinor') && lanes.includes('routine')) {
                        const stemMedian = lane => median(rows.filter(x => x.lane === lane).map(x => x.stemMargin));
                        const minor = stemMedian('outcomeMinor');
                        const routine = stemMedian('routine');
                        const under = minor != null && routine != null ? routine - minor : null;
                        verdict('margins', under != null && under >= 3, `outcome Minor under routine over ${bedName} (cue stem over the bed stems): ${fmt(under)} LU (turn done ${signed(minor)} vs arrival ${signed(routine)}); want ≥ 3`);
                        // Would the stem measure flip any other lane's verdict?
                        const flips = lanes.filter(l => l !== 'outcomeMinor').map((lane) => {
                            const placements = rows.filter(x => x.lane === lane);
                            const a = judgeLane(lane, ctx, placements, { probeBed: bedName }).outcome;
                            const b = judgeLane(lane, ctx, placements.map(p => ({ ...p, margin: p.stemMargin })), { probeBed: bedName }).outcome;
                            return a !== b ? `${lane} ${a}→${b} (${signed(median(placements.map(p => p.margin)))} → ${signed(median(placements.map(p => p.stemMargin)))} LU)` : null;
                        }).filter(Boolean);
                        info('margins', `${bedName}: the cue-stem-over-bed-stems margin for every lane (judged for Minor outcomes only): ${lanes.map(l => `${l} ${signed(stemMedian(l))}`).join(', ')}; verdicts it would flip: ${flips.join('; ') || 'none'}`);
                    }
                    if (has('margins') && bandLufs.length) info('margins', `${bedName}: the band each placement meets (music stem, 3 s before the onset, at the output) ${fmt(Math.min(...bandLufs))}…${fmt(Math.max(...bandLufs))} LUFS, median ${fmt(median(bandLufs))} (${bandLufs.length} placements)`);
                    if (errors.length) info('margins', `${bedName}: page errors: ${errors.slice(0, 3).join(' | ')}`);
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
                if (rows.length < SWITCH_ROWS_WANTED) verdict('switch', false, `expected ${SWITCH_ROWS_WANTED} switches, saw ${rows.length}`);
                const L = SWITCH_LIMITS;
                for (const row of rows) {
                    const head = `${row.label} at ${fmt(row.t)} s: old ${fmt(row.oldLufs)} → new ${fmt(row.newLufs)} LUFS-M`;
                    if (row.direction == null) { verdict('switch', false, `${head}: not measurable (want exactly one side silent — Signals has no bed)`); continue; }
                    const bump = `bump ${fmt(row.bumpDb)} dB over the band's p90 (switch window M max ${fmt(row.maxDuring)})`;
                    if (row.direction === 'out') {
                        verdict('switch', row.pass, `${head} (Town band → Signals): ${bump}; ${fmt(row.fadedDb)} dB down ${fmt(SIGNALS_FADE_SEC)} s in (the fade's end), silent (< ${L.silenceDbfs} dBFS) ${row.silentAfter != null ? `${fmt(row.silentAfter, 2)} s in` : `not within ${fmt(4)} s`}, largest rise after the fade ${fmt(row.clickDb)} dB; want bump ≤ ${L.bumpDb} dB, ≥ ${L.fadedDb} dB down, silent, rise ≤ ${L.clickRiseDb} dB (no click)`);
                    } else {
                        verdict('switch', row.pass, `${head} (Signals → Town band): ${bump}; the band heard (> ${L.soundDbfs} dBFS) ${row.entryAfter != null ? `${fmt(row.entryAfter, 2)} s in` : 'never'}; want bump ≤ ${L.bumpDb} dB, heard by the fade's end (${fmt(SIGNALS_FADE_SEC)} s)`);
                    }
                }
            },
        });
    }
    if (has('ducks')) {
        units.push({
            name: 'ducked time',
            async run() {
                for (const name of ['townBand']) {
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
                const a = avSyncRows(r, { syncMs: AV_SYNC.p95AbsMs });
                const line = (s) => `${s.n} notes, ${s.missed} unheard, median |err| ${fmt(s.medianAbsMs)} ms, p95 ${fmt(s.p95AbsMs)} ms (signed median ${signed(s.medianMs)} ms)`;
                verdict('avsync', a.notes.n > 0 && a.notes.missed === 0 && a.notes.medianAbsMs <= AV_SYNC.medianAbsMs && a.notes.p95AbsMs <= AV_SYNC.p95AbsMs,
                    `published vs heard: ${line(a.notes)}; want median ≤ ${AV_SYNC.medianAbsMs}, p95 ≤ ${AV_SYNC.p95AbsMs}`);
                const accentLine = row => `${row.how}${row.offsetMs != null ? ` ${signed(row.offsetMs, 1)} ms, heard ${signed(row.heardMs, 1)} ms` : ''}`;
                verdict('avsync', a.accents.length > 0 && a.accents.every(row => row.pass),
                    `accents over the Town band (carrying note − accent, heard − carrying note): ${a.accents.map(accentLine).join('; ')}; want each carrying note at its accent (C-CUE-5) or moved onto the band's grid within ±${fmt(BODY_SNAP_SEC * 1000, 0)} ms (S4), heard within ±${AV_SYNC.p95AbsMs} ms of it`);
                info('avsync', `cue score: ${r.meta.cueScore.published} published, ${r.meta.cueScore.anchored} anchored, ${r.meta.cueScore.snapped} snapped, ${r.meta.cueScore.dropped} dropped`);
            },
        });
    }
    if (has('determinism')) {
        units.push({
            name: 'determinism',
            async run() {
                for (const name of ['townBand', 'signalsBusy']) {
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
    units.push(...quietMixUnits(renderOnce));
    units.push(...wave6Units(render, renderOnce, scene, marginBed));
    units.push(...wave7Units(renderOnce));
    return units;
}

// ------------------------------------------------------------ Wave 2 units ----
const siteLine = rows => rows.map(t => `${t.site} ×${t.starts}${t.first?.length && !/Transport\.js/.test(t.site) ? ` [first ${t.first.map(f => `${f.k}@${f.t}s`).join(', ')}]` : ''}${t.callers?.length ? ` (via ${t.callers.slice(0, 2).join(', ')})` : ''}`).join('; ') || 'none';

function wave2Units(render, browser, baseUrl, scene) {
    const units = [];
    if (has('transport')) {
        units.push({
            name: 'transport (10 min, both presets)',
            async run() {
                const r = await render('transport', TRANSPORT_SCENE);
                const t = transportRows(r);
                const j = judgeTransport(t.diag, t.timers);
                const procs = j.processes.map(p => `${p.name} ${fmt(p.maxAheadSec, 2)}/${p.limit} s${p.dropped ? ` (${p.dropped} dropped)` : ''}`).join(', ') || 'none registered';
                verdict('transport', j.pass, `underruns ${t.diag?.underruns ?? '—'}, late dropped ${t.diag?.lateDropped ?? '—'}; committed ahead per process: ${procs}; Transport tick ${j.tick ? `${j.tick.fired} ticks, p95 ${fmt(j.tick.p95Ms, 3)} ms, max ${fmt(j.tick.maxMs, 2)} ms (real main-thread time)` : 'never seen'}; app timers that started continuous sources: ${siteLine(j.soundSites)}${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}; want 0 underruns, ≤ 1.5 s ahead, exactly one timer (Transport.js), tick p95 ≤ 0.5 ms and max ≤ 2 ms`);
                const other = t.timers.filter(x => (x.site === 'harness' || x.site === 'untimed') && x.starts > 0);
                const cues = t.timers.filter(x => x.cueStarts > 0).map(x => `${x.site} ×${x.cueStarts}`).join('; ') || 'none';
                info('transport', `${t.startCount} source starts; discrete cue voices (exempt) by timer site: ${cues}; continuous sources outside app timers (harness actions, the 2 Hz atmosphere pump, the enable): ${siteLine(other)}; transport lateness p95 ${fmt(t.diag?.tickLatenessP95, 1)} ms on the virtual clock (steps of 10.7 ms), max stall ${fmt(t.diag?.maxStallMs, 1)} ms; page errors ${t.errors.length}${t.errors.length ? `: ${t.errors.slice(0, 2).join(' | ')}` : ''}`);
                const slow = t.timers.filter(x => x.maxMs > 2 && !/Transport\.js/.test(x.site)).map(x => `${x.site} max ${fmt(x.maxMs, 1)} ms`);
                if (slow.length) info('transport', `other timers over 2 ms: ${slow.join(', ')}`);
            },
        });
    }
    if (has('pause')) {
        for (const mode of ['signals', 'bgm']) {
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
                info('air', `raw place() sends on the music bus (8 ms burst through connectVoice): ${a.dr.map(x => `d = ${x.d} D/R ${signed(x.drDb)} dB (${place(x)})`).join('; ')} — the gate is the cue path below`);
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
                const withAir = sceneMetrics(await scene('townBand'));
                const dry = await render('townBand:dry', TOWN_DRY_SCENE);
                const without = sceneMetrics(dry);
                const d = withAir.lufsI - without.lufsI;
                verdict('air', dry.meta.airOff === true && d <= ISLAND_AIR.programMaxLu, `Town band busy with air ${fmt(withAir.lufsI, 2)} vs without ${fmt(without.lufsI, 2)} LUFS-I: air adds ${signed(d, 2)} LU${dry.meta.airOff ? '' : ' (air sends not found)'}; want ≤ +${ISLAND_AIR.programMaxLu}`);
            },
        });
    }
    if (has('bank')) {
        units.push({
            name: 'bank (the Town band busy)',
            async run() {
                const r = await scene('townBand');
                wave2.busyBank = r.meta.diagnostics?.bank ?? null;
                wave2.bakeTimers = r.meta.timers;
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
                verdict('ladder', j.pass, `Signals, sound on: ${calls.map(c => `L${c.level} ${signed(c.margin)} LU (trim ${signed(c.trimDb)} dB, GR ${fmt(c.grDb)} dB)`).join(', ') || 'no calls'}; L2 ${fmt(j.l2UnderL1Lu)} LU under L1, trims spread ${fmt(j.trimSpreadDb, 2)} dB${j.failures.length ? ` — ${j.failures.join(', ')}` : ''}; want L2 ≥ 4 LU under L1, one trim held, L3 GR ≤ ${LOUDNESS_TARGETS.ceiling.urgentGrMaxDb} dB`);
            },
        });
        units.push({
            name: 'ladder (sound on, held trim, Town band)',
            async run() {
                // Over music a quiet reminder's program margin reads the band
                // itself (reel v3: equal trims read L1 − L2 +2.7 LU), so the
                // band's L2-under-L1 is the calls' own levels: the cue stem's
                // M max, the same staging for both.
                const r = await render('ladder:trim:band', LADDER_TRIM_BAND_SCENE);
                const calls = ladderTrimRows(r);
                const j = judgeHeldTrim(calls.map(c => ({ ...c, margin: c.cueMaxLufs })));
                const programGap = (() => {
                    const l1 = calls.find(c => c.level === 1);
                    const l2 = calls.find(c => c.level === 2);
                    return l1 && l2 ? l1.margin - l2.margin : null;
                })();
                verdict('ladder', j.pass, `Town band, sound on: ${calls.map(c => `L${c.level} ${fmt(c.cueMaxLufs)} LUFS M max (margin ${signed(c.margin)} LU, trim ${signed(c.trimDb)} dB, GR ${fmt(c.grDb)} dB)`).join(', ') || 'no calls'}; L2 ${fmt(j.l2UnderL1Lu)} LU under L1 on the cue stem (program margins ${fmt(programGap)} LU apart), trims spread ${fmt(j.trimSpreadDb, 2)} dB${j.failures.length ? ` — ${j.failures.join(', ')}` : ''}; want L2 ≥ 4 LU under L1, one trim held (the entry's), L3 GR ≤ ${LOUDNESS_TARGETS.ceiling.urgentGrMaxDb} dB`);
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
        for (const mode of CAPTION_MODES) {
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
                        if (!soundOn && mode === CAPTION_MODES[0]) {
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
            name: 'honesty (must-never 13)',
            async run() {
                const clusters = Object.values(wave3.cluster);
                const locked = clusters.flatMap(c => c.phaseLocked);
                verdict('honesty', clusters.length === 2 && locked.length === 0, `must-never 13 (SIG-10): phase-locked urgent bells among six same-tick needs-you and six errors: ${clusters.length < 2 ? 'not measured' : locked.length ? locked.map(p => `${p.kind} ${p.a}/${p.b} ×${p.hits}`).join(', ') : 'none'}; want none`);
                const s = await render('honesty:stale', STALE_SCENE);
                const sounding = s.meta.scheduled.filter(x => !x.silent && ['summons', 'distress', 'reminder'].includes(x.kind));
                const captions = s.meta.cues.filter(c => ['summons', 'distress', 'reminder'].includes(c.kind)).length;
                verdict('honesty', sounding.length === 0, `must-never 13 (SIG-9): stale agents raising a needs-you and an error in Signals → ${sounding.length} sounding signal score(s) (${captions} caption(s)); want no sound`);
            },
        });
    }
    return units;
}

// ------------------------------------------------------------ quiet mix ----
const pct = x => (Number.isFinite(x) ? `${Math.round(100 * x)} %` : '—');

function quietMixUnits(renderOnce) {
    const units = [];
    const L = QUIET_MIX_LIMITS;
    if (has('quietmix')) {
        units.push({
            name: 'quietmix (5.6: blur in the Town band)',
            async run() {
                const { blurAt, focusAt } = QUIET_MIX;
                const t = await renderOnce('quiet:town', quietMixScene());
                const tt = await renderOnce('quiet:town:twin', quietMixScene({ blur: false }));
                const at = s => t.meta.warmup + s;
                const row = quietStemRow(levelDiffCurve(t.stems.music, tt.stems.music, t.sr), { blurSec: at(blurAt), focusSec: at(focusAt) });
                const x = judgeQuietMix({ 'Town band music': { ...row, want: L.quietTownDb } }).rows[0];
                const q = t.meta.stateLog.find(s => s.t > at(blurAt) + 1 && s.t < at(focusAt))?.quietMix;
                const state = q ? `quietMix ${q.active ? 'active' : 'inactive'} (${q.preset ?? '—'})` : 'no quietMix state';
                verdict('quietmix', x.pass, `Town band blur ${blurAt}–${focusAt} s: music ${signed(x.levelDb, 2)} dB vs the twin that never blurred, back within ${L.quietTolDb} dB ${fmt(x.restoreLagSec, 2)} s after focus; want ${L.quietTownDb} ± ${L.quietTolDb} dB, restored ≤ ${L.restoreSec} s; ${state}`);
            },
        });
    }
    return units;
}

// ------------------------------------------------------------ Wave 6 units ----
// The music. The stem matrix (every piece of PIECES × day/night × Isle/Chip,
// one full-band render each in the piece's own arrangement, every seat on
// its own stem) feeds musicstems (6.2), isleband (6.1) and nightmusic (6.3);
// each render is reduced to numbers in its unit. The score (6.5) also runs
// the shipped Sequencer headless (lib/music-sim.mjs).
// The headless score run (6.5): the whole seeded working day compiles in
// well under a second, so the 8 hours always run.
const SCORE_HOURS = 8;
const re = (v, lead) => (Number.isFinite(v) && Number.isFinite(lead) ? v - lead : (v === -Infinity ? -Infinity : null));
const lu = v => (v === -Infinity ? '−∞' : signed(v));
const MUSIC_MARGIN = { bedWindowSec: AUDIBILITY_WINDOWS.bedWindowSec, cueWindowSec: 2.5, silenceFloorLufs: -80 };
const ROUTINE_KINDS = new Set(['arrival', 'departure', 'recovered', 'recovery', 'council', 'turnDone']);
const hzToMidi = hz => Math.round(69 + 12 * Math.log2(hz / 440));
const midiName = m => (Number.isFinite(m) ? `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}` : '—');

// One 16-bar rendition of a piece: pickup + min(16, its bars) bars + 1.5 s.
function stemSeconds(piece) {
    const bpb = piece.beatsPerBar || 4;
    const beat = 60 / piece.bpm;
    const pickup = (piece.pickup || []).reduce((s, [, b]) => s + b, 0);
    return Math.ceil(0.6 + (pickup + Math.min(16, piece.chords.length) * bpb) * beat + 1.5);
}

// A stem-matrix render → numbers: per-seat LUFS-I, the bands (each the
// admitted seats of Voicings at the arrangement the band actually played,
// the piece's own players), the players the voicing seats and those heard
// per seat, the Isle/Chip arm, nodes per note, the stop lint, the lead's
// range and the melody–bass parallels.
// The seats a piece's arrangement names (C4: lead, counter, engine,
// descant); bass and percussion are the band's own.
const PLAYER_SEATS = Object.freeze(['lead', 'counter', 'engine', 'descant']);
function stemRow(r, { piece, phase, voice }) {
    const marks = r.meta.music?.marks || [];
    const first = marks.find(m => m.kind === 'loop' && m.piece === piece);
    const barSec = first?.barSec ?? null;
    const from = first?.t ?? r.meta.warmup;
    const to = Math.min(r.meta.warmup + r.meta.seconds, barSec ? from + 16 * barSec : Infinity);
    const win = { from, to };
    const pairs = seatPairs(r, win);
    const seats = seatLufs(pairs, r.sr);
    const arr = first?.arrangement ?? {};
    const voicing = band => voicingFor({ voice, piece, keyframe: arr.keyframe, weather: arr.weather, season: arr.season, band });
    const admitted = [0, 1, 2, 3].map(band => voicing(band).admitted.filter(s => pairs[s]));
    const bands = bandRows(r, pairs, admitted, win);
    const notes = noteRows(r, win);
    // The piece's own passes (and their pickups): stingers, tags and
    // interludes seat other players by design.
    const own = notes.filter(n => n.segment === 'pass' || n.segment === 'pickup');
    const players = Object.fromEntries(PLAYER_SEATS.map(seat => [seat, {
        want: voicing(3).seats[seat]?.instrument ?? null,
        heard: [...new Set(own.filter(n => n.seat === seat).map(n => n.instrument).filter(Boolean))],
    }]));
    const lead = seatLine(notes, 'lead');
    const voicesPlayed = [...new Set(marks.filter(m => m.kind === 'loop' || m.kind === 'chunk').map(m => m.voice))];
    return {
        piece, phase, voice, keyframe: arr.keyframe ?? null, voicesPlayed, window: win, found: Boolean(first),
        presence: Object.fromEntries(Object.entries(pairs).map(([seat, p]) => [seat, bandLevelDb(p, r.sr, 2000, 5000)])),
        seats, admitted, players, bands, steps: [1, 2, 3].map(k => bandStep(bands[k - 1], bands[k])),
        arm: armRow(r, win),
        nodes: nodesPerNoteRow(r), stops: stopLevels(r, { maxDb: MUSIC_LIMITS.stopMaxDb }),
        lead: range(lead), parallels: parallelPerfects(lead, seatLine(notes, 'bass')),
        errors: r.errors,
    };
}

function wave6Units(render, renderOnce, scene, marginBed) {
    const units = [];
    const L = MUSIC_LIMITS;
    const stemChecks = ['musicstems', 'isleband', 'nightmusic', 'score'];
    if (stemChecks.some(has)) {
        for (const piece of PIECES) {
            units.push({
                name: `musicstems (6.1–6.3, 6.5: ${piece.name}, day and night, Isle and Chip)`,
                async run() {
                    const rows = {};
                    for (const phase of ['day', 'night']) {
                        for (const voice of ['isle', 'chip']) {
                            const r = await renderOnce(`music:stems:${piece.name}:${phase}:${voice}`, musicStemScene({ piece: piece.name, seconds: stemSeconds(piece), phase, voice }));
                            rows[`${phase}:${voice}`] = stemRow(r, { piece: piece.name, phase, voice });
                        }
                    }
                    for (const row of Object.values(rows)) {
                        const tag = `${piece.name} ${row.phase} ${row.voice} (${row.keyframe ?? '—'})`;
                        if (!row.found) { verdict('musicstems', false, `${tag}: no loop of the pinned piece in the render (errors: ${row.errors.slice(0, 2).join(' | ') || 'none'})`); continue; }
                        const lead = row.seats.lead;
                        const reLead = Object.entries(row.seats).filter(([s]) => s !== 'lead').map(([s, v]) => `${s} ${lu(re(v, lead))}`).join(', ');
                        // Gated on the combinations the Town band plays (PLAYLISTS:
                        // day pieces by day, night pieces at night); a piece in the
                        // other phase's voicing prints as INFO.
                        const played = PLAYLISTS[row.phase]?.includes(piece.name);
                        const judge = (check, pass, detail) => (played ? verdict(check, pass, detail) : info(check, `(not played at ${row.phase}) ${pass ? 'would pass' : 'would fail'}: ${detail}`));
                        if (has('musicstems')) {
                            info('musicstems', `${tag}: per-seat LU re lead (lead ${fmt(lead)} LUFS-I): ${reLead}; admitted by band ${row.admitted.map(a => a.join('+')).join(' / ')}; voice played ${row.voicesPlayed.join('/') || '—'}`);
                            const b = judgeStemBalance(row.seats, row.admitted[3]);
                            judge('musicstems', b.pass && row.voicesPlayed.length === 1 && row.voicesPlayed[0] === row.voice, `${tag}: MUSL-2 stems re lead ${b.rows.map(x => `${x.seat} ${lu(x.reLead)}${x.window ? ` [${signed(x.window[0], 1)} ± ${x.window[1]}]` : ''}${x.pass ? '' : ' ✗'}`).join(', ')}; want every admitted seat in its window, ≥ ${L.floorLu} LU and under the lead`);
                            const steps = row.steps.map((s, i) => `${i}→${i + 1} onsets ${signed(100 * s.rise, 0)} % / octave max ${lu(s.maxOctaveDb)} dB${s.pass ? '' : ' ✗'}`);
                            const seated = PLAYER_SEATS.filter(seat => row.admitted[3].includes(seat));
                            const wrong = seated.filter(seat => row.players[seat].heard.length !== 1 || row.players[seat].heard[0] !== row.players[seat].want);
                            judge('musicstems', seated.length > 0 && wrong.length === 0, `${tag}: the arrangement's players per seat (want → heard) ${seated.map(seat => `${seat} ${row.players[seat].want} → ${row.players[seat].heard.join('/') || '—'}${wrong.includes(seat) ? ' ✗' : ''}`).join(', ')}; want each seat played by its own player alone (C4)`);
                            judge('musicstems', row.steps.every(s => s.pass), `${tag}: MUSL-3 bands (${row.bands.map(x => x.onsets).join('/')} onsets) ${steps.join('; ')}; want ≥ +${100 * L.bandOnsetRise} % onsets or ≥ ${L.bandOctaveDb} dB in some octave band at every step`);
                        }
                        if (has('isleband')) {
                            const n = row.nodes;
                            verdict('isleband', n.notes > 0 && n.over === 0, `${tag}: nodes per note max ${n.max} over ${n.notes} notes (${Object.entries(n.byInstrument).map(([k, v]) => `${k} ${v}`).join(', ')}; each player's first note, which builds it, not judged: ${n.firsts}); want ≤ ${L.nodesPerNote}`);
                        }
                        if (has('nightmusic') && row.phase === 'night') {
                            judge('nightmusic', row.lead.high != null && row.lead.high <= L.nightLeadMaxMidi, `${tag}: the night lead sounds ${midiName(row.lead.low)}–${midiName(row.lead.high)}; want ≤ A5`);
                            verdict('nightmusic', row.stops.voices > 0 && row.stops.over === 0, `${tag}: ${row.stops.voices} stopped voices, the loudest at its stop ${fmt(row.stops.worstDb)} dB re its peak (${row.stops.over} above ${L.stopMaxDb} dB); want none above`);
                        }
                        if (has('score')) {
                            verdict('score', row.parallels.length === 0, `${tag}: melody–bass parallel fifths/octaves ${row.parallels.length}${row.parallels.length ? ` (${row.parallels.slice(0, 3).map(p => `${p.interval} at ${fmt(p.at, 2)} s`).join(', ')})` : ''}; want 0 (MUS-18)`);
                        }
                    }
                    if (has('isleband')) {
                        for (const phase of ['day', 'night']) {
                            const isle = rows[`${phase}:isle`].arm;
                            const chip = rows[`${phase}:chip`].arm;
                            const j = judgeIsleArm(isle);
                            verdict('isleband', j.pass, `${piece.name} ${phase}, level-matched A/B of the same notes (music + its air${isle.air ? '' : ' — no air tap'}; dry S/M ${fmt(isle.dry.sideMidDb)} dB): Isle laptop loss ${fmt(isle.laptopLossLu)} LU, S/M ${fmt(isle.sideMidDb)} dB, mono fold ${fmt(isle.monoLossLu)} LU, 2–5 kHz ${fmt(isle.presenceDb)} dB — Chip ${fmt(chip.laptopLossLu)} LU, ${fmt(chip.sideMidDb)} dB, ${fmt(chip.monoLossLu)} LU, ${fmt(chip.presenceDb)} dB; want Isle laptop ≤ ${L.laptopLossMaxLu} LU, S/M ${L.sideMidDb[0]}…${L.sideMidDb[1]} dB, mono ≤ ${L.monoLossMaxLu} LU${j.failures.length ? ` — ${j.failures.join(', ')}` : ''}`);
                        }
                        const nd = nightDarker(rows['day:isle'].arm.presenceDb, rows['night:isle'].arm.presenceDb);
                        const ndChip = nightDarker(rows['day:chip'].arm.presenceDb, rows['night:chip'].arm.presenceDb);
                        const per = k => Object.entries(rows[k].presence).map(([seat, v]) => `${seat} ${fmt(v)}`).join(', ');
                        info('isleband', `${piece.name}: 2–5 kHz band level per seat (dB, output-referred), Isle day ${per('day:isle')}; night ${per('night:isle')}; air-wet share in the arm: day ${fmt(rows['day:isle'].arm.presenceDb - rows['day:isle'].arm.dry.presenceDb)} dB, night ${fmt(rows['night:isle'].arm.presenceDb - rows['night:isle'].arm.dry.presenceDb)} dB (arm − dry)`);
                        verdict('isleband', nd.pass, `${piece.name}: Isle 2–5 kHz share night ${fmt(rows['night:isle'].arm.presenceDb)} vs day ${fmt(rows['day:isle'].arm.presenceDb)} dB (${fmt(nd.under)} dB under); want ≥ ${L.nightPresenceUnderDayDb} dB under (Chip: ${fmt(ndChip.under)} dB)`);
                    }
                    if (has('nightmusic')) {
                        info('nightmusic', `${piece.name}: night 2–5 kHz share Isle ${fmt(rows['night:isle'].arm.presenceDb)} dB vs Chip ${fmt(rows['night:chip'].arm.presenceDb)} dB (Chip restored ≈ the shipped night band's timbres): ${fmt(rows['night:chip'].arm.presenceDb - rows['night:isle'].arm.presenceDb)} dB under (6.3 asks ≈ 6)`);
                    }
                },
            });
        }
    }
    if (has('isleband')) {
        units.push({
            name: 'isleband (6.1: the music bakes within S8)',
            async run() {
                const r = await scene('townBand');
                const stats = r.meta.diagnostics?.bank;
                const music = stats?.byClient?.music ?? null;
                const bytes = typeof music === 'number' ? music : (music?.bytes ?? music?.resident ?? null);
                verdict('isleband', stats != null && Number.isFinite(bytes) && bytes <= MEMORY_BUDGET.music, `Town band busy: the music client resident ${fmt(bytes / 1048576, 2)} MiB of ${fmt(MEMORY_BUDGET.music / 1048576, 1)} MiB ; bank total ${fmt((stats?.residentBytes ?? NaN) / 1048576, 2)} MiB; slices judged in \`bank\``);
            },
        });
    }
    if (has('score')) {
        units.push({
            name: 'score (6.5: routine cues over the Town band)',
            async run() {
                for (const name of ['townBand']) {
                    const r = await scene(name);
                    const frames = r.meta.music?.frames || [];
                    const chords = frames.flatMap(f => f.chords.map(c => ({ t: c.time, root: c.rootPc, pcs: c.pcs }))).sort((a, b) => a.t - b.t);
                    const playing = t => frames.some(f => t >= (f.chords[0]?.time ?? Infinity) && t < f.until);
                    const cues = r.meta.scheduled.filter(s => !s.silent && ROUTINE_KINDS.has(s.kind)).flatMap(s => s.notes.map((t, i) => ({ t, midi: Number.isFinite(s.hz[i]) ? hzToMidi(s.hz[i]) : null, kind: s.kind }))).filter(c => c.midi != null && playing(c.t));
                    const j = cueClash(cues, chords);
                    verdict('score', j.checked > 0 && j.clashes === 0, `${name}: routine-cue notes over the sounding chord (MusicClock frames): ${j.clashes} clashes of ${j.checked} (${fmt(j.pct)} %); want 0 %`);
                }
            },
        });
        units.push({
            name: `score (6.5: ${SCORE_HOURS}-hour seeded Town band, headless)`,
            async run() {
                const t0 = Date.now();
                const sim = townBandHours({ hours: SCORE_HOURS, seed: SEED });
                const own = sim.marks.filter(m => m.kind === 'rendition');
                const ownGap = identicalRenditionGap(own.map(m => ({ piece: m.piece, t: m.t, key: m.key })));
                const notes = noteRows(sim.marks).filter(n => n.seat !== 'percussion');
                const beatSec = Object.fromEntries(sim.marks.filter(m => m.kind === 'loop').map(m => [m.piece, m.beatSec]));
                const derived = identicalRenditionGap(renditions(notes, { beatSec }));
                const pass = own.length > 0 && ownGap.minGapSec >= L.renditionGapSec && derived.minGapSec >= L.renditionGapSec;
                verdict('score', pass, `${SCORE_HOURS} h of the Town band (seed ${SEED}, ${fmt((Date.now() - t0) / 1000, 1)} s): ${own.length} 16-bar renditions; nearest identical pair ${fmt(ownGap.minGapSec / 60, 1)} min by the sequencer's keys, ${fmt(derived.minGapSec / 60, 1)} min by the analyzer's (notes on the sixteenth grid; ${derived.pairs.length} identical pairs in all); want ≥ 60 min`);
                const loops = loopsPerPieceHour(own.map(m => ({ piece: m.piece, t: m.t, key: m.key })));
                const vis = visitRows(sim.marks, sim.seconds);
                const returns = earlyReturns(vis.pieces, { setSize: PLAYLISTS.day.length });
                verdict('townband', loops.pass && returns.pass, `${SCORE_HOURS} h headless: loops (identical renditions) per piece per hour worst ${loops.worst.loops} (${loops.worst.piece ?? '—'}); early returns ${returns.returns.length} (nearest ${fmt(returns.minGapSec / 60, 1)} min); want ≤ ${L.loopsPerPieceHour} and none < ${returns.minSec / 60} min`);
                const hour = notes.filter(n => n.t < 3600);
                const on = coveredSpans(vis.visits, 0, 3600);
                const tonal = tonalReheard(hour, on);
                const phrase = phraseReheard(hour, on);
                info('score', `Town band hour 1 (headless, from notes): tonal re-heard ${fmt(tonal.pct)} % of ${tonal.windows} windows, phrase ${fmt(phrase.pct)} % of ${phrase.grams} grams; motif statements ${motifStatements(hour).count} in the hour (Willowbrook's own opening included)`);
            },
        });
    }
    if (has('townband')) {
        units.push({
            name: `townband (6.7: a ${TOWN_SESSION.seconds / 60}-min Town band session)`,
            async run() {
                const r = await renderOnce('music:town:session', townSessionScene());
                const end = r.meta.warmup + r.meta.seconds;
                const vis = visitRows(r.meta.music?.marks || [], end);
                const from = r.meta.warmup;
                const returns = earlyReturns(vis.pieces, { setSize: PLAYLISTS.day.length });
                verdict('townband', vis.pieces.length > 0 && returns.pass, `must-never 10 (Town band): ${vis.pieces.length} visits (${vis.pieces.map(v => v.piece).join(', ')}); early returns ${returns.returns.length}${returns.returns.length ? ` (${returns.returns.map(x => `${x.piece} after ${fmt(x.gapSec / 60, 1)} min`).join(', ')})` : ''}, nearest ${fmt(returns.minGapSec / 60, 1)} min; want none < ${returns.minSec / 60} min`);
                const pauses = [...vis.breaths.map(b => b.t), ...vis.interludes];
                const bw = breathsPerWindow(pauses, from, end);
                const breathLen = vis.breaths.map(b => b.until - b.t);
                const badBreath = breathLen.filter(s => Math.abs(s - L.breathSec) > L.breathTolSec);
                verdict('townband', bw.pass && badBreath.length === 0, `${vis.breaths.length} breaths (${fmt(Math.min(...breathLen), 3)}–${fmt(Math.max(...breathLen), 3)} s) and ${vis.interludes.length} interludes; 10-min windows without either: ${bw.empty.length} of ${bw.windows}; want ≥ 1 per 10 min, each breath ${L.breathSec} ± ${L.breathTolSec} s`);
                const duty = dutyOf(vis.visits.filter(v => v.what === 'piece' || v.what === 'interlude'), from, end);
                const interludeShare = dutyOf(vis.visits.filter(v => v.what === 'interlude'), from, end);
                verdict('townband', duty >= L.townDutyMin && interludeShare <= 0.15, `music duty ${pct(duty)} (interludes ${pct(interludeShare)} of the hour); want ≥ ${pct(L.townDutyMin)}, interludes ≤ 15 %`);
                // Tonal re-heard on 10-min windows (the basis of the SCN
                // 34.5 % baseline: each window measured on its own history);
                // the whole hour's figure is INFO.
                const tenMin = [];
                for (let a = from; a + 600 <= end + 1e-6; a += 600) {
                    const i = Math.round(a * r.sr);
                    const j = Math.round((a + 600) * r.sr);
                    tenMin.push(sessionMetrics(r.program.L.subarray(i, j), r.program.R.subarray(i, j), r.sr).repetition.dejaHeardPct);
                }
                const sm = sessionMetrics(r.program.L.subarray(Math.round(from * r.sr)), r.program.R.subarray(Math.round(from * r.sr)), r.sr);
                verdict('townband', tenMin.length > 0 && Math.max(...tenMin) <= L.townReheardMaxPct, `tonal re-heard in each of the six consecutive 10-min windows (each on its own history) ${tenMin.map(v => fmt(v, 0)).join('/')} %; want ≤ ${L.townReheardMaxPct} % in each (34.5 % in 10 min before)`);
                info('townband', `the whole hour's history: tonal re-heard ${fmt(sm.repetition.dejaHeardPct)} % of ${sm.repetition.tonalWindows} tonal windows (${fmt(sm.repetition.tonalPct)} % of windows tonal), phrase n-grams ${fmt(sm.repetition.ngram.reheardPct)} %`);
                const loops = loopsPerPieceHour(vis.renditions, { from });
                verdict('townband', loops.pass, `loops (identical 16-bar renditions) per piece in the hour: worst ${loops.worst.loops}${loops.worst.piece ? ` (${loops.worst.piece})` : ''} of ${vis.renditions.length} renditions; want ≤ ${L.loopsPerPieceHour}`);
                const lou = loudness(r.program.L.subarray(Math.round(from * r.sr)), r.program.R.subarray(Math.round(from * r.sr)), r.sr);
                const t = LOUDNESS_TARGETS.townBand;
                verdict('townband', Math.abs(lou.integrated - t.lufsI) <= t.toleranceLu, `session LUFS-I ${fmt(lou.integrated)} (${r.sr / 1000} kHz render; the 48 kHz 3-min scene is judged in \`scenes\`); want ${t.lufsI} ± ${t.toleranceLu}`);
                const full = loudness(r.program.L, r.program.R, r.sr);
                const call = r.meta.scheduled.find(s => s.kind === 'summons' && !s.silent && s.t >= r.meta.warmup + TOWN_SESSION.waitAt - 0.1);
                const win = laneWindow('needsYou', 'music');
                const margin = call ? marginAt(full.momentaryCurve, call.notes[0], MUSIC_MARGIN).margin : null;
                info('townband', `needs-you at ${TOWN_SESSION.waitAt / 60} min over the band: ${signed(margin)} LU in the ${r.sr / 1000} kHz session (the bell's partials above ${r.sr / 2000} kHz are cut here; judged at 48 kHz below)`);
                const { rows } = await marginBed('music', ['needsYou']);
                const j = judgeLane('needsYou', 'music', rows, { probeBed: 'music' });
                verdict('townband', j.outcome === 'PASS', `needs-you over the Town band (the \`margins\` needs-you render over music, 48 kHz): median ${signed(j.margin)} LU, want ${signed(win.min, 0)}…${signed(win.max, 0)} (S2 over music)${j.failures.length ? ` — ${j.failures.map(f => f.what).join(', ')}` : ''}`);
            },
        });
        units.push({
            name: 'townband (6.7 MUS-9: the waiting cadence)',
            async run() {
                const r = await renderOnce('music:town:wait', waitCadenceScene());
                const w = WAIT_CADENCE;
                const at = x => r.meta.warmup + x;
                // The band decides a phrase end's cadence when it compiles the
                // phrase end's 4-bar chunk (CHUNK_BARS, 1.5 s ahead of the
                // chunk), so a wait changes the phrase ends compiled after the
                // director's setWaiting reached it — up to a chunk and the
                // horizon later than the wait. The marks are in the order the
                // band made them: a cadence is judged by the call before it.
                const marks = (r.meta.music?.marks || []).filter(m => m.preset === 'townBand');
                const waitCall = marks.findIndex(m => m.kind === 'call:setWaiting' && m.arg === true);
                const answerCall = waitCall < 0 ? -1 : marks.findIndex((m, i) => i > waitCall && m.kind === 'call:setWaiting' && m.arg === false);
                const cadences = marks.map((m, i) => ({ ...m, i })).filter(m => m.kind === 'cadence');
                const before = cadences.filter(c => c.i < waitCall && c.t >= at(w.waitAt));
                const during = cadences.filter(c => c.i > waitCall && (answerCall < 0 || c.i < answerCall));
                const after = answerCall < 0 ? null : cadences.find(c => c.i > answerCall);
                // The director tells the band on its next 1 s tick (a render step of slack).
                const told = i => (i >= 0 ? marks[i].t - r.meta.warmup : null);
                const prompt = (i, sec) => told(i) != null && told(i) - sec <= 1.05;
                const pass = prompt(waitCall, w.waitAt) && prompt(answerCall, w.answerAt) && during.length > 0 && during.every(c => c.deceptive) && after?.type === 'home';
                const line = c => `${c.type} (${c.piece} bar ${c.bar} at ${fmt(c.t - r.meta.warmup, 1)} s)`;
                verdict('townband', pass, `a needs-you open ${w.waitAt}–${w.answerAt} s (the band told at ${fmt(told(waitCall), 2)} s, the answer at ${fmt(told(answerCall), 2)} s): phrase ends compiled while waiting ${during.map(line).join(', ') || 'none'}${before.length ? ` (already compiled when the wait came: ${before.map(line).join(', ')})` : ''}; the first compiled after the answer ${after ? line(after) : 'none'}; want the band told within the director's 1 s tick, every phrase end compiled while waiting deceptive, home after`);
            },
        });
    }
    if (has('percussion')) {
        units.push({
            name: 'percussion (6.9: a 10-minute Town band busy sim)',
            async run() {
                const r = await renderOnce('music:town:percussion', percussionScene());
                const marks = r.meta.music?.marks || [];
                const from = r.meta.warmup;
                const end = from + r.meta.seconds;
                // Judged on the bars that can drum (piece passes); each bar's
                // kit level in units of the piece's own rows (probe-wave6).
                const all = percussionPerBar(marks, { from, to: end, rowsOf: name => PIECES.find(p => p.name === name)?.percussion ?? null });
                const bars = all.filter(b => b.capacity > 0);
                const rho = spearman(bars.map(b => b.level), bars.map(b => b.density));
                const mean = (x, f) => x.reduce((a, b) => a + f(b), 0) / Math.max(1, x.length);
                const bySeg = PERCUSSION_SEGMENTS.map(s => { const x = bars.filter(b => b.from >= from + s.from && b.from < from + s.to); return `${s.from / 60}–${s.to / 60} min level ${fmt(mean(x, b => b.level), 2)} (${fmt(mean(x, b => b.onsets), 1)} hits/bar; ${[...new Set(x.map(b => b.piece))].join(', ') || '—'}) at density ${fmt(mean(x, b => b.density), 2)}`; });
                verdict('percussion', rho != null && rho >= L.spearmanMin, `workshop kit per bar, in units of each building's row in the piece, vs the total workshop density the band read, over ${bars.length} piece bars (${all.length - bars.length} tag/interlude bars play no kit): Spearman ${fmt(rho, 2)} (${bySeg.join('; ')}); want ≥ ${L.spearmanMin}`);
                // working === 0 from the last segment: the director's first
                // zero-density call, plus the horizon a chunk was compiled in.
                const lastSeg = PERCUSSION_SEGMENTS[PERCUSSION_SEGMENTS.length - 1];
                const zeroCall = marks.find(m => m.kind === 'call:setWorkshopDensity' && m.t >= from + lastSeg.from - 1 && Object.keys(m.arg || {}).length === 0);
                const zeroFrom = (zeroCall?.t ?? from + lastSeg.from) + 1.5;
                const late = marks.filter(m => m.kind === 'perc' && m.t >= zeroFrom);
                verdict('percussion', zeroCall != null && late.length === 0, `working === 0 from ${fmt(lastSeg.from, 0)} s: the director's densities empty at ${fmt(zeroCall?.t - from, 1)} s; percussion hits after it (+1.5 s horizon) ${late.length}; want 0`);
                const busySeg = PERCUSSION_SEGMENTS[2];
                const pairs = seatPairs(r, { from: from + busySeg.from, to: from + busySeg.to });
                const seats = seatLufs(pairs, r.sr);
                const reLead = re(seats.percussion, seats.lead);
                const [target, tol] = L.stems.percussion;
                verdict('percussion', reLead != null && Math.abs(reLead - target) <= tol, `busy segment: percussion stem ${lu(reLead)} LU re lead (lead ${fmt(seats.lead)}, percussion ${fmt(seats.percussion)} LUFS-I); want ${target} ± ${tol}`);
            },
        });
        units.push({
            name: 'percussion (6.9 MUS-16: rain re-dresses the band at a chunk boundary)',
            async run() {
                const r = await renderOnce('music:town:rain', rainSwitchScene());
                const marks = (r.meta.music?.marks || []).filter(m => m.preset === 'townBand');
                const changeAt = r.meta.warmup + RAIN_SWITCH_AT;
                const switches = marks.filter(m => m.kind === 'arrangement' && m.weather === 'rain').map(m => m.t);
                const boundaries = marks.filter(m => ['loop', 'chunk', 'interlude'].includes(m.kind)).map(m => m.t);
                const j = arrangementSwitch(switches, boundaries, changeAt);
                const call = marks.find(m => m.kind === 'call:setArrangement' && m.arg?.weather === 'rain');
                const played = marks.filter(m => m.kind === 'loop' || m.kind === 'chunk').filter(m => m.t >= (j.switchAt ?? Infinity)).map(m => m.arrangement?.weather);
                verdict('percussion', j.pass && played.length > 0 && played.every(w => w === 'rain'), `rain at ${fmt(RAIN_SWITCH_AT, 0)} s (the director asked at ${fmt(call ? call.t - r.meta.warmup : NaN, 2)} s): the arrangement switched at ${fmt(j.switchAt != null ? j.switchAt - r.meta.warmup : NaN, 2)} s, ${j.onBoundary ? 'on' : 'off'} a chunk boundary (the first after the change ${fmt(j.firstBoundary != null ? j.firstBoundary - r.meta.warmup : NaN, 2)} s); chunks after it ${played.join('/') || '—'}; want the first uncommitted boundary, rain from there`);
            },
        });
    }
    return units;
}

const coveredSpans = (visits, a, b) => visits.map(v => ({ from: Math.max(a, v.from), to: Math.min(b, v.to) })).filter(v => v.to > v.from);

// Wave-3 numbers shared between units (the cluster render feeds must-never 13).
const wave3 = { silent: {}, cluster: {} };

// Wave-2 numbers shared between units (bank reads the air and Town band renders).
const wave2 = {};

function judgeBankRows() {
    const sliceSites = (wave2.bakeTimers || []).concat(wave2.air?.timers || []).filter(t => /SampleBank\.js/.test(t.site));
    const sliceMax = sliceSites.length ? Math.max(...sliceSites.map(t => t.maxMs ?? 0)) : null;
    const slices = sliceSites.reduce((n, t) => n + t.fired, 0);
    for (const [label, stats] of [['after the air bake (engine unit)', wave2.air?.bank], ['Town band busy (3 min)', wave2.busyBank]]) {
        if (stats === undefined) continue;
        const j = judgeBank(stats, sliceMax);
        const clients = j.clients.map(c => `${c.name} ${fmt(c.bytes / 1048576, 2)}/${c.budget != null ? fmt(c.budget / 1048576, 1) : '—'} MiB`).join(', ');
        verdict('bank', j.pass, `${label}: resident ${stats ? fmt(stats.residentBytes / 1048576, 2) : '—'} MiB of ${fmt(MEMORY_BUDGET.totalBytes / 1048576, 0)} (${clients || 'no clients'}); ${stats?.bakes ?? '—'} bakes, ${stats?.evictions ?? '—'} evictions, ${stats?.pending ?? '—'} pending; bake slices ${slices} timed on the virtual clock, max ${fmt(sliceMax, 2)} ms real${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}; want each client and the total within MEMORY_BUDGET, slices ≤ 5 ms`);
    }
}

// ------------------------------------------------------------ Wave 7 units ----
function wave7Units(renderOnce) {
    const units = [];
    const L = WAVE7_LIMITS;
    const db = v => (Number.isFinite(v) ? `${fmt(v)} dBFS` : 'silence');
    if (has('signals')) {
        for (const open of [false, true]) {
            units.push({
                name: `signals (7.2: the Signals floor, busy${open ? ', a wait left open' : ''})`,
                async run() {
                    const r = await renderOnce(`signals:${open ? 'open' : 'answered'}`, signalsScene({ openWait: open }));
                    const x = signalsRows(r);
                    const tag = open ? 'busy, a wait left open' : 'busy';
                    const profile = r.meta.finalSnapshot?.preset ?? r.meta.finalSnapshot?.mode ?? '—';
                    verdict('signals', x.floorWindows > 0 && x.floorMaxDb < L.signalsFloorDbfs, `Signals (${tag}): loudest 400 ms window between cues ${db(x.floorMaxDb)} over ${x.floorWindows} windows; want < ${L.signalsFloorDbfs} dBFS (preset ${profile}; sounding kinds ${x.kinds.join(', ') || 'none'})`);
                    const floorRef = Number.isFinite(x.floorMaxDb) ? x.floorMaxDb : L.signalsFloorDbfs;
                    const call = x.calls[0];
                    verdict('signals', call != null && call.peakDb - floorRef >= L.callOverFloorDb, `Signals (${tag}): the needs-you call ${call ? db(call.peakDb) : 'never sounded'} (loudest 400 ms), ${call ? fmt(call.peakDb - floorRef) : '—'} dB over the floor (${db(x.floorMaxDb)}, counted at ${L.signalsFloorDbfs} dBFS when silent); want ≥ ${L.callOverFloorDb} dB`);
                    for (const a of x.arrivals) {
                        verdict('signals', a.caption != null && !a.sounded && a.peakDb < L.signalsFloorDbfs, `Signals (${tag}): the arrival at ${fmt(a.t - r.meta.warmup, 1)} s captioned ${a.caption ? `"${a.caption}"` : 'nothing'}${a.announceOnly ? ' (announceOnly)' : ''}, ${a.sounded ? 'sounded' : 'no sound'}, loudest 400 ms over the 3 s after ${db(a.peakDb)}; want a caption and no rise (< ${L.signalsFloorDbfs} dBFS)`);
                    }
                    if (!open) info('signals', `Signals (busy): the answered strike at ${x.answered.map(t => `${fmt(t - r.meta.warmup, 1)} s`).join(', ') || 'none'} (the needs-you is answered at ${SIGNALS_ANSWER_AT} s)`);
                    if (r.errors.length) info('signals', `page errors: ${r.errors.slice(0, 3).join(' | ')}`);
                },
            });
        }
    }
    if (has('awaken')) {
        units.push({
            name: 'awaken (7.4: the island awakens, virtual clock)',
            async run() {
                const r = await renderOnce('awaken', AWAKEN_SCENE);
                const x = awakenRows(r, { ...AWAKEN, stAtSec: L.awakenStAtSec });
                verdict('awaken', x.plays === 1, `awakenings in one page session (enable, then Off at ${AWAKEN.offAt} s and the Town band at ${AWAKEN.onAt} s): ${x.plays}${x.presets.length ? ` (${x.presets.join(', ')})` : ''}; want 1`);
                const under = x.callMMax != null && x.awakenMMax != null ? x.callMMax - x.awakenMMax : null;
                verdict('awaken', Number.isFinite(x.awakenMMax) && under != null && under >= L.awakenUnderCallLu, `the awakening's M max ${fmt(x.awakenMMax)} vs the needs-you call's ${fmt(x.callMMax)} LUFS (cue stem): ${fmt(under)} LU under; want ≥ ${L.awakenUnderCallLu}`);
                const d = x.stAt != null && x.steady != null ? x.stAt - x.steady : null;
                verdict('awaken', d != null && Math.abs(d) <= L.awakenStWithinDb, `program short-term ${L.awakenStAtSec} s after the enable ${fmt(x.stAt)} vs steady ${fmt(x.steady)} LUFS (energy mean over ${AWAKEN.steadyFrom}–${AWAKEN.steadyTo} s): ${signed(d)} dB; want within ±${L.awakenStWithinDb}`);
            },
        });
    }
    if (has('listening')) {
        units.push({
            name: 'listening (7.7: output, tone)',
            async run() {
                const busy = {};
                for (const output of ['speakers', 'mono']) busy[output] = outputRow(await renderOnce(`output:busy:${output}`, outputBusyScene({ output })));
                const d = busy.mono.lufsI - busy.speakers.lufsI;
                verdict('listening', Math.abs(d) <= L.monoCompLu && busy.mono.lrDiffDb < -90, `Mono vs Speakers (the Town band with cues): ${fmt(busy.mono.lufsI)} vs ${fmt(busy.speakers.lufsI)} LUFS-I (${signed(d, 2)} LU; compensation ${fmt(busy.mono.output?.monoCompDb, 2)} dB), mono L−R ${Number.isFinite(busy.mono.lrDiffDb) ? `max ${fmt(busy.mono.lrDiffDb)} dBFS` : 'identical'}; want within ±${L.monoCompLu} LU and L = R`);
                const t = {};
                for (const tone of [-1, 0, 1]) t[tone] = toneRow(await renderOnce(`tone:music:${tone}`, outputScene({ tone })));
                for (const tone of [-1, 1]) {
                    const hi = t[tone].highDb - t[0].highDb;
                    const lo = t[tone].lowDb - t[0].lowDb;
                    verdict('listening', Math.abs(hi - tone * L.toneShelfDb) <= L.toneTolDb && Math.abs(lo) <= L.toneLowTolDb, `tone ${signed(tone, 0)} on the Town band: 5–10 kHz ${signed(hi, 2)} dB, 100–1000 Hz ${signed(lo, 2)} dB vs tone 0 (engine tone ${fmt(t[tone].output?.toneDb, 1)} dB); want ${signed(tone * L.toneShelfDb, 0)} ± ${L.toneTolDb} dB above the shelf, within ±${L.toneLowTolDb} dB under it`);
                }
            },
        });
        units.push({
            name: 'listening (7.7: soften sudden sounds)',
            async run() {
                const off = softenRow(await renderOnce('soften:off', softenScene(false)));
                const on = softenRow(await renderOnce('soften:on', softenScene(true)));
                verdict('listening', on.bell?.riseMs != null && on.bell.riseMs >= L.softBellAttackMinMs, `Soften: the arrival bell's attack ${fmt(on.bell?.riseMs, 0)} ms (off ${fmt(off.bell?.riseMs, 0)} ms, −40 → −1 dB re peak); want ≥ ${L.softBellAttackMinMs} ms`);
                const pairs = on.ducks.map((d, i) => ({ d, o: off.ducks[i] })).filter(p => p.o && p.d.kind === p.o.kind && p.d.kind !== 'summons');
                const ratios = pairs.flatMap(({ d, o }) => Object.keys(o.depths).filter(k => o.depths[k] < 0).map(k => ({ kind: d.kind, bus: k, ratio: (d.depths[k] ?? 0) / o.depths[k] })));
                const bad = ratios.filter(x => Math.abs(x.ratio - L.softDuckScale) > L.softDuckTol);
                verdict('listening', ratios.length > 0 && bad.length === 0, `Soften: ${ratios.length} duck depths of non-needs-you cues at ${[...new Set(ratios.map(x => fmt(x.ratio, 2)))].join('/') || '—'} × their depth off (${[...new Set(pairs.map(p => p.d.kind))].join(', ') || 'none paired'}); want ${L.softDuckScale} ± ${L.softDuckTol}${bad.length ? ` — ${bad.slice(0, 3).map(x => `${x.kind} ${x.bus} ×${fmt(x.ratio, 2)}`).join(', ')}` : ''}`);
                const dc = on.callMMax != null && off.callMMax != null ? on.callMMax - off.callMMax : null;
                verdict('listening', dc != null && Math.abs(dc) <= L.callWholeLu, `Soften: the needs-you call's M max ${fmt(on.callMMax)} vs ${fmt(off.callMMax)} LUFS off (${signed(dc, 2)} LU); want whole, within ±${L.callWholeLu} LU`);
            },
        });
    }
    return units;
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
        if (has('awakening')) {
            appUnits.push({ name: 'app first enable (awakening, 7.4)', check: 'awakening', run: async () => judgeAwakening(await appAwakeningUnit(await appB(), reporter), reporter, WAVE7_LIMITS) });
        }
        if (has('captionprobe')) {
            appUnits.push({ name: 'app captions with sound off (captionprobe)', check: 'captionprobe', run: async () => judgeCaption(await appCaptionUnit(await appB(), reporter), reporter) });
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
    const warned = results.filter(r => r.warn);
    if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'probe-report.json'), JSON.stringify({ seed: SEED, planStage: PLAN_STAGE, jobs: JOBS, only: ONLY, soak: Boolean(args.soak), seconds: (Date.now() - t0) / 1000, programTrimDb: PROGRAM_TRIM_DB, targets: LOUDNESS_TARGETS, summary, results }, null, 2));
    }
    console.log(`\naudio:probe ${failed.length ? 'FAILED' : 'passed'} at plan stage ${PLAN_STAGE}: ${passed.length} pass, ${failed.length} fail, ${deferred.length} deferred, ${warned.length} warned in ${((Date.now() - t0) / 1000).toFixed(0)} s (seed ${SEED}, --jobs ${JOBS}${args.soak ? ', --soak' : ''})`);
    for (const f of failed) console.log(`  FAIL ${f.check}: ${f.detail}`);
    for (const d of deferred) console.log(`  DEFER ${d.check} (Wave ${d.deferred}): ${d.detail}`);
    for (const w of warned) console.log(`  WARN ${w.check}: ${w.detail}`);
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
