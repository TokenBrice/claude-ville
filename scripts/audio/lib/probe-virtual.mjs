// The probe's virtual-clock checks (HAR-1/2/3/5/12): named scenes rendered
// through the shipped controller on an OfflineAudioContext (lib/virtual.mjs),
// judged against Loudness.js by lib/checks.mjs. Every function here returns
// numbers; probe.mjs turns them into PASS/FAIL lines.
import { loudness, peaks } from './analyze.mjs';
import { marginAt } from './timeline.mjs';
import { renderEngineUnit, renderVirtual } from './virtual.mjs';
import { LANE_CUE_KIND, LIMITER_UNIT, MARGIN_BEDS, SCENES, marginScene } from './scenes.mjs';
import {
    accentSync, avSync, duckedTime, energyMeanLufs, limiterGainReduction, maxGrIn, onsetNear, presetSwitch,
} from './checks.mjs';
import { cueBandRise, presenceRise } from '../metrics/cuebands.mjs';
import { levelMap } from '../metrics/levelmap.mjs';
import { welch } from '../metrics/dsp.mjs';
import { AUDIBILITY_WINDOWS, PROGRAM_TRIM_DB } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';
import { CUE_ACCENT_NOTE } from '../../../claudeville/src/presentation/shared/audio/CueScore.js';
import { SIGNALS_FADE_SEC } from '../../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { BODY_SNAP_SEC } from '../../../claudeville/src/presentation/shared/audio/cues/CueKit.js';

const MARGIN = { bedWindowSec: AUDIBILITY_WINDOWS.bedWindowSec, cueWindowSec: 2.5, silenceFloorLufs: -80 };
const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const volumeDb = step => (step > 0 ? (step - 10) * 3.6 : -Infinity);

// Output-referred: a bus or cue tap sits before the program trim and volume.
export const outputGainDb = r => PROGRAM_TRIM_DB + volumeDb(r.meta.volumeStep ?? 6);

// Band level (dB, Welch PSD summed over [lo, hi) Hz, both channels): only
// differences between two such numbers mean anything.
export function bandLevelDb({ L, R }, sr, lo, hi) {
    const psd = welch([L, R]);
    const N = (psd.length - 1) * 2;
    let e = 0;
    for (let k = 1; k < psd.length; k++) {
        const f = (k * sr) / N;
        if (f >= lo && f < hi) e += psd[k];
    }
    return e > 0 ? 10 * Math.log10(e) : -Infinity;
}

// A stem's level in `hopSec` blocks, one render minus its twin (dB), as
// [[t, dB], …]; blocks where the twin is silent are skipped (5.6's quiet mix).
export function levelDiffCurve(a, b, sr, { hopSec = 0.1, floor = 1e-7 } = {}) {
    const hop = Math.round(hopSec * sr);
    const n = Math.min(a.L.length, b.L.length);
    const out = [];
    for (let k = 0; (k + 1) * hop <= n; k++) {
        let ea = 0;
        let eb = 0;
        for (let i = k * hop; i < (k + 1) * hop; i++) {
            ea += a.L[i] * a.L[i] + a.R[i] * a.R[i];
            eb += b.L[i] * b.L[i] + b.R[i] * b.R[i];
        }
        if (eb / hop < floor * floor) continue;
        out.push([(k + 1) * hopSec, ea > 0 ? 10 * Math.log10(ea / eb) : -120]);
    }
    return out;
}

// Renders are cached per key so several checks share one render.
export function makeRenderer(browser, baseUrl, { seed, noWorklets }) {
    const cache = new Map();
    return (key, spec) => {
        if (!cache.has(key)) cache.set(key, renderVirtual(browser, baseUrl, { ...spec, name: key, noWorklets }, { seed }));
        return cache.get(key);
    };
}

function cut(pair, sr, fromSec) {
    const a = Math.round(fromSec * sr);
    return { L: pair.L.subarray(a), R: pair.R.subarray(a) };
}

// Program loudness of a scene after its warmup, plus true peak and, when the
// scene has limiter taps, the largest gain reduction.
export function sceneMetrics(r) {
    const { L, R } = cut(r.program, r.sr, r.meta.warmup);
    const lou = loudness(L, R, r.sr);
    const st = lou.shortTermCurve.map(([, v]) => v);
    const finite = st.filter(Number.isFinite);
    const tp = Math.max(peaks(L).truePeak, peaks(R).truePeak);
    let grMax = null;
    if (r.stems.limiterIn && r.stems.limiterOut) {
        const gr = limiterGainReduction(r.stems.limiterIn.L, r.stems.limiterIn.R, r.stems.limiterOut.L, r.stems.limiterOut.R, r.sr);
        grMax = maxGrIn(gr, r.meta.warmup, r.meta.warmup + r.meta.seconds);
    }
    return {
        lufsI: lou.integrated, lra: lou.lra, stMax: lou.shortTermMax,
        stMean: energyMeanLufs(st), stMin: finite.length ? Math.min(...finite) : null,
        truePeakDbtp: toDb(tp), grMaxDb: grMax,
        renderMs: r.meta.renderMs, limiterKind: r.meta.limiterKind,
    };
}

