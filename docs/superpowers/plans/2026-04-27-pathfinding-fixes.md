# Pathfinding Fixes + Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all confirmed and potential cases where agents walk through river/moat water tiles instead of routing via bridges, streamline the pathfinding code, and ship seven targeted quality-of-life upgrades (8-connected movement, path smoothing, repathing throttle, guaranteed-walkable random targets, shared BFS cache, debug overlay, and agent steering separation).

**Architecture:** Bug fixes are surgical edits to `Pathfinder.js`, `AgentSprite.js`, and `SceneryEngine.js`. Upgrades extend `Pathfinder.js` with diagonal support, look-ahead smoothing, a walkable-tile sample list, and a path cache; extend `AgentSprite.js` with repathing throttle and the walkable-tile sampler; add a new `DebugOverlay.js`; and add a steering pass to `IsometricRenderer.js`.

**Tech Stack:** Vanilla ES2022 modules, no transpiler, no test runner. Validation is `node --check` + manual browser observation at `http://localhost:4000`. Server starts with `npm run dev`.

---

## File Map

| File | Role | What changes |
|---|---|---|
| `claudeville/src/presentation/character-mode/AgentSprite.js` | Per-agent movement and rendering | Tasks 1, 3, 10, 11 |
| `claudeville/src/presentation/character-mode/Pathfinder.js` | BFS pathfinding algorithm | Tasks 2, 4, 5, 8, 9, 11, 12 |
| `claudeville/src/presentation/character-mode/SceneryEngine.js` | Walkability grid + bridge placement | Tasks 6, 7 |
| `claudeville/src/presentation/character-mode/IsometricRenderer.js` | Renderer, update loop | Tasks 7, 13, 14 |
| `claudeville/src/presentation/character-mode/DebugOverlay.js` | **New** — toggle-able debug canvas layer | Task 13 |

## Parallelization Guide

Tasks on the same file must be applied sequentially. Tasks on different files are independent and can be dispatched in parallel by a subagent orchestrator.

| Sequential chain | Parallel with |
|---|---|
| **Pathfinder.js** Tasks 2 → 4 → 5 → 8 → 9 → 11 → 12 | Task 6, 10, 13, 14 |
| **AgentSprite.js** Tasks 1 → 3 → 10 → 11 | Task 6, 8, 13, 14 |
| **SceneryEngine.js + IsometricRenderer.js** Tasks 6 → 7 | All Pathfinder + AgentSprite tasks |
| **IsometricRenderer.js** Tasks 13 → 14 | All Pathfinder + AgentSprite + SceneryEngine tasks |

Natural parallel batches for a subagent orchestrator:
- **Batch A** (all independent of each other): Tasks 6, 10, 13
- **Batch B** (after Batch A): Tasks 7, 14
- **All Pathfinder tasks** must run as a single sequential chain.

---

## Task 1: Fix chat-partner movement bypassing the pathfinder

**Root cause:** `AgentSprite._pickTarget` and the per-frame refresh in `update()` set `targetX/targetY` directly in screen space and clear `waypoints = []` when a chat partner exists, so the agent walks a straight screen-space line to its partner — straight through any river in the way.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js:104-113` (`_pickTarget`)
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js:263-266` (`update`)

- [ ] **Step 1: Open AgentSprite.js and locate the two chat-partner movement blocks**

  Verify the exact text of both blocks by reading lines 104–113 and 263–266.

  Block A (in `_pickTarget`, lines 104–113):
  ```js
  if (this.chatPartner) {
      this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
      this.targetY = this.chatPartner.y;
      this.waypoints = [];
      this.moving = true;
      this.waitTimer = 0;
      return;
  }
  ```

  Block B (in `update`, lines 263–266):
  ```js
  // Refresh target when the partner position changes
  this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
  this.targetY = this.chatPartner.y;
  this.waypoints = [];
  ```

- [ ] **Step 2: Replace Block A in `_pickTarget`**

  Replace the entire Block A with the following. Critical: reset `_lastPathTileKey` to `null` first so the pathfinder always computes a fresh route on chat entry — without it, the cache could retain the stale pre-chat tile key and silently skip BFS.

  ```js
  if (this.chatPartner) {
      const offsetX = this.x < this.chatPartner.x ? -25 : 25;
      const chatTargetX = this.chatPartner.x + offsetX;
      const chatTargetY = this.chatPartner.y;
      const targetTile = this._screenToTile(chatTargetX, chatTargetY);
      this._lastPathTileKey = null; // force fresh path on every chat entry
      this._assignTarget(chatTargetX, chatTargetY, targetTile.tileX, targetTile.tileY);
      this.moving = true;
      this.waitTimer = 0;
      return;
  }
  ```

- [ ] **Step 3: Replace Block B in `update()`**

  Replace the Block B comment + 3 lines with the following:

  ```js
  // Refresh target when the partner position changes — route via pathfinder.
  const offsetX = this.x < this.chatPartner.x ? -25 : 25;
  const chatTargetX = this.chatPartner.x + offsetX;
  const chatTargetY = this.chatPartner.y;
  const chatTargetTile = this._screenToTile(chatTargetX, chatTargetY);
  this._assignTarget(chatTargetX, chatTargetY, chatTargetTile.tileX, chatTargetTile.tileY);
  ```

