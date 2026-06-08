# Pi Agent Web Server Runbook

Use this when restarting or verifying the Pi Agent Web UI.

## Production Runtime

The production server is a TypeScript file and must be run through `tsx`.

```bash
cd /Users/ryantaylorvegh/pi-agent-web
npm run build
npm start
```

`npm start` runs:

```bash
node --import tsx server/index.ts
```

Do not use `node server/index.ts`; that bypasses the TypeScript loader and can fail after a restart.

## Current Live Service

The long-running local server is owned by a macOS LaunchAgent:

```bash
~/Library/LaunchAgents/com.ryantaylorvegh.pi-agent-web.plist
```

It runs:

```bash
cd /Users/ryantaylorvegh/pi-agent-web
/opt/homebrew/bin/npm start
```

Avoid starting Pi Agent Web as a loose background process such as:

```bash
npm start > /tmp/pi-agent-web.log 2>&1 &
```

That can leave a working server on port `3001`, but it will not survive restarts and future checks may not find the real owner.

Restart the LaunchAgent with:

```bash
launchctl kickstart -k gui/$(id -u)/com.ryantaylorvegh.pi-agent-web
```

If the LaunchAgent is not loaded:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryantaylorvegh.pi-agent-web.plist
```

Logs live here:

```bash
~/Library/Logs/pi-agent-web/stdout.log
~/Library/Logs/pi-agent-web/stderr.log
```

Only stop a loose server on port `3001` if it is blocking the LaunchAgent from starting.

## Agent-Safe Restart Checklist

Before restarting:

```bash
curl -s http://127.0.0.1:3001/api/runtime
```

Only restart immediately when `safeToRestart` is `true` and `streamingSessions` is empty. `activeProcesses` can be nonzero for dormant chats; the important interruption risk is active streaming.

Then:

1. Run `npm run build` if frontend files changed.
2. Restart the LaunchAgent with `launchctl kickstart -k gui/$(id -u)/com.ryantaylorvegh.pi-agent-web`.
3. Verify the server with the commands below.

## Verification

After any restart, check all of these:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
curl -sI http://127.0.0.1:3001/
curl -s http://127.0.0.1:3001/api/runtime
```

Expected:

- port `3001` has a `node` listener
- `http://127.0.0.1:3001/` returns `HTTP/1.1 200 OK`
- response headers include `Cache-Control: no-store`
- `/api/runtime` returns JSON

## Tailscale Route

The iPhone route depends on the local server being alive on port `3001`:

```text
https://ryans-mac-studio.tailed49b1.ts.net:3443/
```

That route is served by Tailscale HTTPS forwarding to:

```text
http://127.0.0.1:3001
```

## oMLX Server

The local model server is owned by a macOS LaunchAgent:

```bash
~/Library/LaunchAgents/com.ryantaylorvegh.omlx-server.plist
```

It runs the bundled oMLX CLI directly:

```bash
/Applications/oMLX.app/Contents/MacOS/omlx-cli serve \
  --model-dir /Users/ryantaylorvegh/.lmstudio/models \
  --host 127.0.0.1 \
  --port 8000 \
  --api-key this-is-my-api
```

Restart it with:

```bash
launchctl kickstart -k gui/$(id -u)/com.ryantaylorvegh.omlx-server
```

Verify it with:

```bash
curl -s -H 'Authorization: Bearer this-is-my-api' http://127.0.0.1:8000/v1/models
```

Expected models:

- `Qwen3.6-35B-A3B-oQ4-fp16-mtp`
- `Qwen3.6-35B-A3B-8bit`
- `Qwen3.6-27B-8bit`

Logs:

```bash
~/logs/omlx.log
~/logs/omlx.err.log
```

## Safe Restart Check

Before restarting during active use:

```bash
curl -s http://127.0.0.1:3001/api/runtime
```

If `streamingSessions` is non-empty, a restart may interrupt an active Pi response.
