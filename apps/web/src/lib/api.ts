import type {
  CreateSessionRequest,
  OpenRouterModel,
  TableState,
  ParticipantId,
  SessionId,
} from "@llm-table/shared";

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      `Empty response from server (${response.status}). Is the API running on port 8787?`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Invalid JSON from server (${response.status}): ${text.slice(0, 200)}`,
    );
  }
}

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const response = await fetch("/api/models", {
    headers: {
      "X-OpenRouter-Key": apiKey,
    },
  });

  const data = await readJson<{ models?: OpenRouterModel[]; error?: string }>(response);
  if (!response.ok) {
    throw new Error(data.error ?? `Failed to load models (${response.status})`);
  }
  if (!data.models) {
    throw new Error("Models response missing models array");
  }
  return data.models;
}

export async function createSession(request: CreateSessionRequest): Promise<{
  sessionId: SessionId;
  state: TableState;
  localParticipantId: ParticipantId | null;
}> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const data = await readJson<{
    sessionId?: SessionId;
    state?: TableState;
    localParticipantId?: ParticipantId | null;
    error?: string;
  }>(response);

  if (!response.ok || !data.sessionId || !data.state) {
    throw new Error(data.error ?? `Failed to create session (${response.status})`);
  }

  return {
    sessionId: data.sessionId,
    state: data.state,
    localParticipantId: data.localParticipantId ?? null,
  };
}

export async function fetchSession(sessionId: SessionId): Promise<TableState> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  const data = await readJson<{ state?: TableState; error?: string }>(response);
  if (!response.ok || !data.state) {
    throw new Error(data.error ?? `Failed to load session (${response.status})`);
  }
  return data.state;
}
