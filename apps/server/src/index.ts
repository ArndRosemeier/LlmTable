import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CreateSessionRequest, ClientToServerMessage } from "@llm-table/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { closeDatabase } from "./db.js";
import {
  buildPersonaPortraitPrompt,
  generateImage,
  listImageModels,
  listModels,
  OpenRouterError,
} from "./openrouter.js";
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
  advanceRpgSession,
  continuePokerNextHand,
  pauseSession,
  resumeSession,
  startSession,
  submitAction,
} from "./orchestrator.js";
import { listModules } from "./registry.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function openRouterKeyFromRequest(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const apiKey =
    c.req.header("X-OpenRouter-Key") ??
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  return apiKey?.trim() ? apiKey.trim() : null;
}

app.get("/api/models", async (c) => {
  const apiKey = openRouterKeyFromRequest(c);
  if (!apiKey) {
    return c.json({ error: "OpenRouter API key required (X-OpenRouter-Key header)" }, 400);
  }

  try {
    const models = await listModels(apiKey);
    return c.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OpenRouterError && err.status === 401 ? 401 : 502;
    return c.json({ error: message }, status);
  }
});

app.get("/api/image-models", async (c) => {
  const apiKey = openRouterKeyFromRequest(c);
  if (!apiKey) {
    return c.json({ error: "OpenRouter API key required (X-OpenRouter-Key header)" }, 400);
  }

  try {
    const models = await listImageModels(apiKey);
    return c.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OpenRouterError && err.status === 401 ? 401 : 502;
    return c.json({ error: message }, status);
  }
});

app.post("/api/personas/portrait", async (c) => {
  let body: {
    apiKey?: string;
    model?: string;
    displayName?: string;
    systemPrompt?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const apiKey = body.apiKey?.trim() || openRouterKeyFromRequest(c);
  if (!apiKey) {
    return c.json({ error: "OpenRouter API key required" }, 400);
  }

  const model = body.model?.trim() ?? "";
  const displayName = body.displayName?.trim() ?? "";
  const systemPrompt = body.systemPrompt?.trim() ?? "";

  try {
    const prompt = buildPersonaPortraitPrompt(displayName, systemPrompt);
    const { dataUrl } = await generateImage({
      apiKey,
      model,
      prompt,
      aspectRatio: "1:1",
    });
    return c.json({ portraitDataUrl: dataUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof OpenRouterError && (err.status === 401 || err.status === 400)
        ? err.status
        : 502;
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

interface SocketContext {
  connectionId: string;
  sessionId: string | null;
  localParticipantId: string | null;
}

async function listenWithRetry(): Promise<HttpServer> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 40; attempt++) {
    const server = createServer(getRequestListener(app.fetch));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(PORT);
      });
      if (attempt > 0) {
        console.warn(`Bound port ${PORT} after ${attempt + 1} attempt(s)`);
      }
      return server;
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      if (attempt === 0 || attempt % 5 === 4) {
        console.warn(
          `Port ${PORT} in use (attempt ${attempt + 1}/40) — waiting for previous server to exit…`,
        );
      }
      await sleep(250);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Port ${PORT} still in use after retries`);
}

function attachWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

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
            case "poker.nextHand": {
              if (!ctx.sessionId) {
                throw new Error("Join a session before dealing the next hand");
              }
              await continuePokerNextHand(requireSession(ctx.sessionId));
              break;
            }
            case "rpg.advance": {
              if (!ctx.sessionId) {
                throw new Error("Join a session before advancing");
              }
              await advanceRpgSession(requireSession(ctx.sessionId));
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

  return wss;
}

function installShutdown(server: HttpServer, wss: WebSocketServer): void {
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Force-exit if close hangs (Windows watch restarts).
    setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 1500).unref();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.once(signal, shutdown);
  }
}

async function main(): Promise<void> {
  const server = await listenWithRetry();
  const wss = attachWebSocket(server);
  installShutdown(server, wss);
  console.log(`LlmTable server listening on http://localhost:${PORT}`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  closeDatabase();
  process.exit(1);
});
