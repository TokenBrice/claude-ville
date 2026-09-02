---
name: verify-server
description: Verify ClaudeVille server startup, REST payloads, WebSocket snapshots and deltas, and local-request security. Trigger after changes to server.js, adapters, services, or server-facing contracts.
---

# Server Verification

Use the repository's isolated smoke scripts. They create temporary provider data and bind their own server to an ephemeral loopback port.

Never start, stop, or probe port 4000. The operator's maintained server there is read-only for judgment checks through the browser.

## 1. Boot Contract

```bash
node scripts/smoke/boot-contract.mjs
```

This asserts that an isolated server starts and cleans up correctly; `/` serves HTML; `/api/providers`, `/api/sessions`, and `/api/usage` return the expected synthetic payloads; and a WebSocket upgrade succeeds. It also verifies the WebSocket `init` snapshot, a later full snapshot, a JSON-Patch delta after fixture mutation, and a fresh `init` snapshot after a resync request.

- **PASS**: The script exits 0 and prints `boot contract smoke passed`.
- **WARN**: The script reaches its timeout; inspect its reported startup, request, or WebSocket phase.
- **FAIL**: The script exits non-zero; use the named assertion and endpoint or frame type to locate the regression.

## 2. Server Security

```bash
node scripts/smoke/server-security.mjs
```

This asserts loopback binding and local Host/Origin validation for HTTP APIs and WebSocket upgrades. It checks rejected hostile hosts and origins, allowed origin-less CLI requests, request methods and body limits, authenticated hook ingestion and safe errors, valid WebSocket upgrade behavior, and rejection of invalid WebSocket requests and frames. The server intentionally sends no `Access-Control-Allow-Origin` header.

- **PASS**: The script exits 0 and prints `server security smoke passed`.
- **WARN**: A failure follows an intentional server contract change; update the implementation contract and smoke together before accepting it.
- **FAIL**: The script exits non-zero; treat the named status, header, hook, or WebSocket assertion as a security regression.
