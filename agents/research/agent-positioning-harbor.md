# Agent positioning audit — harbor district

## watchtower (Pharos Lighthouse)
- Footprint: x=27-29, y=8-12 (3×5). walkExclusion: dy=5 (south face row y=13, x=27-29). Effective capacity: override=2; intent capacity work=2/ambient=1/overflow=1.
- Visit tiles (4): (28,14) entrance, (28,15), (27,15), (29,15). Two staggered rows on south face within lighthouse-quay dock corridor (x=29 dock runs y=13-19; north-bank promenade hits (28,16)). East of x=30 is open sea.
- Queue risk: **no**. Cap=2 means at most two agents; tiles already span two rows with both flanks. Two agents can occupy (28,14) and (27,15)/(29,15) with no visible line.
- No change recommended.

## harbor (Harbor Master)
- Footprint: x=30-34, y=17-20 (5×4). walkExclusion: dx=-1, width=1, height=4 (column x=29, y=17-20 — west-face wall margin). Effective capacity: override=4; intent capacity work=4/ambient=3/overflow=3.
- Visit tiles (5): (29,19), (29,20), (28,19), (28,20), (30,20). All inside walkExclusion column x=29 or in a tight 3×2 block (x=28-30, y=19-20). With 4 concurrent agents this is the forge pattern — they'll line up along the west wall.
- Queue risk: **yes**. Constraint: north (y<17 below tower at y=8-12 leaves x=27-29 dock corridor only), east (x≥30, y≤20 is footprint; y≥21 is water/dock outbound), south (y=21 transitions to harbor-berths dock heading east; west of x=30 at y=21 is land/shore).
- Proposed visitTiles:
  ```js
  visitTiles: [
      { tileX: 29, tileY: 19 }, // entrance, west face mid
      { tileX: 28, tileY: 18 }, // west flank, north stagger
      { tileX: 28, tileY: 20 }, // west flank, south stagger
      { tileX: 27, tileY: 19 }, // outer west row, central
      { tileX: 27, tileY: 17 }, // outer west row, north corner
      { tileX: 29, tileY: 21 }, // southwest corner, south face
      { tileX: 28, tileY: 21 }, // south face, west of berth dock
  ],
  ```
  Seven tiles across three columns (x=27,28,29) and four rows (y=17-21), avoiding the (29,17-20) walkExclusion interior except the entrance, staying west of harbor-berths dock origin (30,20), and not crossing into water east of x=30.

## Summary
- watchtower: no change — cap=2 with already-staggered tiles.
- harbor: change recommended — current 5 tiles cluster 3×2 against west wall; expand to 7 tiles spanning x=27-29, y=17-21 to break up the queue.