- [ ] **Step 4: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  ```

  Expected: no output (clean).

- [ ] **Step 5: Manual smoke test**

  Start the server: `npm run dev`  
  Open `http://localhost:4000`.  
  Wait for two agents to start chatting (triggered when any agent uses SendMessage with a matched recipient — visible when a yellow CHAT bubble appears).  
  Confirm the approaching agent walks around the river/moat rather than through it.  
  Stop the server.

- [ ] **Step 6: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/AgentSprite.js
  git commit -m "fix: route chat-partner movement through pathfinder to respect water tiles"
  ```

---

## Task 2: Fix Bresenham corner-cut in `_lineWalkable`

**Root cause:** When the Bresenham error simultaneously satisfies both `e2 > -dy` and `e2 < dx`, the algorithm advances both `cx` and `cy` in one iteration (a diagonal step) without checking the two intermediate corner tiles `(cx+sx, cy)` and `(cx, cy+sy)`. A thin water finger oriented diagonally can slip through this check, allowing the fast path to approve a line that grazes a blocked tile.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js:110-126`

- [ ] **Step 1: Read `_lineWalkable` to confirm current code**

  The current method at lines 110–126:
  ```js
  _lineWalkable(x0, y0, x1, y1) {
      // Bresenham-ish: step along the longer axis and require every passed tile to be walkable.
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      let cx = x0;
      let cy = y0;
      while (true) {
          if (!this.isWalkable(cx, cy)) return false;
          if (cx === x1 && cy === y1) return true;
          const e2 = 2 * err;
          if (e2 > -dy) { err -= dy; cx += sx; }
          if (e2 < dx) { err += dx; cy += sy; }
      }
  }
  ```

- [ ] **Step 2: Replace `_lineWalkable` with the corner-safe version**

  ```js
  _lineWalkable(x0, y0, x1, y1) {
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      let cx = x0;
      let cy = y0;
      while (true) {
          if (!this.isWalkable(cx, cy)) return false;
          if (cx === x1 && cy === y1) return true;
          const e2 = 2 * err;
          if (e2 > -dy && e2 < dx) {
              // Diagonal step — check both corner tiles to prevent corner-cutting.
              if (!this.isWalkable(cx + sx, cy) || !this.isWalkable(cx, cy + sy)) return false;
              err -= dy; cx += sx;
              err += dx; cy += sy;
          } else {
              if (e2 > -dy) { err -= dy; cx += sx; }
              if (e2 < dx) { err += dx; cy += sy; }
          }
      }
  }
  ```

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output (clean).

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "fix: prevent Bresenham corner-cut through diagonal water tiles in _lineWalkable"
  ```

---

## Task 3: Fix agent spawn on non-walkable tiles

**Root cause:** `Agent.js` initializes agents at a random `Position(20 + rand*10, 20 + rand*10)`, which intersects the central moat (`~y=22..25`). When a spawn tile is a water tile with no adjacent walkable cardinal neighbor, `Pathfinder.findPath`'s stuck-start guard returns `[]` and the agent freezes permanently. The fix: after the initial screen position is resolved in `AgentSprite` constructor, nudge the sprite to the nearest walkable tile before `_pickTarget()` runs.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js:74-101` (constructor)

- [ ] **Step 1: Locate insertion point in the constructor**

  Read AgentSprite.js lines 74–102. The target block is:
  ```js
  const screen = agent.position.toScreen(TILE_WIDTH, TILE_HEIGHT);
  this.x = screen.x;
  this.y = screen.y;

  this.pathfinder = pathfinder;
  this.bridgeTiles = bridgeTiles;
  this.waypoints = [];
  this._lastPathTileKey = null;
  ```

  The guard must be inserted after `this.pathfinder = pathfinder;` and before `this._pickTarget();` at line 101.

- [ ] **Step 2: Add spawn-guard block after `this._lastPathTileKey = null;`**

  After the line `this._lastPathTileKey = null;` (line 81), insert:

  ```js
  // Guard: if the agent spawns on a non-walkable tile (e.g. water), nudge to
  // the nearest walkable tile so _pickTarget can compute a valid first path.
  if (this.pathfinder) {
      const startTile = this._screenToTile(this.x, this.y);
      const fx = Math.round(startTile.tileX);
      const fy = Math.round(startTile.tileY);
      if (!this.pathfinder.isWalkable(fx, fy)) {
          const neighbors = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
          for (const [dx, dy] of neighbors) {
              const nx = fx + dx;
              const ny = fy + dy;
              if (this.pathfinder.isWalkable(nx, ny)) {
                  const nudged = new Position(nx, ny).toScreen(TILE_WIDTH, TILE_HEIGHT);
                  this.x = nudged.x;
                  this.y = nudged.y;
                  break;
              }
          }
      }
  }
  ```

  `Position` is already imported at line 1 of AgentSprite.js.

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  ```

  Expected: no output (clean).

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/AgentSprite.js
  git commit -m "fix: nudge agent to nearest walkable tile when spawning on water"
  ```

---

## Task 4: Add instrumentation for stuck/unreachable paths

