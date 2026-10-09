// A villager's thought column (W3.1–W3.7): the head bubble and up to two
// older lines stacked above it, in screen pixels relative to the column's base
// point (the label top over the head, or a roof crown for a speaker the depth
// pass hid behind a building). The reservation pass
// (IsometricRenderer._assignAgentBubbleSlots) and the painter
// (AgentSprite._drawStatus) both read `layoutThoughtColumn`, so the rectangle
// a thought reserves is the rectangle it paints (W3.2).
//
// Pure arithmetic, allocation-free on reuse: Departure Mono at 11 px is a
// fixed 7 px advance and Press Start 2P at 8 px a fixed 8 px advance, so every
// width comes from a character count, never from measureText. The painter
// fits its text into these boxes, so a fallback font can only leave slack.
//
// Static band: nothing here moves. A placement changes only when the layout
// commits a new candidate (sticky, W3.3), never on a timer of its own.

export const THOUGHT_HISTORY_LIMIT = 2;
export const THOUGHT_STACK_STEP = 24;
export const THOUGHT_CHAR_ADVANCE = 7;
export const THOUGHT_DISPLAY_ADVANCE = 8;
export const THOUGHT_CONFIDENCE_THRESHOLD = 0.72;

// Head bubble: fill spans centerY ± height/2, the tail hangs `tail` px below.
export const THOUGHT_HEAD = Object.freeze({
    height: 20,
    centerY: -18,
    radius: 5,
    tail: 6,
    tailHalf: 4,
    stroke: 1.5,
    pad: 9,
    maxText: 232,
});
// The long-wait clock replaces the head bubble with a fixed glyph box.
export const THOUGHT_CLOCK_WIDTH = 22;
// Older lines: smaller, fainter rows a 3 px gap above the head and each other.
export const THOUGHT_HISTORY = Object.freeze({
    height: 14,
    radius: 3,
    stroke: 1,
    pad: 7,
    gap: 3,
    maxText: 216,
});
// W3.6 — the repo pennant chip at the head's leading edge (3 × 7 px).
export const THOUGHT_CHIP = Object.freeze({ inset: 4, width: 3, height: 7, gap: 4 });
// W3.6 — the 3-letter speaker tag a displaced head carries after the chip.
export const THOUGHT_TAG = Object.freeze({ chars: 3, gap: 5 });
// W3.7 — the ×N count of a lossless merge, at the head's trailing edge.
export const THOUGHT_COUNT_GAP = 5;
// Where a leader lands over an undisplaced head: the tail tip of a home bubble.
export const THOUGHT_LEADER_TIP = THOUGHT_HEAD.centerY + THOUGHT_HEAD.height / 2 + THOUGHT_HEAD.tail;
// A displaced tail keeps this far inside the head's corners.
const NOTCH_INSET = THOUGHT_HEAD.radius + THOUGHT_HEAD.tailHalf;
// The thought layer paints in two passes: every leader, then every column, so
// a leader runs under a neighbouring bubble instead of across its text.
export const THOUGHT_PAINT = Object.freeze({ LEADER: 1, COLUMN: 2 });

// W3.1 — the deterministic placement candidates, cheapest first: slot is the
// vertical step (THOUGHT_STACK_STEP px each), lateral the sideways step in half
// column widths, mirrored per speaker. A home bubble (0, 0) needs no leader; a
// half-width step keeps the head over the speaker with a short elbow; a full
// width costs about as much leader as three slots, so it comes later.
const CANDIDATE_TABLE = [
    [0, 0], [0, -1], [0, 1],
    [1, 0], [1, -1], [1, 1],
    [2, 0], [0, -2], [0, 2],
    [2, -1], [2, 1], [1, -2], [1, 2],
    [3, 0], [3, -1], [3, 1], [2, -2], [2, 2],
    [4, 0], [4, -1], [4, 1], [3, -2], [3, 2],
    [5, 0], [5, -1], [5, 1], [4, -2], [4, 2], [5, -2], [5, 2],
];
export const THOUGHT_CANDIDATE_COUNT = CANDIDATE_TABLE.length;
export const THOUGHT_CANDIDATE_SLOT = Object.freeze(CANDIDATE_TABLE.map(([slot]) => slot));
export const THOUGHT_CANDIDATE_LATERAL = Object.freeze(CANDIDATE_TABLE.map(([, lateral]) => lateral));

