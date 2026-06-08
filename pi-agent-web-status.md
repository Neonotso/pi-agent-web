# π Agent Web — Status

## What's Built ✅
- React 19 + TypeScript + Vite + Tailwind CSS frontend
- Node.js + Express + WebSocket backend
- Multi-session architecture: one WS connection, multiple Pi processes
- Pi RPC mode integration (`pi --mode rpc`)
- Session CRUD: create, switch, delete, rename
- Real-time streaming responses with markdown rendering
- PWA support (manifest + service worker for iPhone)
- Responsive UI — sidebar for sessions, chat area for messages
- Auto-reconnect with exponential backoff
- Message buffering for pre-session sends
- localStorage persistence (sessions + messages)
- Conversation replay on reconnect (history sent to Pi process)

## Repo
https://github.com/Neonotso/pi-agent-web

## Bugs Fixed ✅
- **Session routing** — `connected` event was broadcast to ALL clients via `broadcastAll`, causing every client to overwrite their `activeSessionId`. Fixed with `sessionOwners` Map, per-client routing, and `sessionId` on all `pi_event` messages.
- **Pi stdout buffering** — Partial JSON lines from Pi stdout were silently failing. Fixed with line buffering.
- **Session cleanup** — Added disconnect cleanup, `sessionOwners` tracking.
- **Sidebar buttons** — Absolute positioning broken in scrollable container. Fixed with inline flexbox layout.
- **Session names overwritten** — `session_list` broadcast overwrote custom names. Fixed by merging with local state.
- **Service worker caching** — SW was caching old JS indefinitely, preventing any code updates. Fixed by disabling SW on localhost entirely.
- **localStorage persistence** — Sessions + messages saved/loaded. Empty initial state no longer overwrites saved data.
- **Server binding** — Changed `listen(PORT)` to `listen(PORT, "0.0.0.0")` for network access.
- **Reconnect persistence** — Browser reconnect now sends `resume_session`; server reattaches to the existing Pi process instead of killing sessions on browser close.
- **HTTPS WebSocket URL** — Client now uses `wss://` when loaded from HTTPS, fixing the Tailscale/iPhone mixed-content WebSocket failure.
- **Build script** — Removed stale `cp dist/*` step because Vite already emits the production bundle into `public/`.
- **Mobile sidebar** — Sidebar now starts hidden on mobile, can be closed by the overlay or close button, and keeps edit/delete actions tappable.
- **Cross-device session names** — Session renames now go through the server and broadcast to all connected browsers.
- **iPhone refresh pain** — Service worker registration is disabled on localhost/Tailscale dev hosts, old registrations and caches are cleared, and `/sw.js` now self-unregisters to evict stale Safari/PWA caches.
- **iPhone safe area layout** — App shell now uses dynamic viewport height, respects the iPhone top/bottom safe areas, and fixes mobile flex sizing so the message pane is not cut off above empty bottom space.
- **iPhone bottom gap + rename** — Removed duplicated bottom safe-area padding, hid the desktop-only local-runtime footer on mobile, and stopped rename input taps from bubbling up to the chat row/sidebar close handler.
- **Cross-device transcripts** — Server sessions now keep shared chat messages and broadcast them, so Mac and iPhone see the same conversation contents inside a session while the server is running.
- **Bottom edge cleanup** — Removed the remaining iPhone bottom safe-area padding so the input area can sit cleanly at the bottom of the screen.
- **Model selector** — Header now includes a model selector for new chats. Default is `Qwen3.6-35B-A3B-8bit`; alternate is `Qwen3.6-27B-8bit`. New sessions launch through oMLX with the selected model.
- **Disk persistence** — Server now saves session metadata and transcripts to `data/sessions.json`, reloads them on startup, and does not erase chats just because a Pi subprocess exits.
- **iPhone viewport fill** — App shell is now fixed to all four screen edges and uses the measured viewport height only as a fallback, to avoid Safari/PWA leaving a blank bottom band below the input bar.
- **Thinking output** — Server now captures assistant `thinking`/reasoning content from Pi events, persists it with the shared transcript, and the chat UI shows it in a collapsible Thinking panel above the answer.
- **Project folders** — Sessions can now be organized into project folders. Projects sync over WebSocket, persist to `data/sessions.json`, and the sidebar supports creating, renaming, deleting, and moving chats between folders.
- **Chat commands** — Slash commands sent in the chat now route through a web command layer. `/help`, `/commands`, `/reload`, `/new`, `/name`, `/model`, `/thinking`, `/state`, `/stats`, `/compact`, `/bash`, `/export`, and `/last` are handled directly or through Pi RPC; unknown slash commands pass through to Pi so extension/prompt/skill commands still work.
- **Sidebar and streaming UX** — Project folders can collapse, chat names get two-line room plus a wider sidebar, unread chats show notification dots/counts, active generation no longer forces scroll-to-bottom when the user scrolls up, and messages typed during generation are sent as Pi steering prompts.
- **Markdown and chronological tools** — Code blocks now render real text with a working Copy button, send/stop buttons are vertically centered, and new tool-call events split assistant output so future transcripts appear closer to the actual thinking/tool/final-answer order.
- **Attachments and speech input** — Composer now has an attachment button and a first-pass microphone button. Uploaded files are saved under `data/uploads/<session-id>/`, their local paths are included in the prompt, and image attachments are also sent through Pi's image input. Speech input uses the browser speech API when available.
- **Safer Pi session persistence** — Backend now assigns each web chat its own Pi session file under `data/pi-sessions/`, starts saved chats lazily instead of launching every Pi process at server boot, seeds a Pi session file from the saved web transcript when needed, and exposes `/api/runtime` so we can check whether it is safe to restart before applying UI updates.

