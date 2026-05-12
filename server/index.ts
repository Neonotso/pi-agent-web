import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");
const PI_CMD = process.env.PI_CMD || "pi";

// ── Session Management ──────────────────────────────────────────────

interface PiSession {
  proc: ReturnType<typeof spawn>;
  connectedClients: Set<WebSocket>;
  name: string;
  createdAt: number;
}

// Map of sessionId -> session
const sessions = new Map<string, PiSession>();

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSession(name: string = "New Chat"): PiSession {
  const id = generateSessionId();
  console.log(`[Session] Creating: ${id} (${name})`);

  const proc = spawn(PI_CMD, ["--mode", "rpc", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  // Forward stdout events to all connected clients
  proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const data = { type: "pi_event", raw: line };
      broadcastToSession(id, data);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.error(`[Pi ${id}] ${text}`);
    }
  });

  proc.on("error", (err) => {
    console.error(`[Session ${id}] Error:`, err);
  });

  proc.on("close", (code) => {
    console.log(`[Session ${id}] Closed with code ${code}`);
    broadcastToSession(id, { type: "session_closed" });
    // Auto-restart if any clients are still connected
    if (session.connectedClients.size > 0) {
      console.log(`[Session ${id}] Restarting for remaining clients...`);
      restartSession(id);
    } else {
      sessions.delete(id);
    }
  });

  const session: PiSession = {
    proc,
    connectedClients: new Set(),
    name,
    createdAt: Date.now(),
  };

  sessions.set(id, session);
  return session;
}

function restartSession(id: string) {
  const old = sessions.get(id);
  if (!old) return;
  old.proc.kill();
  const name = old.name;
  sessions.set(id, createSession(name));
}

function broadcastToSession(id: string, data: Record<string, unknown>) {
  const session = sessions.get(id);
  if (!session) return;
  const msg = JSON.stringify(data);
  for (const client of session.connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function sendToSession(id: string, command: Record<string, unknown>) {
  const session = sessions.get(id);
  if (!session) {
    console.error(`[Session] No session: ${id}`);
    return;
  }
  const line = JSON.stringify(command) + "\n";
  session.proc.stdin.write(line, (err) => {
    if (err) console.error(`[Session ${id}] Write error:`, err);
  });
}

// ── Express Server ──────────────────────────────────────────────────

const app = express();
const server = createServer(app);

// Serve static files
const clientDist = join(__dirname, "../client/dist");
const publicDir = join(__dirname, "../public");
const buildDir = existsSync(clientDist) ? clientDist : existsSync(publicDir) ? publicDir : null;

if (buildDir) {
  app.use(express.static(buildDir));
}

// API routes
app.get("/api/sessions", (_req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    name: s.name,
    createdAt: s.createdAt,
  }));
  res.json(list);
});

app.post("/api/sessions", (req, res) => {
  const name = (req.body?.name as string) || "New Chat";
  const session = createSession(name);
  res.json({ sessionId: session.id, name: session.name });
});

app.delete("/api/sessions/:id", (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Not found" });

  session.proc.kill();
  sessions.delete(id);
  // Notify connected clients
  broadcastToSession(id, { type: "session_deleted", sessionId: id });
  res.json({ success: true });
});

// SPA fallback
app.get("*", (_req, res) => {
  if (buildDir) {
    res.sendFile(join(buildDir, "index.html"));
  } else {
    res.send("Pi Agent Web - No build found. Run 'npm run build' first.");
  }
});

// ── WebSocket Server ────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  // Create or join a session
  let sessionId: string | null = null;
  const session = createSession();
  sessionId = session.id;
  session.connectedClients.add(ws);

  // Send session info
  ws.send(
    JSON.stringify({
      type: "connected",
      sessionId,
      sessionCount: sessions.size,
    })
  );

  // Handle incoming messages
  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleClientMessage(ws, sessionId!, msg);
    } catch (err) {
      console.error("[WS] Parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
    session.connectedClients.delete(ws);
    // If no more clients, kill the session
    if (session.connectedClients.size === 0) {
      session.proc.kill();
      sessions.delete(sessionId!);
    }
  });

  ws.on("error", (err) => {
    console.error("[WS] Client error:", err);
  });
});

function handleClientMessage(ws: WebSocket, sessionId: string, msg: Record<string, unknown>) {
  const type = msg.type as string;

  switch (type) {
    case "prompt":
      sendToSession(sessionId, {
        type: "prompt",
        message: msg.message as string,
        streamingBehavior: (msg.streamingBehavior as "steer" | "followUp") || undefined,
      });
      break;

    case "abort":
      sendToSession(sessionId, { type: "abort" });
      break;

    case "new_session": {
      // Close current, start new
      const oldSession = sessions.get(sessionId);
      if (oldSession) {
        oldSession.proc.kill();
        sessions.delete(sessionId);
      }
      const newSession = createSession("New Chat");
      sessionId = newSession.id;
      ws.send(
        JSON.stringify({
          type: "session_created",
          sessionId: newSession.id,
          oldSessionId: sessionId,
        })
      );
      break;
    }

    case "get_state":
      sendToSession(sessionId, { type: "get_state" });
      break;

    case "get_messages":
      sendToSession(sessionId, { type: "get_messages" });
      break;

    case "get_session_stats":
      sendToSession(sessionId, { type: "get_session_stats" });
      break;

    case "compact":
      sendToSession(sessionId, {
        type: "compact",
        ...(msg.customInstructions && { customInstructions: msg.customInstructions }),
      });
      break;

    case "switch_session": {
      const targetId = msg.targetSessionId as string;
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        // Leave current session
        const current = sessions.get(sessionId);
        if (current) current.connectedClients.delete(ws);

        // Join target
        targetSession.connectedClients.add(ws);
        sessionId = targetId;

        ws.send(
          JSON.stringify({
            type: "session_switched",
            sessionId: targetId,
          })
        );
      }
      break;
    }

    case "delete_session": {
      const deleteId = msg.sessionId as string;
      const delSession = sessions.get(deleteId);
      if (delSession) {
        delSession.proc.kill();
        sessions.delete(deleteId);
        ws.send(
          JSON.stringify({
            type: "session_deleted",
            sessionId: deleteId,
          })
        );
        // If we were in the deleted session, switch to another
        if (sessionId === deleteId) {
          const remaining = Array.from(sessions.entries());
          if (remaining.length > 0) {
            const [newId] = remaining[0];
            sessions.get(newId)?.connectedClients.add(ws);
            sessionId = newId;
          }
        }
      }
      break;
    }

    default:
      // Forward unknown commands to Pi
      console.log(`[WS] Forwarding: ${type}`);
      sendToSession(sessionId, msg);
  }
}

// ── Start ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] π Agent Web → http://localhost:${PORT}`);
  console.log(`[Server] WebSocket on port ${PORT}`);
  console.log(`[Server] Pi command: ${PI_CMD}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  for (const [, s] of sessions) {
    s.proc.kill();
  }
  wss.close();
  server.close(() => process.exit(0));
});
