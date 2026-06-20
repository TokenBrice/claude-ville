// Mark governor (visual-upgrade item #2) — the value-hierarchy contract's
// per-frame enforcement arm, the twin of the motion budget.
//
// Every decorative overlay mark (a ring, a tether, a halo, an aura, a banner)
// declares a TIER when it asks to draw:
//
//   PRIMARY   — errored / waiting-on-user / selected. The reads the operator
//               MUST never lose in a crowd. Always full alpha, never culled.
//   SECONDARY — working glow, relationship tethers, council rings, talk arcs.
//               Capped in count and alpha per screen region so a clustered
//               crowd does not stack into a wash; the overflow is culled.
//   AMBIENT   — drifting motes, ground tints, building halos, banners. The
//               first marks to dim and the first to cull when a region is busy.
//
// The governor buckets the screen into coarse regions and counts admitted
// SECONDARY/AMBIENT marks per region per frame; as a region fills, later marks
// of those tiers fade and then drop entirely. PRIMARY marks bypass all of it.
//
// Reduced motion (motionScale === 0): static caps only — alpha is clamped to
// each tier's cap but NO region culling happens, so the still scene keeps every
// mark it would otherwise show, just at the calmer ceiling alpha. This is the
// item's reduced-motion fallback: the governor degrades to a pure alpha clamp.

export const MarkTier = Object.freeze({
    PRIMARY: 'primary',
    SECONDARY: 'secondary',
    AMBIENT: 'ambient',
});

// Per-tier alpha ceilings (multipliers applied to the caller's own alpha) and
// per-region soft/hard limits. PRIMARY is uncapped and uncounted.
const TIER_POLICY = Object.freeze({
    [MarkTier.PRIMARY]: { alphaCap: 1, soft: Infinity, hard: Infinity },
    [MarkTier.SECONDARY]: { alphaCap: 0.85, soft: 4, hard: 9 },
    [MarkTier.AMBIENT]: { alphaCap: 0.6, soft: 3, hard: 6 },
});

const DEFAULT_REGION_SIZE = 200;

export class MarkGovernor {
    constructor() {
        this.regionSize = DEFAULT_REGION_SIZE;
        this.motionScale = 1;
        // Map<regionKey, { secondary: n, ambient: n }>
        this._regions = new Map();
        this._frame = 0;
    }

    // Reset per-frame state. Called once per frame by the renderer before the
    // draw passes run.
    beginFrame({ regionSize = DEFAULT_REGION_SIZE, motionScale = 1 } = {}) {
        this.regionSize = regionSize > 0 ? regionSize : DEFAULT_REGION_SIZE;
        this.motionScale = motionScale;
        this._regions.clear();
        this._frame++;
    }

    _bucket(x, y) {
        const size = this.regionSize;
        const rx = Number.isFinite(x) ? Math.floor(x / size) : 0;
        const ry = Number.isFinite(y) ? Math.floor(y / size) : 0;
        const key = `${rx},${ry}`;
        let region = this._regions.get(key);
        if (!region) {
            region = { secondary: 0, ambient: 0 };
            this._regions.set(key, region);
        }
        return region;
    }

    // Ask the governor whether a mark of `tier` at screen-space (x, y) may draw.
    // Returns { draw, alpha } where `alpha` is a 0..1 multiplier to apply on top
    // of the caller's own alpha. PRIMARY always returns { draw: true, alpha: 1 }.
    //
    // For SECONDARY/AMBIENT: alpha rides the tier cap until the region's soft
    // limit, then ramps down to 0 between soft and hard, then culls (draw:false)
    // past hard. Under reduced motion the region count is ignored (static caps).
    admit(tier, x = 0, y = 0) {
        const policy = TIER_POLICY[tier] || TIER_POLICY[MarkTier.AMBIENT];
        if (tier === MarkTier.PRIMARY) return { draw: true, alpha: 1 };

        // Reduced motion: no region culling, just the static ceiling.
        if (this.motionScale <= 0) {
            return { draw: true, alpha: policy.alphaCap };
        }

        const region = this._bucket(x, y);
        const field = tier === MarkTier.SECONDARY ? 'secondary' : 'ambient';
        const index = region[field];
        region[field] = index + 1;

        if (index >= policy.hard) return { draw: false, alpha: 0 };

        let alpha = policy.alphaCap;
        if (index >= policy.soft) {
            const span = Math.max(1, policy.hard - policy.soft);
            const decay = 1 - (index - policy.soft) / span;
            alpha = policy.alphaCap * Math.max(0, decay);
        }
        return { draw: alpha > 0.01, alpha };
    }

    // Convenience: just the alpha multiplier (0 when culled).
    alphaFor(tier, x = 0, y = 0) {
        const result = this.admit(tier, x, y);
        return result.draw ? result.alpha : 0;
    }
}

// Module-singleton. The frame orchestrator (WorldFrameRenderer / DrawablePass)
// calls the draw functions with renderer-derived option bags that do not carry
// the governor, and AgentSprite.draw() receives no governor argument — so the
// renderer publishes the active governor here and the decorative draw paths
// read it back. The renderer owns the lifecycle: it constructs the governor and
// calls beginFrame() each frame before drawing.
let activeGovernor = null;

export function setActiveMarkGovernor(governor) {
    activeGovernor = governor || null;
}

export function getActiveMarkGovernor() {
    return activeGovernor;
}
