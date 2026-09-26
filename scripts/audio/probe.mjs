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
// plus the Wave-0 checks on the live app. Checks (PASS/FAIL/INFO lines; any
// FAIL exits 1; WARN flags a finding that is not a verdict):
//   scenes       S2 scene targets (Loudness.js) at the standard step: anchor,
//                village busy, Town band, rain, storm, resting, the night
//                program vs noon (Wave 6); HAR-5 stems
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
//   noise        2.5 / C-AMB-3: texture autocorrelation (the sea too), bed
//                ICC and mono fold (night and storm too), lanes
//                on one pool buffer ≥ 5 s apart, the pool's budget
//   bank         2.6: resident bytes vs MEMORY_BUDGET, bake slices ≤ 5 ms
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
//   worldmap     4.5 / S2 / S7: the 72-scene world map (4 phases × 6 weathers ×
//                resting / 3 / 12 working, 30 s, the program = the world
//                stratum) vs its S2 rows relative to A and the day arc's
//                share; must-never 7 (night/weather ≤ day + 6 LU); night
//                2–5 kHz ≥ 4 dB under noon; ambient onsets ≤ 180/min; the
//                world stem at 3 vs 12 and the CPU offline proxy (INFO)
//   worldstem    S6 / C-AMB-1: the world stem at 0 vs 12 working, one seed,
//                identical within renderer noise (max |Δ| ≤ 1e-6 or ≤ a
//                same-count repeat's)
//   sea          4.1: the day sea 2–6 LU under A, ICC and r(4 s), breaks per
//                minute, the night bed's 250 Hz–1 kHz gain, gulls roost,
//                hull groans off 500–700 Hz, nodes only per rare take
//   thunder      4.2: near/far LU from the onset, onset delay after the
//                flash, monotonic in intensity, GR, fresh grain, no duck
//   masking      must-never 8: needs-you and error inside a thunder roll
//                and over rain keep their S2 floors
//   crest        4.6: a cue whose first note lands on a sea crest keeps its
//                S2 margin (night Village bed, storm)
//   workshops    5.1: the FOL reference scene's Forge (longest gap, stop vs
//                the first non-working observation, no accent from a stale
//                smith), zero onsets from stale agents, idle and a lost
//                link, strikes vs drawn downbeats in World (median / p95)
//                and the poll-lock pulse index, node creations per take,
//                main-thread cost per tick (INFO)
//   worklevel    5.3: the reference scenes by day (the stratum as ctx − env
//                of two sample-aligned renders): work bed ≤ program − 8 LU,
//                program Δ, work TP under the quietest urgent cue, accents
//                heard per building, onset-weighted 2–5 kHz share, onsets
//                in any 1 s, routine-cue margin loss
//   workslots    5.4: two smiths on two pitches, focus +4 dB, a needs-you
//                from another agent unchanged
//   worknight    5.5: accents heard per building over the night environment
//   quietmix     5.6 (D3): blur in Village (music 0, world and work ×0.5,
//                ghosts off, held note and signals untouched), Town band
//                −3 dB with no work stratum (D4), focus restores in ≤ 1 s
//   quota        5.7: the mine's 80–160 Hz band over a 0.7 → 1.0 sweep, no
//                cue, silent when the quota goes stale
//   camera       5.8: a pan across the Harbor — its workshop and sea pans
//                through 0 within 0.6 s of the camera, steps ≤ 0.2, zero
//                writes while still
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
    BASELINE_TOLERANCE, CROWN_SYNC_MS, CUE_STRATUM, HELD_NOTE, ISLAND_AIR, LADDER, MUST_NEVER_7_LU, NOISE_LIMITS, PLAN_STAGE, SEA_LIMITS, THUNDER_LIMITS, URGENT_LANES, WORLD_STEM_MAX_ABS, bakeLandingDiffs,
    beatingDepthDb, compareBaseline, expectedLadder, groanViolations, heldNoteRise, judgeAirT60, judgeBank, judgeCaptionParity, judgeCluster, judgeDiscrimination,
    judgeDuckedTime, judgeHeldTrim, judgeLadder, judgeLane, judgeOnsetBudget, judgeSceneTargets, judgeThunder, judgeTransport, judgeWakes,
    judgeWorldMap, judgeWorldStem, median, nightWeatherOverDay, noiseLaneConflicts, onsetNear, presenceUnderNoon, waitAudibleWindows, withinRange, worldStemDiffers,
    WORK_BANDS_DAY, WORK_BANDS_NIGHT, WORK_LIMITS, downbeatSync, judgeCameraPan, judgeFocus, judgeHeard, judgeQuietMix, judgeQuotaSweep, judgeWorkLevel, longestGap,
    maxOnsetsIn, pulseIndex, quietStemRow, signCrossing, stopTiming, targetTrajectory,
    D1_DUTY, MUSIC_LIMITS, arrangementSwitch, bandStep, breathsPerWindow, coveredSec, earlyReturns, judgeDuty, judgeIsleArm, judgeStemBalance, laneWindow,
    loopsPerPieceHour, musicInWindows, nightDarker, perHourMax, spearman,
} from './lib/checks.mjs';
import {
    AIR_CUE_SCENE, CAPTION_SETTINGS, DASHBOARD_SCENE, GALLERY_VOICES, HELD_ANSWER_SEC, HELD_OPEN_SEC, LADDER_OPEN_SEC, LADDER_SECONDS, LADDER_TRIM_SCENE,
    LONG_WAIT_SCENE, LONG_WAIT_SECONDS, MARGIN_BEDS, MARGIN_LANES, OUTCOME_SCENE, STALE_SCENE, TEXTURE_SCENES, TRANSPORT_SCENE,
    VILLAGE_DRY_SCENE, WAKE_SCENE, captionScene, clusterScene, galleryScene, heldNoteScene, hiddenScene, ladderSilentScene,
    CREST_BEDS, CREST_WINDOW, MAP_LOADS, MAP_PHASES, MAP_SECONDS, MAP_WEATHERS, MASKING_SCENE, NIGHT_BED_NO_SEA, SEA_NIGHT_SCENE, SEA_RARE_SCENE,
    SILENT_ISLAND_SCENE, THUNDER_INTENSITIES, THUNDER_SCENE, WORLD_STEM_FIXTURES, WORLD_STEM_SECONDS, crestCalibration, crestPlaced, crestScene,
    worldMapCells, worldStemScene,
    AUDIBILITY_SECONDS, CAMERA_PAN, QUIET_MIX, QUOTA_STALE_AT, QUOTA_STEPS, WORK_HONESTY, WORK_HONESTY_SCENE, WORK_PATTERNS, WORK_POLL, WORK_SLOTS,
    audibilityScene, cameraScene, quietMixScene, quotaScene, workDownbeatScene, workSlotsScene, workshopScene,
    PERCUSSION_SEGMENTS, RAIN_SWITCH_AT, TOWN_SESSION, VILLAGE_FIXTURES, VIRTUAL_DAY, WAIT_CADENCE, musicStemScene, percussionScene, rainSwitchScene,
    townSessionScene, villageMusicScene, waitCadenceScene,
} from './lib/scenes.mjs';
import {
    captionRows, clusterRow, crownRow, galleryRows, heldNoteRows, heldWhileMusic, ladderCalls, ladderCaptioned, ladderTrimRows, laneEvents, wakeRows,
} from './lib/probe-wave3.mjs';
import { renderSilent, renderVirtual } from './lib/virtual.mjs';
import { discriminationMatrix } from './metrics/discrim.mjs';
import {
    avSyncRows, duckRows, laneMarginRows, limiterUnitRows, makeRenderer, marginRows, renderLimiterUnit, sceneLevelMap,
    sceneMetrics, sceneSpec, stemReport, switchRows,
} from './lib/probe-virtual.mjs';
import {
    bandLevelDb, concurrentOverBedLu, crestGap, firstDivergenceSec, loudestCrest, maxSampleDiff, seaStemRow, thunderRows, worldBandDb, worldCellRow,
} from './lib/probe-wave4.mjs';
import {
    HARBOR_WORLD, accentGainOffsetDb, cameraPanTarget, downbeatRows, forgeRow, ghostsIn, heardRows, honestyRows, levelDiffCurve, offsetStepDb, onsetShare25, pairedGainDiffs,
    onsetsOf, placementLogRows, quotaRows, routineLossRows, slotRows, strikesOf, tickRows, urgentTpRows, workLevelRow,
} from './lib/probe-wave5.mjs';
import {
    airRows, arrivalDrRows, bedRows, pauseRows, renderAir, textureRows, transportRows, urgentWetRows,
} from './lib/probe-wave2.mjs';
import {
    appBusyUnit, appCeremonyUnit, appContinuityUnit, appFrameCostUnit, judgeBusy, judgeCeremony, judgeContinuity, judgeFrameCost, lintUnits,
} from './lib/probe-app.mjs';
import {
    OCTAVE_CENTERS, bandRows, armRow, densityTrack, dutyOf, heardSpans, nodesPerNoteRow, noteRows, percussionPerBar, seatLufs, seatPairs, stopLevels,
    sumOf, toOutput, visitRows,
} from './lib/probe-wave6.mjs';
import { townBandHours, villageDay } from './lib/music-sim.mjs';
import {
    cueClash, identicalRenditionGap, motifStatements, parallelPerfects, phraseReheard, range, renditions, seatLine, tonalReheard,
} from './score-analyzer.mjs';
import { loudness } from './lib/analyze.mjs';
import { marginAt } from './lib/timeline.mjs';
import { sessionMetrics } from './metrics/session-metrics.mjs';
import { outputGainDb } from './lib/probe-wave5.mjs';
import { runSoak } from './lib/soak.mjs';
import { FRAGMENTS, PIECES, PLAYLISTS } from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';
import { voicingFor } from '../../claudeville/src/presentation/shared/audio/music/Voicings.js';
import { D1_DUTY as OCC_DUTY, RING_OUT_SEC as OCC_RING_OUT_SEC, dutyBandFor } from '../../claudeville/src/presentation/shared/audio/OccasionClock.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { AUDIBILITY_WINDOWS, LIMITER_CEILING_DBFS, LOUDNESS_TARGETS, MEMORY_BUDGET, PROGRAM_TRIM_DB, STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';