**Root cause:** When `Pathfinder.findPath` returns `[]` (no path found or stuck start with no escape), `AgentSprite._assignTarget` silently freezes the agent in place. There is no log, no counter, no way to know from runtime that this happened.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js:30-38`

- [ ] **Step 1: Add warn to stuck-start recursion failure (line 38)**

  The current code at lines 30–38:
  ```js
  if (!this.isWalkable(fx, fy)) {
      for (const [dx, dy] of DIRS) {
          const nx = fx + dx;
          const ny = fy + dy;
          if (!this.isWalkable(nx, ny)) continue;
          const sub = this.findPath({ tileX: nx, tileY: ny }, to, bridgeTiles);
          if (sub.length > 0) return [{ tileX: nx, tileY: ny }, ...sub];
      }
      return [];
  }
  ```

  Replace the `return [];` at line 38 with:
  ```js
      console.warn('[Pathfinder] stuck: no walkable cardinal neighbor at', fx, fy);
      return [];
  }
  ```

- [ ] **Step 2: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output (clean).

- [ ] **Step 3: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "fix: log warning when pathfinder finds no walkable escape from stuck-start tile"
  ```

  **Note:** Task 4 instruments line 38 (recursion stuck-start, no walkable cardinal neighbor). Task 5 instruments the BFS no-path return (`foundIdx === -1`, a different line). Both tasks patch non-overlapping code paths and **both should be applied**.

---

## Task 5: Replace O(n²) `queue.shift()` with index pointer and integer target set

**Root cause:** BFS at `Pathfinder.findPath:61` uses `queue.shift()` — an O(n) operation on a plain JS array — making the overall BFS O(n²) in queue size. Separately, the target set uses string concatenation keys (`"${cx},${cy}"`) requiring string allocation and hashing on every dequeue. Both are fixed in one surgical edit to the BFS block.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js:52-80`

- [ ] **Step 1: Read the current BFS block**

  Current code at lines 52–80:
  ```js
  // BFS.
  const N = MAP_SIZE;
  const visited = new Uint8Array(N * N);
  const parent = new Int32Array(N * N).fill(-1);
  const targetSet = new Set(targetCandidates.map(({ tileX, tileY }) => `${tileX},${tileY}`));
  const queue = [fy * N + fx];
  visited[fy * N + fx] = 1;
  let foundIdx = -1;
  while (queue.length) {
      const cur = queue.shift();
      const cx = cur % N;
      const cy = (cur - cx) / N;
      if (targetSet.has(`${cx},${cy}`)) {
          foundIdx = cur;
          break;
      }
      for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
          const idx = ny * N + nx;
          if (visited[idx]) continue;
          if (!this.isWalkable(nx, ny)) continue;
          visited[idx] = 1;
          parent[idx] = cur;
          queue.push(idx);
      }
  }
  if (foundIdx === -1) return [];
  ```

- [ ] **Step 2: Replace the entire BFS block with the optimized version**

  ```js
  // BFS — index-pointer queue (O(n)) and integer target set (no string allocation).
  const N = MAP_SIZE;
  const visited = new Uint8Array(N * N);
  const parent = new Int32Array(N * N).fill(-1);
  const targetSet = new Set(targetCandidates.map(({ tileX, tileY }) => tileY * N + tileX));
  const queue = [fy * N + fx];
  let head = 0;
  visited[fy * N + fx] = 1;
  let foundIdx = -1;
  while (head < queue.length) {
      const cur = queue[head++];
      if (targetSet.has(cur)) {
          foundIdx = cur;
          break;
      }
      const cx = cur % N;
      const cy = (cur - cx) / N;
      for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
          const idx = ny * N + nx;
          if (visited[idx]) continue;
          if (!this.isWalkable(nx, ny)) continue;
          visited[idx] = 1;
          parent[idx] = cur;
          queue.push(idx);
      }
  }
  if (foundIdx === -1) {
      console.warn('[Pathfinder] no path from', fx, fy, 'to nearest of', targetCandidates.length, 'candidates; closest:', JSON.stringify(targetCandidates[0]));
      return [];
  }
  ```

  **Note:** Task 5 instruments the BFS no-path case (`foundIdx === -1`) here. Task 4 instruments the stuck-start recursion exhaustion at line 38 — a different code path. Both tasks patch non-overlapping lines and **both should be applied**.

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output (clean).

- [ ] **Step 4: Smoke-test pathfinding still routes correctly**

  Start the server: `npm run dev`  
  Open `http://localhost:4000`.  
  Confirm agents are moving between buildings normally (not frozen).  
  Confirm agents do not cross the river moat on the south half of the map.  
  Stop the server.

- [ ] **Step 5: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "perf: replace queue.shift() with index pointer and use integer target set in BFS"
  ```

  *(Task 4's commit — stuck-start warn at line 38 — should also be applied; it patches a different code path.)*

---

## Task 6: Fix `generateBridges` early-exit that silences auto-placement

**Root cause:** `SceneryEngine.generateBridges` contains `if (this.bridgeTiles.size > 0) return;` at line 266, inserted after `_addHarborDocks()`. Since `_addHarborDocks` always populates 47+ bridge tiles, the auto-placement loop (lines 268–278) is unreachable in any map that has a harbor. If a road tile ever lands on a water tile without an authored bridge, no bridge is auto-placed. The auto-placement loop already guards against double-placing with `if (this.bridgeTiles.has(key)) continue;`, so removing the early-exit is safe.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js:266`

