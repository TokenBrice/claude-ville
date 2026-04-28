---
name: verify-server
description: Verify ClaudeVille server starts correctly, REST API responds, and WebSocket connections work. Trigger after changes to server.js or adapters/ files.
---

# Server Verification

Verify the ClaudeVille Node.js server operates correctly with all endpoints and real-time features.

## Prerequisites

- Server may already be running on port 4000 in the operator's environment. Do not stop or replace an existing listener unless ownership is clear and the operator approves process cleanup.
- Node.js available

## Check Items

### 1. Server Startup

Start the server only when port 4000 is free, then verify it binds to port 4000:

```bash
npm run dev
sleep 2
lsof -ti :4000
```

- **PASS**: Server starts, port 4000 in use, startup summary printed
- **FAIL**: Server crashes, port conflict, or startup error

### 2. Provider Detection

Check server log output for active providers:

- **PASS**: At least one provider detected (`~/.claude/`, `~/.codex/`, or `~/.gemini/` exists)
- **WARN**: Only 1 provider detected
- **WARN**: No providers detected on a machine with no supported CLI session data

### 3. REST API - Sessions Endpoint

```bash
curl -s http://localhost:4000/api/sessions
```

- **PASS**: Returns JSON with `{ sessions: [...], count: N, timestamp: N }`
- **FAIL**: Non-200 status, invalid JSON, or missing fields

### 4. REST API - Teams Endpoint

```bash
curl -s http://localhost:4000/api/teams
```

- **PASS**: Returns JSON with `{ teams: [...], count: N }`
- **FAIL**: Non-200 status or invalid JSON

### 5. REST API - Providers Endpoint

```bash
curl -s http://localhost:4000/api/providers
```

- **PASS**: Returns JSON with `{ providers: [...], count: N }`
- **FAIL**: Non-200 status or invalid JSON

### 6. Static File Serving

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/widget.html
```

- **PASS**: index.html returns 200, widget.html returns 200
- **WARN**: widget.html returns 404 (widget route not added to server)
- **FAIL**: index.html returns non-200

### 7. CORS Headers

```bash
curl -s -I http://localhost:4000/api/sessions
```

- **PASS**: `Access-Control-Allow-Origin: *` header present
- **FAIL**: Missing CORS headers

## Cleanup

If you started the server in a dedicated terminal, stop only that process with Ctrl-C in that terminal. Do not kill arbitrary port-4000 listeners in a shared checkout.
