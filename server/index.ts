import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");
const PI_CMD = process.env.PI_CMD || "pi";

// ── Session Storage ─────────────────────────────────────────────────
// Clean map: sessionId → PiSession. No ws tricks, no closures.

interface PiSession {
  id: string;
  proc: ReturnType<typeof spawn>;
  name: string;
  createdAt: number;
}

const sessions = new Map<string, PiSession>();

function generateId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSession(name: string = "New Chat"): PiSession {
  const id = generateId();
  console.log(`[Session] Created: ${id} (${name})`);

  const proc = spawn(PI_CMD, ["--mode", "rpc", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  // Stream Pi output to ALL connected clients
  proc.stdout.on("data", (chunk: Buffer) => {
    broadcastAll(JSON.stringify({ type: "pi_event", raw: chunk.toString("utf8") }));
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    console.error(`[Pi ${id}]`, chunk.toString("utf8").trim());
  });

  proc.on("close", (code) => {
    console.log(`[Session] ${id} closed (code ${code})`);
    sessions.delete(id);
    broadcastAll(JSON.stringify({ type: "session_closed", sessionId: id }));
  });

  const session: PiSession = { id, proc, name, createdAt: Date.now() };
  sessions.set(id, session);
  return session;
}

function broadcastAll(data: string) {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ── Express Server ──────────────────────────────────────────────────

const app = express();
const server = createServer(app);

const clientDist = join(__dirname, "../client/dist");
const publicDir = join(__dirname, "../public");
const buildDir = existsSync(clientDist) ? clientDist : existsSync(publicDir) ? publicDir : null;

if (buildDir) app.use(express.static(buildDir));

app.get("/api/sessions", (_req, res) => {
  res.json(Array.from(sessions.values()));
});

app.get("*", (_req, res) => {
  if (buildDir) res.sendFile(join(buildDir, "index.html"));
  else res.send("Pi Agent Web");
});

// ── WebSocket Server ────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  // Send existing sessions
  ws.send(JSON.stringify({
    type: "session_list",
    sessions: Array.from(sessions.values()),
  }));

  // Auto-create a session for this client
  const session = createSession("New Chat");
  ws.send(JSON.stringify({ type: "connected", sessionId: session.id }));

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const cmdType = msg.type as string;
      const sessionId = msg.sessionId as string;

      console.log("[WS]", cmdType, sessionId ? `for ${sessionId}` : "");

      switch (cmdType) {
        case "prompt": {
          const target = sessions.get(sessionId);
          if (!target) {
            ws.send(JSON.stringify({ type: "error", data: `Session ${sessionId} not found` }));
            break;
          }
          target.proc.stdin.write(JSON.stringify({
            type: "prompt",
            message: msg.message,
            streamingBehavior: msg.streamingBehavior,
          }) + "\n");
          break;
        }

        case "abort": {
          const target = sessions.get(sessionId);
          if (target) target.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
          break;
        }

        case "new_session": {
          const newSession = createSession(msg.name || "New Chat");
          ws.send(JSON.stringify({ type: "session_created", sessionId: newSession.id }));
          break;
        }

        case "switch_session": {
          const target = sessions.get(msg.targetSessionId as string);
          if (target) {
            ws.send(JSON.stringify({ type: "session_switched", sessionId: target.id, messages: [] }));
          } else {
            ws.send(JSON.stringify({ type: "error", data: "Session not found" }));
          }
          break;
        }

        case "delete_session": {
          const toDelete = sessions.get(msg.sessionId as string);
          if (toDelete) {
            toDelete.proc.kill();
            sessions.delete(toDelete.id);
            ws.send(JSON.stringify({ type: "session_deleted", sessionId: toDelete.id }));
          }
          break;
        }

        case "get_state":
        case "get_messages":
        case "get_session_stats":
        case "compact": {
          const target = sessions.get(sessionId);
          if (target) target.proc.stdin.write(JSON.stringify(msg) + "\n");
          break;
        }

        default:
          console.log("[WS] Forwarding:", cmdType);
          const target = sessions.get(sessionId);
          if (target) target.proc.stdin.write(JSON.stringify(msg) + "\n");
      }
    } catch (err) {
      console.error("[WS] Parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });
});

// ── Start ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] π Agent Web → http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  sessions.forEach((s) => s.proc.kill());
  wss.close();
  server.close(() => process.exit(0));
});
