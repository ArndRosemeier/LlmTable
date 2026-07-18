# LlmTable

A modular gaming-table app where LLM personas sit around a table. Conversation, Texas Hold'em, and theater-of-the-mind RPG — all in the browser. Uses your OpenRouter API key.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev
```

Or double-click `start.bat` (stops any previous Vite instance, then starts one).

Open http://localhost:5173. Set your OpenRouter API key in the header settings.

## Architecture

- `shared/` — table state, actions, module contracts
- `modules/conversation/` — conversation rules + LLM coordinator
- `modules/poker/` — Texas Hold'em rules + coordinator + play/talk LLM turns
- `modules/rpg/` — RPG rules, seeds, coordinator, GM/PC turns
- `apps/web/` — lobby, persona editor, table UI, local orchestration

Everything runs in the browser. There is no separate API server. OpenRouter is called directly from the client.

## Persistence

All durable state is in IndexedDB (`llm-table`):

- settings (API key, coordinator model, image model)
- lobby draft (personas, invites, module choice)
- custom adventure seeds
- full session snapshots + active session id

## Security note

Your OpenRouter key is stored in browser IndexedDB and used from the page for API calls. Do not treat this as production secret handling; anyone with access to the browser profile can read it.