- [ ] **Step 1: Read the current `generateBridges` method**

  Lines 258–279 should read:
  ```js
  generateBridges(pathTiles) {
      // 1. Authored hints — always placed if the tile is water.
      for (const hint of BRIDGE_HINTS) {
          const key = `${hint.tileX},${hint.tileY}`;
          if (!this.waterTiles.has(key)) continue;
          this._addBridgeSpan(hint.tileX, hint.tileY, hint.orientation);
      }
      this._addHarborDocks();
      if (this.bridgeTiles.size > 0) return;

      // 2. Auto-place where any path tile lies on water.
      for (const key of pathTiles) {
          if (!this.waterTiles.has(key)) continue;
          if (this.bridgeTiles.has(key)) continue;
          const comma = key.indexOf(',');
          const tileX = Number(key.slice(0, comma));
          const tileY = Number(key.slice(comma + 1));
          this.bridgeTiles.set(key, {
              orientation: this._inferOrientation(tileX, tileY),
          });
      }
  }
  ```

- [ ] **Step 2: Remove the early-exit guard**

  Delete the line `if (this.bridgeTiles.size > 0) return;` so the method becomes:

  ```js
  generateBridges(pathTiles) {
      // 1. Authored hints — always placed if the tile is water.
      for (const hint of BRIDGE_HINTS) {
          const key = `${hint.tileX},${hint.tileY}`;
          if (!this.waterTiles.has(key)) continue;
          this._addBridgeSpan(hint.tileX, hint.tileY, hint.orientation);
      }
      this._addHarborDocks();

      // 2. Auto-place where any path tile lies on water and has no authored bridge.
      for (const key of pathTiles) {
          if (!this.waterTiles.has(key)) continue;
          if (this.bridgeTiles.has(key)) continue;
          const comma = key.indexOf(',');
          const tileX = Number(key.slice(0, comma));
          const tileY = Number(key.slice(comma + 1));
          this.bridgeTiles.set(key, {
              orientation: this._inferOrientation(tileX, tileY),
          });
      }
  }
  ```

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/SceneryEngine.js
  ```

  Expected: no output (clean).

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/SceneryEngine.js
  git commit -m "fix: allow auto-placement of bridges even when authored hints exist"
  ```

---

## Task 7: Remove dead `pathTiles` parameter from `getWalkabilityGrid`

**Root cause:** `SceneryEngine.getWalkabilityGrid(pathTiles)` declares a `pathTiles` parameter that is never read inside the function. The caller `IsometricRenderer.js:247` passes `this.pathTiles` unnecessarily. This is dead code that misleads readers into thinking `pathTiles` affects the walkability grid.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js:446`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:247`

- [ ] **Step 1: Update the method signature in SceneryEngine.js**

  Change line 446 from:
  ```js
  getWalkabilityGrid(pathTiles) {
  ```
  to:
  ```js
  getWalkabilityGrid() {
  ```

- [ ] **Step 2: Update the call site in IsometricRenderer.js**

  Change line 247 from:
  ```js
  this.walkabilityGrid = this.scenery.getWalkabilityGrid(this.pathTiles);
  ```
  to:
  ```js
  this.walkabilityGrid = this.scenery.getWalkabilityGrid();
  ```

- [ ] **Step 3: Syntax check both files**

  ```bash
  node --check claudeville/src/presentation/character-mode/SceneryEngine.js
  node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
  ```

  Expected: no output from either.

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/SceneryEngine.js \
          claudeville/src/presentation/character-mode/IsometricRenderer.js
  git commit -m "refactor: remove unused pathTiles parameter from getWalkabilityGrid"
  ```

---

## Final Integration Smoke Test (all tasks)

- [ ] **Step 1: Full syntax pass over all modified and new files**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  node --check claudeville/src/presentation/character-mode/SceneryEngine.js
  node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
  node --check claudeville/src/presentation/character-mode/DebugOverlay.js
  ```

  All expected to produce no output.

- [ ] **Step 2: Server startup**

  ```bash
  npm run dev
  ```

  Expected: server starts on port 4000 with no errors.

- [ ] **Step 3: API sanity**

  ```bash
  curl -s http://localhost:4000/api/sessions | head -c 200
  ```

  Expected: JSON array (possibly empty `[]` if no active agent sessions).

- [ ] **Step 4: Visual validation**

  Open `http://localhost:4000`. Confirm:
  - The world renders without JS errors in the browser console.
  - Agents spawn on land, not frozen over water.
  - Agents navigate around the central moat, crossing only at the two authored bridge tiles (near `x=14,y=25` and `x=22,y=25`) or harbor docks.
  - When two agents enter chat state (yellow CHAT bubble), the approaching agent walks around, not through, the river.
  - No `[Pathfinder] stuck` or `[Pathfinder] no path` warnings appear in the browser console during normal play (they should be rare; their presence indicates a map/spawn edge case worth investigating).

  **Task 3 verification:** To explicitly verify the spawn nudge, temporarily change `Agent.js` line 127 to `new Position(22, 23)` (a moat tile), confirm the agent spawns on land and walks normally with no `[Pathfinder] stuck` warning, then revert the change.
  - Agents take noticeably more diagonal paths across open ground (Task 8).
  - Press `Shift+D` — debug overlay appears with correct walkability tint and cyan waypoint lines (Task 13).
  - Agents at the same building entrance spread apart rather than overlapping (Task 14).
  - Open the browser console and confirm no `[Pathfinder] stuck` or `[Pathfinder] no path` warnings during normal operation.

