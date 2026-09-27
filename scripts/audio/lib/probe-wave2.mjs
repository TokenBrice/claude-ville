// The probe's Wave-2 measurements ("one clock, one air"): the Transport and
// timer attribution, pause in place and Island Air, on the virtual clock
// (lib/virtual.mjs). Every function returns numbers; probe.mjs turns them
// into PASS/FAIL lines through the pure judges in checks.mjs.
import { renderAirUnit } from './virtual.mjs';
import { energyRatioDb, resumeBurst } from './checks.mjs';
import { AIR_ARRIVALS, AIR_UNIT, HIDDEN_AT, HIDDEN_SECONDS } from './scenes.mjs';
import { rt60 } from '../metrics/amb-metrics.mjs';


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
// burst: dry (music bus) over wet (air return) energy in the burst's 4.4 s.
export function airRows(u) {
    const t60 = {};
    for (const phase of ['day', 'night']) {
        const ir = u.irs[phase];
        t60[phase] = ir ? rt60(ir.L, ir.R, u.irRates[phase === 'day' ? 'irDay' : 'irNight'], { bands: [1000, 4000] }) : null;
    }
    const dr = AIR_UNIT.bursts.map((b) => {
        const dry = slice(u.stems.music, u.sr, b.at, b.at + 4.4);
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
