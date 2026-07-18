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

function parseUsdAmount(raw: string | number | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function formatUsd(amount: number): string {
  if (amount === 0) {
    return "$0";
  }
  const abs = Math.abs(amount);
  if (abs >= 100) {
    return `$${amount.toFixed(0)}`;
  }
  if (abs >= 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (abs >= 0.01) {
    return `$${amount.toFixed(2)}`;
  }
  if (abs >= 0.0001) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toExponential(2)}`;
}

function formatPerMillion(perToken: number): string {
  return formatUsd(perToken * 1_000_000);
}

function formatChatPriceLabel(pricing: {
  prompt?: string;
  completion?: string;
} | undefined): string | undefined {
  if (!pricing) {
    return undefined;
  }
  const prompt = parseUsdAmount(pricing.prompt);
  const completion = parseUsdAmount(pricing.completion);
  if (prompt === null || completion === null) {
    return undefined;
  }
  if (prompt < 0 || completion < 0) {
    return "variable";
  }
  if (prompt === 0 && completion === 0) {
    return "free";
  }
  return `${formatPerMillion(prompt)}/${formatPerMillion(completion)} per 1M`;
}

interface ImageEndpointPriceLine {
  billable?: string;
  unit?: string;
  cost_usd?: number;
  variant?: string | null;
}

function formatImageEndpointPriceLabel(
  lines: ImageEndpointPriceLine[] | undefined,
): string | undefined {
  if (!lines || lines.length === 0) {
    return undefined;
  }

  const outputs = lines.filter((line) => line.billable === "output_image");
  if (outputs.length === 0) {
    return undefined;
  }

  const imageUnit = outputs.filter(
    (line) => line.unit === "image" && parseUsdAmount(line.cost_usd) !== null,
  );
  if (imageUnit.length > 0) {
    const costs = imageUnit.map((line) => parseUsdAmount(line.cost_usd)!);
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    if (min === max) {
      return `${formatUsd(min)}/image`;
    }
    return `${formatUsd(min)}–${formatUsd(max)}/image`;
  }

  const tokenUnit = outputs.find((line) => line.unit === "token");
  const tokenCost = parseUsdAmount(tokenUnit?.cost_usd);
  if (tokenCost !== null) {
    return `${formatPerMillion(tokenCost)}/M img-tok`;
  }

  const megapixel = outputs.find((line) => line.unit === "megapixel");
  const mpCost = parseUsdAmount(megapixel?.cost_usd);
  if (mpCost !== null) {
    return `${formatUsd(mpCost)}/MP`;
  }

  const fallback = parseUsdAmount(outputs[0]?.cost_usd);
  const unit = outputs[0]?.unit ?? "unit";
  if (fallback === null) {
    return undefined;
  }
  return `${formatUsd(fallback)}/${unit}`;
}

async function fetchImageModelPriceLabel(
  apiKey: string,
  modelId: string,
): Promise<string | undefined> {
  const modelPath = modelId.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${OPENROUTER_BASE}/images/models/${modelPath}/endpoints`,
    { headers: authHeaders(apiKey) },
  );
  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as {
    endpoints?: Array<{ pricing?: ImageEndpointPriceLine[] }>;
  };

  const merged = (data.endpoints ?? []).flatMap((endpoint) => endpoint.pricing ?? []);
  return formatImageEndpointPriceLabel(merged);
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
    data: Array<{
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };

  return data.data
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length,
      priceLabel: formatChatPriceLabel(m.pricing),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function listImageModels(apiKey: string): Promise<OpenRouterModel[]> {
  await validateApiKey(apiKey);

  const response = await fetch(`${OPENROUTER_BASE}/images/models`, {
    headers: authHeaders(apiKey),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new OpenRouterError(formatAuthError(response.status, body), response.status);
  }

  const data = (await response.json()) as {
    data: Array<{ id: string; name?: string }>;
  };

  const priced = await Promise.all(
    data.data.map(async (m) => {
      const priceLabel = await fetchImageModelPriceLabel(apiKey, m.id);
      return {
        id: m.id,
        name: m.name ?? m.id,
        priceLabel,
      };
    }),
  );

  return priced.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildPersonaPortraitPrompt(
  displayName: string,
  systemPrompt: string,
): string {
  const name = displayName.trim();
  const definition = systemPrompt.trim().slice(0, 1200);
  if (!name) {
    throw new OpenRouterError("Persona name is required to generate a portrait", 400);
  }
  if (!definition) {
    throw new OpenRouterError("Persona definition is required to generate a portrait", 400);
  }

  return [
    `Character portrait of "${name}".`,
    "Single subject, head-and-shoulders, looking toward the viewer.",
    "Expressive face that matches this character description:",
    definition,
    "Soft naturalistic lighting, shallow depth of field, plain muted background.",
    "No text, no watermark, no border, no collage.",
  ].join(" ");
}

export async function generateImage(params: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
}): Promise<{ dataUrl: string }> {
  const model = params.model.trim();
  if (!model) {
    throw new OpenRouterError("Image model is required", 400);
  }

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio ?? "1:1",
  };

  const response = await fetch(`${OPENROUTER_BASE}/images`, {
    method: "POST",
    headers: authHeaders(params.apiKey, true),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OpenRouterError(formatAuthError(response.status, text), response.status);
  }

  const data = (await response.json()) as {
    data?: Array<{ b64_json?: string; media_type?: string }>;
  };

  const image = data.data?.[0];
  if (!image) {
    throw new OpenRouterError("OpenRouter returned no image data");
  }
  const b64 = image.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new OpenRouterError("OpenRouter returned no image data");
  }

  const mediaType =
    typeof image.media_type === "string" && image.media_type.startsWith("image/")
      ? image.media_type
      : "image/png";

  return { dataUrl: `data:${mediaType};base64,${b64}` };
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
