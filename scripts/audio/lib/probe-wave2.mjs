// The probe's Wave-2 measurements ("one clock, one air"): the Transport and
// timer attribution, pause in place, Island Air, the noise pool, the
// SampleBank and sequencer equivalence, on the virtual clock (lib/virtual.mjs),
// plus the sequencer's Wave-1 reference renders taken from an exported
// earlier revision. Every function returns numbers; probe.mjs turns them
// into PASS/FAIL lines through the pure judges in checks.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loudness } from './analyze.mjs';
import { renderAirUnit } from './virtual.mjs';
import { REPO_ROOT, startStaticServer } from './server.mjs';
import { energyRatioDb, pieceOnsets, resumeBurst } from './checks.mjs';
import { AIR_ARRIVALS, AIR_UNIT, HIDDEN_AT, HIDDEN_SECONDS, sequencerPieces } from './scenes.mjs';
import { repetition, rt60 } from '../metrics/amb-metrics.mjs';
import { levelMap } from '../metrics/levelmap.mjs';

const SONGBOOK = 'claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';

function slice(pair, sr, a, b) {
    const i = Math.max(0, Math.round(a * sr));
    const j = Math.min(pair.L.length, Math.round(b * sr));
    return { L: pair.L.subarray(i, j), R: pair.R.subarray(i, j) };
}
const mono = ({ L, R }) => { const m = new Float32Array(L.length); for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]); return m; };

// -------------------------------------------------------------- transport ----
export function transportRows(r) {
    return { diag: r.meta.diagnostics?.transport ?? null, timers: r.meta.timers, startCount: r.meta.startCount, errors: r.errors };
}

// ------------------------------------------------------- pause in place ----
// The context's suspend and resume (the shimmed state log) after the
// scene's hide, the resume burst, and the piece before and after. The audio
// clock is frozen while suspended (freezeOnSuspend), so hide and show sit a
// few ms apart in audio time; the virtual clock ran HIDDEN_SECONDS between.
export function pauseRows(r) {
    const hideT = r.meta.warmup + HIDDEN_AT;
    const states = r.meta.contextStates;
    const suspendedAt = states.find(s => s.state === 'suspended' && s.t >= hideT - 0.01)?.t ?? null;
    const resumedAt = suspendedAt == null ? null : states.find(s => s.state === 'running' && s.t >= suspendedAt)?.t ?? null;
    const burst = resumeBurst(r.meta.starts, { hideT, resumeT: resumedAt ?? hideT });
    const playing = (t) => {
        const row = [...r.meta.stateLog].reverse().find(s => s.t <= t);
        const np = row?.nowPlaying;
        return np ? (np.piece ?? np.song ?? null) : null;
    };
    return {
        hideT, hiddenSec: HIDDEN_SECONDS, suspendedAt, resumedAt, ...burst,
        pieceBefore: playing(hideT - 0.5), pieceAfter: resumedAt != null ? playing(resumedAt + 2) : null,
    };
}

// -------------------------------------------------------------- Island Air ----
export async function renderAir(browser, baseUrl, { seed }) {
    return renderAirUnit(browser, baseUrl, AIR_UNIT, { seed });
}

// T60 per phase from the IRs themselves; direct-to-reverberant of each
// burst: dry (world bus) over wet (air return) energy in the burst's 4.4 s.
export function airRows(u) {
    const t60 = {};
    for (const phase of ['day', 'night']) {
        const ir = u.irs[phase];
        t60[phase] = ir ? rt60(ir.L, ir.R, u.irRates[phase === 'day' ? 'irDay' : 'irNight'], { bands: [1000, 4000] }) : null;
    }
    const dr = AIR_UNIT.bursts.map((b) => {
        const dry = slice(u.stems.world, u.sr, b.at, b.at + 4.4);
        const wet = slice(u.stems.airWet, u.sr, b.at, b.at + 4.4);
        return { d: b.d, drDb: energyRatioDb(mono(dry), mono(wet)), placed: u.meta.placements.find(p => p.at === b.at) ?? null };
    });
    return { t60, dr, bank: u.meta.diagnostics?.bank ?? null, timers: u.meta.timers, errors: u.errors };
}