---

## Deferred / Out-of-Scope Items

These issues were identified during the exploration but are deliberately excluded from this plan. They should be addressed in follow-up work:

- **`bridgeTiles` is a `Map` while `waterTiles`/`pathTiles` are `Set`s** — `Minimap.js` already special-cases this mismatch. A separate cleanup task should normalize all grid-layer collections to `Map<string, metadata>` or add a `WorldGrid` abstraction.
- **String `"x,y"` keys throughout `SceneryEngine.js`** — all render/draw callers loop over string-keyed sets. Switching to integer-indexed `Uint8Array` layers would eliminate per-iteration string parsing. Low-priority perf cleanup.
- **`_simplify` does not force waypoints at bridge entry/exit land tiles** — only bridge deck tiles themselves are forced as waypoints. A screen-space interpolation between the last land waypoint and the first bridge waypoint could notionally drift over a water-edge tile if the bridge is entered at an angle. Verify empirically before treating as a bug.
- **Recursive `findPath` for stuck-start can chain beyond depth 1** — if a cardinal neighbor of an unwalkable start is itself unwalkable, the recursion descends again. In theory, a chain of mutually-unwalkable tiles could stack. The spawn nudge (Task 3) reduces the frequency; Task 4's warn makes it visible.
- **`_pickTarget` random ground target** — addressed by Task 11 (pre-built walkable tile sample list).

---

## Task 8: Add 8-connected BFS with diagonal corner-cut guard

**Why:** Current BFS is 4-connected, forcing agents to take L-shaped detours across open ground. Adding 4 diagonal directions produces shorter, more natural paths with a minimal code change. The corner-cut guard (both axis-aligned neighbors must be walkable) prevents diagonal steps from slipping through a thin water or building edge.

**Prerequisite:** Task 5 must already be applied (this task modifies the same BFS neighbor-expansion block).

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js:3` (DIRS constant)
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js` (BFS neighbor loop from Task 5)

- [ ] **Step 1: Expand DIRS to include diagonals**

  Line 3 currently reads:
  ```js
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  ```

  Replace with:
  ```js
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  ```

- [ ] **Step 2: Add corner-cut guard to the BFS neighbor expansion loop**

  Find the BFS neighbor loop inside `findPath` (placed there by Task 5). It currently reads:
  ```js
  for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
      const idx = ny * N + nx;
      if (visited[idx]) continue;
      if (!this.isWalkable(nx, ny)) continue;
      visited[idx] = 1;
      parent[idx] = cur;
      queue.push(idx);
  }
  ```

  Replace with:
  ```js
  for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
      // Corner-cut guard: diagonal step requires both axis-aligned neighbors walkable.
      if (dx !== 0 && dy !== 0 && (!this.isWalkable(cx + dx, cy) || !this.isWalkable(cx, cy + dy))) continue;
      const idx = ny * N + nx;
      if (visited[idx]) continue;
      if (!this.isWalkable(nx, ny)) continue;
      visited[idx] = 1;
      parent[idx] = cur;
      queue.push(idx);
  }
  ```

  Note: `_simplify` already handles diagonal directions correctly — it uses `Math.sign(next.tileX - t.tileX)` and `Math.sign(next.tileY - t.tileY)` to build direction keys, which covers all 8 directions naturally.

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output.

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "feat: add 8-connected BFS with diagonal corner-cut guard for more direct agent paths"
  ```

---

## Task 9: Add waypoint look-ahead smoothing pass

**Why:** After BFS + `_simplify`, agents still walk through intermediate waypoints they could skip. A second pass using the existing `_lineWalkable` check greedily removes collinear or near-collinear waypoints, reducing the total turn count and producing visually smoother trajectories with zero new geometry risk (the line check is already water-safe after Task 2).

**Prerequisite:** Task 8 must be applied (look-ahead operates on 8-connected BFS output). Task 2 must be applied (relies on the fixed `_lineWalkable`).

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js` (add method + update `findPath` return)

- [ ] **Step 1: Add `_lookahead` method to `Pathfinder`**

  Insert this method after `_simplify` (before the closing `}` of the class):

  ```js
  _lookahead(tiles, bridgeTiles) {
      if (tiles.length <= 2) return tiles;
      const out = [tiles[0]];
      let i = 0;
      while (i < tiles.length - 1) {
          // Find the furthest waypoint reachable via a clear straight line from tiles[i].
          let j = tiles.length - 1;
          while (j > i + 1) {
              // Never skip over bridge tiles — they must remain explicit waypoints.
              const hasBridge = tiles.slice(i + 1, j).some(
                  t => bridgeTiles?.has(`${t.tileX},${t.tileY}`)
              );
              if (!hasBridge && this._lineWalkable(
                  tiles[i].tileX, tiles[i].tileY,
                  tiles[j].tileX, tiles[j].tileY,
              )) break;
              j--;
          }
          out.push(tiles[j]);
          i = j;
      }
      return out;
  }
  ```