export function createThoughtColumn() {
    return {
        clock: false,
        rows: 0,
        headWidth: 0,
        headTop: 0,
        headBottom: 0,
        tail: 0,
        tailTipY: 0,
        chipZone: 0,
        tagWidth: 0,
        textLeft: 0,
        textWidth: 0,
        countWidth: 0,
        historyCount: 0,
        historyWidth: [0, 0],
        historyTextWidth: [0, 0],
        historyCenterY: [0, 0],
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
    };
}

// Width of a line once the painter has fitted it: whole characters, with the
// ellipsis taking the last cell when the line is cut.
export function thoughtTextWidth(length, maxWidth) {
    const full = length * THOUGHT_CHAR_ADVANCE;
    if (full <= maxWidth) return full;
    return Math.floor(maxWidth / THOUGHT_CHAR_ADVANCE) * THOUGHT_CHAR_ADVANCE;
}

// A tool label below the classifier's confidence threshold carries a '?',
// unless it already ends in punctuation. Speech has no confidence (null) and
// never takes the mark: the model's own words are not a guess.
export function needsConfidenceMark(text, confidence) {
    if (confidence === null || confidence === undefined || confidence === '') return false;
    const value = Number(confidence);
    if (!Number.isFinite(value) || value >= THOUGHT_CONFIDENCE_THRESHOLD) return false;
    const source = String(text ?? '');
    let end = source.length - 1;
    while (end >= 0 && source.charCodeAt(end) <= 32) end--;
    if (end < 0) return false;
    const last = source[end];
    return last !== '.' && last !== '!' && last !== '?' && last !== '…';
}

// Three upper-case letters or digits from the speaker's name ("Atlas 2" →
// "ATL"); empty for a nameless agent.
export function speakerTagFor(name) {
    const source = String(name || '');
    let tag = '';
    for (let i = 0; i < source.length && tag.length < THOUGHT_TAG.chars; i++) {
        const code = source.charCodeAt(i);
        const digit = code >= 48 && code <= 57;
        const upper = code >= 65 && code <= 90;
        const lower = code >= 97 && code <= 122;
        if (digit || upper) tag += source[i];
        else if (lower) tag += String.fromCharCode(code - 32);
    }
    return tag;
}

function countDigits(value) {
    let digits = 1;
    for (let n = Math.floor(value / 10); n > 0; n = Math.floor(n / 10)) digits++;
    return digits;
}

/**
 * Lays out the column `thread` will draw into `out` (from createThoughtColumn).
 * `clock` swaps the head for the long-wait clock glyph; `chip` reserves the
 * repo pennant zone; `tagLength` > 0 adds the speaker tag (displaced or
 * occluded heads only); `mergedCount` > 1 adds the ×N count.
 * Bounds (`left/right/top/bottom`) are whole pixels around every painted
 * fill and stroke, tail included, relative to the bubble centre and base.
 */
