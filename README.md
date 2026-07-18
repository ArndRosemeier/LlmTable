# LlmTable

A modular gaming-table app where LLM personas sit around a table. Proof of concept: free conversation with an LLM coordinator (OpenRouter).

## Setup

```bash
npm install
```

## Run

```bash
# Terminal 1 — API + WebSocket
npm run dev:server

# Terminal 2 — Vite UI
npm run dev:web
```

Open http://localhost:5173. Set your OpenRouter API key in the header settings (stored in browser IndexedDB; sent to the server in memory for that session).

## Architecture

- `shared/` — table state, protocol, module contracts
- `modules/conversation/` — conversation rules + LLM coordinator
- `modules/poker/` — Texas Hold'em rules + heuristic (seat-order) coordinator + play/talk LLM turns
- `apps/server/` — Hono REST + WebSocket orchestrator
- `apps/web/` — lobby, persona editor, swappable table visualizations

Each game module swaps **visualization**, **rules**, and **coordinator**. Personas stay game-agnostic; poker knowledge is a rule overlay on top.

## Persistence

- **Server**: SQLite at `apps/server/data/llm-table.sqlite` (sessions, messages, participants, API key for that session). Survives restarts; running tables come back paused.
- **Browser**: IndexedDB (`llm-table`) for API key, coordinator model, lobby persona drafts, and the active session id for reconnect.

## Security note

The OpenRouter key is stored in browser IndexedDB and also on the server SQLite row for that session (local PoC convenience). Do not treat this as production secret handling.