- [ ] **Step 2: Update `findPath` to call `_lookahead` after `_simplify`**

  In `findPath`, the reconstruction currently ends with:
  ```js
  tiles.reverse();
  return this._simplify(tiles, bridgeTiles);
  ```

  Replace with:
  ```js
  tiles.reverse();
  return this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
  ```

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output.

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "feat: add waypoint look-ahead pass to reduce redundant turns in agent paths"
  ```

---

## Task 10: Throttle chat-partner repathing to tile-boundary changes only

**Why:** After Task 1, Block B in `update()` calls `_assignTarget` every frame while approaching a chat partner. `_assignTarget`'s cache guard short-circuits when the tile key is unchanged, but the guard itself still runs on every frame. Adding an explicit frame-age counter makes the intent explicit, bounds repathing cadence, and prevents a failed-path tileKey from permanently blocking retries.

**Prerequisite:** Task 1 must be applied (adds the Block B `_assignTarget` call this throttle governs).

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js` (constructor + `_assignTarget`)

- [ ] **Step 1: Add `_pathAgeFrames` to the constructor**

  In the constructor, after `this._lastPathTileKey = null;` (line 81), add:
  ```js
  this._pathAgeFrames = 0;
  ```

- [ ] **Step 2: Update the cache guard in `_assignTarget`**

  The current guard at lines 168–170 reads:
  ```js
  if (tileKey === this._lastPathTileKey && this.waypoints.length > 0) {
      return;
  }
  this._lastPathTileKey = tileKey;
  ```

  Replace with:
  ```js
  if (tileKey === this._lastPathTileKey && this.waypoints.length > 0 && this._pathAgeFrames < 30) {
      this._pathAgeFrames++;
      return;
  }
  this._pathAgeFrames = 0;
  this._lastPathTileKey = tileKey;
  ```

  This allows a stale path to be re-evaluated after 30 frames (~500 ms at 60 fps) even if the target tile hasn't changed, preventing silent freeze from a previously cached failed path.

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  ```

  Expected: no output.

- [ ] **Step 4: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/AgentSprite.js
  git commit -m "feat: throttle agent repathing to tile-boundary crossings with 30-frame stale limit"
  ```

---

## Task 11: Pre-built walkable tile list for guaranteed-walkable random targets

**Why:** `_pickTarget` currently samples random ground targets from `[10..30, 10..30]` tile-space without consulting the walkability grid. When the target lands on water, `_walkableCandidates` silently shifts the destination by up to 5 tiles. A pre-built `walkableTiles[]` built once at grid construction eliminates this mismatch entirely.

**Prerequisite:** None for the Pathfinder side. Task 10 must be applied before touching AgentSprite (same file).

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js` (constructor, `setGrid`, new method)
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js:127-135` (`_pickTarget` random branch)

- [ ] **Step 1: Add `walkableTiles` build to `Pathfinder` constructor**

  The current constructor is:
  ```js
  constructor(grid) {
      this.grid = grid; // Uint8Array, 1 = walkable
  }
  ```

  Replace with:
  ```js
  constructor(grid) {
      this.grid = grid;
      this.walkableTiles = this._buildWalkableList(grid);
  }
  ```

- [ ] **Step 2: Add `_buildWalkableList` and `sampleWalkable` methods**

  Insert after the constructor:

  ```js
  _buildWalkableList(grid) {
      const tiles = [];
      for (let y = 0; y < MAP_SIZE; y++) {
          for (let x = 0; x < MAP_SIZE; x++) {
              if (grid[y * MAP_SIZE + x] === 1) tiles.push({ tileX: x, tileY: y });
          }
      }
      return tiles;
  }

  sampleWalkable(rng) {
      return this.walkableTiles[Math.floor(rng * this.walkableTiles.length)];
  }
  ```

- [ ] **Step 3: Update `setGrid` to rebuild the list**

  The current `setGrid` is:
  ```js
  setGrid(grid) {
      this.grid = grid;
  }
  ```

  Replace with:
  ```js
  setGrid(grid) {
      this.grid = grid;
      this.walkableTiles = this._buildWalkableList(grid);
  }
  ```

- [ ] **Step 4: Update `_pickTarget` in `AgentSprite` to use `sampleWalkable`**

  The current random ground branch (lines 127–135) reads:
  ```js
  const tx = 10 + this._noise(seed, 3) * 20;
  const ty = 10 + this._noise(seed, 7) * 20;
  const target = new Position(tx, ty);
  const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
  this._assignTarget(screen.x, screen.y, target.tileX, target.tileY);
  this.moving = true;
  this.waitTimer = 0;
  return;
  ```

  Replace with:
  ```js
  const tile = this.pathfinder
      ? this.pathfinder.sampleWalkable(this._noise(seed, 3))
      : { tileX: 10 + this._noise(seed, 3) * 20, tileY: 10 + this._noise(seed, 7) * 20 };
  const target = new Position(tile.tileX, tile.tileY);
  const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
  this._assignTarget(screen.x, screen.y, tile.tileX, tile.tileY);
  this.moving = true;
  this.waitTimer = 0;
  return;
  ```

