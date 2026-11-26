#!/usr/bin/env node
// Evensong 10-day listening harness (spec §5.5, run by hand, not in CI):
//
//   node scripts/audio/evensong-harness.mjs [--input-dir agents/evensong/days]
//                                           [--out-dir agents/evensong/render] (or --out)
//                                           [--synthetic] [--days 10]
//                                           [--key A] [--mode minor]
//                                           [--seed 0x5eed]
//                                           [--node-synth]
//
// Privacy lock: repo and agent names in Chronicle CSVs are reduced to anonymous
// integer slot numbers immediately upon parsing; no repo or agent string is
// ever printed to stdout or written to WAV metadata, PNGs, or scorecard.md.
//
// Automated pre-gate per day:
//   1. validateEvensongGrammar(score) — fails fast on any grammar defect.
//   2. ITU-R BS.1770-4 integrated loudness within 1 LU of Town band target - 3 dB
//      (LOUDNESS_TARGETS.townBand.lufsI + EVENSONG_GAIN_DB = -34.0 ± 1.0 LUFS-I).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
    EVENSONG_BARS,
    EVENSONG_BEATS_PER_BAR,
    EVENSONG_DAY_BARS,
    EVENSONG_GAIN_DB,
    composeEvensong,
    normalizeEvensongKey,
    validateEvensongGrammar,
} from '../../claudeville/src/presentation/shared/audio/bgm/Evensong.js';
import { RANGES } from '../../claudeville/src/presentation/shared/audio/bgm/ScoreKit.js';
import { LOUDNESS_TARGETS } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { noteHz } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { compileEvensongEvents } from '../../claudeville/src/presentation/shared/audio/bgm/BandEngine.js';
import { loudness, writeWavFloat } from './lib/analyze.mjs';
import { AUDIO_DIR, REPO_ROOT, startStaticServer } from './lib/server.mjs';
import { DEFAULT_SEED, HARNESS_CHROME_ARGS, newHarnessPage, pullPcm } from './lib/capture.mjs';

export const EVENSONG_TARGET_LUFS = LOUDNESS_TARGETS.townBand.lufsI + EVENSONG_GAIN_DB; // -34.0 LUFS-I
export const EVENSONG_LUFS_TOLERANCE_LU = 1.0;

const SAMPLE_RATE = 48000;
const FAILED_PUSH_RE = /\b(was rejected|was cancelled|was canceled|failed)\b/i;

// ------------------------------------------------------------------ CSV ----

function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(cell);
            cell = '';
        } else if (ch === '\r') {
            if (src[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += ch;
        }
    }
    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function unescapeExcelLiteral(value) {
    const s = String(value ?? '').trim();
    return s.startsWith("'") && /^[=+\-@]/.test(s.slice(1).trimStart()) ? s.slice(1) : s;
}

function parseClockMinutes(text) {
    const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(text || ''));
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    const ss = match[3] != null ? Number(match[3]) : 0;
    if (hh < 0 || hh > 24 || mm < 0 || mm >= 60 || ss < 0 || ss >= 60) return null;
    return hh * 60 + mm + ss / 60;
}

/**
 * Parse a Chronicle CSV export (`ChroniclePanel.buildChronicleCsv`) and
 * immediately anonymize all repository and agent strings into integer slots.
 * Zero repo, agent, commit subject, or prose strings survive this function.
 */
export function parseChronicleCsv(csvText) {
    const rows = parseCsvRows(csvText);
    if (!rows.length) return { events: [], repoCount: 0 };

    const header = rows[0].map(col => unescapeExcelLiteral(col).toLowerCase());
    const idx = name => header.indexOf(name);
    const iRowType = idx('row_type');
    const iTime = idx('time');
    const iTs = idx('ts');
    const iKind = idx('kind');
    const iAgent = idx('agent');
    const iProject = idx('project') >= 0 ? idx('project') : idx('repo');
    const iEvent = idx('event');
    const iOutcome = idx('outcome');

    const repoSlots = new Map();
    const agentSlots = new Map();
    const events = [];

    for (let r = 1; r < rows.length; r++) {
        const cols = rows[r];
        if (!cols.length || cols.every(c => !String(c || '').trim())) continue;
        if (iRowType >= 0) {
            const rowType = unescapeExcelLiteral(cols[iRowType]).toLowerCase();
            if (rowType !== 'event') continue;
        }
        const kind = iKind >= 0 ? unescapeExcelLiteral(cols[iKind]).toLowerCase() : '';
        if (!kind) continue;

        let minuteOfDay = iTime >= 0 ? parseClockMinutes(unescapeExcelLiteral(cols[iTime])) : null;
        if (minuteOfDay == null && iTs >= 0) {
            const rawTs = Number(unescapeExcelLiteral(cols[iTs]));
            if (Number.isFinite(rawTs)) {
                const d = new Date(rawTs);
                minuteOfDay = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
            }
        }
        if (minuteOfDay == null) continue;

        // Privacy lock: immediately map repo & agent names to anonymous integer
        // slots and drop every raw string before constructing the event record.
        const rawRepo = iProject >= 0 ? unescapeExcelLiteral(cols[iProject]) : '';
        let repoSlot = 0;
        if (rawRepo) {
            if (!repoSlots.has(rawRepo)) repoSlots.set(rawRepo, repoSlots.size);
            repoSlot = repoSlots.get(rawRepo);
        }

        const rawAgent = iAgent >= 0 ? unescapeExcelLiteral(cols[iAgent]) : '';
        let agentSlot = null;
        if (rawAgent) {
            if (!agentSlots.has(rawAgent)) agentSlots.set(rawAgent, agentSlots.size);
            agentSlot = agentSlots.get(rawAgent);
        }

        let outcome = null;
        if (kind === 'push') {
            const explicitOutcome = iOutcome >= 0 ? unescapeExcelLiteral(cols[iOutcome]).toLowerCase() : '';
            const prose = iEvent >= 0 ? unescapeExcelLiteral(cols[iEvent]) : '';
            if (explicitOutcome) outcome = explicitOutcome;
            else if (FAILED_PUSH_RE.test(prose)) outcome = 'failed';
        }

        const record = { minuteOfDay, kind, repoSlot };
        if (agentSlot != null) record.agentSlot = agentSlot;
        if (outcome) record.outcome = outcome;
        events.push(record);
    }

    return { events, repoCount: repoSlots.size };
}

