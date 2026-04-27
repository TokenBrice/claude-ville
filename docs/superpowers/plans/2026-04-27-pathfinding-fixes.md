# Pathfinding Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all confirmed and potential cases where agents walk through river/moat water tiles instead of routing via bridges, and streamline the pathfinding code.

**Architecture:** Two confirmed bugs exist — chat-partner movement bypasses the pathfinder entirely (agents beeline through water when approaching a chat partner), and the Bresenham fast-path can corner-cut thin diagonal water fingers. Additionally a spawn-on-water issue can freeze agents, the BFS queue uses O(n²) `Array.shift()`, and a dead parameter pollutes the API. All fixes are surgical edits to three files: `Pathfinder.js`, `AgentSprite.js`, and `SceneryEngine.js`.

**Tech Stack:** Vanilla ES2022 modules, no transpiler, no test runner. Validation is `node --check` + manual browser observation at `http://localhost:4000`. Server starts with `npm run dev`.

---

## File Map

| File | Role | What changes |
|---|---|---|
| `claudeville/src/presentation/character-mode/AgentSprite.js` | Per-agent movement and rendering | Tasks 1, 3 |
| `claudeville/src/presentation/character-mode/Pathfinder.js` | BFS pathfinding algorithm | Tasks 2, 4, 5 |
| `claudeville/src/presentation/character-mode/SceneryEngine.js` | Walkability grid + bridge placement | Tasks 6, 7 |
| `claudeville/src/presentation/character-mode/IsometricRenderer.js` | Wires walkability grid to pathfinder | Task 7 (call-site only) |

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

## Final Integration Smoke Test

- [ ] **Step 1: Full syntax pass over all modified files**

  ```bash
  node --check claudeville/src/presentation/character-mode/Pathfinder.js
  node --check claudeville/src/presentation/character-mode/AgentSprite.js
  node --check claudeville/src/presentation/character-mode/SceneryEngine.js
  node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
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

---

## Deferred / Out-of-Scope Items

These issues were identified during the exploration but are deliberately excluded from this plan. They should be addressed in follow-up work:

- **`bridgeTiles` is a `Map` while `waterTiles`/`pathTiles` are `Set`s** — `Minimap.js` already special-cases this mismatch. A separate cleanup task should normalize all grid-layer collections to `Map<string, metadata>` or add a `WorldGrid` abstraction.
- **String `"x,y"` keys throughout `SceneryEngine.js`** — all render/draw callers loop over string-keyed sets. Switching to integer-indexed `Uint8Array` layers would eliminate per-iteration string parsing. Low-priority perf cleanup.
- **`_simplify` does not force waypoints at bridge entry/exit land tiles** — only bridge deck tiles themselves are forced as waypoints. A screen-space interpolation between the last land waypoint and the first bridge waypoint could notionally drift over a water-edge tile if the bridge is entered at an angle. Verify empirically before treating as a bug.
- **Recursive `findPath` for stuck-start can chain beyond depth 1** — if a cardinal neighbor of an unwalkable start is itself unwalkable, the recursion descends again. In theory, a chain of mutually-unwalkable tiles could stack. The spawn nudge (Task 3) reduces the frequency; Task 4's warn makes it visible.
- **`_pickTarget` random ground target does not consult the walkability grid** — random `(10..30, 10..30)` tile-space targets can land on water; `_walkableCandidates` in the pathfinder recovers (5-tile radius search), but adds unnecessary BFS overhead. Fix: sample from a pre-built list of walkable tiles at startup.