- [ ] **Step 5: Syntax check both files**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  ```

  Expected: no output from either.

- [ ] **Step 6: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js \
          claudeville/src/presentation/character-mode/AgentSprite.js
  git commit -m "feat: pre-build walkable tile list so random targets always land on walkable ground"
  ```

---

## Task 12: Shared per-from/to path cache with FIFO eviction

**Why:** Multiple agents heading to the same building (a common pattern with 9 shared buildings) each independently run BFS from nearby tiles. A 256-entry cache keyed on `from,to` rounded tile coords lets the second agent reuse the first's result instantly.

**Prerequisite:** Tasks 9 and 11 must be applied (Task 12 extends the constructor and `setGrid` already touched by Task 11, and references the `_lookahead` return from Task 9).

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Pathfinder.js` (constructor, `setGrid`, `findPath`, new helpers)

- [ ] **Step 1: Add `_pathCache` to the constructor**

  After `this.walkableTiles = this._buildWalkableList(grid);` in the constructor (placed by Task 11), add:
  ```js
  this._pathCache = new Map();
  ```

- [ ] **Step 2: Clear the cache in `setGrid`**

  After `this.walkableTiles = this._buildWalkableList(grid);` in `setGrid` (placed by Task 11), add:
  ```js
  this._pathCache.clear();
  ```

- [ ] **Step 3: Add `_cacheResult` helper method**

  Insert after `sampleWalkable`:
  ```js
  _cacheResult(key, value) {
      if (this._pathCache.size >= 256) {
          this._pathCache.delete(this._pathCache.keys().next().value);
      }
      this._pathCache.set(key, value);
  }
  ```

- [ ] **Step 4: Add cache lookup before the fast path**

  In `findPath`, after the `targetCandidates.length === 0` guard and before the fast-path `for` loop, insert:
  ```js
  const cacheKey = `${fx},${fy}|${Math.round(to.tileX)},${Math.round(to.tileY)}`;
  const cached = this._pathCache.get(cacheKey);
  if (cached) return cached;
  ```

- [ ] **Step 5: Cache the fast-path result**

  The fast-path return currently reads:
  ```js
  return [{ tileX: target.tileX, tileY: target.tileY }];
  ```

  Replace with:
  ```js
  const fastResult = [{ tileX: target.tileX, tileY: target.tileY }];
  this._cacheResult(cacheKey, fastResult);
  return fastResult;
  ```

- [ ] **Step 6: Cache the BFS result**

  The final reconstruction return currently reads (after Task 9):
  ```js
  return this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
  ```

  Replace with:
  ```js
  const result = this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
  this._cacheResult(cacheKey, result);
  return result;
  ```

- [ ] **Step 7: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  ```

  Expected: no output.

- [ ] **Step 8: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/Pathfinder.js
  git commit -m "feat: add 256-entry shared path cache with FIFO eviction to Pathfinder"
  ```

---

## Task 13: Toggle-able debug visualization overlay

**Why:** A keyboard-triggered canvas overlay showing the walkability grid, per-agent waypoint paths, and bridge tiles pays for itself the first time a future pathfinding or scenery bug needs debugging. Zero impact on gameplay when off.

**Files:**
- Create: `claudeville/src/presentation/character-mode/DebugOverlay.js`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js` (import + instantiate + wire keypress + call in `_render`)

- [ ] **Step 1: Create `DebugOverlay.js`**

  Create the file at `claudeville/src/presentation/character-mode/DebugOverlay.js` with this content:

  ```js
  import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

  export class DebugOverlay {
      constructor() {
          this.enabled = false;
      }

      toggle() {
          this.enabled = !this.enabled;
      }

      draw(ctx, { walkabilityGrid, bridgeTiles, agentSprites }) {
          if (!this.enabled) return;

          // Walkability tint: green = walkable, red = blocked, yellow = bridge.
          ctx.save();
          for (let y = 0; y < MAP_SIZE; y++) {
              for (let x = 0; x < MAP_SIZE; x++) {
                  const wx = (x - y) * TILE_WIDTH / 2;
                  const wy = (x + y) * TILE_HEIGHT / 2;
                  const walkable = walkabilityGrid[y * MAP_SIZE + x] === 1;
                  const isBridge = bridgeTiles?.has(`${x},${y}`);
                  ctx.globalAlpha = 0.28;
                  ctx.fillStyle = isBridge ? '#f2d36b' : walkable ? '#4caf50' : '#f44336';
                  ctx.fillRect(wx - TILE_WIDTH / 4, wy - TILE_HEIGHT / 4, TILE_WIDTH / 2, TILE_HEIGHT / 2);
              }
          }
          ctx.restore();

          // Per-agent waypoint polylines.
          ctx.save();
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.75;
          for (const sprite of agentSprites.values()) {
              if (!sprite.waypoints?.length) continue;
              ctx.beginPath();
              ctx.moveTo(sprite.x, sprite.y);
              for (const wp of sprite.waypoints) ctx.lineTo(wp.x, wp.y);
              ctx.stroke();
          }
          ctx.restore();
      }
  }
  ```

