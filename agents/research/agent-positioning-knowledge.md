# Agent positioning audit — knowledge district

## archive
- Footprint x=3-7, y=15-17 (5x3). `walkExclusion` `{dx:0, dy:3, w:5, h:1}` blocks y=18 across x=3-7. Effective capacity 4 (override); intent capacity work=4, overflow=6.
- Visit tiles (9): all on the EAST face but spread across a 3-column by 4-row zone — x=8,9,10, y=16-19. Tile (8,19) provides a south-east anchor; the rest stagger across two columns at y=17/18. Tiles at x=8,9,10 sit outside the y=18 walkExclusion (which only covers x=3-7).
- Queue risk: **no**. With per-slot reservation (180) and crowd penalty (18) on a 3x4 spread, 4 concurrent occupants distribute naturally; even the overflow=6 case has enough scatter. Already healthier than the pre-fix forge layout.
- No change recommended.

## observatory
- Footprint x=21-24, y=14-17 (4x4). `walkExclusion` `{dx:4, dy:1, w:1, h:3}` blocks east strip x=25, y=15-17. Effective capacity 3 (override); intent capacity work=3, overflow=2.
- Visit tiles (5): all on SOUTH face. y=18 row holds three tiles (22,23,24) — exactly equal to capacity — and y=19 holds (23,24). Worst case: all 3 agents pick y=18 (closer/lower distance) and form a visible line directly under the building. Same failure mode as pre-fix forge.
- Queue risk: **yes** — single-face south layout with capacity-equal row.
- Proposed visitTiles:
  ```
  { tileX: 23, tileY: 18 }, // entrance, south face center
  { tileX: 22, tileY: 19 }, // south-west staggered
  { tileX: 24, tileY: 19 }, // south-east staggered
  { tileX: 20, tileY: 16 }, // west flank upper (x=20 free, west of footprint)
  { tileX: 20, tileY: 17 }, // west flank lower
  { tileX: 21, tileY: 18 }, // south-west corner
  { tileX: 25, tileY: 18 }, // south-east corner just below east exclusion
  ```
  Entrance unchanged (23,18). West flank avoids walkExclusion; clock-walk path at x=23, y=16-18 is preserved.

## Summary
- archive: spread already adequate, no change.
- observatory: single south face causes capacity-equal queue row; replace with staggered south + west-flank layout above.
