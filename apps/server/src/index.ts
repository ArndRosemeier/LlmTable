import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CreateSessionRequest, ClientToServerMessage } from "@llm-table/shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { listModels, OpenRouterError } from "./openrouter.js";
import {
  attachConnection,
  broadcast,
  createSession,
  detachConnection,
  getSession,
  loadSessionsFromDisk,
  persistSession,
  publicState,
  requireSession,
} from "./session.js";
import {
  pauseSession,
  resumeSession,
  startSession,
  submitAction,
} from "./orchestrator.js";
import { listModules } from "./registry.js";

const PORT = Number(process.env.PORT ?? 8787);
const restored = loadSessionsFromDisk();
console.log(`Restored ${restored} session(s) from disk`);

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type", "Authorization", "X-OpenRouter-Key"],
  }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/modules", (c) => c.json({ modules: listModules() }));

app.get("/api/models", async (c) => {
  const apiKey =
    c.req.header("X-OpenRouter-Key") ??
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

  if (!apiKey?.trim()) {
    return c.json({ error: "OpenRouter API key required (X-OpenRouter-Key header)" }, 400);
  }

  try {
    const models = await listModels(apiKey.trim());
    return c.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OpenRouterError && err.status === 401 ? 401 : 502;
    return c.json({ error: message }, status);
  }
});

app.post("/api/sessions", async (c) => {
  let body: CreateSessionRequest;
  try {
    body = (await c.req.json()) as CreateSessionRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const { session, localParticipantId } = createSession(body);
    return c.json({
      sessionId: session.state.sessionId,
      state: publicState(session),
      localParticipantId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

app.get("/api/sessions/:sessionId", (c) => {
  const session = getSession(c.req.param("sessionId"));
  if (!session) {
    return c.json({ error: "Unknown session" }, 404);
  }
  return c.json({
    sessionId: session.state.sessionId,
    state: publicState(session),
  });
});

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`LlmTable server listening on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({
  server: server as unknown as import("node:http").Server,
  path: "/ws",
});

interface SocketContext {
  connectionId: string;
  sessionId: string | null;
  localParticipantId: string | null;
}

wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
  const ctx: SocketContext = {
    connectionId: crypto.randomUUID(),
    sessionId: null,
    localParticipantId: null,
  };

  ws.on("message", (raw) => {
    void (async () => {
      let msg: ClientToServerMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientToServerMessage;
      } catch {
        ws.send(JSON.stringify({ type: "session.error", message: "Invalid JSON message" }));
        return;
      }

      try {
        switch (msg.type) {
          case "session.join": {
            const session = requireSession(msg.sessionId);
            const apiKey = msg.apiKey.trim();
            if (!apiKey) {
              throw new Error(
                "OpenRouter API key required to join. Save your key in settings first.",
              );
            }
            session.secrets.apiKey = apiKey;
            persistSession(session);
            const localParticipantId = attachConnection(
              session,
              ctx.connectionId,
              ws,
              msg.participantId ?? null,
            );
            ctx.sessionId = msg.sessionId;
            ctx.localParticipantId = localParticipantId;
            ws.send(
              JSON.stringify({
                type: "session.updated",
                state: publicState(session, localParticipantId),
                localParticipantId,
              }),
            );
            broadcast(session);
            break;
          }
          case "session.start": {
            if (!ctx.sessionId) {
              throw new Error("Join a session before starting");
            }
            const session = requireSession(ctx.sessionId);
            const apiKey = msg.apiKey.trim();
            if (!apiKey) {
              throw new Error(
                "OpenRouter API key required to start. Save your key in settings first.",
              );
            }
            session.secrets.apiKey = apiKey;
            persistSession(session);
            await startSession(session);
            break;
          }
          case "session.pause": {
            if (!ctx.sessionId) {
              throw new Error("Join a session before pausing");
            }
            pauseSession(requireSession(ctx.sessionId));
            break;
          }
          case "session.resume": {
            if (!ctx.sessionId) {
              throw new Error("Join a session before resuming");
            }
            const session = requireSession(ctx.sessionId);
            const apiKey = msg.apiKey.trim();
            if (!apiKey) {
              throw new Error(
                "OpenRouter API key required to resume. Save your key in settings first.",
              );
            }
            session.secrets.apiKey = apiKey;
            persistSession(session);
            await resumeSession(session);
            break;
          }
          case "action.submit": {
            if (!ctx.sessionId) {
              throw new Error("Join a session before submitting actions");
            }
            if (!ctx.localParticipantId) {
              throw new Error("Only a bound human participant can submit actions");
            }
            await submitAction(
              requireSession(ctx.sessionId),
              ctx.localParticipantId,
              msg.action,
            );
            break;
          }
          default: {
            const exhaustive: never = msg;
            throw new Error(`Unhandled message: ${(exhaustive as { type: string }).type}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "session.error", message }));
      }
    })();
  });

  ws.on("close", () => {
    if (!ctx.sessionId) {
      return;
    }
    const session = getSession(ctx.sessionId);
    if (!session) {
      return;
    }
    detachConnection(session, ctx.connectionId);
    broadcast(session);
  });
});
