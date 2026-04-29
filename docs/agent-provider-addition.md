# Provider, Model, And Agent Addition Runbook

Use this runbook when adding a new CLI provider, a new model for an existing provider, or a new visual identity/sprite variant. Keep the app desktop-only and zero-build.

## Common Contract

Every adapter-backed session should normalize unsupported features to `null`, `[]`, or `{}` instead of omitting fields where possible.

Required session-list fields:

| Field | Default when unsupported | Notes |
| --- | --- | --- |
| `provider` | required | Stable id consumed by registry, UI, widgets, and visual identity. |
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
6. Add or update `ModelVisualIdentity.js` so labels, colors, sprite ids, palette keys, minimap colors, and effort/accessory rules resolve without provider-specific UI conditionals.
7. Smoke Dashboard cards, Sidebar rows, Activity Panel detail, World sprites, and minimap.
8. Check widget impact. Browser widget resources, Swift `buildHTML()`, and KDE QML may need provider/model/status/pricing label updates.
9. Update docs: `README.md`, `claudeville/adapters/README.md`, and this runbook when the contract changes.

## Track B: New Model For Existing Provider

1. Confirm the adapter already passes the model string through unchanged.
2. Update `ModelVisualIdentity.js` for display label, color, sprite id, palette key, minimap color, and effort/accessory behavior.
3. If the model changes pricing or status copy, update all affected surfaces: browser UI, Swift widget, static widget resources, KDE widget, and docs.
4. If the model needs a new sprite, follow Track C.
5. Smoke Dashboard, Activity Panel, Sidebar, World mode, and minimap with a session using the new model string.

## Track C: New Visual Identity Or Sprite Variant

1. Add manifest entries under `claudeville/assets/sprites/manifest.yaml`; keep sprite IDs stable and descriptive.
2. Generate or add PNGs using the manifest-first workflow in `scripts/sprites/generate.md`.
3. Update `ModelVisualIdentity.js` to point the relevant provider/model/effort to the new sprite id and palette.
4. Verify `AvatarCanvas`, World mode sprite composition, Activity Panel, Dashboard cards, and minimap all use the shared identity mapping.
5. Run sprite validation when dev dependencies are available.

## Validation Matrix

Backend/provider changes:

```bash
node --check claudeville/adapters/<provider>.js
node --check claudeville/adapters/index.js
npm run dev
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
curl 'http://localhost:4000/api/session-detail?provider=<provider>&sessionId=<id>&project=<project>'
```

Frontend identity changes:

- Open `http://localhost:4000` at a desktop viewport of at least 1280px.
- Test World and Dashboard modes.
- Select and deselect an agent from canvas, Sidebar, and Dashboard when available.
- Confirm the Activity Panel detail fetch works and does not duplicate aggressively.

Sprite changes:

```bash
npm run sprites:validate
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

Widget changes:

- macOS: `npm run widget:build`, then `npm run widget`.
- KDE: `npm run widget:kde:install` when KDE is available; otherwise diff the QML and shell scripts.

Docs-only changes:

```bash
git status --short
```
