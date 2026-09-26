// Village industry: a faint low murmur whose level follows how many agents
// are working. Silent when the village is idle; turned down at night by the
// director. The murmur is work, not world, so it has its own random stream.
// The workshop voices arrive with the workshop layer (plan 5.1).

import { BaseLayer } from './BaseLayer.js';
import { makeFilter } from '../Filters.js';

export class VillageHumLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.15, group: 'hum', ...options });
        this.murmurGain = null;
    }

    _start(ctx) {
        const src = this.engine.noiseSource('brown', { rng: this.rng });
        const bp = makeFilter(ctx, 'bandpass', 300, { q: 0.7 });

        this.murmurGain = ctx.createGain();
        this.murmurGain.gain.value = 0.12;

        src.connect(bp).connect(this.murmurGain).connect(this.out);
        src.start(ctx.currentTime);
        this.trackSource(src);
        this.track(bp, this.murmurGain);
    }
}