// Direct-to-reverberant through the cue path: each placed arrival's dry
// (cue sum) over wet (air return, cue sends only) energy in the 4.4 s from
// its first published note.
export function arrivalDrRows(r) {
    const arrivals = r.meta.scheduled.filter(s => !s.silent && s.kind === 'arrival');
    return AIR_ARRIVALS.map((a) => {
        const at = r.meta.warmup + a.at;
        const s = arrivals.find(x => x.t >= at - 0.01 && x.t <= at + 1);
        if (!s) return { d: a.d, drDb: null };
        const t = s.notes[0];
        return { d: a.d, t, drDb: energyRatioDb(mono(slice(r.stems.cue, r.sr, t, t + 4.4)), mono(slice(r.stems.airWet, r.sr, t, t + 4.4))) };
    });
}

// Urgent cues: wet (air return, cue sends only) re dry (cue sum) over each
// needs-you's 2.5 s from its first published note.
export function urgentWetRows(r) {
    return r.meta.scheduled.filter(s => !s.silent && s.kind === 'summons').map((s) => {
        const t = s.notes[0];
        return { t, wetDb: energyRatioDb(mono(slice(r.stems.airWet, r.sr, t, t + 2.5)), mono(slice(r.stems.cue, r.sr, t, t + 2.5))) };
    });
}

// ---------------------------------------------------------------- noise ----
export function textureRows(r, stem) {
    const pair = slice(r.stems[stem], r.sr, r.meta.warmup, r.meta.warmup + r.meta.seconds);
    const rep = repetition(pair.L, pair.R, r.sr);
    const lou = loudness(pair.L, pair.R, r.sr);
    return { peak: rep.peak, icc: rep.icc, lufsI: lou.integrated };
}

export function bedRows(r) {
    const cut = { L: r.program.L.subarray(Math.round(r.meta.warmup * r.sr)), R: r.program.R.subarray(Math.round(r.meta.warmup * r.sr)) };
    const world = r.stems.world ? slice(r.stems.world, r.sr, r.meta.warmup, r.meta.warmup + r.meta.seconds) : null;
    return { monoLossLU: levelMap(cut.L, cut.R, r.sr).monoLossLU, worldIcc: world ? repetition(world.L, world.R, r.sr).icc : null };
}

// ------------------------------------------------------------- sequencer ----
// One traced render of a pinned piece → its onsets and program loudness
// from the first onset to the end of the song or loop (+ 1.5 s of tail).
export function sequencerRow(r, p) {
    const po = pieceOnsets(r.meta.musicOnsets || [], { loopSec: p.loopSec });
    if (po.start == null) return { onsets: [], lufsI: null, pinned: r.meta.pinned, errors: r.errors };
    const end = p.loopSec != null ? po.start + p.loopSec : po.end + 1.5;
    const win = slice(r.program, r.sr, po.start, Math.min(end + 1.5, r.program.L.length / r.sr));
    return { onsets: po.onsets, lufsI: loudness(win.L, win.R, r.sr).integrated, start: po.start, pinned: r.meta.pinned, rng: r.meta.rng, errors: r.errors };
}

export async function loadPieces(root = REPO_ROOT) {
    const mod = await import(pathToFileURL(path.join(root, SONGBOOK)).href);
    return sequencerPieces(mod.PIECES);
}

// Exports `rev`'s claudeville/ into a temp dir (git archive: read-only) and
// serves it; the harness pages stay the current ones and feature-detect
// the older engine.
export async function referenceServer(rev) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeville-audio-ref-'));
    const archive = spawnSync('git', ['archive', '--format=tar', rev, 'claudeville'], { cwd: REPO_ROOT, maxBuffer: 1 << 30 });
    if (archive.status !== 0) throw new Error(`git archive ${rev}: ${archive.stderr}`);
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1 << 30 });
    if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
    const server = await startStaticServer({ appDir: path.join(dir, 'claudeville') });
    return {
        server, root: dir,
        async close() { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
}
