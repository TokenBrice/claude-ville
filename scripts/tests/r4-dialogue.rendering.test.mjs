// Bubble legibility. The old renderer shrank text one character at a time and
// cut mid-word, which is what produced unreadable fragments over villagers'
// heads. These tests defend the pixel-fit-then-word-boundary behaviour and the
// hover provenance that makes the badge on the bubble mean something.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';

// Monospace stand-in: every glyph is 6px wide, so expected widths are exact and
// the assertions do not depend on a real font being present.
const CHAR_PX = 6;
function fakeCtx() {
    return {
        font: '10px test',
        measureCalls: 0,
        measureText(text) {
            this.measureCalls++;
            return { width: String(text).length * CHAR_PX };
        },
    };
}

function layout(text, maxWidthChars) {
    const ctx = fakeCtx();
    // Fresh host per call, so the layout cache never masks a measurement count.
    const host = { _bubbleLayoutCacheKey: null, _bubbleLayoutCache: null };
    const result = AgentSprite.prototype._bubbleLayout.call(host, ctx, text, maxWidthChars * CHAR_PX, true);
    return { ...result, measureCalls: ctx.measureCalls };
}

test('text that fits is left completely alone', () => {
    const { displayText } = layout('Running the checks', 40);
    assert.equal(displayText, 'Running the checks');
});

test('overlong text is cut at a word boundary, never mid-word', () => {
    const { displayText } = layout('Reclassify supplemental Aave lending rows', 24);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length <= 24, true);
    // The body must end on a whole word.
    const body = displayText.slice(0, -1);
    assert.equal('Reclassify supplemental Aave lending rows'.startsWith(body), true);
    assert.match(body, /(Reclassify|supplemental|Aave|lending)$/);
});

test('a long unbroken token still yields readable text', () => {
    // No space to break on: a word-boundary-only rule would collapse this to
    // nothing, which is worse than a hard cut.
    const { displayText } = layout('$PROJECT/src/presentation/character-mode/AgentSprite.js', 20);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length > 2, true);
});

test('fitting is logarithmic, not one character per measurement', () => {
    const long = 'Reclassify supplemental Aave lending rows so they stop outranking native wrappers';
    const { measureCalls } = layout(long, 24);
    // Character-by-character shrinking would need ~60 measurements here.
    assert.equal(measureCalls < 15, true, `expected a binary search, got ${measureCalls} measureText calls`);
});

test('trailing punctuation is not left dangling before the ellipsis', () => {
    const { displayText } = layout('Checking the adapter, then the renderer', 22);
    assert.doesNotMatch(displayText, /[,;:]…$/);
});

test('a surrogate pair is never split', () => {
    const { displayText } = layout('🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷', 6);
    assert.doesNotMatch(displayText, /[\ud800-\udbff]…$/);
});

test('hover exposes the untrimmed wording and the exact origin', () => {
    const host = {
        _activitySnapshot: {
            text: 'The user wants me to execute a research procedure for mint…',
            full: 'The user wants me to execute a research procedure for mint-bridge-boundary analysis.',
            kind: 'thinking',
            source: 'grok.thought.chunk',
            fidelity: 'excerpt',
            redacted: false,
        },
    };
    const tip = AgentSprite.prototype.dialogueTooltip.call(host);
    // Full text, so hovering recovers what the bubble had to cut.
    assert.match(tip, /boundary analysis\./);
    // And the origin, named exactly.
    assert.match(tip, /Model reasoning — grok\.thought\.chunk \(excerpt\)/);
});

test('hover discloses redaction', () => {
    const host = {
        _activitySnapshot: {
            text: 'Implemented the fix in $PROJECT/src/foo.js',
            full: null,
            kind: 'assistant',
            source: 'claude.text',
            fidelity: 'verbatim',
            redacted: true,
        },
    };
    assert.match(AgentSprite.prototype.dialogueTooltip.call(host), /\(redacted\)/);
});

test('a silent villager has no tooltip', () => {
    assert.equal(AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: null }), '');
    // Harness status entries carry no source, so they claim no provenance.
    assert.equal(
        AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: { text: 'WORKING', source: null } }),
        '',
    );
});
