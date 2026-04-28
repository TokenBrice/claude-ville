# Legacy Building Renderer Archive Decision

Date: 2026-04-28

`claudeville/src/presentation/character-mode/BuildingRenderer.legacy.js` was a non-imported rollback/reference renderer replaced by `BuildingSprite`, `AssetManager`, and `SpriteRenderer`.

Repository scan before removal:

- Runtime imports: none.
- Remaining references: prose-only references in renderer/docs files and agent plans.
- File header stated it was kept for one release cycle after the sprite renderer shipped and should not be imported.

Decision:

- Remove the legacy source file in the follow-up remediation branch.
- Keep this archive note as the retained context instead of preserving 3,274 lines of dead rendering code in the runtime tree.
- Current building behavior remains owned by `BuildingSprite.js`; future building renderer work should not target the removed legacy implementation.
