# π Agent Web

A beautiful, app-like web interface for the [π coding agent](https://github.com/badlogic/pi-mono) with multi-session sidebar support and PWA (Progressive Web App) capabilities.

## Features

- 🎨 **Beautiful dark UI** — Designed for comfortable extended use
- 📱 **iPhone PWA** — Add to Home Screen for a native-app experience
- 💻 **Mac compatible** — Works in any modern browser
- 📑 **Multi-session sidebar** — Switch between project chats seamlessly
- ⚡ **Quick chat** — Start a fresh conversation instantly
- 🔌 **Real-time streaming** — Watch Pi's responses stream in
- 🛠️ **Tool visibility** — See when Pi is running commands
- 🗣️ **Markdown rendering** — Formatted code blocks, lists, tables

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser (iPhone / Mac)                      │
│                                              │
│  ┌──────────┐    WebSocket    ┌────────────┐ │
│  │ React UI │ ◄────────────► │ Node.js    │ │
│  │ (PWA)    │   JSON         │ Server     │ │
│  └──────────┘                │            │ │
│                              │  π --mode  │ │
│                              │   rpc      │ │
│                              └────────────┘ │
└──────────────────────────────────────────────┘
```

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + WebSocket (ws)
- **Communication**: Pi RPC mode (JSON over stdin/stdout)
- **PWA**: Service worker for offline support & home screen installation

## Quick Start

### Prerequisites

- Node.js 20+
- Pi coding agent installed (`npm install -g @mariozechner/pi-coding-agent`)

### Install & Run

```bash
# Install dependencies
npm install

# Start both server and client
npm run dev
```

This starts:
- **Server** on `http://localhost:3001`
- **Client** (dev) on `http://localhost:5173`

The dev client proxies API/WebSocket calls to the server.

### Build for Production

```bash
npm run build
npm start
```

### Access on iPhone

1. On your Mac, find your local IP: `ifconfig | grep "inet "`
2. On your iPhone, open Safari and go to `http://<your-mac-ip>:3001`
3. Tap the share button → **"Add to Home Screen"**
4. Launch from the home screen — it opens as a standalone app!

## Project Structure

```
pi-agent-web/
├── client/                 # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/     # React components
│   │   │   ├── ChatArea.tsx
│   │   │   ├── Message.tsx
│   │   │   ├── MarkdownRenderer.tsx
│   │   │   └── Sidebar.tsx
│   │   ├── contexts/       # React Context (WebSocket state)
│   │   │   └── PiAgentContext.tsx
│   │   ├── types.ts        # TypeScript types
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css       # Tailwind styles
│   ├── public/             # Static assets
│   │   ├── manifest.json   # PWA manifest
│   │   ├── sw.js           # Service worker
│   │   └── vite.svg        # Icon
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
├── server/                 # Backend
│   └── index.ts            # Express + WebSocket + Pi RPC bridge
├── package.json
└── README.md
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (both client + server) |
| `npm run dev:client` | Start only the dev client |
| `npm run dev:server` | Start only the backend server |
| `npm run build` | Build frontend for production |
| `npm start` | Run production server |

## RPC Protocol

The server bridges WebSocket connections to Pi's RPC protocol. Supported commands:

| Client Command | Pi RPC Command |
|---------------|----------------|
| `{ type: "prompt" }` | Prompt the agent |
| `{ type: "abort" }` | Abort current operation |
| `{ type: "new_session" }` | Create a new session |
| `{ type: "switch_session" }` | Switch to another session |
| `{ type: "delete_session" }` | Delete a session |
| `{ type: "get_state" }` | Get agent state |
| `{ type: "get_messages" }` | Get conversation messages |
| `{ type: "compact" }` | Compact conversation |

Events from Pi are forwarded to connected WebSocket clients as `pi_event` messages.

## Customization

### Port

```bash
PORT=8080 npm start
```

### Pi Command Path

```bash
PI_CMD=/path/to/pi npm start
```

### Custom Theme

Edit `client/src/index.css` and `client/tailwind.config.js` to customize colors, spacing, and typography.

## Future Enhancements

- [ ] Session persistence (save/load sessions)
- [ ] Conversation search/filter
- [ ] Fork/branch conversations
- [ ] Tool call visualization with expandable results
- [ ] Model selection UI
- [ ] Settings panel
- [ ] Hermes agent support (configurable backend)
- [ ] Push notifications for long-running tasks
- [ ] File attachment support
- [ ] Voice input
- [ ] Native desktop app (Tauri/Electron)

## License

MIT
