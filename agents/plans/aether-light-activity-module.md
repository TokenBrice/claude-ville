# Razer Aether Activity Light Module

Date: 2026-05-17
Status: ready
Baseline HEAD: `94a037a1bdd234dcae93370c7d6c4f38555b4d4b`
Initial `git status --short`: clean
Final expected `git status --short`: one new optional module plan plus `agents/README.md` index update

## Scope

Owned paths for implementation:

- `scripts/lights/claudeville-lights.mjs`
- `scripts/lights/README.md`
- `scripts/lights/config.example.json`
- `package.json` only if adding a convenience script such as `lights`

Read-only paths:

- `claudeville/server.js`
- `claudeville/src/application/AgentManager.js`
- `claudeville/src/application/SessionWatcher.js`
- `claudeville/src/domain/events/DomainEvent.js`
- `claudeville/src/infrastructure/ClaudeDataSource.js`
- `claudeville/src/presentation/character-mode/AgentEventStream.js`

Source docs:

- Razer Aether product page: `https://www.razer.com/gamer-room-lights/razer-aether-light-strip`
- Razer Aether support FAQ: `https://mysupport.razer.com/app/answers/detail/a_id/5891/~/razer-aether-light-strip-%7C-rz43-0424-support-%26-faqs`
- Razer Aether master guide: `https://dl.razerzone.com/master-guides/RazerSynapse3/AETHERLIGHTSTRIP-00000784-en.pdf`
- Home Assistant Matter integration: `https://www.home-assistant.io/integrations/matter/`
- Home Assistant REST API: `https://developers.home-assistant.io/docs/api/rest/`
- Home Assistant `light.turn_on`: `https://www.home-assistant.io/actions/light.turn_on/`
- OpenRazer: `https://openrazer.github.io/`
- Razer Chroma SDK REST docs, Windows/Synapse fallback only: `https://assets.razerzone.com/dev_portal/REST/html/index.html`

## Goal

Add an optional, non-core Linux-friendly light sidecar that watches ClaudeVille session activity and drives a Razer Aether Light Strip through Home Assistant's Matter-backed `light` entity. The module should run only when explicitly started, require no build step, and leave ClaudeVille's server, browser UI, adapters, and provider session files untouched.

## Non-Goals

- Do not embed hardware control into `claudeville/server.js`.
- Do not add browser UI, settings panels, or dashboard controls in phase 1.
- Do not attempt direct Matter commissioning/control from ClaudeVille in phase 1.
- Do not automate the Razer Gamer Room mobile app.
- Do not rely on Razer Synapse or Chroma SDK for the EndeavourOS/Linux path.
- Do not add mandatory dependencies, install steps, bundlers, daemons, or system services.

## Findings By Priority

Critical:

- The Linux path should be Home Assistant, not Razer Synapse. Razer's Aether guide lists Synapse requirements as Windows 10 64-bit or higher, while the strip also supports Matter. Home Assistant can control Matter devices locally once paired, and its REST API can call `light.turn_on`.
- Matter control has a feature ceiling. Razer's support FAQ says third-party Matter apps work but cannot set Chroma effects. The sidecar should assume common light attributes only: power, brightness, RGB/HS/XY color, transition, and maybe `flash` if the Home Assistant entity exposes it.

High:

- OpenRazer is not the right first integration for this strip. OpenRazer targets Linux-supported Razer peripherals and exposes firmware/device RGB features, but the Aether Light Strip is a Wi-Fi/Matter Gamer Room device and is not listed on the OpenRazer page by `Aether`, `Light Strip`, or `RZ43`.
- Home Assistant Matter has network requirements that affect EndeavourOS users. Home Assistant's Matter docs recommend Home Assistant OS with the Matter Server app as the supported path and call out IPv6 multicast availability on the network. If Home Assistant runs in containers or VMs, host networking and multicast must be verified.
- ClaudeVille already has a stable observation surface. `/api/sessions` returns active sessions; current app code consumes that through `ClaudeDataSource.getSessions()`, and the server also broadcasts session updates over WebSocket. A polling sidecar can avoid adding a Node WebSocket dependency.

Medium:

