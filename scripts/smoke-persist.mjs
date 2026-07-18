import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "apps/server/data");
const dbFile = path.join(dataDir, "llm-table.sqlite");

// Use a temp data dir for the smoke test
const smokeDir = path.join(root, "apps/server/data-smoke");
rmSync(smokeDir, { recursive: true, force: true });

const child = spawn(
  "npx",
  ["tsx", "src/index.ts"],
  {
    cwd: path.join(root, "apps/server"),
    env: { ...process.env, PORT: "8799", LLM_TABLE_DATA_DIR: smokeDir },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  },
);

let output = "";
child.stdout.on("data", (d) => {
  output += String(d);
});
child.stderr.on("data", (d) => {
  output += String(d);
});

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://localhost:8799/api/health");
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start.\n${output}`);
}

try {
  await waitForHealth();

  const createRes = await fetch("http://localhost:8799/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "persist-test-key",
      coordinatorModel: "openai/gpt-4o-mini",
      moduleId: "conversation",
      personas: [
        { id: "p1", displayName: "Avery", systemPrompt: "Curious", model: "openai/gpt-4o-mini" },
        { id: "p2", displayName: "Blake", systemPrompt: "Witty", model: "openai/gpt-4o-mini" },
      ],
    }),
  });
  const created = await createRes.json();
  if (!created.sessionId) {
    throw new Error(`Create failed: ${JSON.stringify(created)}`);
  }

  const smokeDb = path.join(smokeDir, "llm-table.sqlite");
  if (!existsSync(smokeDb)) {
    throw new Error(`SQLite file missing at ${smokeDb}`);
  }
  console.log("created session + sqlite ok", created.sessionId);

  child.kill();
  await new Promise((r) => child.on("exit", r));

  // Restart and verify restore
  const child2 = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: path.join(root, "apps/server"),
    env: { ...process.env, PORT: "8799", LLM_TABLE_DATA_DIR: smokeDir },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  let out2 = "";
  child2.stdout.on("data", (d) => {
    out2 += String(d);
  });
  child2.stderr.on("data", (d) => {
    out2 += String(d);
  });

  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://localhost:8799/api/health");
      if (res.ok) break;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
    if (i === 39) throw new Error(`Restart failed.\n${out2}`);
  }

  const getRes = await fetch(`http://localhost:8799/api/sessions/${created.sessionId}`);
  const loaded = await getRes.json();
  if (!getRes.ok || loaded.state?.sessionId !== created.sessionId) {
    throw new Error(`Restore failed: ${JSON.stringify(loaded)}\n${out2}`);
  }
  console.log("restored session after restart ok", loaded.state.sessionId, "phase", loaded.state.phase);

  child2.kill();
  await new Promise((r) => child2.on("exit", r));
  rmSync(smokeDir, { recursive: true, force: true });
  console.log("persist smoke passed");
  // avoid unused
  void dbFile;
  void dataDir;
} catch (err) {
  child.kill();
  console.error(err);
  process.exit(1);
}
