// Overview trade glyph (plan 5.6): the tool an agent is working, drawn from
// the authored 8×8 EventShapes motifs in the status colour with a one-pixel
// dark outline — the same pixel grammar the rest of the world's icons use, no
// anti-aliased vector strokes, no backplate, no glow.
//
// Pure draw helper with no motion, so reduced motion is identical. The caller
// has already translated/scaled into a fixed screen-space frame.

import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { drawOutlinedMotif } from './WorldLabelKit.js';

// Tool category (ToolIdentity.toolCategory) → glyph key.
const CATEGORY_GLYPH = Object.freeze({
    read: 'book',
    search: 'lens',
    write: 'feather',
    exec: 'gear',
    task: 'scroll',
    other: 'dot',
});

// Building hints that override the category glyph for richer reads. The
// classifier resolves Bash/web/etc. to a building even when category is broad.
const BUILDING_GLYPH = Object.freeze({
    observatory: 'globe',
    mine: 'pick',
    portal: 'globe',
    harbor: 'anchor',
});

// Glyph key → authored motif (shared/EventShapes.js).
const GLYPH_MOTIF = Object.freeze({
    book: 'read-page',
    lens: 'search-lens',
    feather: 'edit-strike',
    gear: 'shell-slate',
    scroll: 'task-slip',
    globe: 'globe',
    pick: 'pick',
    anchor: 'anchor',
    dot: 'tool-unknown',
});

/**
 * Resolve the glyph key for an agent's current tool.
 * @param {string} tool - raw tool name (agent.currentTool)
 * @param {string|null} building - optional classified building (overrides category)
 * @returns {string} glyph key understood by drawToolGlyphBadge
 */
export function toolGlyphKey(tool, building = null) {
    if (building && BUILDING_GLYPH[building]) return BUILDING_GLYPH[building];
    return CATEGORY_GLYPH[toolCategory(tool)] || 'dot';
}

/**
 * Draw a tool glyph with its 8×8 motif's top-left at (x, y) in the caller's
 * screen-space frame. `step` 1 below zoom 3, 2 at close range.
 */
export function drawToolGlyphBadge(ctx, { glyph = 'dot', color = '#f2d36b', x = -4, y = 0, step = 1 } = {}) {
    drawOutlinedMotif(ctx, GLYPH_MOTIF[glyph] || GLYPH_MOTIF.dot, x, y, { step, color });
}