- Git events already exist on session objects as `gitEvents`, including commits and pushes from provider adapters. The sidecar should dedupe by event identity so the strip does not flash repeatedly for the same push.
- Session completion is not a universal explicit server event. Browser world mode infers subagent completion through `AgentEventStream` when an agent is removed. The sidecar should implement its own diff: session present in previous snapshot, absent in current snapshot, and previously active within a short TTL.
- Node 18 has stable `fetch`, so the first version can use HTTP polling and Home Assistant REST without dependencies. Avoid Node's `WebSocket` global unless the project baseline moves to a version where that is guaranteed.

Low:

- Razer Chroma SDK is still useful as a future backend for Windows users. Its local REST server initializes at `http://localhost:54235/razer/chromasdk`, but it depends on Synapse/Chroma SDK availability and is not the EndeavourOS default.

## Proposed Module

Command:

```bash
node scripts/lights/claudeville-lights.mjs --config scripts/lights/config.json
```

Optional package shortcut:

```json
"lights": "node scripts/lights/claudeville-lights.mjs --config scripts/lights/config.json"
```

Environment variables should override config file values:

- `CLAUDEVILLE_URL`, default `http://localhost:4000`
- `CLAUDEVILLE_LIGHTS_BACKEND`, default `homeassistant`
- `HA_URL`, example `http://homeassistant.local:8123`
- `HA_TOKEN`, long-lived Home Assistant access token
- `HA_LIGHT_ENTITY`, example `light.razer_aether_light_strip`
- `CLAUDEVILLE_LIGHTS_INTERVAL_MS`, default `1500`
- `CLAUDEVILLE_LIGHTS_DRY_RUN`, default `0`

Config example:

```json
{
  "claudevilleUrl": "http://localhost:4000",
  "backend": "homeassistant",
  "pollIntervalMs": 1500,
  "quietHours": null,
  "homeAssistant": {
    "url": "http://homeassistant.local:8123",
    "lightEntity": "light.razer_aether_light_strip"
  },
  "effects": {
    "idle": { "rgb": [28, 38, 64], "brightnessPct": 12, "transition": 1.2 },
    "active": { "rgb": [48, 184, 255], "brightnessPct": 24, "transition": 0.7 },
    "tool": { "rgb": [255, 181, 74], "brightnessPct": 45, "durationMs": 700 },
    "commit": { "rgb": [177, 106, 255], "brightnessPct": 55, "durationMs": 1000 },
    "push": { "rgb": [82, 255, 148], "brightnessPct": 80, "durationMs": 1400 },
    "complete": { "rgb": [255, 255, 255], "brightnessPct": 70, "durationMs": 900 },
    "failure": { "rgb": [255, 65, 73], "brightnessPct": 85, "durationMs": 1200 }
  }
}
```

## Event Model

The sidecar should poll `GET {CLAUDEVILLE_URL}/api/sessions` and normalize each session to:

- `id`: `session.sessionId`
- `provider`
- `status`
- `lastActivity`
- `lastTool`
- `lastToolInput`
- `gitEvents[]`
- `project`
- `agentType`
- `parentId`

Derived signals:

- `activityLevel`: active session count, working count, freshest `lastActivity`.
- `toolStarted`: same session id but `lastTool` or normalized `lastToolInput` changed.
- `agentAppeared`: session id newly present.
- `agentCompleted`: session id disappeared after recent activity; suppress if older than 2 minutes.
- `gitCommit`: new `gitEvents` item with type `commit`.
- `gitPush`: new `gitEvents` item with type `push`.
- `failure`: git event with `success === false` or `status === "failed"`; later versions can infer command failures from richer detail endpoints.

Priority order for effects:

1. `failure`
2. `push`
3. `complete`
4. `commit`
5. `toolStarted`
6. `agentAppeared`
7. ambient `active` or `idle`

The sidecar should keep a short event queue and apply one foreground effect at a time. After a foreground effect finishes, it should restore the ambient state computed from current sessions.

## Home Assistant Backend

Preflight checks:

1. `GET {HA_URL}/api/` with `Authorization: Bearer {HA_TOKEN}` returns `{"message":"API running."}`.
2. `GET {HA_URL}/api/states/{HA_LIGHT_ENTITY}` returns an entity with domain `light`.
3. A dry-run command can print the exact `POST /api/services/light/turn_on` payload without sending it.
4. A real probe sets a low-brightness color and then restores prior state if available.