// HAR-5: each stem's loudness as heard at the output (bus taps sit before
// the program trim and the volume; the cue tap before its own trim) and its
// share of the program's K-weighted energy (ungated: the energy mean of the
// momentary blocks, so a sparse cue stem is not lifted by gating).
export function stemReport(r) {
    const gainDb = PROGRAM_TRIM_DB + volumeDb(r.meta.volumeStep ?? 6);
    const program = cut(r.program, r.sr, r.meta.warmup);
    const programLou = loudness(program.L, program.R, r.sr);
    const programMean = energyMeanLufs(programLou.momentaryCurve.map(([, v]) => v));
    const rows = {};
    for (const [name, pair] of Object.entries(r.stems)) {
        if (name.startsWith('limiter')) continue;
        const { L, R } = cut(pair, r.sr, r.meta.warmup);
        const lou = loudness(L, R, r.sr);
        const mean = energyMeanLufs(lou.momentaryCurve.map(([, v]) => v));
        rows[name] = {
            lufsI: lou.integrated + gainDb, stMax: lou.shortTermMax + gainDb,
            shareOfProgramDb: mean != null && programMean != null ? mean + gainDb - programMean : null,
        };
    }
    return { programLufs: programLou.integrated, gainDb, stems: rows };
}

// The first published note of the cue an action marker raised.
function onsetFor(marker, scheduled, kinds) {
    const s = scheduled.find(x => !x.silent && kinds.includes(x.kind)
        && x.t >= marker.t - 0.002 && x.t <= marker.t + 5
        && (marker.agentId == null || x.agentId == null || x.agentId === marker.agentId));
    return s ? { onset: s.notes[0], kind: s.kind, agentId: s.agentId } : null;
}

// HAR-3: every lane's placements over one bed: LU margin (max momentary in
// [t, t + 2.5] over the 3 s before), the band rule inputs and the limiter GR.
export function marginRows(r, bedName) {
    return laneMarginRows(r, MARGIN_BEDS[bedName].bed);
}

// The cue's own level over the bed (Minor outcomes, the Wave-4 ruling): the
// cue stem's max momentary in [t, t + 2.5 s] over the energy mean of the
// music stem (the one bed bus; same bus staging as the cue tap) in the 3 s
// before — so a swell of the band under a quiet knock cannot lift it.
// null without the music stem.
const BED_STEMS = ['music'];
function stemMarginRows(r) {
    const beds = BED_STEMS.filter(k => r.stems[k]);
    if (!r.stems.cue || !beds.length) return null;
    const n = r.stems.cue.L.length;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (const k of beds) {
        const s = r.stems[k];
        for (let i = 0; i < n; i++) { L[i] += s.L[i]; R[i] += s.R[i]; }
    }
    const bedCurve = loudness(L, R, r.sr).momentaryCurve;
    const cueCurve = loudness(r.stems.cue.L, r.stems.cue.R, r.sr).momentaryCurve;
    return (t) => {
        const bed = marginAt(bedCurve, t, MARGIN).bed;
        const cue = marginAt(cueCurve, t, MARGIN).cueMax;
        return Number.isFinite(cue) ? cue - Math.max(bed, MARGIN.silenceFloorLufs) : null;
    };
}

// The same for any render whose lane actions carry `lane` markers and whose
// stems include both limiter taps; `bed` is the S2 bed context. Every row
// carries `programMargin` (cue + bed over the bed, on the program) and,
// with bed stems, `stemMargin`; `margin` is the program margin, except for
// Minor outcomes, judged on `stemMargin` (the Wave-4 ruling).
export function laneMarginRows(r, bed) {
    const { L, R } = r.program;
    const lou = loudness(L, R, r.sr);
    const stemMargin = stemMarginRows(r);
    const gr = limiterGainReduction(r.stems.limiterIn.L, r.stems.limiterIn.R, r.stems.limiterOut.L, r.stems.limiterOut.R, r.sr);
    const rows = [];
    for (const m of r.meta.markers.filter(x => x.lane && LANE_CUE_KIND[x.lane])) {
        const voice = m.laneVoice ?? LANE_CUE_KIND[m.lane];
        const hit = onsetFor(m, r.meta.scheduled, [voice]);
        if (!hit) { rows.push({ lane: m.lane, voice, bed, label: m.label, at: m.t, margin: null }); continue; }
        const t = hit.onset;
        const mg = marginAt(lou.momentaryCurve, t, MARGIN);
        const bands = cueBandRise(L, R, r.sr, t);
        const sm = stemMargin ? stemMargin(t) : null;
        rows.push({
            lane: m.lane, voice, bed, label: m.label, at: t,
            margin: m.lane === 'outcomeMinor' && sm != null ? sm : mg.margin, programMargin: mg.margin, stemMargin: sm,
            bedLufs: mg.bed, cueMaxLufs: mg.cueMax,
            bandsOver6dB: bands.bandsOver6dB, bestRiseDb: bands.bestRiseDb,
            presenceRiseDb: presenceRise(L, R, r.sr, t),
            grDb: maxGrIn(gr, t, t + MARGIN.cueWindowSec),
            trimDb: r.meta.levels.find(l => l.kind === hit.kind && Math.abs(l.at - t) < 0.05)?.trimDb ?? null,
        });
    }
    return rows;
}

