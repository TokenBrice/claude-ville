# Provider, Model, And Agent Addition Runbook

Use this runbook when adding a new CLI provider, a new model for an existing provider, or a new visual identity/sprite variant. Keep the app desktop-only and zero-build.

## Common Contract

Every adapter-backed session should normalize unsupported features to `null`, `[]`, or `{}` instead of omitting fields where possible.

Required session-list fields:

| Field | Default when unsupported | Notes |
| --- | --- | --- |
| `provider` | required | Stable id consumed by registry, UI, and visual identity. |
| `sessionId` | required | Unique across providers; prefix if provider ids can collide. |
| `project` | `null` | Absolute path when available. |
| `model` | `'unknown'` or provider fallback | Free-form provider model string. |
| `status` | `'active'` | Client may infer idle/ended states later. |
| `lastActivity` | file mtime or `Date.now()` fallback | Millisecond epoch; sort key. |
| `lastTool` | `null` | Most recent tool name. |
| `lastMessage` | `null` | Short assistant/user-facing summary. |
| `tokenUsage` | `null` | Use normalized aliases documented in `claudeville/adapters/README.md`. |
| `gitEvents` | `[]` | Commit/push events only; omit dry-runs. |

Detail payloads should return `{ sessionId, toolHistory, messages, tokenUsage }` with empty arrays or `null` for unsupported sections.

## Track A: New Provider

1. Add `claudeville/adapters/<provider>.js` implementing the adapter contract from `claudeville/adapters/README.md`.
2. Register it in `claudeville/adapters/index.js` and confirm `/api/providers` reports the provider only when its local source directory exists.
3. Normalize session fields at the adapter boundary. Provider-specific record shapes should not leak into UI components.
4. Add watch paths for live updates. Prefer directory watches with filters over one watcher per file.
5. Check `AgentManager` handling for provider id, role, project grouping, status fallback, and parent/child relationships.
6. Add or update `ModelVisualIdentity.js` so labels, colors, sprite ids, palette keys, and effort/accessory rules resolve without provider-specific UI conditionals.
7. Smoke Dashboard cards, Sidebar rows, Activity Panel detail, and World sprites.
8. Update docs: `README.md`, `claudeville/adapters/README.md`, and this runbook when the contract changes.

## Track B: New Model For Existing Provider

This track is being replaced by a canonical model registry (`claudeville/src/config/models.json`); until that lands, follow the list below.

Today, server presentation in `claudeville/adapters/sessionPresentation.js` `modelIdentity` is required for every model addition.

1. Confirm the adapter already passes the model string through unchanged.
2. Update `claudeville/adapters/sessionPresentation.js` `modelIdentity` for server-side presentation.
3. Update `claudeville/src/config/model-pricing.json` and the rate tables in `claudeville/src/domain/value-objects/TokenUsage.js`.
4. Update the model tiers in `claudeville/src/domain/value-objects/AgentMood.js`.
5. Update `claudeville/src/presentation/shared/ModelVisualIdentity.js`, including `contextWindowLimitForModel`, for display identity, sprite/palette behavior, and context limits.
6. Update `scripts/tests/r2-02.pricing.test.mjs` and `scripts/tests/r2-06.model-behaviour.test.mjs` for the new model behavior.
7. If the model needs a new sprite, follow Track C.
8. Smoke Dashboard, Activity Panel, Sidebar, and World mode with a session using the new model string.

## Track C: New Visual Identity Or Sprite Variant

1. Add manifest entries under `claudeville/assets/sprites/manifest.yaml`; keep sprite IDs stable and descriptive.
2. Generate or add PNGs using the manifest-first workflow in `scripts/sprites/generate.md`.
3. Update `ModelVisualIdentity.js` to point the relevant provider/model/effort to the new sprite id and palette.
4. Verify `AvatarCanvas`, World mode sprite composition, Activity Panel, and Dashboard cards all use the shared identity mapping.
5. Run sprite validation when dev dependencies are available.

## Validation Matrix

Backend/provider changes:

```bash
npm run check:adapters
npm run check:services
node --check claudeville/adapters/<provider>.js
node --check claudeville/adapters/index.js
npm run dev
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
curl 'http://localhost:4000/api/session-detail?provider=<provider>&sessionId=<id>&project=<project>'
```

Run `node scripts/smoke/adapters.mjs` when touching Claude adapter discovery or shared adapter fixture assumptions. It currently covers Claude fixture behavior, not every provider. Run `npm run check:git-events` when provider changes affect git command extraction.

Frontend identity changes:

- Open `http://localhost:4000` at a desktop viewport of at least 1280px.
- Test World and Dashboard modes.
- Select and deselect an agent from canvas, Sidebar, and Dashboard when available.
- Confirm the Activity Panel detail fetch works and does not duplicate aggressively.

Sprite changes:

```bash
npm run sprites:audit-refresh
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

Docs-only changes:

```bash
git diff -- docs README.md AGENTS.md CLAUDE.md claudeville/CLAUDE.md
git status --short
```

Run `npm run validate:quick` only when a documentation change also changes a command, generated asset policy, validation matrix, or code-facing contract.