// ------------------------------------------------------------ synthetic ----

function makeLcg(seed) {
    let s = (Number(seed) >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Deterministic generator of up to 10 realistic varied Chronicle days using
 * anonymous integer repo slots only (zero repo strings).
 */
export function generateSyntheticDays(count = 10, seed = DEFAULT_SEED) {
    const rand = makeLcg(seed);
    const ev = (hour, min, kind, repoSlot, agentSlot = 0) => ({
        minuteOfDay: hour * 60 + min,
        kind,
        repoSlot,
        agentSlot,
    });

    const archetypes = [
        // Day 01: quiet 1-commit day, mended
        () => [ev(10, 15, 'commit', 0, 0)],

        // Day 02: light steady day across 2 repos + 1 push
        () => [
            ev(9, 20, 'commit', 0, 0),
            ev(10, 45, 'commit', 1, 0),
            ev(12, 10, 'commit', 0, 1),
            ev(14, 5, 'commit', 1, 0),
            ev(16, 30, 'commit', 0, 1),
            ev(17, 45, 'push', 0, 1),
            ev(19, 10, 'commit', 1, 0),
        ],

        // Day 03: busy 40-commit sprint testing thinning (<= 4/bar) + 3 pushes
        () => {
            const list = [];
            for (let i = 0; i < 40; i++) {
                const minute = 9 * 60 + Math.floor((i / 40) * (11.5 * 60) + rand() * 8);
                const repoSlot = (i + Math.floor(rand() * 3)) % 3;
                list.push({ minuteOfDay: Math.min(20 * 60 + 55, minute), kind: 'commit', repoSlot, agentSlot: i % 3 });
            }
            list.push(ev(12, 30, 'push', 0, 0), ev(16, 15, 'push', 1, 1), ev(20, 20, 'push', 2, 2));
            return list;
        },

        // Day 04: multi-repo day (8 repos, lower & upper octaves)
        () => [
            ev(8, 50, 'commit', 0, 0), ev(9, 35, 'commit', 1, 0),
            ev(10, 25, 'commit', 5, 1), ev(11, 15, 'commit', 6, 1),
            ev(12, 40, 'commit', 2, 2), ev(13, 30, 'push', 2, 2),
            ev(14, 15, 'commit', 7, 1), ev(15, 0, 'commit', 3, 0),
            ev(15, 55, 'commit', 4, 2), ev(16, 40, 'commit', 5, 1),
            ev(17, 25, 'commit', 6, 0), ev(18, 15, 'commit', 7, 2),
            ev(19, 5, 'commit', 1, 0), ev(19, 55, 'push', 5, 1),
            ev(20, 25, 'commit', 0, 0),
        ],

        // Day 05: release day (held fifth bar + commits + push)
        () => [
            ev(9, 10, 'commit', 0, 0),
            ev(10, 40, 'commit', 1, 0),
            ev(11, 55, 'commit', 0, 1),
            ev(13, 20, 'commit', 1, 1),
            ev(14, 50, 'push', 0, 0),
            ev(16, 10, 'release', 0, 0),
            ev(18, 5, 'commit', 1, 1),
            ev(19, 40, 'commit', 0, 0),
        ],

        // Day 06: open-error day (suspension close, no tag)
        () => [
            ev(9, 30, 'commit', 0, 0),
            ev(11, 0, 'commit', 1, 1),
            ev(12, 30, 'commit', 2, 0),
            ev(14, 15, 'push', 0, 0),
            ev(15, 45, 'commit', 1, 1),
            ev(17, 20, 'commit', 2, 0),
            ev(18, 40, 'commit', 0, 0),
            ev(19, 35, 'errored', 1, 1),
            ev(20, 10, 'commit', 0, 0),
        ],

        // Day 07: error-then-mended day (plagal tag close)
        () => [
            ev(9, 0, 'commit', 0, 0),
            ev(10, 30, 'commit', 1, 1),
            ev(11, 45, 'errored', 1, 1),
            ev(12, 15, 'commit', 0, 0),
            ev(12, 40, 'mended', 1, 1),
            ev(13, 50, 'commit', 2, 2),
            ev(15, 20, 'commit', 1, 1),
            ev(16, 40, 'push', 1, 1),
            ev(18, 10, 'commit', 2, 2),
            ev(19, 30, 'commit', 0, 0),
        ],

        // Day 08: 10-repo marathon day + release + pushes
        () => {
            const list = [];
            for (let i = 0; i < 24; i++) {
                const minute = 8 * 60 + 30 + Math.floor((i / 24) * (12 * 60));
                list.push({ minuteOfDay: minute, kind: 'commit', repoSlot: i % 10, agentSlot: i % 4 });
            }
            list.push(ev(12, 0, 'push', 2, 0), ev(15, 30, 'release', 5, 1), ev(19, 45, 'push', 8, 2));
            return list;
        },

        // Day 09: afternoon/evening sprint with 1 resolved error + 1 still open
        () => [
            ev(13, 10, 'commit', 0, 0),
            ev(13, 45, 'commit', 1, 1),
            ev(14, 20, 'errored', 0, 0),
            ev(14, 50, 'resolved', 0, 0),
            ev(15, 25, 'commit', 2, 2),
            ev(16, 10, 'commit', 3, 1),
            ev(16, 55, 'push', 2, 2),
            ev(17, 40, 'commit', 0, 0),
            ev(18, 25, 'commit', 1, 1),
            ev(19, 10, 'errored', 3, 3),
            ev(19, 45, 'commit', 2, 2),
            ev(20, 20, 'commit', 0, 0),
        ],

        // Day 10: celebratory day with 2 releases + 4 pushes across 5 repos
        () => [
            ev(9, 15, 'commit', 0, 0),
            ev(10, 0, 'commit', 1, 1),
            ev(10, 45, 'push', 0, 0),
            ev(11, 30, 'release', 0, 0),
            ev(13, 0, 'commit', 2, 2),
            ev(13, 50, 'commit', 3, 1),
            ev(14, 40, 'push', 2, 2),
            ev(15, 30, 'commit', 4, 0),
            ev(16, 20, 'commit', 1, 1),
            ev(17, 10, 'push', 3, 1),
            ev(18, 0, 'release', 4, 0),
            ev(19, 20, 'commit', 2, 2),
            ev(20, 10, 'push', 4, 0),
        ],
    ];

    const clamped = Math.max(1, Math.min(10, Math.floor(Number(count) || 10)));
    const days = [];
    for (let i = 0; i < clamped; i++) {
        days.push({
            id: `day-${String(i + 1).padStart(2, '0')}`,
            events: archetypes[i % archetypes.length](),
        });
    }
    return days;
}

// --------------------------------------------------- pure-Node PNG writer ----

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const kind = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([kind, data])), 0);
    return Buffer.concat([len, kind, data, crcBuf]);
}