REST calls:

```http
POST /api/services/light/turn_on
Authorization: Bearer <token>
Content-Type: application/json

{
  "entity_id": "light.razer_aether_light_strip",
  "rgb_color": [82, 255, 148],
  "brightness_pct": 80,
  "transition": 0.2
}
```

Implementation notes:

- Use `fetch` with an `AbortController` timeout.
- Keep `HA_TOKEN` out of committed config; document env var usage.
- Treat unsupported fields as recoverable. Home Assistant commonly ignores unsupported light attributes, but log the response if it returns non-2xx.
- Rate limit steady ambient updates. Send ambient updates only when the ambient bucket changes or at a slow keepalive interval, not every poll.
- Use `dryRun` to validate ClaudeVille event derivation without touching the light.

## Razer Chroma Backend

Keep this as a later backend, not phase 1 for EndeavourOS.

Requirements:

- Windows 10/11 machine on the same workflow, with Razer Synapse/Chroma SDK installed.
- Aether strip set up in Synapse with Synapse Override if Chroma-driven behavior is desired.
- Chroma Apps enabled in Synapse.

Backend shape:

- Initialize app via `POST http://localhost:54235/razer/chromasdk`.
- Keep alive via heartbeat within the SDK timeout.
- Use `/chromalink` static/custom effects.

Reason to defer:

- The user is on EndeavourOS.
- Chroma SDK depends on Synapse/Chroma availability.
- Matter via Home Assistant gives a cleaner local Linux bridge.

## Plan

1. Add `scripts/lights/README.md` documenting EndeavourOS/Home Assistant setup: pair the Aether strip to Razer Gamer Room first if needed, share/add it to Home Assistant via Matter, confirm entity id, create a long-lived token, and run dry mode.
2. Add `scripts/lights/config.example.json` with safe low-brightness defaults and no secrets.
3. Implement `scripts/lights/claudeville-lights.mjs` as a dependency-free Node 18 script using HTTP polling.
4. Split logic into small local functions in the script: config loading, Home Assistant client, session normalization, snapshot diffing, event queue, effect scheduler, and ambient restoration.
5. Add `--dry-run`, `--probe`, `--once`, `--verbose`, and `--config` flags.
6. Add a convenience `npm run lights` only if that matches the desired repo ergonomics; otherwise keep the command documented only.
7. Validate syntax with `node --check scripts/lights/claudeville-lights.mjs`.
8. Validate dry run against ClaudeVille with `node scripts/lights/claudeville-lights.mjs --dry-run --once`.
9. Validate Home Assistant probe only when the user provides/exports `HA_URL`, `HA_TOKEN`, and `HA_LIGHT_ENTITY`.

## Execution Readiness

Safe to execute: partial

Required preflight:

- Re-run `git status --short`.
- Re-check owned paths for unrelated edits.
- Confirm Home Assistant is installed and reachable from the EndeavourOS host.
- Confirm the Aether strip appears in Home Assistant as a `light.*` entity.
- Confirm the strip supports RGB or HS color through that entity; if Matter exposes only brightness/on-off, reduce effects to brightness pulses.
- Confirm user consent before any real light probe above low brightness.

## Validation

Validation required:

- `node --check scripts/lights/claudeville-lights.mjs`
- `node scripts/lights/claudeville-lights.mjs --dry-run --once`
- With ClaudeVille running: `curl http://localhost:4000/api/sessions`
- With Home Assistant configured: `curl -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" "$HA_URL/api/"`
- With Home Assistant configured and user approval: `node scripts/lights/claudeville-lights.mjs --probe`

Validation run:

- Not run; planning artifact only.

## Residual Risks

- Matter may expose fewer capabilities than Razer's native Chroma mode. This is expected; the phase 1 plan intentionally favors reliable Linux control over full Chroma effects.
- Home Assistant Matter setup quality depends on network multicast/IPv6 behavior. EndeavourOS firewall, router isolation, VM networking, or container networking can block commissioning or local control.
- ClaudeVille's active-session window is currently short by design. A disappeared session may mean "aged out" rather than "completed"; the sidecar must apply TTL and dedupe rules to avoid noisy completion flashes.
- Bright flashing can be distracting. Defaults should be dim, brief, and configurable.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`.