export function layoutThoughtColumn(out, thread, clock = false, chip = false, tagLength = 0, mergedCount = 1) {
    const head = thread?.[0] || null;
    out.clock = clock;
    out.headTop = THOUGHT_HEAD.centerY - THOUGHT_HEAD.height / 2;
    out.headBottom = THOUGHT_HEAD.centerY + THOUGHT_HEAD.height / 2;
    out.chipZone = 0;
    out.tagWidth = 0;
    out.countWidth = 0;
    out.textWidth = 0;
    if (clock) {
        out.headWidth = THOUGHT_CLOCK_WIDTH;
        out.tail = THOUGHT_HEAD.tail;
        out.textLeft = 0;
    } else {
        const text = head?.text || '';
        const length = text.length + (needsConfidenceMark(text, head?.confidence) ? 1 : 0);
        out.textWidth = thoughtTextWidth(length, THOUGHT_HEAD.maxText);
        out.chipZone = chip ? THOUGHT_CHIP.inset + THOUGHT_CHIP.width + THOUGHT_CHIP.gap : THOUGHT_HEAD.pad;
        out.tagWidth = tagLength > 0 ? tagLength * THOUGHT_DISPLAY_ADVANCE + THOUGHT_TAG.gap : 0;
        out.countWidth = mergedCount > 1
            ? THOUGHT_COUNT_GAP + (1 + countDigits(mergedCount)) * THOUGHT_DISPLAY_ADVANCE
            : 0;
        out.textLeft = out.chipZone + out.tagWidth;
        out.headWidth = out.textLeft + out.textWidth + out.countWidth + THOUGHT_HEAD.pad;
        // Long-form reasoning excerpts are chips, not quotes: no speech tail.
        out.tail = head?.shape === 'chip' ? 0 : THOUGHT_HEAD.tail;
    }
    out.tailTipY = out.headBottom + out.tail;

    const historyCount = Math.min(Math.max(0, (thread?.length || 0) - 1), THOUGHT_HISTORY_LIMIT);
    out.historyCount = historyCount;
    let rowBottom = out.headTop - THOUGHT_HISTORY.gap;
    let top = out.headTop - THOUGHT_HEAD.stroke / 2;
    let half = out.headWidth / 2 + THOUGHT_HEAD.stroke / 2;
    for (let i = 0; i < historyCount; i++) {
        const entry = thread[i + 1];
        const textWidth = thoughtTextWidth(String(entry?.text || '').length, THOUGHT_HISTORY.maxText);
        const width = textWidth + THOUGHT_HISTORY.pad * 2;
        out.historyTextWidth[i] = textWidth;
        out.historyWidth[i] = width;
        out.historyCenterY[i] = rowBottom - THOUGHT_HISTORY.height / 2;
        top = rowBottom - THOUGHT_HISTORY.height - THOUGHT_HISTORY.stroke / 2;
        half = Math.max(half, width / 2 + THOUGHT_HISTORY.stroke / 2);
        rowBottom -= THOUGHT_HISTORY.height + THOUGHT_HISTORY.gap;
    }
    out.rows = 1 + historyCount;
    out.top = Math.floor(top);
    out.bottom = Math.ceil(out.tailTipY + THOUGHT_HEAD.stroke / 2);
    out.left = -Math.ceil(half);
    out.right = Math.ceil(half);
    out.width = out.right - out.left;
    out.height = out.bottom - out.top;
    return out;
}

// Horizontal offset of a column placed `lateral` half-widths off its anchor.
export function thoughtLateralShift(column, lateral) {
    return lateral * Math.ceil(column.width / 2);
}

/**
 * The elbow from a displaced head back to its anchor, in the same base-relative
 * screen px: `x` is the notch column (clamped inside the head's corners, so the
 * shortest elbow wins), the run goes down from the tail tip `fromY` to `toY`,
 * then along `toY` to the anchor column 0. `tailX` is the notch relative to
 * the bubble centre, where the displaced tail hangs.
 */
export function thoughtLeader(out, column, shiftX, slotShift, toY) {
    const halfHead = Math.floor(column.headWidth / 2);
    const inset = Math.min(NOTCH_INSET, halfHead);
    const x = Math.max(shiftX - halfHead + inset, Math.min(shiftX + halfHead - inset, 0));
    out.x = x;
    out.tailX = x - shiftX;
    out.fromY = slotShift + column.tailTipY + 1;
    out.toY = toY;
    return out;
}
