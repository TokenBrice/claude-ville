# Agent positioning audit — civic district

## command
- Footprint x=13–17, y=16–19 (5×4). walkExclusion blocks row y=20 (south facade). Effective capacity: override=5, intent work=5.
- Current 6 visit tiles all sit south of the building on two rows: y=21 (x=12,16,18) and y=22 (x=14,16,18). No west/east/north flanks. Worst case at capacity 5: agents fill y=21 row first (closer to entrance, lower distance score) and visibly queue along the promenade.
- Queue risk: yes — the building is 5 tiles wide but all approach tiles concentrate on the south face within 2 rows; per-slot reservation (180) plus crowd penalty (18) cannot pull agents to flanks that don't exist.
- Proposed visitTiles:
```js
visitTiles: [
    { tileX: 16, tileY: 21 }, // entrance, south-center row 1
    { tileX: 14, tileY: 21 }, // south-west row 1
    { tileX: 18, tileY: 21 }, // south-east row 1
    { tileX: 15, tileY: 22 }, // south-center row 2 staggered
    { tileX: 17, tileY: 22 }, // south-center row 2 staggered
    { tileX: 12, tileY: 18 }, // west flank mid
    { tileX: 12, tileY: 19 }, // west flank south corner
    { tileX: 18, tileY: 18 }, // east flank mid
    { tileX: 18, tileY: 19 }, // east flank south corner
],
```

## taskboard
- Footprint x=21–24, y=31–33 (4×3). walkExclusion blocks row y=34. Effective capacity: override=4, intent work=4.
- Current 5 visit tiles are all south: y=35 (x=21,23,25) and y=36 (x=22,24). With 4 concurrent agents, 3 of 4 land on y=35 (closer to entrance), producing the same single-row queue the forge had.
- Queue risk: yes — the 4-wide south face mirrors the original forge layout; flanks at x=20 and x=25 along the building's sides are unused despite being clear (mine is at x=11–14, forge at x=26–29 y=26–28).
- Proposed visitTiles:
```js
visitTiles: [
    { tileX: 23, tileY: 35 }, // entrance, south-center
    { tileX: 21, tileY: 35 }, // south-west row
    { tileX: 25, tileY: 35 }, // south-east row
    { tileX: 22, tileY: 36 }, // south staggered row 2
    { tileX: 24, tileY: 36 }, // south staggered row 2
    { tileX: 20, tileY: 32 }, // west flank mid
    { tileX: 20, tileY: 33 }, // west flank south corner
    { tileX: 25, tileY: 32 }, // east flank mid
    { tileX: 25, tileY: 33 }, // east flank south corner
],
```

## Summary
- command: queue risk, recommend 9-tile layout adding west/east flanks at x=12 and x=18.
- taskboard: queue risk, recommend 9-tile layout adding west/east flanks at x=20 and x=25.
