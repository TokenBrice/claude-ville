# scripts/smoke/

Deterministic smoke checks against fixture data. The project has no test
runner by design; these scripts provide minimum confidence for two critical
paths and are intended to be run by hand before risky merges.

They are **not** a replacement for a test runner.

## What they cover

- `adapters.mjs` — Builds a synthetic `~/.claude` tree under `os.tmpdir()`,
  overrides `process.env.HOME` so the Claude adapter resolves against it,
  and asserts that `getActiveSessions(threshold)` returns the expected main
  session, links subagents to their parent via `parentSessionId`, and
  resolves a team-member session's `teamName` from
  `teams/<team>/inboxes/<agentName>.json`.
- `relationship.mjs` — Dispatches `agent:added` events for a stub world of
  five agents (1 parent, 3 subagents, 1 team-member), then asserts that
  `RelationshipState.update()` produces the expected `parentToChildren`,
  `childToParent`, and `teamToMembers` maps. Also verifies the Phase 0
  membership cache: when `_membershipDirty === false`, two successive
  non-dirty `update()` calls must reuse the same `teamToMembers` Map and
  inner Array references, while a membership-dirtying event triggers a
  rebuild.

## How to run

```
node scripts/smoke/adapters.mjs
node scripts/smoke/relationship.mjs
```

Both scripts exit 0 on success and 1 on any assertion failure, and clean
up their temp fixtures in a `finally` block.

`relationship.mjs` may print a one-time `MODULE_TYPELESS_PACKAGE_JSON`
warning from Node — `claudeville/src/**` files use ES module syntax but
the repo's `package.json` has no `"type": "module"` (deliberate, to keep
the static frontend separate from the CJS Node server). The warning is
benign; suppress with `NODE_NO_WARNINGS=1 node …` if needed.

## When to run

- After editing `claudeville/adapters/claude.js`.
- After editing `claudeville/src/presentation/character-mode/RelationshipState.js`.
- Before opening a PR that touches adapter discovery or relationship state.