function encodeRgbPng(width, height, rgb) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // 8-bit depth
    ihdr[9] = 2; // RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = width * 3;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        const dst = y * (stride + 1);
        raw[dst] = 0; // filter None
        rgb.copy(raw, dst + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// Minimal 5x7 uppercase bitmap font (zero external font dependencies).
const FONT_5X7 = Object.freeze({
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
    '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
    '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
});

/**
 * Render a pure-Node piano-roll PNG buffer for one Evensong score.
 * Contains ONLY anonymous day index, key, counts, loudness, and note geometry
 * (never any repo or agent name).
 */
export function renderPianoRollPng(score, { dayLabel = 'DAY 01', lufsI = null } = {}) {
    const W = 960;
    const H = 360;
    const rgb = Buffer.alloc(W * H * 3);

    const setPx = (x, y, r, g, b) => {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        const o = (y * W + x) * 3;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = b;
    };
    const fillRect = (x, y, w, h, [r, g, b]) => {
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(W, Math.floor(x + w));
        const y1 = Math.min(H, Math.floor(y + h));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) setPx(px, py, r, g, b);
        }
    };
    const drawText = (text, x, y, color, scale = 1) => {
        const s = String(text || '').toUpperCase();
        let cx = Math.floor(x);
        for (let i = 0; i < s.length; i++) {
            const glyph = FONT_5X7[s[i]] || FONT_5X7[' '];
            for (let row = 0; row < 7; row++) {
                for (let col = 0; col < 5; col++) {
                    if (glyph[row][col] === '1') {
                        fillRect(cx + col * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            cx += 6 * scale;
        }
    };

    const BG = [16, 20, 29];
    const HEADER = [22, 28, 40];
    const LANE_BG = [19, 24, 35];
    const CLOSE_BG = [30, 27, 46];
    const CLOSE_SUSP_BG = [38, 25, 36];
    const RELEASE_BG = [38, 34, 24];
    const GRID_BAR = [54, 65, 86];
    const GRID_SUB = [28, 35, 49];
    const GRID_PITCH = [32, 40, 56];
    const BORDER = [72, 86, 112];
    const INK = [235, 229, 214];
    const INK_DIM = [152, 164, 184];
    const LEAD_DAY = [122, 198, 232];
    const LEAD_PUSH = [110, 231, 183];
    const LEAD_RELEASE = [245, 204, 102];
    const LEAD_TAG = [240, 185, 110];
    const LEAD_SUSP = [224, 132, 166];
    const BASS_COL = [184, 134, 92];
    const BASS_PUSH = [224, 170, 96];

    fillRect(0, 0, W, H, BG);
    fillRect(0, 0, W, 38, HEADER);
    fillRect(0, 38, W, 1, BORDER);

    const keyLabel = `${score.key.tonic} ${score.key.mode === 'minor' ? 'MIN' : 'MAJ'}`;
    const closeLabel = score.close?.kind === 'suspension' ? 'SUSP' : 'PLAGAL';
    const lufsLabel = Number.isFinite(lufsI) ? `${lufsI.toFixed(1)} LUFS` : 'NO WAV';
    const title = `EVENSONG ${dayLabel}  KEY ${keyLabel}  ${score.bpm} BPM  EV ${score.meta.verifiedEvents}  NOTES ${score.meta.noteCount}  ${lufsLabel}  ${closeLabel}`;
    drawText(title, 18, 13, INK, 1);

    const plotX = 54;
    const plotW = W - plotX - 20;
    const totalBeats = score.bars * score.beatsPerBar;
    const barW = plotW / score.bars;

    const leadTop = 56;
    const leadH = 166;
    const bassTop = 242;
    const bassH = 92;

    fillRect(plotX, leadTop, plotW, leadH, LANE_BG);
    fillRect(plotX, bassTop, plotW, bassH, LANE_BG);

    // Highlight release bars and the 2-bar close.
    const releaseSet = new Set(score.meta?.releaseBars || []);
    const pushSet = new Set(score.meta?.pushBars || []);
    for (const bar of releaseSet) {
        const bx = plotX + bar * barW;
        fillRect(bx, leadTop, barW, leadH, RELEASE_BG);
        fillRect(bx, bassTop, barW, bassH, RELEASE_BG);
    }
    const closeX = plotX + EVENSONG_DAY_BARS * barW;
    const closeW = (score.bars - EVENSONG_DAY_BARS) * barW;
    const closeTint = score.close?.kind === 'suspension' ? CLOSE_SUSP_BG : CLOSE_BG;
    fillRect(closeX, leadTop, closeW, leadH, closeTint);
    fillRect(closeX, bassTop, closeW, bassH, closeTint);

    // Horizontal pitch guide lines.
    const leadLow = RANGES.lead.low;
    const leadHigh = RANGES.lead.high;
    const leadSpan = leadHigh - leadLow + 1;
    const leadRowH = leadH / leadSpan;
    const leadY = semi => leadTop + (leadHigh - semi) * leadRowH;

    for (const semi of [-12, 0, 12]) {
        const y = Math.round(leadY(semi) + leadRowH / 2);
        fillRect(plotX, y, plotW, 1, GRID_PITCH);
    }
    drawText('A5', 16, Math.round(leadY(12)), INK_DIM, 1);
    drawText('A4', 16, Math.round(leadY(0)), INK_DIM, 1);
    drawText('A3', 16, Math.round(leadY(-12) - 2), INK_DIM, 1);

    const bassLow = RANGES.bass.low;
    const bassHigh = RANGES.bass.high;
    const bassSpan = bassHigh - bassLow + 1;
    const bassRowH = bassH / bassSpan;
    const bassY = semi => bassTop + (bassHigh - semi) * bassRowH;

    for (const semi of [-33, -24, -12, -7]) {
        const y = Math.round(bassY(semi) + bassRowH / 2);
        fillRect(plotX, y, plotW, 1, GRID_PITCH);
    }
    drawText('D4', 16, Math.round(bassY(-7)), INK_DIM, 1);
    drawText('A2', 16, Math.round(bassY(-24)), INK_DIM, 1);
    drawText('C2', 16, Math.round(bassY(-33) - 3), INK_DIM, 1);

    // Vertical grid lines (beats & bars).
    for (let bar = 0; bar <= score.bars; bar++) {
        const x = Math.round(plotX + bar * barW);
        const isCloseEdge = bar === EVENSONG_DAY_BARS;
        const col = isCloseEdge ? [164, 134, 214] : GRID_BAR;
        fillRect(x, leadTop, isCloseEdge ? 2 : 1, leadH, col);
        fillRect(x, bassTop, isCloseEdge ? 2 : 1, bassH, col);
        if (bar < score.bars) {
            for (let beat = 1; beat < score.beatsPerBar; beat++) {
                const sx = Math.round(plotX + (bar + beat / score.beatsPerBar) * barW);
                fillRect(sx, leadTop, 1, leadH, GRID_SUB);
                fillRect(sx, bassTop, 1, bassH, GRID_SUB);
            }
            const label = String(bar + 1);
            drawText(label, x + Math.floor(barW / 2) - label.length * 3, H - 18, bar >= EVENSONG_DAY_BARS ? LEAD_TAG : INK_DIM, 1);
            if (pushSet.has(bar)) {
                fillRect(x + 2, bassTop + bassH - 3, Math.max(2, Math.floor(barW) - 4), 3, BASS_PUSH);
            }
        }
    }

    // Draw lead notes.
    let beat = 0;
    for (const [semi, dur] of score.melody) {
        if (semi != null) {
            const bar = Math.floor(beat / score.beatsPerBar + 1e-6);
            const x = plotX + (beat / totalBeats) * plotW;
            const w = Math.max(3, (dur / totalBeats) * plotW - 1);
            const y = leadY(semi);
            const h = Math.max(5, Math.floor(leadRowH) - 1);
            let col = LEAD_DAY;
            if (bar >= EVENSONG_DAY_BARS) {
                col = score.close?.kind === 'suspension' ? LEAD_SUSP : LEAD_TAG;
            } else if (releaseSet.has(bar)) {
                col = LEAD_RELEASE;
            } else if (pushSet.has(bar)) {
                col = LEAD_PUSH;
            }
            fillRect(x, y, w, h, col);
            fillRect(x, y, w, 1, [Math.min(255, col[0] + 45), Math.min(255, col[1] + 45), Math.min(255, col[2] + 45)]);
        }
        beat += dur;
    }

    // Draw bass notes.
    beat = 0;
    for (const [semi, dur] of score.bass) {
        if (semi != null) {
            const bar = Math.floor(beat / score.beatsPerBar + 1e-6);
            const x = plotX + (beat / totalBeats) * plotW;
            const w = Math.max(3, (dur / totalBeats) * plotW - 1);
            const y = bassY(semi);
            const h = Math.max(4, Math.floor(bassRowH) + 1);
            const col = pushSet.has(bar) ? BASS_PUSH : BASS_COL;
            fillRect(x, y, w, h, col);
        }
        beat += dur;
    }

    // Outer borders & non-overlapping lane headers.
    fillRect(plotX, leadTop, plotW, 1, BORDER);
    fillRect(plotX, leadTop + leadH, plotW, 1, BORDER);
    fillRect(plotX, bassTop, plotW, 1, BORDER);
    fillRect(plotX, bassTop + bassH, plotW, 1, BORDER);
    drawText('LEAD', plotX, leadTop - 11, INK, 1);
    drawText('BASS', plotX, bassTop - 11, INK, 1);
    drawText('CLOSE', Math.floor(closeX + 6), leadTop - 11, score.close?.kind === 'suspension' ? LEAD_SUSP : LEAD_TAG, 1);

    return encodeRgbPng(W, H, rgb);
}

// -------------------------------------------------- schedule compilation ----

// The live engine's own compiler (bgm/BandEngine.js `compileEvensongEvents`):
// the loudness pre-gate renders exactly the events the Evensong band plays.

// ------------------------------------------ offline renderer (Chromium) ----

const VIRTUAL_CLOCK_JS = fs.readFileSync(path.join(AUDIO_DIR, 'page/virtual-clock.js'), 'utf8');

async function createChromiumRenderer({ voice = 'isle', seed = DEFAULT_SEED }) {
    const { launchChromium } = await import('../smoke/support/chromium.mjs');
    const server = await startStaticServer();
    const browser = await launchChromium({ args: HARNESS_CHROME_ARGS });

    async function renderScore(score) {
        const { events, totalSec } = compileEvensongEvents(score);
        const padSec = 2.0;
        const h = await newHarnessPage(browser, seed, undefined, [VIRTUAL_CLOCK_JS]);
        try {
            await h.page.goto(`${server.baseUrl}/__har/virtual.html`);
            await h.page.waitForFunction(() => window.__vcReady === true, null, { timeout: 20000 });

            const meta = await h.page.evaluate(async (payload) => {
                const { AudioEngine } = await import('/src/presentation/shared/audio/AudioEngine.js');
                const { createInstrument, INSTRUMENTS } = await import('/src/presentation/shared/audio/music/Instruments.js');
                const { voicingFor } = await import('/src/presentation/shared/audio/music/Voicings.js');
                const { STANDARD_VOLUME_STEP } = await import('/src/presentation/shared/audio/Loudness.js');
                const { noteHz } = await import('/src/presentation/shared/audio/MusicalScale.js');
                const { rngStream, setRngSeed } = await import('/src/presentation/shared/audio/Rng.js');

                const vc = window.__vc;
                const realSleep = ms => new Promise(r => vc.real.setTimeout(r, ms));
                setRngSeed(Number(payload.seed) >>> 0);

                const sr = payload.sampleRate;
                const totalSeconds = payload.totalSec + payload.padSec;
                const ctx = new OfflineAudioContext({
                    numberOfChannels: 2,
                    length: Math.ceil(totalSeconds * sr),
                    sampleRate: sr,
                });
                let state = 'suspended';
                Object.defineProperty(ctx, 'state', { configurable: true, get: () => state });
                ctx.resume = () => { state = 'running'; return Promise.resolve(); };
                ctx.suspend = () => { state = 'suspended'; return Promise.resolve(); };
                ctx.close = () => { state = 'closed'; return Promise.resolve(); };
                let handed = false;
                window.AudioContext = function VirtualAudioContext() {
                    if (handed) throw new Error('evensong: expected single AudioContext');
                    handed = true;
                    return ctx;
                };
                window.webkitAudioContext = window.AudioContext;

                const engine = new AudioEngine();
                engine.setVolumeStep(STANDARD_VOLUME_STEP);
                let ok = false;
                engine.ensureContext().then((v) => { ok = v; });
                while (!ok) {
                    await vc.advanceTo(vc.now + 5);
                    await realSleep(0);
                }
                engine.fadeGain.gain.value = 1;
                engine.started = true;
                engine.start?.();
                while (!(engine.air?.buffers?.().day && engine.air.buffers().night)) {
                    await vc.advanceTo(vc.now + 10);
                    await realSleep(0);
                }
                engine.fadeDirector?.('bgm', 1, { duration: 0 });
                engine.setAirPhase?.(payload.family === 'night' ? 'night' : 'day');

                const keyframe = payload.family === 'night' ? 'night' : 'golden-hour';
                const voicing = voicingFor({
                    voice: payload.voice,
                    keyframe,
                    weather: 'clear',
                    season: 'summer',
                    band: 2,
                });

                // Town band preset trim (0.536) * BGM_LEVEL (0.9) * Evensong -3 dB offset,
                // routed into engine.groupInput + Island Air exactly as BaseLayer does.
                const dbToGain = db => Math.pow(10, db / 20);
                const bandTrim = 0.536 * 0.9 * dbToGain(payload.gainDb);
                const mix = ctx.createGain();
                mix.gain.value = bandTrim * dbToGain(payload.calibrateDb || 0);
                mix.connect(engine.groupInput('music', 'bgm'));

                const airOut = ctx.createGain();
                airOut.gain.value = mix.gain.value;
                engine.airSendFrom?.(airOut, 1, { group: 'music', director: 'bgm' });

                const performRng = rngStream('music.evensong.perform');
                const seats = {};
                const players = {};
                // 3-voice Evensong balance calibrated against the shipped AudioEngine
                // + Isle Band instruments (no counter/percussion/descant seats) so both
                // quiet (1-commit) and dense (40-commit) days sit at -34.0 ± 1.0 LUFS-I.
                const seatOffsetDb = payload.family === 'night'
                    ? { lead: 4.35, bass: 11.85, engine: 12.35 }
                    : { lead: -1.5, bass: 11.7, engine: 11.7 };

                for (const seatName of ['lead', 'bass', 'engine']) {
                    const spec = voicing.seats?.[seatName];
                    if (!spec) continue;
                    const bus = ctx.createGain();
                    bus.gain.value = dbToGain(spec.gainDb + (seatOffsetDb[seatName] || 0));
                    const pan = ctx.createStereoPanner();
                    pan.pan.value = Math.max(-1, Math.min(1, Number(spec.pan) || 0));
                    bus.connect(pan);
                    pan.connect(mix);
                    const airGain = Math.max(0, Number(spec.air) || 0);
                    if (airGain > 0) {
                        const send = ctx.createGain();
                        send.gain.value = airGain;
                        pan.connect(send).connect(airOut);
                    }
                    seats[seatName] = { spec, bus };
                    players[seatName] = createInstrument(engine, spec.instrument, { dest: bus, rng: performRng });
                }

                // Wait for baked takes (harp, upright, musicBox, etc.) to finish baking.
                const waitStart = vc.now;
                while (vc.now - waitStart < 4000) {
                    const pending = engine.bank?.stats?.()?.pending ?? 0;
                    if (pending === 0 && Object.values(players).every(p => p?.ready !== false)) break;
                    await vc.advanceTo(vc.now + 20);
                    await realSleep(0);
                }

                const withinRange = (semi, range) => {
                    if (!range) return semi;
                    let s = semi;
                    while (s > range[1]) s -= 12;
                    while (s < range[0]) s += 12;
                    return s > range[1] ? null : s;
                };

                const leadStartOffset = 0.25;
                const lengthShare = { lead: 0.92, bass: 0.98, engine: 0.9 };
                for (const ev of payload.events) {
                    const seat = seats[ev.seat];
                    const player = players[ev.seat];
                    if (!seat || !player) continue;
                    const semi = withinRange(ev.semi + (seat.spec.octaveShift || 0), INSTRUMENTS[seat.spec.instrument]?.range);
                    if (semi == null) continue;
                    const dur = Math.max(0.05, ev.dur * (lengthShare[ev.seat] ?? 0.92));
                    player.note(leadStartOffset + ev.t, noteHz(semi), dur, ev.vel, {
                        bright: seat.spec.bright,
                        soft: seat.spec.soft,
                    });
                }

                const buffer = await OfflineAudioContext.prototype.startRendering.call(ctx);
                const L = buffer.getChannelData(0);
                const R = buffer.getChannelData(1);
                const pcm = new Float32Array(L.length * 2);
                for (let k = 0; k < L.length; k++) {
                    pcm[2 * k] = L[k];
                    pcm[2 * k + 1] = R[k];
                }
                window.__vcStage = pcm;
                return { frames: L.length, sampleRate: sr, engine: 'chromium-offline' };
            }, {
                events,
                totalSec,
                padSec,
                family: score.family,
                gainDb: score.gainDb,
                voice,
                seed,
                sampleRate: SAMPLE_RATE,
                calibrateDb: 0,
            });

            const pcm = await pullPcm(h.page, meta.frames * 2, '__vcStage');
            await h.page.evaluate(() => { window.__vcStage = null; });
            return { ...pcm, sr: meta.sampleRate, totalSec, backend: meta.engine };
        } finally {
            await h.context.close();
        }
    }

    return {
        backend: 'chromium-offline',
        renderScore,
        async close() {
            await browser.close();
            await server.close();
        },
    };
}

// ------------------------------------- pure-Node offline synth fallback ----

function renderScoreNodeSynth(score) {
    const { events, totalSec } = compileEvensongEvents(score);
    const padSec = 1.5;
    const sr = SAMPLE_RATE;
    const frames = Math.ceil((totalSec + padSec) * sr);
    const L = new Float32Array(frames);
    const R = new Float32Array(frames);

    // Calibrated linear gains so the 3-voice ensemble sits naturally near
    // -34.0 LUFS-I across both quiet (1-commit) and dense (40-commit) days.
    const seatCfg = {
        lead: { amp: 0.0247, pan: 0.12, attack: 0.008, decay: 1.5, harmonics: [1, 0.28, 0.09] },
        bass: { amp: 0.0376, pan: 0.0, attack: 0.012, decay: 1.8, harmonics: [1, 0.22, 0.05] },
        engine: { amp: 0.0206, pan: 0.34, attack: 0.01, decay: 1.1, harmonics: [1, 0.2, 0.06] },
    };

    const twoPi = 2 * Math.PI;
    const offsetSec = 0.15;

    for (const ev of events) {
        const cfg = seatCfg[ev.seat];
        if (!cfg) continue;
        const hz = noteHz(ev.semi);
        const start = Math.floor((offsetSec + ev.t) * sr);
        const noteDur = Math.min(ev.dur + 0.55, 5.0);
        const len = Math.min(frames - start, Math.ceil(noteDur * sr));
        if (len <= 0) continue;

        const amp = cfg.amp * (ev.vel ?? 0.9);
        const panAngle = (cfg.pan + 1) * (Math.PI / 4);
        const gL = Math.cos(panAngle);
        const gR = Math.sin(panAngle);
        const attackSamples = Math.max(1, Math.floor(cfg.attack * sr));
        const releaseStart = Math.max(attackSamples, Math.floor(ev.dur * 0.92 * sr));
        const releaseLen = Math.max(1, len - releaseStart);

        for (let i = 0; i < len; i++) {
            const t = i / sr;
            let env = Math.exp(-t / cfg.decay);
            if (i < attackSamples) env *= i / attackSamples;
            else if (i > releaseStart) {
                const rf = 1 - (i - releaseStart) / releaseLen;
                env *= Math.max(0, rf);
            }
            let sample = 0;
            for (let h = 0; h < cfg.harmonics.length; h++) {
                sample += cfg.harmonics[h] * Math.sin(twoPi * hz * (h + 1) * t);
            }
            const out = sample * env * amp;
            L[start + i] += out * gL;
            R[start + i] += out * gR;
        }
    }

    return { L, R, sr, totalSec, backend: 'node-synth' };
}

// -------------------------------------------------------------- scorecard ----

/**
 * Emit scorecard.md with one blank evaluation row per day
 * (`day`, `events`, `notes`, `pleasant (y/n)`, `remark`) and zero repo names.
 */
export function buildScorecardMarkdown(rows) {
    const lines = [
        '# Evensong Listening Scorecard',
        '',
        'Kill criteria (§5.5): **7+ pleasant** → ship the tune · **4–6** → ship 4-note motto · **3 or fewer** → cut music (keep bell turn only).',
        '',
        '| day | events | notes | pleasant (y/n) | remark |',
        '| --- | ---: | ---: | :---: | --- |',
    ];
    for (const r of rows) {
        lines.push(`| ${r.day} | ${r.events} | ${r.notes} |  |  |`);
    }
    lines.push(
        '',
        '## Automated Pre-Gate Summary',
        '',
        '| day | key | close | grammar | LUFS-I | target | status |',
        '| --- | --- | --- | :---: | ---: | ---: | :---: |',
    );
    for (const r of rows) {
        const lufsStr = r.silent ? '—' : (Number.isFinite(r.lufsI) ? `${r.lufsI.toFixed(2)}` : '—');
        const targetStr = r.silent ? '—' : `${EVENSONG_TARGET_LUFS.toFixed(1)} ± ${EVENSONG_LUFS_TOLERANCE_LU.toFixed(1)}`;
        lines.push(`| ${r.day} | ${r.key} | ${r.close} | ${r.grammarOk ? 'PASS' : 'FAIL'} | ${lufsStr} | ${targetStr} | ${r.status} |`);
    }
    lines.push('');
    return lines.join('\n');
}

// ------------------------------------------------------------------ CLI ----

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
        const eq = arg.indexOf('=');
        if (eq > 0) {
            out[arg.slice(2, eq)] = arg.slice(eq + 1);
        } else {
            const next = argv[i + 1];
            if (next == null || next.startsWith('--')) {
                out[arg.slice(2)] = true;
            } else {
                out[arg.slice(2)] = next;
                i++;
            }
        }
    }
    return out;
}

function loadCsvDays(inputDir, maxDays) {
    if (!fs.existsSync(inputDir)) {
        throw new Error(`input directory not found: ${inputDir} (pass --synthetic to generate synthetic days)`);
    }
    const files = fs.readdirSync(inputDir)
        .filter(name => name.toLowerCase().endsWith('.csv'))
        .sort()
        .slice(0, maxDays);
    if (!files.length) {
        throw new Error(`no .csv files found in ${inputDir} (pass --synthetic to generate synthetic days)`);
    }
    return files.map((file, idx) => {
        const parsed = parseChronicleCsv(fs.readFileSync(path.join(inputDir, file), 'utf8'));
        return {
            id: `day-${String(idx + 1).padStart(2, '0')}`,
            events: parsed.events,
        };
    });
}

// Measure active body loudness (trimming render padding tail) with BS.1770-4.
function measureActiveLoudness(pcm, sr, totalSec) {
    const activeFrames = Math.min(pcm.L.length, Math.round((totalSec + 0.35) * sr));
    const L = pcm.L.subarray(0, activeFrames);
    const R = pcm.R.subarray(0, activeFrames);
    return loudness(L, R, sr).integrated;
}

export async function runHarness(options = {}) {
    const synthetic = Boolean(options.synthetic);
    const maxDays = Math.max(1, Math.min(10, Number(options.days || 10)));
    const inputDir = path.resolve(options.inputDir || path.join(REPO_ROOT, 'agents/evensong/days'));
    const outDir = path.resolve(options.outDir || path.join(REPO_ROOT, 'agents/evensong/render'));
    const key = normalizeEvensongKey({ tonic: options.key || 'A', mode: options.mode || 'minor' });
    const voice = 'isle';
    const seed = options.seed != null ? Number(options.seed) : DEFAULT_SEED;
    const forceNodeSynth = Boolean(options.nodeSynth);
    const quiet = Boolean(options.quiet);
    const log = quiet ? () => {} : (...a) => console.log(...a);

    const days = synthetic ? generateSyntheticDays(maxDays, seed) : loadCsvDays(inputDir, maxDays);
    fs.mkdirSync(outDir, { recursive: true });

    let renderer = null;
    if (!forceNodeSynth) {
        try {
            renderer = await createChromiumRenderer({ voice, seed });
        } catch (err) {
            log(`[evensong] Chromium offline renderer unavailable (${err.message}); using pure-Node fallback synth`);
        }
    }

    const rows = [];
    let failures = 0;

    try {
        for (const day of days) {
            const score = composeEvensong(day.events, key);
            if (!score) {
                rows.push({
                    day: day.id,
                    events: 0,
                    notes: 0,
                    key: `${key.tonic} ${key.mode}`,
                    close: 'silent',
                    grammarOk: true,
                    lufsI: -Infinity,
                    silent: true,
                    status: 'SILENT',
                });
                log(`${day.id}: silent (0 verified events)`);
                continue;
            }

            // 1. Automated grammar pre-gate (fails fast on any grammar bug).
            const grammar = validateEvensongGrammar(score);
            if (!grammar.ok) {
                throw new Error(`${day.id}: grammar pre-gate failed:\n  - ${grammar.errors.join('\n  - ')}`);
            }

            // 2. Offline render to stereo float PCM.
            const pcm = renderer ? await renderer.renderScore(score) : renderScoreNodeSynth(score);
            const lufsI = measureActiveLoudness(pcm, pcm.sr, pcm.totalSec);
            const lufsDelta = Math.abs(lufsI - EVENSONG_TARGET_LUFS);
            const lufsOk = Number.isFinite(lufsI) && lufsDelta <= EVENSONG_LUFS_TOLERANCE_LU;

            // 3. Emit WAV + pure-Node piano-roll PNG (strictly anonymous filenames & labels).
            const wavPath = path.join(outDir, `${day.id}.wav`);
            const pngPath = path.join(outDir, `${day.id}.png`);
            writeWavFloat(wavPath, pcm.L, pcm.R, pcm.sr);
            fs.writeFileSync(pngPath, renderPianoRollPng(score, { dayLabel: day.id.toUpperCase(), lufsI }));

            if (!lufsOk) failures++;
            rows.push({
                day: day.id,
                events: score.meta.verifiedEvents,
                notes: score.meta.noteCount,
                key: `${score.key.tonic} ${score.key.mode}`,
                close: score.close.kind,
                grammarOk: grammar.ok,
                lufsI,
                silent: false,
                status: lufsOk ? 'PASS' : 'FAIL',
            });
            log(
                `${day.id}: ${lufsOk ? 'PASS' : 'FAIL'}  events=${score.meta.verifiedEvents}  notes=${score.meta.noteCount}`
                + `  close=${score.close.kind}  LUFS-I=${lufsI.toFixed(2)} (target ${EVENSONG_TARGET_LUFS.toFixed(1)} ± ${EVENSONG_LUFS_TOLERANCE_LU.toFixed(1)})`
                + `  [${pcm.backend}]`,
            );
        }
    } finally {
        await renderer?.close();
    }

    const scorecardPath = path.join(outDir, 'scorecard.md');
    fs.writeFileSync(scorecardPath, buildScorecardMarkdown(rows), 'utf8');
    log(`wrote ${rows.length} day(s) and scorecard to ${outDir}`);

    if (failures > 0) {
        throw new Error(`Evensong pre-gate failed: ${failures} day(s) outside ${EVENSONG_TARGET_LUFS.toFixed(1)} ± ${EVENSONG_LUFS_TOLERANCE_LU.toFixed(1)} LUFS-I`);
    }

    return { rows, outDir, scorecardPath };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const args = parseArgs(process.argv.slice(2));
    runHarness({
        inputDir: args['input-dir'],
        outDir: args['out-dir'] ?? args.out,
        synthetic: Boolean(args.synthetic),
        days: args.days,
        key: args.key,
        mode: args.mode,
        seed: args.seed,
        nodeSynth: Boolean(args['node-synth']),
    }).catch((err) => {
        console.error(err?.message || err);
        process.exitCode = 1;
    });
}
