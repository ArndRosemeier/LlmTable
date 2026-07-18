import type { OpenRouterModel } from "@llm-table/shared";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function requireApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new OpenRouterError(
      "OpenRouter API key is empty. Save your key in settings, then restart/resume the table.",
      401,
    );
  }
  return trimmed;
}

function authHeaders(apiKey: string, contentTypeJson = false): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${requireApiKey(apiKey)}`);
  // OpenRouter attribution headers (optional but recommended)
  headers.set("HTTP-Referer", "http://localhost:5173");
  headers.set("X-Title", "LlmTable");
  if (contentTypeJson) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function formatAuthError(status: number, body: string): string {
  // OpenRouter often returns this message for invalid/empty keys too — not only truly missing headers.
  if (status === 401) {
    return (
      "OpenRouter rejected the API key (401). " +
      "Re-paste your key from https://openrouter.ai/keys, click Save & load models, " +
      "then Leave table and create/rejoin so the session picks up the new key. " +
      `Details: ${body}`
    );
  }
  return `OpenRouter request failed (${status}): ${body}`;
}

/** Authenticated probe — /models is public and cannot validate keys. */
export async function validateApiKey(apiKey: string): Promise<void> {
  const response = await fetch(`${OPENROUTER_BASE}/key`, {
    headers: authHeaders(apiKey),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new OpenRouterError(formatAuthError(response.status, body), response.status);
  }
}

export async function listModels(apiKey: string): Promise<OpenRouterModel[]> {
  await validateApiKey(apiKey);

  const response = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: authHeaders(apiKey),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new OpenRouterError(formatAuthError(response.status, body), response.status);
  }

  const data = (await response.json()) as {
    data: Array<{ id: string; name?: string; context_length?: number }>;
  };

  return data.data
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function chatCompletion(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: "json_object";
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
  };

  if (params.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: authHeaders(params.apiKey, true),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OpenRouterError(formatAuthError(response.status, text), response.status);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new OpenRouterError("OpenRouter returned empty completion content");
  }

  return content.trim();
}
