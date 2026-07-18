import WebSocket from "ws";

const createRes = await fetch("http://localhost:8787/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    apiKey: "test-key",
    coordinatorModel: "openai/gpt-4o-mini",
    moduleId: "conversation",
    personas: [
      {
        id: "p1",
        displayName: "Avery",
        systemPrompt: "Curious",
        model: "openai/gpt-4o-mini",
      },
      {
        id: "p2",
        displayName: "Blake",
        systemPrompt: "Witty",
        model: "openai/gpt-4o-mini",
      },
    ],
  }),
});

const created = await createRes.json();
if (!created.sessionId) {
  throw new Error(`Create failed: ${JSON.stringify(created)}`);
}

console.log("created LLM-only session", created.sessionId);

const ws = new WebSocket("ws://localhost:8787/ws");

await new Promise((resolve, reject) => {
  let started = false;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.join",
        sessionId: created.sessionId,
        apiKey: "test-key",
      }),
    );
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "session.updated" && !started && msg.state.phase === "lobby") {
      started = true;
      console.log("joined lobby, starting…");
      ws.send(JSON.stringify({ type: "session.start" }));
      return;
    }
    if (msg.type === "session.updated" && (msg.state.phase === "paused" || msg.state.error)) {
      console.log("result phase:", msg.state.phase);
      console.log("result error:", msg.state.error);
      ws.close();
      resolve(undefined);
      return;
    }
    if (msg.type === "session.error") {
      console.log("session.error", msg.message);
      ws.close();
      resolve(undefined);
    }
  });

  ws.on("error", reject);
  setTimeout(() => reject(new Error("timeout")), 15000);
});