## Current Status

Server is accessible on tailnet at `https://ryans-mac-studio.tailed49b1.ts.net:3443` (via `tailscale serve --bg --https 3443 http://127.0.0.1:3001`). FocusTube on port 443 is restored.

Current local production server target:
- LaunchAgent: `~/Library/LaunchAgents/com.ryantaylorvegh.pi-agent-web.plist`
- command: `cd /Users/ryantaylorvegh/pi-agent-web && /opt/homebrew/bin/npm start`
- `npm start` runs `node --import tsx server/index.ts`
- restart rule: use `launchctl kickstart -k gui/$(id -u)/com.ryantaylorvegh.pi-agent-web`; do not leave it running as a loose background `npm start ... &` process

Verified from the Mac on 2026-05-25:
- `http://127.0.0.1:3001/` returns the production app
- `https://ryans-mac-studio.tailed49b1.ts.net:3443/` returns the production app
- `wss://ryans-mac-studio.tailed49b1.ts.net:3443/ws` accepts WebSocket connections
- `/api/runtime` returns healthy JSON
- `lsof -nP -iTCP:3001 -sTCP:LISTEN` shows a `node` listener launched by `com.ryantaylorvegh.pi-agent-web`

Still needs phone-side confirmation:
- Confirm the mobile sidebar opens/closes cleanly on iPhone.
- Rename a session on iPhone and confirm the name updates on Mac.

## Run
```bash
cd ~/pi-agent-web
npm run build
npm start
```

Production runs on: http://localhost:3001

`npm start` must use `node --import tsx server/index.ts`; do not restart this server with `node server/index.ts` directly.

See `SERVER_RUNBOOK.md` for the current LaunchAgent restart and verification commands.

## Future Work
- Model selector bug: 27B dense option is visible but needs follow-up because Pi/oMLX still appears to use the 35B model.
- Tool call visualization
- Conversation fork/branch
- Settings panel (model, thinking level)
- Hermes agent support
- File attachment support
- Native desktop (Tauri/Electron)
- Mobile access (Tailscale/remote access)