const APP_CHROME_ARGS = ['--autoplay-policy=user-gesture-required', ...BACKGROUND_ARGS];
const BASELINE_FILE = path.join(AUDIO_DIR, 'baselines/scenes.json');
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
const VIRTUAL_CHECKS = ['scenes', 'margins', 'limiter', 'switch', 'ducks', 'avsync', 'determinism', 'baseline', 'transport', 'pause', 'air', 'noise', 'bank', 'discrim', 'ladder', 'cluster', 'heldnote', 'outcomes', 'captions', 'honesty', 'worldmap', 'worldstem', 'sea', 'thunder', 'masking', 'crest', 'workshops', 'worklevel', 'workslots', 'worknight', 'quietmix', 'quota', 'camera', 'musicstems', 'isleband', 'nightmusic', 'score', 'occasions', 'townband', 'percussion'];
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
                // S2's night row with its occasion: the program at night and
                // at noon, same load, music at its default (Wave 6 owns it).
                for (const name of ['nightProgram', 'noonProgram']) {
                    const r = await scene(name);
                    const m = sceneMetrics(r);
                    const presenceDb = bandLevelDb({ L: r.program.L.subarray(Math.round(r.meta.warmup * r.sr)), R: r.program.R.subarray(Math.round(r.meta.warmup * r.sr)) }, r.sr, 2000, 5000);
                    measured[name] = { lufsI: m.lufsI, presenceDb };
                    summary[`scene:${name}`] = { lufsI: m.lufsI, stMax: m.stMax };
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
    // Uncached renders (the 72-cell map and one-off scenes): each is reduced
    // to numbers inside its unit, so its PCM never outlives it.
    const renderOnce = async (key, spec) => {
        const r = await renderVirtual(browser, baseUrl, { ...spec, name: key, noWorklets: NO_WORKLETS }, { seed: SEED });
        keep(key, r);
        return r;
    };
    // HAR-3: each lane over each probe bed from its own render (the bed
    // under a placement depends on the cues before it; lib/scenes.mjs
    // marginScene), reduced to its rows and, for urgent lanes, the cue's true
    // peak at the output; shared by margins, masking, worklevel and townband.
    const laneMemo = new Map();
    const marginLane = (bedName, lane) => {
        const key = `margin:${bedName}:${lane}`;
        if (!laneMemo.has(key)) {
            laneMemo.set(key, renderOnce(key, sceneSpec(key)).then(r => ({
                rows: marginRows(r, bedName), errors: r.errors,
                urgentTp: URGENT_LANES.includes(lane) ? urgentTpRows(r, [lane])[0] : null,
            })));
        }
        return laneMemo.get(key);
    };
    const marginBed = async (bedName, lanes = MARGIN_LANES) => {
        const each = [];
        for (const lane of lanes) each.push(await marginLane(bedName, lane));
        return { rows: each.flatMap(x => x.rows), errors: each.flatMap(x => x.errors), urgentTp: each.map(x => x.urgentTp).filter(Boolean) };
    };
    if (has('margins') || has('baseline')) {
        for (const bedName of Object.keys(MARGIN_BEDS)) {
            units.push({
                name: `margins over ${bedName}`,
                async run() {
                    const { rows, errors } = await marginBed(bedName);
                    for (const lane of MARGIN_LANES) {
                        const placements = rows.filter(x => x.lane === lane);
                        const j = judgeLane(lane, MARGIN_BEDS[bedName].bed, placements, { probeBed: bedName });
                        summary[`margin:${bedName}:${lane}`] = { margin: j.margin };
                        if (!has('margins')) continue;
                        const win = `${j.window.min != null ? `≥ ${signed(j.window.min, 0)}` : ''}${j.window.min != null && j.window.max != null ? ', ' : ''}${j.window.max != null ? `≤ ${signed(j.window.max, 0)}` : ''}`;
                        const each = placements.map(p => signed(p.margin)).join(' / ');
                        const trims = placements.map(p => signed(p.trimDb)).join(' / ');
                        const extra = j.gr != null ? `; ${MARGIN_BEDS[bedName].bed === 'music' ? `presence rise ${fmt(j.band)} dB` : `${fmt(j.band, 0)} bands ≥ +6 dB`}, GR ${fmt(j.gr)} dB` : '';
                        const why = j.failures.map(f => (f.gatedFrom > PLAN_STAGE ? `${f.what} (Wave ${f.gatedFrom})` : f.what)).join(', ');
                        outcome('margins', j.outcome, `${lane} over ${bedName}: median ${signed(j.margin)} LU (${each}; cue trims ${trims} dB, ${j.n} admitted), want ${win}${extra}${why ? ` — ${why}` : ''}`, Math.max(...j.failures.map(f => f.gatedFrom), 0));
                    }
                    // S2: a Minor outcome also sits ≥ 3 LU under the routine cue,
                    // both as the cue's own level over the bed stems.
                    if (has('margins')) {
                        const stemMedian = lane => median(rows.filter(x => x.lane === lane).map(x => x.stemMargin));
                        const minor = stemMedian('outcomeMinor');
                        const routine = stemMedian('routine');
                        const under = minor != null && routine != null ? routine - minor : null;
                        verdict('margins', under != null && under >= 3, `outcome Minor under routine over ${bedName} (cue stem over the bed stems): ${fmt(under)} LU (turn done ${signed(minor)} vs arrival ${signed(routine)}); want ≥ 3`);
                        // Would the stem measure flip any other lane's verdict?
                        const flips = MARGIN_LANES.filter(l => l !== 'outcomeMinor').map((lane) => {
                            const placements = rows.filter(x => x.lane === lane);
                            const a = judgeLane(lane, MARGIN_BEDS[bedName].bed, placements, { probeBed: bedName }).outcome;
                            const b = judgeLane(lane, MARGIN_BEDS[bedName].bed, placements.map(p => ({ ...p, margin: p.stemMargin })), { probeBed: bedName }).outcome;
                            return a !== b ? `${lane} ${a}→${b} (${signed(median(placements.map(p => p.margin)))} → ${signed(median(placements.map(p => p.stemMargin)))} LU)` : null;
                        }).filter(Boolean);
                        info('margins', `${bedName}: the cue-stem-over-bed-stems margin for every lane (judged for Minor outcomes only): ${MARGIN_LANES.map(l => `${l} ${signed(stemMedian(l))}`).join(', ')}; verdicts it would flip: ${flips.join('; ') || 'none'}`);
                    }
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
    units.push(...wave4Units(render, renderOnce, scene, marginBed));
    units.push(...wave5Units(render, renderOnce, scene, marginBed));
    units.push(...wave6Units(render, renderOnce, scene, marginBed));
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
                for (const name of ['anchor', 'rain', 'storm', 'nightClear', 'villageBusy']) renders[name] = await scene(name);
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
                // C-AMB-3 (2.5, 4.3): the world bed by day, at night (the sea
                // forward), in rain and in the storm.
                for (const name of ['anchor', 'nightClear', 'rain', 'storm']) {
                    const b = bedRows(renders[name]);
                    verdict('noise', b.worldIcc >= NOISE_LIMITS.icc.min && b.worldIcc <= NOISE_LIMITS.icc.max, `${name} world bed ICC ${fmt(b.worldIcc, 3)} on 60 s; want ${NOISE_LIMITS.icc.min}–${NOISE_LIMITS.icc.max}`);
                }
                for (const name of ['anchor', 'nightClear', 'rain', 'storm', 'villageBusy']) {
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
                const music = await render('held:music', heldNoteScene({ working: 4, music: true, answerAt: null, seconds: 50 }));
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

// ------------------------------------------------------------ Wave 4 units ----
// Wave-4 numbers shared between units: the map's cells (judged after the
// pool, when every phase has landed) and the anchor they are relative to.
const wave4 = { cells: [], A: null };
const cellLabel = c => `${c.phase} ${c.weather} ${c.load === 'resting' ? 'resting' : c.load.slice(1)}`;

function wave4Units(render, renderOnce, scene, marginBed) {
    const units = [];
    const anchorA = async () => (wave4.A ??= sceneMetrics(await scene('anchor')).lufsI);
    if (has('worldmap')) {
        const cells = worldMapCells();
        for (const phase of MAP_PHASES) {
            units.push({
                name: `worldmap (${phase}: ${Object.keys(MAP_WEATHERS).length} weathers × ${Object.keys(MAP_LOADS).length} loads, ${MAP_SECONDS} s each)`,
                async run() {
                    await anchorA();
                    // S6 across the map: each 12-working cell's world stem
                    // against the 3-working render of its phase and weather.
                    let three = null;
                    for (const c of cells.filter(x => x.phase === phase)) {
                        const r = await renderOnce(c.key, c.spec);
                        const row = { phase: c.phase, weather: c.weather, load: c.load, ...worldCellRow(r) };
                        if (c.load === 'w3') three = r.stems.world;
                        if (c.load === 'w12') { row.worldMaxAbs = three ? maxSampleDiff(three, r.stems.world) : null; three = null; }
                        wave4.cells.push(row);
                        summary[c.key] = { lufsI: row.lufsI };
                    }
                },
            });
        }
    }
    if (has('worldstem')) {
        for (const fixture of Object.keys(WORLD_STEM_FIXTURES)) {
            units.push({
                name: `worldstem (${fixture}: 0 vs 12 working)`,
                async run() {
                    const none = await renderOnce(`worldstem:${fixture}:0`, worldStemScene(fixture, 0));
                    const busy = await renderOnce(`worldstem:${fixture}:12`, worldStemScene(fixture, 12));
                    const again = await renderOnce(`worldstem:${fixture}:12#2`, worldStemScene(fixture, 12));
                    const d = maxSampleDiff(none.stems.world, busy.stems.world);
                    const noise = maxSampleDiff(busy.stems.world, again.stems.world);
                    const j = judgeWorldStem(d, { noise });
                    const work = sceneMetrics(busy).lufsI - sceneMetrics(none).lufsI;
                    const e = x => (x === Infinity ? 'length differs' : x.toExponential(2));
                    verdict('worldstem', j.pass, `S6 / C-AMB-1, ${fixture}: world stem at 0 vs 12 working agents (same seed, no cue scheduled, ${WORLD_STEM_SECONDS + 2} s from the enable — before the empty village rests): ${j.identical ? 'bit-identical' : `max |Δ| ${e(d)}`}; the renderer's own noise (12 vs 12 again) ${e(noise)}; program Δ ${signed(work, 2)} LU from the work stratum; want identical within renderer noise, max |Δ| ≤ ${j.max.toExponential(0)} (−120 dBFS) or ≤ the repeat's. The sea's yield to scheduled cues (4.6, AMB-9) is the sanctioned cue coupling, not agent state`);
                    // Where two renders part, and which bakes landed at other
                    // audio times: the renderer's known nondeterminism.
                    const attribute = (x, y) => {
                        const from = firstDivergenceSec(x.stems.world, y.stems.world, x.sr, WORLD_STEM_MAX_ABS);
                        const landed = bakeLandingDiffs(x.meta.bakes || [], y.meta.bakes || []);
                        const live = (x.meta.workletNodes || []).filter(w => w.t > 0);
                        const liveLine = live.length ? `AudioWorkletNodes built mid-render (their processors start on an audio-thread race): ${live.slice(0, 6).map(w => `${w.name} at ${fmt(w.t, 3)} s`).join(', ')}` : 'no AudioWorkletNode built mid-render';
                        return `first over ${WORLD_STEM_MAX_ABS.toExponential(0)} at ${fmt(from, 3)} s; bakes landing at different audio times: ${landed.length ? landed.slice(0, 6).map(b => `${b.key} ${fmt(b.a, 3)} vs ${fmt(b.b, 3)} s`).join(', ') : `none of ${(x.meta.bakes || []).length}`}; ${liveLine}`;
                    };
                    if (noise > WORLD_STEM_MAX_ABS) warn('worldstem', `${fixture}: two renders of one scene (12 working, one seed) differ by max |Δ| ${e(noise)} (${fmt(20 * Math.log10(noise))} dBFS) — renderer nondeterminism, not float noise; ${attribute(busy, again)}`);
                    if (!j.pass) info('worldstem', `${fixture}, 0 vs 12: ${attribute(none, busy)}`);
                },
            });
        }
    }
    if (has('sea')) {
        units.push({
            name: 'sea (4.1: stem, texture, crests, rare voices)',
            async run() {
                const A = await anchorA();
                const day = seaStemRow(await render('texture:sea', TEXTURE_SCENES.sea.spec));
                const storm = seaStemRow(await render('texture:seaStorm', TEXTURE_SCENES.seaStorm.spec));
                const night = seaStemRow(await renderOnce('sea:night', SEA_NIGHT_SCENE));
                const rare = seaStemRow(await renderOnce('sea:rare', SEA_RARE_SCENE));
                const silentCpu = seaStemRow(await renderOnce('sea:silent', SILENT_ISLAND_SCENE)).cpuPct;
                const bed = await scene('nightClear');
                const [lo, hi] = SEA_LIMITS.nightGainBandHz;
                const gainDb = worldBandDb(bed, lo, hi) - worldBandDb(await renderOnce('sea:night-no-sea', NIGHT_BED_NO_SEA), lo, hi);
                const all = { day, night, storm, rare };
                const missing = Object.entries(all).filter(([, s]) => !s.snapshot).map(([k]) => k);
                verdict('sea', missing.length === 0, `SeaLayer snapshot (director.layers.sea.snapshot()) in ${4 - missing.length}/4 renders${missing.length ? `; missing in ${missing.join(', ')}` : ''}; want every render`);
                summary['sea:day'] = { lufsI: day.lufsOut };
                const under = A - day.lufsOut;
                verdict('sea', withinRange(under, SEA_LIMITS.underA), `day sea stem ${fmt(day.lufsOut)} LUFS-I at the output = ${fmt(under)} LU under A (${fmt(A)}); want ${SEA_LIMITS.underA.join('–')} under (ground, not figure)`);
                for (const [name, s] of [['day', day], ['night', night], ['storm', storm]]) {
                    verdict('sea', withinRange(s.icc, SEA_LIMITS.icc) && s.r4 < SEA_LIMITS.r4Max, `${name} sea (60 s alone): ICC ${fmt(s.icc, 3)}, r(4 s) ${fmt(s.r4, 3)} (peak ${fmt(s.peak?.r, 3)} at ${fmt(s.peak?.lagS, 2)} s), ${fmt(s.lufsOut)} LUFS-I at the output; want ICC ${SEA_LIMITS.icc.join('–')}, r(4 s) < ${SEA_LIMITS.r4Max}`);
                }
                verdict('sea', withinRange(day.breaksPerMin, SEA_LIMITS.breaksPerMin), `breaking waves by day: ${fmt(day.breaksPerMin)}/min (crests committed in the 60 s); want ${SEA_LIMITS.breaksPerMin.join('–')} (4.1: ~5)`);
                info('sea', `breaking waves: night ${fmt(night.breaksPerMin)}/min, storm ${fmt(storm.breaksPerMin)}/min (AMB-1 asks ${SEA_LIMITS.stormBreaksPerMin.join('–')} in a storm)`);
                verdict('sea', withinRange(gainDb, SEA_LIMITS.nightGainDb), `night bed, aggregate ${lo} Hz–${hi / 1000} kHz band energy, with the sea vs without it (nightClear, the sea forced to 0): ${signed(gainDb)} dB; want ${SEA_LIMITS.nightGainDb.map(v => `+${v}`).join('…')}`);
                const gulls = [night, storm].flatMap(s => s.rare.filter(v => v.kind === 'gull'));
                verdict('sea', gulls.length === 0, `gulls at night and in the storm: ${gulls.length}; want 0 (C-AMB-7: gulls roost)`);
                const rareAll = Object.values(all).flatMap(s => s.rare);
                const kinds = ['gull', 'clink', 'groan'].map(k => `${k} ${rareAll.filter(v => v.kind === k).length}`).join(', ');
                const groans = rareAll.filter(v => v.kind === 'groan');
                const bad = groanViolations(rareAll);
                if (groans.length) verdict('sea', bad.length === 0, `hull groans: ${groans.length}, resonances ${[...new Set(groans.flatMap(g => g.hz || []).map(h => Math.round(h)))].join(', ')} Hz; ${bad.length} inside ${SEA_LIMITS.groanForbiddenHz.join('–')} Hz; want none (S1, C-AMB-8)`);
                else info('sea', `no hull groan sounded in ${60 * 3 + 240} s of sea (the resonance rule is unexercised)`);
                const nodeRows = Object.entries(all).map(([k, s]) => ({ k, nodes: s.nodeCreations, takes: s.rare.length }));
                const over = nodeRows.filter(x => !(Number.isFinite(x.nodes) && x.nodes <= SEA_LIMITS.nodesPerTake * x.takes));
                verdict('sea', over.length === 0, `node creations after start: ${nodeRows.map(x => `${x.k} ${x.nodes ?? '—'} for ${x.takes} rare take(s)`).join(', ')} (rare voices: ${kinds}); want ≤ ${SEA_LIMITS.nodesPerTake} per take and 0 per wave (C-AMB-4)`);
                info('sea', `CPU offline proxy (render wall ÷ audio time, harness included): sea alone ${fmt(day.cpuPct, 2)} % by day, ${fmt(storm.cpuPct, 2)} % in the storm vs an island with every layer at 0 ${fmt(silentCpu, 2)} % → the sea ≈ ${fmt(day.cpuPct - silentCpu, 2)} / ${fmt(storm.cpuPct - silentCpu, 2)} % (4.1: ≤ 2 % on a quiet host; relative only)`);
            },
        });
    }
    if (has('thunder')) {
        units.push({
            name: `thunder (4.2: ${THUNDER_INTENSITIES.length} strikes over the storm)`,
            async run() {
                const r = await renderOnce('thunder', THUNDER_SCENE);
                const t = thunderRows(r);
                const j = judgeThunder(t.rows);
                for (const row of j.rows) {
                    summary[`thunder:${row.intensity}`] = { margin: row.margin };
                    verdict('thunder', row.pass, `intensity ${row.intensity} (${row.near ? 'near' : 'far'}): onset ${fmt(row.delaySec, 2)} s after the flash (want ${fmt(row.expectedDelaySec, 2)}), ${signed(row.margin)} LU over the storm from the onset (bed ${fmt(row.bedLufs)} LUFS), GR ${fmt(row.grDb)} dB, grain ${row.grains.map(g => `buf ${g.buf} ${fmt(g.off, 2)}–${fmt(g.end, 2)} s`).join(' + ') || 'none seen'}; want +${row.window.min}…+${row.window.max} LU, GR ≤ ${LOUDNESS_TARGETS.ceiling.thunderGrMaxDb} dB${row.failures.length ? ` — ${row.failures.join('; ')}` : ''}`);
                }
                const order = j.rows.filter(x => Number.isFinite(x.margin)).sort((a, b) => a.intensity - b.intensity).map(x => `${x.intensity} ${signed(x.margin)}`).join(' < ');
                verdict('thunder', j.monotonic, `level vs intensity: ${order || 'none heard'}${j.drops.length ? `; louder for less: ${j.drops.map(d => `${d.from}→${d.to} ${signed(d.deltaLu)} LU`).join(', ')}` : ''}; want monotonic (tolerance ${THUNDER_LIMITS.monotonicTolLu} LU)`);
                verdict('thunder', j.reused.length === 0 && j.rows.every(x => x.grains.length > 0), `fresh noise grain per strike: ${j.reused.length} reused pair(s)${j.reused.length ? ` (${j.reused.map(x => `#${x.a}/#${x.b} buf ${x.buf} ${signed(x.gapSec, 2)} s apart`).join(', ')})` : ''}, ${j.rows.filter(x => !x.grains.length).length} strike(s) with no pool read seen; want each strike's reads ≥ ${THUNDER_LIMITS.grainSepSec} s of buffer from the previous ${THUNDER_LIMITS.grainRecent} strikes'`);
                verdict('thunder', t.ducks.length === 0, `ducks during the thunder scene: ${t.ducks.length}; want none (S3: thunder ducks nothing)`);
                verdict('thunder', t.stMax <= LOUDNESS_TARGETS.storm.stMax, `storm with ${j.rows.length} strikes (world only): ST max ${fmt(t.stMax)}, LUFS-I ${fmt(t.lufsI)}, GR max ${fmt(t.grMaxDb)} dB; want ST max ≤ ${LOUDNESS_TARGETS.storm.stMax}${t.extraScores ? ` (${t.extraScores} thunder score(s) with no flash: the fallback?)` : ''}`);
            },
        });
    }
    if (has('masking')) {
        units.push({
            name: 'masking (must-never 8: thunder and rain)',
            async run() {
                const r = await renderOnce('masking:storm', MASKING_SCENE);
                const onsets = thunderRows(r).rows.map(x => x.onset).filter(Number.isFinite);
                for (const row of laneMarginRows(r, 'weather')) {
                    const j = judgeLane(row.lane, 'weather', [row]);
                    const onset = onsets.filter(o => o <= row.at).pop();
                    const concurrent = row.at != null ? concurrentOverBedLu(r, row.at) : null;
                    outcome('masking', j.outcome, `must-never 8: ${row.lane} ${onset != null ? `${fmt(row.at - onset, 2)} s into a full thunder roll` : '(no thunder before it)'}: ${signed(row.margin)} LU over the 3 s before (${fmt(j.band, 0)} bands ≥ +6 dB, GR ${fmt(j.gr)} dB); cue stem ${signed(concurrent)} LU over the world stem while both sound; want ≥ +${j.window.min}${j.failures.length ? ` — ${j.failures.map(f => f.what).join(', ')}` : ''}`, Math.max(0, ...j.failures.map(f => f.gatedFrom)));
                }
                const { rows: rain } = await marginBed('rain', URGENT_LANES);
                for (const lane of URGENT_LANES) {
                    const j = judgeLane(lane, 'weather', rain.filter(x => x.lane === lane), { probeBed: 'rain' });
                    outcome('masking', j.outcome, `must-never 8: ${lane} over rain: median ${signed(j.margin)} LU (${j.n} placements, GR ${fmt(j.gr)} dB); want ≥ +${j.window.min}${j.failures.length ? ` — ${j.failures.map(f => f.what).join(', ')}` : ''}`, Math.max(0, ...j.failures.map(f => f.gatedFrom)));
                }
            },
        });
    }
    if (has('crest')) {
        for (const [bedName, b] of Object.entries(CREST_BEDS)) {
            units.push({
                name: `crest (4.6: ${b.lanes.join(', ')} on a crest over the ${bedName} bed)`,
                async run() {
                    const free = await renderOnce(`crest:${bedName}:free`, crestScene(bedName));
                    const crest = loudestCrest(free, free.meta.warmup + CREST_WINDOW[0], free.meta.warmup + CREST_WINDOW[1]);
                    if (!crest) { verdict('crest', false, `${bedName}: no crest committed in [${CREST_WINDOW.join(', ')}] s of a cue-free render (sea snapshot ${free.meta.sea ? 'present' : 'missing'})`); return; }
                    const cal = crestCalibration(bedName);
                    const c = await renderOnce(`crest:${bedName}:cal`, cal.spec);
                    const offRows = laneMarginRows(c, b.bed);
                    for (const lane of b.lanes) {
                        const off = offRows.find(x => x.lane === lane);
                        if (!off || off.margin == null) { verdict('crest', false, `${lane} over the ${bedName} bed: the calibration cue was not admitted`); continue; }
                        const lead = off.at - (c.meta.warmup + cal.at[lane]);
                        const p = await renderOnce(`crest:${bedName}:${lane}`, crestPlaced(bedName, lane, crest.t - free.meta.warmup - lead));
                        const on = laneMarginRows(p, b.bed).find(x => x.lane === lane);
                        const j = judgeLane(lane, b.bed, on ? [on] : []);
                        const gap = on ? crestGap(p, on.at) : null;
                        outcome('crest', j.outcome, `${lane} over the ${bedName} bed, first note ${on ? `${signed(on.at - crest.t, 2)} s` : '—'} from the loudest crest of the cue-free render (${fmt(crest.t)} s, amp ${fmt(crest.amp, 2)}): ${signed(on?.margin)} LU on the crest vs ${signed(off.margin)} off it (GR ${fmt(on?.grDb)} dB); nearest crest in this render ${gap ? `${fmt(gap.gapSec, 2)} s away${gap.moved ? ', moved for the cue' : ''}` : '—'}, sea yields ${p.meta.sea?.yields ?? '—'} (cue lead ${fmt(lead, 2)} s: under 1.5 s the duck alone covers it); want ${j.window.min != null ? `≥ ${signed(j.window.min, 0)}` : ''}${j.window.max != null ? ` ≤ ${signed(j.window.max, 0)}` : ''}${j.failures.length ? ` — ${j.failures.map(f => f.what).join(', ')}` : ''}`, Math.max(0, ...j.failures.map(f => f.gatedFrom)));
                    }
                },
            });
        }
    }
    return units;
}

// 4.5 and S2/S6/S7 over the whole map, once every phase unit has landed.
function judgeWorldMapRows() {
    const order = (c) => [MAP_PHASES.indexOf(c.phase), Object.keys(MAP_WEATHERS).indexOf(c.weather), Object.keys(MAP_LOADS).indexOf(c.load)];
    const cells = wave4.cells.slice().sort((a, b) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
    const want = MAP_PHASES.length * Object.keys(MAP_WEATHERS).length * Object.keys(MAP_LOADS).length;
    const A = wave4.A;
    if (!Number.isFinite(A) || cells.length !== want) { verdict('worldmap', false, `${cells.length}/${want} cells rendered, A ${fmt(A)}; want every cell`); return; }
    const j = judgeWorldMap(cells, A);
    for (const phase of MAP_PHASES) {
        for (const weather of Object.keys(MAP_WEATHERS)) {
            const rows = j.rows.filter(r => r.phase === phase && r.weather === weather);
            info('worldmap', `${phase} ${weather} [${rows[0].row}${rows.some(r => r.row !== rows[0].row) ? `/${rows.find(r => r.row !== rows[0].row).row}` : ''}]: ${rows.map(r => `${r.load === 'resting' ? 'resting' : `${r.load.slice(1)} working`} ${fmt(r.load === 'resting' ? r.stMean : r.lufsI)} (A ${signed(r.over)}${r.pass ? '' : ' ✗'})`).join(' · ')}; 2–5 kHz ${rows.map(r => fmt(r.presenceDb)).join('/')} dB, onsets ${rows.map(r => fmt(r.onsetsPerMin, 0)).join('/')}/min, CPU proxy ${rows.map(r => fmt(r.cpuPct, 1)).join('/')} %${rows[0].dayArc ? `, grade ${rows[0].dayArc}` : ''}`);
        }
    }
    verdict('worldmap', j.failures.length === 0, `${cells.length} world scenes vs their S2 rows relative to A ${fmt(A)} (resting: pilot light; rain ≤ A + ${LOUDNESS_TARGETS.rain.maxOverA}; storm ≤ A + ${LOUDNESS_TARGETS.storm.maxOverA} with ST max ≤ ${LOUDNESS_TARGETS.storm.stMax}; night ≤ A + ${LOUDNESS_TARGETS.night.maxOverA ?? '—'}): ${j.failures.length} failing${j.failures.length ? `: ${j.failures.slice(0, 8).map(r => `${cellLabel(r)} A ${signed(r.over)} (want ${r.want})`).join('; ')}` : ''}`);
    const arcOut = j.rows.filter(r => r.row === 'dayArc' && !r.inArc);
    verdict('worldmap', j.arc.pass, `day arc (4.5, AMB-12): ${j.arc.within}/${j.arc.n} waking dry-weather scenes within A ${signed(LOUDNESS_TARGETS.dayArc?.overA, 0)} ± ${LOUDNESS_TARGETS.dayArc?.toleranceLu ?? '—'} (${fmt(100 * (j.arc.share ?? NaN), 0)} %)${arcOut.length ? `; outside: ${arcOut.slice(0, 8).map(r => `${cellLabel(r)} ${signed(r.over)}`).join(', ')}` : ''}; want ≥ ${fmt(100 * (j.arc.minShare ?? NaN), 0)} %`);
    const mn7 = nightWeatherOverDay(cells);
    verdict('worldmap', mn7.pass, `must-never 7: loudest night/weather scene over the clear day at the same load: ${mn7.worst ? `${cellLabel(mn7.worst)} ${signed(mn7.worst.overDay)} LU` : '—'}${mn7.failures.length ? `; over: ${mn7.failures.map(r => `${cellLabel(r)} ${signed(r.overDay)}`).join(', ')}` : ''}; want ≤ +${MUST_NEVER_7_LU} LU`);
    for (const load of ['w3', 'w12']) {
        const cell = (phase) => cells.find(c => c.phase === phase && c.weather === 'clear' && c.load === load);
        const p = presenceUnderNoon(cell('night').presenceDb, cell('day').presenceDb);
        verdict('worldmap', p.pass, `S2 night row, world stratum (${load.slice(1)} working, clear): 2–5 kHz ${fmt(p.underDb)} dB under noon (program = world); want ≥ ${p.minDb} dB darker`);
    }
    const ob = judgeOnsetBudget(cells);
    verdict('worldmap', ob.pass, `ambient onsets (S7, band-rise detector on the program): busiest ${ob.worst ? `${cellLabel(ob.worst)} ${fmt(ob.worst.onsetsPerMin, 0)}/min` : '—'}${ob.over.length ? `; over: ${ob.over.map(c => `${cellLabel(c)} ${fmt(c.onsetsPerMin, 0)}`).join(', ')}` : ''}; want ≤ ${ob.max}/min everywhere`);
    const s6 = worldStemDiffers(cells);
    const worstAbs = s6.pairs.reduce((w, p) => (p.maxAbs != null && (w == null || p.maxAbs > w) ? p.maxAbs : w), null);
    info('worldmap', `S6 / C-AMB-1 across the map (the gate is \`worldstem\`, which measures the renderer's noise beside it): world stem at 3 vs 12 working identical within renderer noise in ${s6.pairs.length - s6.differing.length}/${s6.pairs.length} phase × weather pairs (${s6.pairs.filter(p => p.identical).length} bit-identical, worst max |Δ| ${worstAbs != null ? worstAbs.toExponential(2) : '—'})${s6.differing.length ? `; differ: ${s6.differing.map(d => `${d.phase} ${d.weather} ${d.maxAbs != null ? d.maxAbs.toExponential(2) : '—'}`).join(', ')}` : ''}; ≤ ${WORLD_STEM_MAX_ABS.toExponential(0)} is the noise-free bar (storm cells carry a flash, no cue)`);
    const cpu = cells.map(c => c.cpuPct).filter(Number.isFinite);
    const cpuOf = (weather, phase = 'day') => cells.find(c => c.phase === phase && c.weather === weather && c.load === 'w3')?.cpuPct;
    info('worldmap', `CPU offline proxy (render wall ÷ audio time, the harness and the directors included): median ${fmt(median(cpu), 1)} %, max ${fmt(Math.max(...cpu), 1)} %; day clear ${fmt(cpuOf('clear'), 1)} %, day storm ${fmt(cpuOf('storm'), 1)} %, night clear ${fmt(cpuOf('clear', 'night'), 1)} % (S8: calm ≤ 2.5 %, storm ≤ 3.5 % of a core for the environment on a quiet host; relative only)`);
    const errs = cells.flatMap(c => c.errors || []);
    if (errs.length) info('worldmap', `page errors: ${errs.slice(0, 3).join(' | ')}`);
}

// ------------------------------------------------------------ Wave 5 units ----
const pct = x => (Number.isFinite(x) ? `${Math.round(100 * x)} %` : '—');
const lastWord = s => (s ? s.split('/').pop() : '—');

// The layer must exist and publish before any Wave-5 number means anything.
function workshopsPresent(check, r, label) {
    const snap = r.meta.workshops;
    if (snap && !snap.error) return true;
    verdict(check, false, `${label}: no workshop layer (director.layers.workshops.snapshot() ${snap?.error ? `threw: ${snap.error}` : 'missing'}); page errors: ${r.errors.slice(0, 2).join(' | ') || 'none'}`);
    return false;
}

function wave5Units(render, renderOnce, scene, marginBed) {
    const units = [];
    const L = WORK_LIMITS;
    const reference = () => render('workRef:day', workshopScene('reference'));
    if (has('workshops')) {
        units.push({
            name: 'workshops (5.1: the reference Forge, nodes, tick cost)',
            async run() {
                const r = await reference();
                if (!workshopsPresent('workshops', r, 'reference day')) return;
                const f = forgeRow(r, { stopLabel: 'forge#0 idle', staleLabel: 'forge#2 stale', staleAgentIndex: 2 });
                const gap = longestGap(f.active, { from: r.meta.warmup, to: f.stopSec });
                verdict('workshops', gap.maxGapSec != null && gap.maxGapSec <= L.forgeMaxGapSec, `reference day: Forge longest gap while working ${fmt(gap.maxGapSec, 2)} s (after ${fmt(gap.at, 2)} s; ${gap.n} strikes in ${fmt(r.meta.warmup)}–${fmt(f.stopSec)} s, one smith stale at ${fmt(f.staleSec, 1)} s); want ≤ ${L.forgeMaxGapSec} s (FOL v3: 2.76 s schedule, 4.15 s heard)`);
                const stop = stopTiming(f.times, f.stopSec, f.periodSec);
                verdict('workshops', stop.pass, `reference day: the Forge's last strike ${fmt(stop.lastSec, 2)} s = ${fmt(stop.leadSec, 2)} s before the smiths' first non-working observation (${fmt(f.stopSec, 2)} s); ${stop.late} strike(s) later than P_b ${fmt(f.periodSec, 2)} s after it; want ≤ ${L.stopLeadSec} s before and none after (FOL v3: 0.45 s)`);
                verdict('workshops', f.staleAccents === 0, `reference day: accents from the smith after it went stale (${fmt(f.staleSec, 1)} s): ${f.staleAccents}; want 0 (S6)`);
                const snap = r.meta.workshops;
                const sounded = (r.meta.work || []).length;
                verdict('workshops', Number.isFinite(snap.nodeCreations) && snap.nodeCreations <= 2 * sounded, `node creations ${snap.nodeCreations ?? '—'} for ${sounded} published strikes (${fmt(snap.nodeCreations / Math.max(1, sounded), 2)} per take; overlap-guard hits ${snap.overlapGuardHits ?? '—'}, cancelled ${snap.cancelled ?? '—'}, dropped ${JSON.stringify(snap.dropped ?? null)}); want ≤ 2 per sounding take (S8)`);
                const tick = tickRows(r);
                const line = t => (t ? `${lastWord(t.site)} ×${t.fired}: p95 ${fmt(t.p95Ms, 3)} ms, max ${fmt(t.maxMs, 3)} ms` : '—');
                info('workshops', `main-thread per tick (real ms on this host, harness included; 5.1 asks ≤ ${L.tickMs} ms for the scheduler): the layer's Transport windows p95 ${fmt(tick.layer?.p95, 3)} ms, max ${fmt(tick.layer?.max, 3)} ms over ${tick.layer?.windows ?? '—'}; director ${line(tick.director)}; Transport ${line(tick.transport)}`);
            },
        });
        units.push({
            name: 'workshops (5.1 / S6: stale, idle, lost link)',
            async run() {
                const r = await renderOnce('work:honesty', WORK_HONESTY_SCENE);
                if (!workshopsPresent('workshops', r, 'honesty')) return;
                const h = honestyRows(r, WORK_HONESTY);
                verdict('workshops', h.staleOnly === 0, `S6: onsets while only stale agents work and one is idle (0–${WORK_HONESTY.freshAt} s): ${h.staleOnly}; want 0`);
                verdict('workshops', h.fresh > 0 && h.again > 0, `a fresh smith is heard: ${h.fresh} strikes while it works, ${h.again} after it resumes; want > 0 each`);
                verdict('workshops', h.idle === 0, `S6: onsets with working === 0 (from P_b after the smith goes idle until it resumes): ${h.idle}; want 0`);
                verdict('workshops', h.lostAt != null && h.afterLost === 0, `S6: onsets after the link is lost (linkLost cue at ${fmt(h.lostAt, 2)} s; the feed dropped at ${fmt(r.meta.warmup + WORK_HONESTY.dropAt, 1)} s), past the 0.35 s work horizon: ${h.afterLost ?? '—'}; work stem ${fmt(h.workLufsBefore)} LUFS before → ${fmt(h.workLufsAfterLost)} LUFS from 4 s after; want 0`);
            },
        });
        units.push({
            name: 'workshops (5.1 / FOL-5: downbeats in World, the poll in Dashboard)',
            async run() {
                const world = await renderOnce('work:downbeats', workDownbeatScene());
                const dash = await renderOnce('work:downbeats:dashboard', workDownbeatScene({ dashboard: true }));
                if (!workshopsPresent('workshops', world, 'downbeats (World)')) return;
                const d = downbeatRows(world);
                const withBeat = d.accents.filter(s => Number.isFinite(s.downbeatMs));
                const sync = downbeatSync(withBeat.map(s => s.wallMs), d.drawn.map(x => x.atMs));
                const own = withBeat.map(s => Math.abs(s.wallMs - s.downbeatMs));
                verdict('workshops', sync.pass, `World: ${withBeat.length}/${d.accents.length} accents on a drawn downbeat (${d.drawn.length} drawn by the stand-in conductor); published strike vs the drawn beat: median ${fmt(sync.medianAbsMs, 1)} ms, p95 ${fmt(sync.p95AbsMs, 1)} ms, ${sync.unmatched} off every drawn beat (layer's own |wall − downbeat| median ${fmt(median(own), 1)} ms); drawn beats with a strike within ±${L.syncMedianMs} ms: ${sync.covered}/${sync.drawn}; want median ≤ ${L.syncMedianMs}, p95 ≤ ${L.syncP95Ms} ms`);
                const phase = world.meta.warmup + WORK_POLL.phaseSec;
                const pw = pulseIndex(d.onsets, { pollPhaseSec: phase });
                verdict('workshops', pw.index != null && pw.index <= L.pulseIndexMax, `World: poll-lock pulse index ${fmt(pw.index, 2)} over ${d.onsets.length} onsets (poll-phase histogram ${pw.histogram.join(' ')}); want ≤ ${L.pulseIndexMax} (FOL: downbeats-only 2.21); C-FOL-1: ${pct(d.grid)} of strikes on their gesture grid (±15 ms of k·P_b)`);
                const dd = downbeatRows(dash);
                const pd = pulseIndex(dd.onsets, { pollPhaseSec: dash.meta.warmup + WORK_POLL.phaseSec });
                const ratio = d.onsets.length ? dd.onsets.length / d.onsets.length : null;
                info('workshops', `Dashboard (no ritual; the de-clumped grid): pulse index ${fmt(pd.index, 2)} (histogram ${pd.histogram.join(' ')}), ${dd.onsets.length} onsets vs ${d.onsets.length} in World (${fmt(ratio, 2)}×; FOL-1 asks ±10 %), ${dd.accents.filter(s => Number.isFinite(s.downbeatMs)).length} accents claiming a downbeat (want 0)`);
            },
        });
    }
    // 5.3 / 5.5 audibility on the dedicated cells (≥ 20 accents a building).
    const audibilityUnit = (check, pattern, phase) => ({
        name: `${check} (${phase === 'night' ? '5.5' : '5.3'}: ${pattern} accents heard by ${phase}, ${AUDIBILITY_SECONDS} s cell)`,
        async run() {
            const ctx = await renderOnce(`work:audible:${pattern}:${phase}`, audibilityScene(pattern, { phase }));
            if (!workshopsPresent(check, ctx, `${pattern} ${phase} audibility cell`)) return;
            const env = await renderOnce(`work:audible:${pattern}:${phase}:env`, audibilityScene(pattern, { phase, env: true }));
            const accents = strikesOf(ctx, { from: ctx.meta.warmup, to: ctx.meta.warmup + ctx.meta.seconds - 0.3 }).filter(s => s.kind === 'accent' && !s.flam);
            const heard = heardRows(accents, ctx.program, env.program, ctx.sr, phase === 'night' ? WORK_BANDS_NIGHT : WORK_BANDS_DAY);
            const h = judgeHeard(heard, Object.keys(heard).sort());
            const band = phase === 'night' ? '1.2–3 kHz' : "FOL round 2's day bands";
            verdict(check, h.pass && h.rows.length > 0, `${pattern} ${phase}: accents heard (band rise ≥ ${L.heardRiseDb} dB in context, ${band}) — ${h.rows.map(x => `${x.building} ${pct(x.share)} of ${x.n}${x.enough ? '' : ' (too few)'} (control ${pct(heard[x.building].control / heard[x.building].n)}, median rise ${fmt(heard[x.building].medianRiseDb, 1)} dB)`).join(', ') || 'none'}; want ≥ ${pct(L.heardShare)} on ≥ ${L.heardMinAccents} accents at every staffed building (v3: ${phase === 'night' ? '78' : '86'}–100 %)`);
            info(check, `${pattern} ${phase} audibility cell: program ${fmt(sceneMetrics(ctx).lufsI)} LUFS-I vs ${fmt(sceneMetrics(env).lufsI)} without the stratum; ${onsetsOf(strikesOf(ctx)).length} onsets in ${ctx.meta.seconds} s; layer night ${ctx.meta.workshops?.night ?? '—'}${phase === 'night' ? `; Forge accent slots ${[...new Set(accents.filter(s => s.building === 'forge').map(s => Math.round(s.hz)))].sort().join('/') || '—'} Hz (C♯7 → C7, F♯7 → G7 at night)` : ''}`);
        },
    });
    if (has('worklevel')) {
        units.push({
            name: 'worklevel (5.3: reference scenes by day, ctx vs env)',
            async run() {
                const urgent = (await marginBed('village', URGENT_LANES)).urgentTp;
                info('worklevel', `urgent-cue true peaks at the output (the margins' Village placements, each lane on its own render; Wave-3 voices at their in-context trims): ${urgent.map(u => `${u.lane} ${fmt(u.tpDbtp)} dBTP (n ${u.n})`).join(', ')}`);
                for (const pattern of Object.keys(WORK_PATTERNS)) {
                    const ctx = pattern === 'reference' ? await reference() : await renderOnce(`workOther:day`, workshopScene(pattern));
                    if (!workshopsPresent('worklevel', ctx, `${pattern} day`)) continue;
                    const env = await renderOnce(`work:${pattern}:day:env`, workshopScene(pattern, { env: true }));
                    const row = workLevelRow(ctx, env);
                    const j = judgeWorkLevel({ ...row, urgentTpDbtp: urgent.map(u => u.tpDbtp) });
                    summary[`work:${pattern}:day`] = { lufsI: row.workLufs };
                    verdict('worklevel', j.pass, `${pattern} day: workshop stratum (dry + air, ctx − env) ${fmt(row.workLufs)} LUFS-I (M max ${fmt(row.workMMax)}) = ${fmt(j.underLu)} LU under the program ${fmt(row.programLufs)} (want ≥ ${L.underProgramLu}; v3 13.4); program Δ ${signed(j.deltaLu, 2)} LU vs the environment alone ${fmt(row.envProgramLufs)} (want ≤ +${L.programDeltaMaxLu}); work TP ${fmt(row.workTpDbtp)} dBTP = ${fmt(j.tpMarginDb)} dB under the quietest urgent cue ${fmt(j.urgentFloorDbtp)} (want ≥ ${L.tpUnderUrgentDb})${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}`);
                    const all = strikesOf(ctx, { from: ctx.meta.warmup, to: ctx.meta.warmup + ctx.meta.seconds - 0.3 });
                    const times = onsetsOf(all).map(s => s.at);
                    const share = onsetShare25(ctx.program, ctx.sr, times);
                    const envShare = onsetShare25(env.program, env.sr, times);
                    const shareLine = `onset-weighted 2–5 kHz share of the program ${fmt(share, 2)} % over ${times.length} strike windows (environment alone at the same instants ${fmt(envShare, 2)} %, so the stratum adds ${signed(share - envShare, 2)} points; the stratum itself ${fmt(onsetShare25(row.stratum, ctx.sr, times), 1)} %)`;
                    // The plan's absolute figure is the reference scene's;
                    // elsewhere the environment differs, so the stratum's
                    // increment is judged and the absolute share is INFO.
                    if (pattern === 'reference') verdict('worklevel', share != null && share <= L.share25MaxPct, `${pattern} day: ${shareLine}; want ≤ ${L.share25MaxPct} % (v3: 1.02 %)`);
                    else verdict('worklevel', share != null && envShare != null && share - envShare <= L.share25IncrementMaxPts, `${pattern} day: ${shareLine}; want the increment ≤ +${L.share25IncrementMaxPts} points (absolute INFO; ≤ ${L.share25MaxPct} % is the reference scene's)`);
                    const dense = maxOnsetsIn(times, 1);
                    const accents = all.filter(s => s.kind === 'accent');
                    verdict('worklevel', dense <= L.maxOnsetsPer1s, `${pattern} day: densest 1 s ${dense} onsets (${times.length} in ${ctx.meta.seconds} s, ${fmt(times.length / ctx.meta.seconds, 2)}/s; ${accents.length} accents, ${times.length - accents.length} ghosts); want ≤ ${L.maxOnsetsPer1s} (S7)`);
                    const loss = routineLossRows(ctx, env);
                    const worst = loss.reduce((m, x) => (x.lossLu != null && (m == null || x.lossLu > m) ? x.lossLu : m), null);
                    verdict('worklevel', loss.length > 0 && loss.every(x => x.lossLu != null) && worst <= L.routineLossMaxLu, `${pattern} day: routine-cue margin with the stratum vs without — ${loss.map(x => `${x.label} ${signed(x.on)} vs ${signed(x.off)} LU`).join(', ') || 'no routine cue admitted'}; worst loss ${signed(worst, 2)} LU; want ≤ ${L.routineLossMaxLu}`);
                }
            },
        });
        for (const pattern of Object.keys(WORK_PATTERNS)) units.push(audibilityUnit('worklevel', pattern, 'day'));
    }
    if (has('workslots')) {
        units.push({
            name: 'workslots (5.4: two smiths, focus, a needs-you)',
            async run() {
                const on = await renderOnce('work:slots', workSlotsScene());
                const off = await renderOnce('work:slots:twin', workSlotsScene({ select: false }));
                if (!workshopsPresent('workslots', on, 'slots')) return;
                const a = slotRows(on, { selectLabel: 'select smith 1', needsYouAt: WORK_SLOTS.needsYouAt });
                const b = slotRows(off, { selectLabel: 'select smith 1', needsYouAt: WORK_SLOTS.needsYouAt });
                const agents = Object.keys(a.byAgent).filter(id => id !== 'null' && id !== 'undefined');
                // A pitch is its slot (pitchIndex); Hz carries the take's ±0.3 % rate jitter.
                const pitches = agents.map(id => [...new Set(a.byAgent[id].map(s => s.pitchIndex))]);
                const hzOf = id => fmt(median(a.byAgent[id].map(s => s.hz)), 0);
                const distinct = new Set(pitches.flat()).size;
                verdict('workslots', agents.length === 2 && pitches.every(p => p.length === 1) && distinct === 2, `2 forge agents: accent pitches ${agents.map((id, i) => `${id} slot ${pitches[i].join('/')} ≈ ${hzOf(id)} Hz (${a.byAgent[id].length} accents)`).join(', ') || 'none'}; ${distinct} distinct; want 2 agents, one pitch each, 2 distinct (SIG-11)`);
                const selected = on.meta.markers.find(m => m.label === 'select smith 1')?.agentId;
                const other = agents.find(id => id !== selected);
                // The same accents booked in both renders (one seed), after the
                // selection: their published gains differ by the focus alone.
                const t0 = a.selectAt;
                const paired = pairedGainDiffs(on, off, { from: t0 + 0.5, to: on.meta.warmup + on.meta.seconds });
                const fo = judgeFocus({ focusDb: paired[selected] || [], otherDb: paired[other] || [] });
                verdict('workslots', fo.pass, `focus on ${selected ?? '—'} at ${fmt(t0, 1)} s: its accents ${signed(fo.focusDb, 2)} dB over the same accents in the twin without focus (${(paired[selected] || []).length} paired; published gains), the other smith ${signed(fo.otherDb, 2)} dB (${(paired[other] || []).length} paired); want ${signed(L.focusDb, 0)} ± ${L.focusTolDb} and the other unmoved`);
                const n = a.needsYou;
                const m = b.needsYou;
                const pre = x => (x && Number.isFinite(x.trimDb) ? x.mMax - x.trimDb : x?.mMax);
                const delta = n && m ? pre(n) - pre(m) : null;
                verdict('workslots', delta != null && Math.abs(delta) <= L.signalTolLu, `a needs-you from the bystander while smith 1 is focused: ${fmt(n?.mMax)} vs ${fmt(m?.mMax)} LUFS-M max without focus (cue trims ${signed(n?.trimDb)} / ${signed(m?.trimDb)} dB), before its bed-aware trim ${signed(delta, 2)} LU; want within ±${L.signalTolLu} (focus never touches the signal stratum)`);
            },
        });
    }
    if (has('worknight')) {
        for (const pattern of Object.keys(WORK_PATTERNS)) units.push(audibilityUnit('worknight', pattern, 'night'));
    }
    if (has('quietmix')) {
        units.push({
            name: 'quietmix (5.6: blur in Village and Town band)',
            async run() {
                const { blurAt, focusAt } = QUIET_MIX;
                const pair = async kind => [await renderOnce(`quiet:${kind}`, quietMixScene(kind)), await renderOnce(`quiet:${kind}:twin`, quietMixScene(kind, { blur: false }))];
                const at = (r, s) => r.meta.warmup + s;
                const rowOf = (x, y, stem) => quietStemRow(levelDiffCurve(x.stems[stem], y.stems[stem], x.sr), { blurSec: at(x, blurAt), focusSec: at(x, focusAt) });
                const stateLine = (r) => {
                    const q = r.meta.stateLog.find(s => s.t > at(r, blurAt) + 1 && s.t < at(r, focusAt))?.quietMix;
                    return q ? `quietMix ${q.active ? 'active' : 'inactive'} (${q.preset ?? '—'}: ${Object.entries(q.factors || {}).map(([k, v]) => `${k} ×${fmt(v, 2)}`).join(', ')})` : 'no quietMix state';
                };
                const [v, vt] = await pair('village');
                if (!workshopsPresent('quietmix', v, 'village blur')) return;
                const musicPlays = levelDiffCurve(vt.stems.music, vt.stems.music, vt.sr).filter(([t]) => t > at(vt, blurAt) && t < at(vt, focusAt)).length;
                const end = v.meta.warmup + v.meta.seconds;
                const accIn = accentGainOffsetDb(v, [{ from: at(v, blurAt) + 1, to: at(v, focusAt) }]);
                // The unblurred reference: before the blur and from 1 s after focus.
                const accOut = accentGainOffsetDb(v, [{ from: v.meta.warmup, to: at(v, blurAt) }, { from: at(v, focusAt) + 1, to: end }]);
                const acc = { n: accIn.n, medianDb: accOut.n >= L.quietRefAccentsMin ? offsetStepDb(accIn, accOut) : null };
                const ghosts = ghostsIn(v, at(v, blurAt) + 0.5, at(v, focusAt));
                const ghostsTwin = ghostsIn(vt, at(vt, blurAt) + 0.5, at(vt, focusAt));
                const village = judgeQuietMix({
                    world: { ...rowOf(v, vt, 'world'), want: L.quietWorldDb },
                    // Wave 6 (D1, D3): the quiet mix releases the Village's
                    // tune; the occasion clock, not the focus, starts the next.
                    music: { ...rowOf(v, vt, 'music'), want: -Infinity, restore: false },
                    'work accents': { levelDb: acc.medianDb, restoreLagSec: null, restore: false, want: L.quietWorldDb },
                });
                const how = x => (x.name === 'music' ? 'vs the twin that never blurred (released at the blur, not resumed at focus: D1)'
                    : x.restore === false ? `(work-stem peak over published gain, ${acc.n} blurred accents vs ${accOut.n} unblurred before the blur and after focus, want ≥ ${L.quietRefAccentsMin})`
                        : `vs the twin that never blurred, back within ${L.quietTolDb} dB ${fmt(x.restoreLagSec, 2)} s after focus`);
                for (const x of village.rows) verdict('quietmix', x.pass, `Village blur ${blurAt}–${focusAt} s, ${x.name}: ${signed(x.levelDb)} dB ${how(x)}; want ${x.want === -Infinity ? `≤ ${L.musicOffDb} dB (music 0)` : `${signed(x.want)} ± ${L.quietTolDb} dB`}${x.restore === false ? '' : `, restored ≤ ${L.restoreSec} s`}${x.name === 'music' && !musicPlays ? ' (the twin played no music in the window)' : ''}`);
                verdict('quietmix', ghosts === 0 && ghostsTwin > 0, `Village blur: ghost strikes ${ghosts} (twin ${ghostsTwin} in the same window); want 0 while blurred (accents only); ${stateLine(v)}`);
                const [h, ht] = await pair('held');
                const held = judgeQuietMix({ 'held note': { ...rowOf(h, ht, 'signalBed'), want: 0, tolDb: L.heldTolDb, restore: false } });
                verdict('quietmix', held.pass, `Village blur, the held note (signalBed stem): ${signed(held.rows[0].levelDb, 2)} dB vs the twin; want 0 ± ${L.heldTolDb} dB (untouched); world ${signed(rowOf(h, ht, 'world').levelDb)} dB`);
                const sh = slotRows(h, { selectLabel: null, needsYouAt: QUIET_MIX.needsYouAt });
                const st = slotRows(ht, { selectLabel: null, needsYouAt: QUIET_MIX.needsYouAt });
                const pre = x => (x && Number.isFinite(x.trimDb) ? x.mMax - x.trimDb : x?.mMax);
                const dn = sh.needsYou && st.needsYou ? pre(sh.needsYou) - pre(st.needsYou) : null;
                verdict('quietmix', dn != null && Math.abs(dn) <= L.signalTolLu, `Village blur, a needs-you at ${QUIET_MIX.needsYouAt} s: ${fmt(sh.needsYou?.mMax)} vs ${fmt(st.needsYou?.mMax)} LUFS-M max in the twin (trims ${signed(sh.needsYou?.trimDb)} / ${signed(st.needsYou?.trimDb)} dB: the bed-aware trim follows the quieter bed), before its trim ${signed(dn, 2)} LU; want within ±${L.signalTolLu} (the signal path untouched)`);
                const [t, tt] = await pair('town');
                const town = judgeQuietMix({ 'Town band music': { ...rowOf(t, tt, 'music'), want: L.quietTownDb } });
                const x = town.rows[0];
                verdict('quietmix', x.pass, `Town band blur: music ${signed(x.levelDb, 2)} dB vs the twin, back within ${L.quietTolDb} dB ${fmt(x.restoreLagSec, 2)} s after focus; want ${L.quietTownDb} ± ${L.quietTolDb} dB, restored ≤ ${L.restoreSec} s; ${stateLine(t)}`);
                const townStrikes = strikesOf(t, { from: 0, to: Infinity }).length + strikesOf(tt, { from: 0, to: Infinity }).length;
                verdict('quietmix', townStrikes === 0, `D4: workshop strikes in Town band with 4 workers (both renders): ${townStrikes}; want 0 (no work stratum in Town band)`);
            },
        });
    }
    if (has('quota')) {
        units.push({
            name: 'quota (5.7: the mine rumble over a quota sweep)',
            async run() {
                const s = await renderOnce('quota:sweep', quotaScene());
                const tw = await renderOnce('quota:twin', quotaScene({ sweep: false }));
                if (!workshopsPresent('quota', s, 'quota sweep')) return;
                const q = quotaRows(s, tw, { ...QUOTA_STEPS, staleAt: QUOTA_STALE_AT });
                const j = judgeQuotaSweep(q.steps);
                const lvl = x => (x === -Infinity ? 'silent' : `${fmt(x)} dB`);
                verdict('quota', j.pass, `mine 80–160 Hz (the quota lane: work stem minus the twin without usage) at ratio ${q.steps.map(x => `${x.ratio} ${lvl(x.levelDb)}`).join(' → ')} (heard work stem ${q.steps.map(x => lvl(x.heardDb)).join(' → ')}; before the sweep ${lvl(q.before)}): rise ${j.riseDb === Infinity ? 'from silence' : `${signed(j.riseDb)} dB`}${j.drops.length ? `; drops ${j.drops.map(d => `${d.from}→${d.to} ${signed(d.deltaDb)}`).join(', ')}` : ''}; want ≥ +${L.quotaRiseDb} dB, monotonic (±${L.quotaMonotonicTolDb})`);
                verdict('quota', q.cues === 0, `audio:cue-played during the sweep: ${q.cues}; want 0 (continuous textures never caption)`);
                const top = q.steps.at(-1)?.levelDb;
                verdict('quota', Number.isFinite(top) && (q.staleDb === -Infinity || q.staleDb <= top + L.quotaSilentDb), `quota unavailable at ${QUOTA_STALE_AT} s: the lane ${lvl(q.staleDb)} from 3 s after vs ${lvl(top)} at 1.0${q.staleDb === -Infinity ? '' : ` (${signed(q.staleDb - top)} dB)`}; want ≤ ${L.quotaSilentDb} dB (silent on stale data)`);
                info('quota', `layer quota state at the end: ${JSON.stringify(s.meta.workshops?.quota ?? null)}`);
            },
        });
    }
    if (has('camera')) {
        units.push({
            name: 'camera (5.8: a pan across the Harbor)',
            async run() {
                const spec = cameraScene(HARBOR_WORLD);
                const r = await renderOnce('camera:pan', spec);
                if (!workshopsPresent('camera', r, 'camera pan')) return;
                if (!r.meta.cameraSeam) { verdict('camera', false, 'director.setCameraSource is missing: the scripted camera cannot reach the director'); return; }
                const w = r.meta.warmup;
                const c = CAMERA_PAN;
                const camCross = signCrossing(t => cameraPanTarget(spec.camera, t), c.stillUntil - 1, c.panUntil + 1);
                const cameraCrossSec = camCross != null ? w + camCross : null;
                const end = w + r.meta.seconds;
                const emitters = [
                    ['workshop Harbor', r.meta.workshops?.placementLog, 'harbor'],
                    ['sea harbor lane', r.meta.sea?.placementLog, 'harbor'],
                ];
                for (const [label, log, key] of emitters) {
                    const rows = placementLogRows(log, key, 'pan');
                    if (!rows.length) { verdict('camera', false, `${label}: no placement writes logged (${log ? 'empty log' : 'no placementLog in the snapshot'})`); continue; }
                    const traj = targetTrajectory(rows, rows[0].value);
                    const heardCrossSec = signCrossing(traj, w + c.stillUntil - 1, w + c.panUntil + 3);
                    const moving = rows.filter(x => x.at >= w + c.stillUntil - 0.5 && x.at <= w + c.panUntil + 2);
                    const still = rows.filter(x => (x.at >= w + 2 && x.at < w + c.stillUntil - 0.5) || (x.at >= w + c.stillFrom && x.at <= end)).length;
                    const allWrites = (log || []).filter(x => (x.building ?? x.lane) && ((x.at >= w + 2 && x.at < w + c.stillUntil - 0.5) || x.at >= w + c.stillFrom)).length;
                    const j = judgeCameraPan({ cameraCrossSec, heardCrossSec, targets: [rows.filter(x => x.at < w + c.stillUntil - 0.5).at(-1)?.value, ...moving.map(x => x.value)].filter(Number.isFinite), stillWrites: still });
                    verdict('camera', j.pass, `${label}: the camera crosses the Harbor at ${fmt(cameraCrossSec, 2)} s, its pan through 0 at ${fmt(heardCrossSec, 2)} s (${signed(j.lagSec, 2)} s); ${moving.length} writes while panning, largest step ${fmt(j.maxStep, 3)}; writes while the camera is still ${j.stillWrites} (any emitter in that log: ${allWrites}); want ≤ ${L.crossWithinSec} s after, steps ≤ ${L.panStep}, 0 still`);
                }
                info('camera', `placement writes: workshops ${r.meta.workshops?.placementWrites ?? '—'}, sea ${r.meta.sea?.placementWrites ?? '—'}; sea coast ${JSON.stringify(r.meta.sea?.placement?.coast ?? null)}`);
            },
        });
    }
    return units;
}

// ------------------------------------------------------------ Wave 6 units ----
// The music. The stem matrix (every piece × day/night × Isle/Chip, one
// full-band render each, every seat on its own stem) feeds musicstems (6.2),
// isleband (6.1) and nightmusic (6.3); each render is reduced to numbers in
// its unit. The score (6.5) and the occasion clock's day (6.6) also run the
// shipped Sequencer and OccasionClock headless (lib/music-sim.mjs).
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
// admitted seats of Voicings at the arrangement the band actually played),
// the Isle/Chip arm, nodes per note, the stop lint, the lead's range and
// the melody–bass parallels.
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
    const admitted = [0, 1, 2, 3].map(band => voicingFor({ voice, mode: 'townBand', keyframe: arr.keyframe, weather: arr.weather, season: arr.season, band }).admitted.filter(s => pairs[s]));
    const bands = bandRows(r, pairs, admitted, win);
    const notes = noteRows(r, win);
    const lead = seatLine(notes, 'lead');
    const voicesPlayed = [...new Set(marks.filter(m => m.kind === 'loop' || m.kind === 'chunk').map(m => m.voice))];
    return {
        piece, phase, voice, keyframe: arr.keyframe ?? null, voicesPlayed, window: win, found: Boolean(first),
        presence: Object.fromEntries(Object.entries(pairs).map(([seat, p]) => [seat, bandLevelDb(p, r.sr, 2000, 5000)])),
        seats, admitted, bands, steps: [1, 2, 3].map(k => bandStep(bands[k - 1], bands[k])),
        arm: armRow(r, win),
        nodes: nodesPerNoteRow(r), stops: stopLevels(r, { maxDb: MUSIC_LIMITS.stopMaxDb }),
        lead: range(lead), parallels: parallelPerfects(lead, seatLine(notes, 'bass')),
        bank: r.meta.diagnostics?.bank ?? null, errors: r.errors,
    };
}

// The Village's working day for the occasion clock (09:00–18:00, minutes
// of the day): busy most of it, a light hour, rain, a resting spell, a wait
// that passes 6 min, urgent cues.
const DAY_PLAN = Object.freeze([
    { from: 540, to: 630, working: 6 },
    { from: 630, to: 690, working: 2 },
    { from: 690, to: 780, working: 7 },
    { from: 780, to: 820, working: 6, raining: true },
    { from: 820, to: 870, working: 5 },
    { from: 870, to: 910, working: 0, resting: true },
    { from: 910, to: 960, working: 6, waitFrom: 920, waitTo: 940 },
    { from: 960, to: 1080, working: 8 },
]);
const DAY_URGENT = Object.freeze([600, 725, 1000, 1050]);
function dayPlanAt(minute) {
    const seg = DAY_PLAN.find(s => minute >= s.from && minute < s.to) || DAY_PLAN[DAY_PLAN.length - 1];
    const waitMs = seg.waitFrom != null && minute >= seg.waitFrom && minute < seg.waitTo ? (minute - seg.waitFrom) * 60e3 : 0;
    return { working: seg.working, raining: Boolean(seg.raining), resting: Boolean(seg.resting), oldestWaitMs: waitMs, urgent: DAY_URGENT.some(u => minute >= u && minute < u + 1 / 60) };
}
function phaseAt(minute) {
    const s = createAtmosphereSnapshot({ now: new Date(2026, 6, 15, 12, 0, 0), hourOverride: minute / 60, weatherOverride: { type: 'clear' } });
    return { phase: s.phase, progress: s.phaseProgress ?? 0 };
}
// The day's hard-zero windows in sim seconds (S7).
function dayZeroWindows(fromMinute) {
    const sec = m => (m - fromMinute) * 60;
    const rows = [];
    for (const s of DAY_PLAN) {
        if (s.raining) rows.push({ from: sec(s.from), to: sec(s.to), why: 'rain' });
        if (s.resting) rows.push({ from: sec(s.from), to: sec(s.to), why: 'resting' });
        if (s.waitFrom != null) rows.push({ from: sec(s.waitFrom + 6), to: sec(s.waitTo), why: 'wait ≥ 6 min' });
    }
    for (const u of DAY_URGENT) rows.push({ from: sec(u), to: sec(u) + 5, why: 'urgent + 5 s' });
    return rows;
}

let daySimPromise = null;
function daySim() {
    daySimPromise ||= Promise.resolve().then(() => {
        const ledger = { firstOccasion: true, welcomeDay: VIRTUAL_DAY, islandDay: VIRTUAL_DAY, occasions: [] };
        const t0 = Date.now();
        const sim = villageDay({ seed: SEED, plan: dayPlanAt, phaseAt, ledger });
        return { ...sim, wallSec: (Date.now() - t0) / 1000 };
    });
    return daySimPromise;
}

// Heard spans: a visit from its first note to its end plus the ring-out in
// the air (OccasionClock's own measure of duty).
const heardVisits = (visits, ring = OCC_RING_OUT_SEC) => visits.map(v => ({ ...v, to: v.to + ring }));

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
                    const bank = rows['day:isle'].bank?.byClient?.music ?? null;
                    if (has('isleband') && bank) wave6.musicBank.push(bank);
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
    if (has('nightmusic')) {
        units.push({
            name: 'nightmusic (6.3: the night occasion over its bed)',
            async run() {
                const r = await scene('nightProgram');
                const vis = visitRows(r.meta.music?.marks || [], r.meta.warmup + r.meta.seconds, 'village');
                const occ = vis.visits.find(v => v.what === 'occasion');
                verdict('nightmusic', occ != null, `night 22:30, a settled profile: the Village started ${vis.visits.map(v => `${v.what} ${v.name} (${v.reason}) at ${fmt(v.from, 1)} s`).join(', ') || 'nothing'}; want the night occasion`);
                if (!occ) return;
                const over = musicOverBed(r, occ);
                const t = LOUDNESS_TARGETS.villageMusic;
                verdict('nightmusic', over.stMaxOverBed != null && over.stMaxOverBed <= t.stMaxOverBed, `night occasion ${occ.name}: music ST max ${fmt(over.musicStMax)} vs the bed (world + work) ${fmt(over.bedLufs)} LUFS over the occasion: ${signed(over.stMaxOverBed)} LU; want ≤ bed + ${t.stMaxOverBed} LU`);
                const lead = range(seatLine(noteRows(r, { from: occ.from, to: occ.to }), 'lead'));
                verdict('nightmusic', lead.high != null && lead.high <= L.nightLeadMaxMidi, `night occasion lead ${midiName(lead.low)}–${midiName(lead.high)}; want ≤ A5`);
                const stops = stopLevels(r, { maxDb: L.stopMaxDb });
                verdict('nightmusic', stops.over === 0, `night occasion: ${stops.voices} stopped voices, the loudest at its stop ${fmt(stops.worstDb)} dB re its peak; want none above ${L.stopMaxDb} dB`);
            },
        });
    }
    if (has('score')) {
        units.push({
            name: 'score (6.5: routine cues over the band, Town band and Village)',
            async run() {
                for (const name of ['townBand', 'villageBusy']) {
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
                const own = sim.marks.filter(m => m.kind === 'rendition' && m.what !== 'fragment');
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
        units.push({
            name: 'score (6.5: the Village day — re-hearing over music-on windows, motif per hour)',
            async run() {
                const sim = await daySim();
                const vis = visitRows(sim.marks, sim.seconds, 'village');
                const notes = noteRows(sim.marks).filter(n => n.seat !== 'percussion');
                const on = heardVisits(vis.visits);
                const rows = [];
                for (let h = 0; h * 3600 < sim.seconds; h++) {
                    const a = h * 3600;
                    const b = Math.min(sim.seconds, a + 3600);
                    const hn = notes.filter(n => n.t >= a && n.t < b).map(n => ({ ...n, t: n.t - a }));
                    const ho = coveredSpans(on, a, b).map(w => ({ from: w.from - a, to: w.to - a }));
                    rows.push({ h, tonal: tonalReheard(hn, ho), phrase: phraseReheard(hn, ho) });
                }
                const worst = Math.max(...rows.map(x => Math.max(x.tonal.pct, x.phrase.pct)));
                verdict('score', rows.length > 0 && worst <= L.reheardMaxPct, `Village 09:00–18:00 (seed ${SEED}), re-heard over music-on windows per hour — tonal ${rows.map(x => fmt(x.tonal.pct, 0)).join('/')} %, phrase ${rows.map(x => fmt(x.phrase.pct, 0)).join('/')} %; want ≤ ${L.reheardMaxPct} % in every hour`);
                const motif = motifStatements(notes);
                // The hour phrase (D7) is the motif's answer: one statement at
                // each hour 07:00–20:00; the aurora quotes the call when a
                // chronicle aurora fires (INFO: not modelled here).
                const chimes = [];
                for (let m = Math.ceil(sim.fromMinute / 60) * 60; (m - sim.fromMinute) * 60 < sim.seconds; m += 60) chimes.push((m - sim.fromMinute) * 60);
                const per = perHourMax([...motif.at.map(x => x.t), ...chimes], 0, sim.seconds);
                verdict('score', per.pass, `motif statements per hour (fragments and occasions ${motif.count} + hour phrases ${chimes.length}): ${per.perHour.join('/')}; want ≤ ${L.motifPerHour} (S7)`);
            },
        });
    }
    if (has('occasions')) {
        units.push({
            name: 'occasions (6.6: the seeded working day 09:00–18:00, headless)',
            async run() {
                const sim = await daySim();
                const end = sim.seconds;
                const vis = visitRows(sim.marks, end, 'village');
                const heard = heardVisits(vis.visits);
                const minuteOf = t => sim.fromMinute + t / 60;
                // Duty per regime, over the regime's time outside the hard
                // zeros, from fragments (occasions are their own budget).
                const zeros = dayZeroWindows(sim.fromMinute);
                const regimeTime = { busy: 0, light: 0 };
                const regimeFrag = { busy: 0, light: 0 };
                for (let t = 0; t < end; t += 10) {
                    const p = dayPlanAt(minuteOf(t));
                    if (zeros.some(z => t >= z.from && t < z.to) || p.working === 0) continue;
                    const regime = dutyBandFor({ phase: phaseAt(minuteOf(t)).phase, working: p.working }).name;
                    if (!(regime in regimeTime)) continue;
                    regimeTime[regime] += 10;
                    regimeFrag[regime] += coveredSec(heard.filter(v => v.what === 'fragment'), t, t + 10);
                }
                const busy = judgeDuty(regimeFrag.busy / regimeTime.busy, 'busy');
                const light = judgeDuty(regimeFrag.light / regimeTime.light, 'light');
                const dayFrags = FRAGMENTS.filter(f => !f.night);
                const fragSec = dayFrags.reduce((s, f) => s + fragmentSeconds(f), 0) / Math.max(1, dayFrags.length) + OCC_RING_OUT_SEC;
                const expect = regime => fragSec / (fragSec + (OCC_DUTY[regime].gapSec[0] + OCC_DUTY[regime].gapSec[1]) / 2);
                verdict('occasions', busy.pass && light.pass, `D1 fragment duty (heard, incl. ${OCC_RING_OUT_SEC} s ring-out): busy ${pct(busy.share)} of ${fmt(regimeTime.busy / 60, 0)} min (want ${pct(D1_DUTY.busy[0])}–${pct(D1_DUTY.busy[1])}; the constants give ${pct(expect('busy'))}: ${fmt(fragSec, 1)} s fragments, ${OCC_DUTY.busy.gapSec.join('–')} s gaps), light ${pct(light.share)} of ${fmt(regimeTime.light / 60, 0)} min (want ≤ ${pct(D1_DUTY.light[1])}; constants ${pct(expect('light'))})`);
                const occ = vis.visits.filter(v => v.what === 'occasion').map(v => `${v.name} ${fmtClock(minuteOf(v.from))}`);
                info('occasions', `the day: ${vis.visits.length} starts (${vis.visits.filter(v => v.what === 'fragment').length} fragments; occasions ${occ.join(', ') || 'none'}); simulated in ${fmt(sim.wallSec, 1)} s`);
                // S7 zeros: no start inside a zero; what played when one began
                // ends within the director's tick (1 s) and fade (0.4 s).
                const shrink = zeros.map(z => ({ ...z, from: z.from + 1.5 }));
                const z = musicInWindows(vis.visits, shrink, vis.visits.map(v => v.from));
                const starts = vis.visits.filter(v => zeros.some(w => v.from >= w.from && v.from < w.to));
                verdict('occasions', z.overlapSec === 0 && starts.length === 0, `must-never 9 / S7 (headless day): music inside rain, resting, a wait ≥ 6 min or 5 s after an urgent cue ${fmt(z.overlapSec, 1)} s past the 1.5 s release; starts inside ${starts.length}${starts.length ? ` (${starts.slice(0, 3).map(v => `${v.name} at ${fmtClock(minuteOf(v.from))}`).join(', ')})` : ''} (${zeros.map(w => `${w.why} ${fmtClock(minuteOf(w.from))}`).join(', ')}); want 0 and 0`);
                const noReason = vis.visits.filter(v => !v.reason);
                verdict('occasions', vis.visits.length > 0 && noReason.length === 0, `every start carries a reason: ${vis.visits.length - noReason.length}/${vis.visits.length} (${[...new Set(vis.visits.map(v => v.reason))].join(', ')})`);
                const hours = [];
                for (let a = 0; a < end; a += 3600) hours.push(coveredSec(heard, a, Math.min(end, a + 3600)) / Math.min(3600, end - a));
                verdict('occasions', Math.max(...hours) <= L.villageOnMax, `must-never 10 (Village): music on per working hour ${hours.map(x => pct(x)).join('/')} (occasions included); want ≤ ${pct(L.villageOnMax)}`);
            },
        });
        for (const kind of Object.keys(VILLAGE_FIXTURES)) {
            units.push({
                name: `occasions (6.6: Village fixture ${kind})`,
                async run() {
                    const r = await renderOnce(`music:village:${kind}`, villageMusicScene(kind));
                    judgeVillageFixture(kind, r);
                },
            });
        }
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
                const cad = (r.meta.music?.marks || []).filter(m => m.preset === 'townBand' && m.kind === 'cadence').sort((a, b) => a.t - b.t);
                // A wait reaches the band on the director's next tick and the
                // phrase end must not yet be committed: 1 s + 1.5 s.
                const during = cad.filter(c => c.t >= at(w.waitAt) + 2.5 && c.t < at(w.answerAt));
                const after = cad.find(c => c.t >= at(w.answerAt) + 2.5);
                const pass = during.length > 0 && during.every(c => c.deceptive) && after != null && !after.deceptive;
                verdict('townband', pass, `a needs-you open ${w.waitAt}–${w.answerAt} s: phrase ends while waiting ${during.map(c => `${c.type} (${c.piece} bar ${c.bar})`).join(', ') || 'none'}; the first after the answer ${after ? `${after.type} at ${fmt(after.t - at(w.answerAt), 1)} s` : 'none'}; want every phrase end deceptive while waiting, home after`);
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
                const density = densityTrack(marks);
                const bars = percussionPerBar(marks, density, { from, to: end });
                const rho = spearman(bars.map(b => b.onsets), bars.map(b => b.density));
                const bySeg = PERCUSSION_SEGMENTS.map(s => { const x = bars.filter(b => b.from >= from + s.from && b.from < from + s.to); return `${s.from / 60}–${s.to / 60} min ${fmt(x.reduce((a, b) => a + b.onsets, 0) / Math.max(1, x.length), 1)}/bar at density ${fmt(x.reduce((a, b) => a + b.density, 0) / Math.max(1, x.length), 2)}`; });
                verdict('percussion', rho != null && rho >= L.spearmanMin, `percussion onsets per bar vs total workshop density over ${bars.length} bars: Spearman ${fmt(rho, 2)} (${bySeg.join('; ')}); want ≥ ${L.spearmanMin}`);
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

const wave6 = { musicBank: [] };
// Minutes of the day (or of a session) as hh:mm.
const fmtClock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const coveredSpans = (visits, a, b) => visits.map(v => ({ from: Math.max(a, v.from), to: Math.min(b, v.to) })).filter(v => v.to > v.from);
function fragmentSeconds(frag) {
    const bpb = frag.beatsPerBar || 4;
    const bars = frag.chords?.length ?? frag.bars ?? 0;
    const pickup = (frag.pickup || []).reduce((s, [, b]) => s + b, 0);
    return (bars * bpb + pickup) * 60 / frag.bpm;
}

// Music ST max over the bed (world + work stems summed) over one visit.
function musicOverBed(r, visit) {
    const g = outputGainDb(r);
    const a = Math.max(0, visit.from);
    const b = Math.min(r.meta.warmup + r.meta.seconds, visit.to + 1);
    const cut = pair => ({ L: pair.L.subarray(Math.round(a * r.sr), Math.round(b * r.sr)), R: pair.R.subarray(Math.round(a * r.sr), Math.round(b * r.sr)) });
    const music = toOutput(cut(r.stems.music), g);
    const beds = ['world', 'work'].filter(k => r.stems[k]).map(k => toOutput(cut(r.stems[k]), g));
    const bed = sumOf(beds, music.L.length);
    const musicStMax = loudness(music.L, music.R, r.sr).shortTermMax;
    const bedLufs = loudness(bed.L, bed.R, r.sr).integrated;
    return { musicStMax, bedLufs, stMaxOverBed: Number.isFinite(musicStMax) && Number.isFinite(bedLufs) ? musicStMax - bedLufs : null };
}

// A Village fixture's heard music (the music stem, output-referred) against
// its zero windows, its control (music once the zero clears), reasons and
// level over the bed.
function judgeVillageFixture(kind, r) {
    const f = VILLAGE_FIXTURES[kind];
    const w0 = r.meta.warmup;
    const end = w0 + r.meta.seconds;
    const vis = visitRows(r.meta.music?.marks || [], end, 'village');
    const heard = heardSpans(r.stems.music, r.sr, outputGainDb(r), { floorLufs: -70 });
    const cueAt = kindName => r.meta.scheduled.filter(s => s.kind === kindName && !s.silent).map(s => s.notes[0]);
    const startLine = vis.visits.map(v => `${v.what} ${v.name} (${v.reason}) at ${fmt(v.from - w0, 1)} s`).join(', ') || 'none';
    const zeros = [];
    let controlFrom = null;
    if (kind === 'rain') { zeros.push({ from: 0, to: w0 + f.clearAt, why: 'rain' }); controlFrom = w0 + f.clearAt; }
    if (kind === 'wait') { zeros.push({ from: 0, to: w0 + f.answerAt, why: 'a wait ≥ 6 min' }); controlFrom = w0 + f.answerAt; }
    if (kind === 'urgent') {
        zeros.push({ from: 0, to: w0 + f.clearAt, why: 'rain' });
        for (const t of cueAt('summons')) zeros.push({ from: t, to: t + 5, why: 'urgent + 5 s' });
        controlFrom = w0 + f.clearAt;
    }
    if (kind === 'resting') {
        const rest = r.meta.stateLog.filter(s => s.state === 'resting').map(s => s.t);
        if (rest.length) zeros.push({ from: Math.min(...rest), to: Math.max(...rest) + 1, why: 'resting (director state)' });
        controlFrom = w0 + f.workAt;
        info('occasions', `resting fixture: director state resting ${rest.length ? `${fmt(Math.min(...rest) - w0, 0)}–${fmt(Math.max(...rest) - w0, 0)} s` : 'never'}`);
    }
    if (zeros.length) {
        // Music already sounding when a zero begins may ring out for the
        // director's tick, the 0.4 s release and the air (3 s); none may start.
        const soft = zeros.map(z => ({ ...z, from: z.from === 0 ? 0 : z.from + 3 }));
        const inside = musicInWindows(heard, soft, vis.visits.map(v => v.from));
        verdict('occasions', inside.overlapSec === 0 && inside.starts === 0, `must-never 9 / S7, fixture ${kind}: heard music inside ${zeros.map(z => `${z.why} ${fmt(z.from - w0, 1)}–${fmt(z.to - w0, 1)} s`).join(', ')}: ${fmt(inside.overlapSec, 2)} s, starts ${inside.starts}; want 0 (starts: ${startLine})`);
    }
    if (controlFrom != null && kind !== 'resting') {
        const later = vis.visits.find(v => v.from >= controlFrom);
        verdict('occasions', later != null, `fixture ${kind} control: once the zero clears at ${fmt(controlFrom - w0, 1)} s the due occasion plays: ${later ? `${later.name} at ${fmt(later.from - w0, 1)} s` : 'nothing'} (otherwise the zero proves nothing)`);
    }
    if (kind === 'first' || kind === 'fragment') {
        const want = kind === 'first' ? 'occasion' : 'fragment';
        const v = vis.visits.find(x => x.what === want);
        const reasons = r.meta.stateLog.map(s => s.music?.lastStart?.reason).filter(Boolean);
        verdict('occasions', v != null && Boolean(v.reason) && reasons.length > 0, `fixture ${kind}: starts ${startLine}; snapshot reasons ${[...new Set(reasons)].join(', ') || 'none'}; want a${want === 'occasion' ? 'n' : ''} ${want} with its reason in the snapshot`);
        if (v) {
            const over = musicOverBed(r, v);
            const t = LOUDNESS_TARGETS.villageMusic;
            const max = kind === 'first' ? t.stMaxOverBed : t.fragmentStMaxOverBed;
            verdict('occasions', over.stMaxOverBed != null && over.stMaxOverBed <= max, `Village music (${want} ${v.name}): ST max ${fmt(over.musicStMax)} over the bed's ${fmt(over.bedLufs)} LUFS: ${signed(over.stMaxOverBed)} LU; want ≤ bed + ${max} LU (S2)`);
        }
    }
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
        if (has('worldmap')) judgeWorldMapRows();
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

