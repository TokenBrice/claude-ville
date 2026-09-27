// The songbook's index: every tune the Town band plays, one file per piece
// under `pieces/` (built with `ScoreKit.js`, which this re-exports), the
// playlists derived from each piece's `phases`, and the island's two
// stingers. The sequencer plays it through `music/Voicings.js`.
//
// A piece is written in one of `ALLOWED_KEYS` (A, D or E; major by day,
// minor at night), the keys whose scale holds the signal cues' fixed
// pitches; the sequencer publishes the piece's key and its sounding chord to
// the MusicClock, so routine cues sing its chord tones (MusicalScale roles)
// instead of trusting the key. The motif source (Willowbrook) and the
// stingers stay in A. `scripts/audio/score-analyzer.mjs` checks every
// invariant.

import { deepFreeze } from './ScoreKit.js';
import willowbrook from './pieces/willowbrook.js';
import cobblemarket from './pieces/cobblemarket.js';
import millwheel from './pieces/millwheel.js';
import paintedIsle from './pieces/paintedIsle.js';
import hearthfire from './pieces/hearthfire.js';
import millbrook from './pieces/millbrook.js';
import saltwindJig from './pieces/saltwindJig.js';
import maypole from './pieces/maypole.js';
import shepherdsHill from './pieces/shepherdsHill.js';
import tinkersMarch from './pieces/tinkersMarch.js';
import greenwoodReel from './pieces/greenwoodReel.js';
import starfall from './pieces/starfall.js';
import moonwell from './pieces/moonwell.js';
import lanternlight from './pieces/lanternlight.js';
import lanternway from './pieces/lanternway.js';
import starwake from './pieces/starwake.js';
import emberwatch from './pieces/emberwatch.js';
import mistHarbor from './pieces/mistHarbor.js';
import owlLullaby from './pieces/owlLullaby.js';

export * from './ScoreKit.js';

// Day pieces, then night pieces.
export const PIECES = Object.freeze([
    willowbrook,
    cobblemarket,
    millwheel,
    paintedIsle,
    hearthfire,
    millbrook,
    saltwindJig,
    maypole,
    shepherdsHill,
    tinkersMarch,
    greenwoodReel,
    starfall,
    moonwell,
    lanternlight,
    lanternway,
    starwake,
    emberwatch,
    mistHarbor,
    owlLullaby,
]);

// Which pieces the Town band plays at which time of day: each piece's
// `phases`. Every day set has at least four pieces, so no piece has to
// return within six minutes (6.7).
export const PLAYLISTS = Object.freeze(Object.fromEntries(['dawn', 'day', 'dusk', 'night'].map(phase => [
    phase,
    Object.freeze(PIECES.filter(p => p.phases.includes(phase)).map(p => p.name)),
])));

// The lantern-lighting cadence (MUS-11): four bars at the blue-hour → night
// boundary, the major tonic darkening through the borrowed iv to minor.
export const NIGHTFALL_TAG = deepFreeze({
    bpm: 64, beatsPerBar: 4,
    chords: ['A', 'Dm', 'E', 'Am'],
    melody: [[4, 2], [7, 2], [5, 2], [8, 2], [2, 1], [-1, 1], [2, 2], [0, 4]],
    bass: [[-24, 4], [-19, 4], [-29, 4], [-24, 4]],
});

// The release stinger (MUS-11): the motif's call answered by its home phrase
// over the tonic, on the bar after the gold peal. Minor at night.
export const RELEASE_FANFARE = deepFreeze({
    day: {
        bpm: 96, beatsPerBar: 4,
        chords: ['A', 'A'],
        melody: [[0, 1], [4, 1], [7, 1.5], [4, 0.5], [7, 1], [4, 0.5], [2, 0.5], [0, 2]],
        bass: [[-24, 2], [-20, 2], [-24, 2], [-17, 2]],
    },
    night: {
        bpm: 80, beatsPerBar: 4,
        chords: ['Am', 'Am'],
        melody: [[0, 1], [3, 1], [7, 1.5], [3, 0.5], [7, 1], [3, 0.5], [2, 0.5], [0, 2]],
        bass: [[-24, 2], [-21, 2], [-24, 2], [-17, 2]],
    },
});
