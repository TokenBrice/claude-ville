# Code Health Artifact Hygiene

Root-level PNG captures are temporary verification artifacts. Keep future captures under this directory or a task-specific subdirectory under `agents/research/` when they are worth preserving.

Policy:

- Relocate tracked root PNGs here when they are useful evidence for a code-health task.
- Remove tracked root PNGs from the index when they are disposable local smoke captures.
- Keep widget build output ignored and out of version control; rebuild it with `npm run widget:build`.
- Do not delete or move tracked binaries/images directly from an agent turn unless the orchestrator has explicitly assigned that cleanup.