- [ ] **Step 2: Import `DebugOverlay` in `IsometricRenderer.js`**

  After the last existing import (line 18: `import { LandmarkActivity } from './LandmarkActivity.js';`), add:
  ```js
  import { DebugOverlay } from './DebugOverlay.js';
  ```

- [ ] **Step 3: Instantiate and wire keypress in `IsometricRenderer` constructor**

  In the constructor, after `this._unsubscribers = [];` (the last line before the closing brace of the constructor), add:
  ```js
  this.debugOverlay = new DebugOverlay();
  this._onKeyDown = (e) => { if (e.key === 'd' && e.shiftKey) this.debugOverlay.toggle(); };
  window.addEventListener('keydown', this._onKeyDown);
  ```

- [ ] **Step 4: Call `debugOverlay.draw` at the end of `_render`**

  In `_render`, just before the minimap call (the `this.minimap.draw(...)` call near the end of `_render`), insert:
  ```js
  // Debug overlay (Shift+D to toggle).
  this.debugOverlay?.draw(ctx, {
      walkabilityGrid: this.walkabilityGrid,
      bridgeTiles: this.bridgeTiles,
      agentSprites: this.agentSprites,
  });
  ```

- [ ] **Step 5: Clean up the keypress listener on `hide()`**

  Find the `hide()` method in `IsometricRenderer.js`. After any existing cleanup in it, add:
  ```js
  if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
  ```

- [ ] **Step 6: Syntax check both files**

  ```bash
  node --check claudeville/src/presentation/character-mode/DebugOverlay.js
  node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
  ```

  Expected: no output from either.

- [ ] **Step 7: Manual smoke test**

  Start the server: `npm run dev`  
  Open `http://localhost:4000`.  
  Press `Shift+D`. Confirm:  
  - A green/red tint covers every tile (green = walkable, red = water/building).  
  - Bridge tiles show yellow.  
  - Moving agents show a cyan waypoint polyline in front of them.  
  Press `Shift+D` again. Confirm the overlay disappears.  
  Stop the server.

- [ ] **Step 8: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/DebugOverlay.js \
          claudeville/src/presentation/character-mode/IsometricRenderer.js
  git commit -m "feat: add Shift+D debug overlay showing walkability grid and agent waypoints"
  ```

---

## Task 14: Agent steering separation

**Why:** Agents currently walk through each other at popular building entrances. A lightweight per-frame repulsion pass in the renderer's update loop pushes moving agents apart when their screen distance falls below a threshold, making the world feel meaningfully more alive.

**Prerequisite:** Task 13 must be applied if it modifies the same region of `IsometricRenderer.js`; otherwise independent.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js` (agent update loop in `_update`)

- [ ] **Step 1: Locate the agent update loop in `_update`**

  Find the block in `_update` that reads:
  ```js
  // Update agent sprites
  let shouldResort = false;
  for (const sprite of this.agentSprites.values()) {
      sprite.update(this.particleSystem, dt);
      if (sprite._lastSortedY !== sprite.y) {
          shouldResort = true;
          sprite._lastSortedY = sprite.y;
      }
  }
  if (shouldResort) {
      this._markSpritesDirty();
  }
  ```

- [ ] **Step 2: Add the separation pass after the agent update loop**

  Immediately after `this._markSpritesDirty();` (still before the `const sortedSnapshot` line), insert:

  ```js
  // Steering separation: push moving agents apart when they overlap in screen space.
  const SEP_RADIUS = 28;   // px — slightly wider than sprite half-width (24)
  const SEP_STRENGTH = 0.8; // px per frame — small enough to never push across a tile
  const movingSprites = Array.from(this.agentSprites.values()).filter(s => s.moving && !s.chatting);
  for (let i = 0; i < movingSprites.length; i++) {
      for (let j = i + 1; j < movingSprites.length; j++) {
          const a = movingSprites[i];
          const b = movingSprites[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= SEP_RADIUS || dist === 0) continue;
          const overlap = (SEP_RADIUS - dist) / SEP_RADIUS;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x += nx * overlap * SEP_STRENGTH;
          a.y += ny * overlap * SEP_STRENGTH;
          b.x -= nx * overlap * SEP_STRENGTH;
          b.y -= ny * overlap * SEP_STRENGTH;
      }
  }
  ```

  `SEP_STRENGTH = 0.8` is intentionally sub-pixel relative to one tile width (64 px) so the displacement never exceeds 1 tile even after many frames of maximum overlap, making water-crossing from separation physically impossible on a 2+ tile wide river.

- [ ] **Step 3: Syntax check**

  ```bash
  node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
  ```

  Expected: no output.

- [ ] **Step 4: Manual smoke test**

  Start the server: `npm run dev`  
  Open `http://localhost:4000`.  
  Observe two agents converging on the same building entrance. Confirm they spread apart slightly rather than fully overlapping. Confirm no agent crosses water as a result of the separation force.  
  Stop the server.

- [ ] **Step 5: Commit**

  ```bash
  git add claudeville/src/presentation/character-mode/IsometricRenderer.js
  git commit -m "feat: add steering separation pass to prevent agents overlapping at building entrances"
  ```

---

## Final Integration Smoke Test (all tasks)
