import test from 'node:test';
import assert from 'node:assert/strict';

import { cueCaptionShown, cueStratum } from '../../claudeville/src/presentation/shared/Toast.js';

const SIGNALS = ['summons', 'distress', 'limit', 'reminder', 'answered'];
const EVENTS = [
    'turnDone', 'subagentReturn', 'toolFailed', 'commit', 'push', 'release', 'pushFailed', 'dispatch',
    'arrival', 'departure', 'recovery', 'council',
];
const SCENERY = ['hourBell', 'aurora', 'thunder', 'linkLost', 'linkRestored'];

// Plan 3.8 / S6: which strata each caption setting shows, with sound off and on.
const EXPECTED = {
    auto: { off: ['signal'], on: ['signal', 'event'] },
    signals: { off: ['signal'], on: ['signal'] },
    events: { off: ['signal', 'event'], on: ['signal', 'event'] },
    all: { off: ['signal', 'event'], on: ['signal', 'event', 'scenery'] },
};

test('every contract kind belongs to its stratum', () => {
    for (const kind of SIGNALS) assert.equal(cueStratum(kind), 'signal', kind);
    for (const kind of EVENTS) assert.equal(cueStratum(kind), 'event', kind);
    for (const kind of SCENERY) assert.equal(cueStratum(kind), 'scenery', kind);
    assert.equal(cueStratum('digest'), 'soundOnly');
});

test('caption policy covers every kind × setting × sound state', () => {
    for (const [setting, bySound] of Object.entries(EXPECTED)) {
        for (const [sound, strata] of Object.entries(bySound)) {
            const soundOn = sound === 'on';
            for (const kind of [...SIGNALS, ...EVENTS, ...SCENERY]) {
                assert.equal(
                    cueCaptionShown({ kind }, { setting, soundOn }),
                    strata.includes(cueStratum(kind)),
                    `${kind} · captions ${setting} · sound ${sound}`,
                );
            }
        }
    }
});

test('the return digest never captions, in any setting or sound state', () => {
    for (const setting of Object.keys(EXPECTED)) {
        for (const soundOn of [false, true]) {
            assert.equal(cueCaptionShown({ kind: 'digest', soundOnly: true }, { setting, soundOn }), false);
            assert.equal(cueCaptionShown({ kind: 'digest' }, { setting, soundOn }), false);
            assert.equal(cueCaptionShown({ kind: 'summons', soundOnly: true }, { setting, soundOn }), false);
        }
    }
});

test('an unknown setting reads as automatic and a missing cue shows nothing', () => {
    assert.equal(cueCaptionShown({ kind: 'push' }, { setting: 'loud', soundOn: false }), false);
    assert.equal(cueCaptionShown({ kind: 'push' }, { setting: 'loud', soundOn: true }), true);
    assert.equal(cueCaptionShown({ kind: 'thunder' }, { setting: 'loud', soundOn: true }), false);
    assert.equal(cueCaptionShown({ kind: 'summons' }), true);
    assert.equal(cueCaptionShown({ kind: 'arrival' }), false, 'defaults are automatic with sound off');
    assert.equal(cueCaptionShown(null), false);
});