export function switchRows(r) {
    const lou = loudness(r.program.L, r.program.R, r.sr);
    return r.meta.markers.filter(m => m.label?.startsWith('mode:')).map(m => ({
        label: m.label, t: m.t, ...presetSwitch(lou.momentaryCurve, { L: r.program.L, R: r.program.R, sr: r.sr }, m.t, { fadeSec: SIGNALS_FADE_SEC }),
    }));
}

export function duckRows(r) {
    const start = r.meta.warmup;
    const end = r.meta.warmup + r.meta.seconds;
    const inside = r.meta.ducks.filter(d => d.until >= start && d.from <= end);
    return { fractions: duckedTime(inside, start, end), windows: inside.length, cancelled: inside.filter(d => d.cancelledAt != null).length };
}

// HAR-12 on the virtual clock: every published note of every sounding score
// against the first onset heard on the cue stem near it; accents declared
// before their cue against the heard carrying note, which S4's grid may have
// moved onto the band's grid (lib/checks.mjs accentSync).
export function avSyncRows(r, { syncMs }) {
    const cue = r.stems.cue;
    const mono = new Float32Array(cue.L.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (cue.L[i] + cue.R[i]);
    const notes = [];
    for (const s of r.meta.scheduled.filter(x => !x.silent)) {
        s.notes.forEach((t, i) => {
            // A note closer than 40 ms to its neighbour cannot be told apart.
            const prev = s.notes[i - 1];
            if (prev != null && t - prev < 0.04) return;
            notes.push({ kind: s.kind, published: t, heard: onsetNear(mono, r.sr, t) });
        });
    }
    const accents = r.meta.accents.map((a) => {
        const s = r.meta.scheduled.find(x => !x.silent && x.kind === a.kind && x.agentId === a.agentId && x.t >= a.t - 0.002);
        const note = s?.notes[CUE_ACCENT_NOTE[a.kind] ?? 0];
        return { kind: a.kind, published: a.accentT, carrying: note ?? null, heard: note != null ? onsetNear(mono, r.sr, note) : null };
    });
    return { notes: avSync(notes), accents: accentSync(accents, r.meta.music?.frames, { snapSec: BODY_SNAP_SEC, syncMs }) };
}

export function limiterUnitRows(u) {
    const { limiterIn, limiterOut } = u.stems;
    const sr = u.sr;
    const slice = (x, a, b) => x.subarray(Math.round(a * sr), Math.round(b * sr));
    const rms = (x) => { let e = 0; for (const v of x) e += v * v; return Math.sqrt(e / Math.max(1, x.length)); };
    const staticIn = rms(slice(limiterIn.L, 1.2, 1.9));
    const staticOut = rms(slice(limiterOut.L, 1.2, 1.9));
    const burstIn = Math.max(peaks(slice(limiterIn.L, 2.9, 5.2)).sample, peaks(slice(limiterIn.R, 2.9, 5.2)).sample);
    const outL = slice(u.program.L, 2.9, 5.3);
    const outR = slice(u.program.R, 2.9, 5.3);
    const pOut = Math.max(peaks(outL).sample, peaks(outR).sample);
    const tpOut = Math.max(peaks(outL).truePeak, peaks(outR).truePeak);
    return {
        limiterKind: u.meta.limiterKind,
        staticGainDb: toDb(staticOut / staticIn),
        burstInDbfs: toDb(burstIn),
        burstOutDbfs: toDb(pOut),
        burstOutDbtp: toDb(tpOut),
    };
}

export async function renderLimiterUnit(browser, baseUrl, { seed, noWorklets }) {
    return renderEngineUnit(browser, baseUrl, { ...LIMITER_UNIT, noWorklets }, { seed });
}

export function sceneSpec(name) {
    if (SCENES[name]) return SCENES[name];
    // margin:<bed>:<lane>[:<voice>][#<placement>] (lib/scenes.mjs marginKeys)
    const m = /^margin:(\w+):(\w+)(?::(\w+))?(?:#(\d+))?$/.exec(name);
    if (m) return marginScene(m[1], m[2], m[3] ?? null, m[4] != null ? Number(m[4]) : null);
    throw new Error(`unknown scene ${name}`);
}

// A levelled summary of a scene for the report and the JSON (levelmap).
export function sceneLevelMap(r) {
    const { L, R } = cut(r.program, r.sr, r.meta.warmup);
    return levelMap(L, R, r.sr);
}
