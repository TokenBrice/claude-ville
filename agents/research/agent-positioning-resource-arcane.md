# Agent positioning audit — resource and arcane districts

## mine
- Footprint x=11-14, y=31-33. walkExclusion blocks y=34, x=11-14. Effective capacity 4 (`BUILDING_CAPACITY_OVERRIDES.mine`); intent capacity work=3, ambient=2, overflow=2.
- Current visit tiles (5): (13,35), (11,35), (15,35), (12,36), (14,36). All five on the south face; three share row y=35. With cap 4, that row fills → same pattern as the original forge.
- Queue risk: yes. Production-row path runs east-west along y=34, reinforcing the horizontal line read.
- Proposed visitTiles:
```js
visitTiles: [
    { tileX: 13, tileY: 35 }, // south-front primary, on production-row
    { tileX: 11, tileY: 35 }, // south-front, west of entrance
    { tileX: 15, tileY: 35 }, // south-front, east of entrance
    { tileX: 12, tileY: 36 }, // south-back, staggered
    { tileX: 14, tileY: 36 }, // south-back, staggered
    { tileX: 10, tileY: 33 }, // west flank, beside building south row
    { tileX: 15, tileY: 33 }, // east flank, beside building south row
],
```

## portal
- Footprint x=5-8, y=29-32. walkExclusion blocks y=33, x=5-9. Effective capacity 4 (`BUILDING_CAPACITY_OVERRIDES.portal`); intent capacity work=4, ambient=2, overflow=2.
- Current visit tiles (5): (9,34), (5,34), (8,34), (6,35), (9,35). Three share row y=34; cap 4 lines them up.
- Queue risk: yes. South face only; west (x=4) and east (x=9 alongside building) flanks unused.
- Proposed visitTiles:
```js
visitTiles: [
    { tileX: 9, tileY: 34 }, // south-front primary near entrance
    { tileX: 5, tileY: 34 }, // south-front, west end
    { tileX: 7, tileY: 34 }, // south-front, mid
    { tileX: 6, tileY: 35 }, // south-back, staggered
    { tileX: 8, tileY: 35 }, // south-back, staggered
    { tileX: 9, tileY: 30 }, // east flank, beside building mid row
    { tileX: 9, tileY: 32 }, // east flank, beside building south row
],
```

## Summary
- mine: change recommended — south face single-row heavy; add west/east flank tiles at y=33 to break the line.
- portal: change recommended — three pack on y=34; add east-flank tiles (x=9, y=30/32) to spread load.
