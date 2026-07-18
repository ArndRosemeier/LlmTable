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
      "OpenRouter API key is empty. Save your key in settings, then start/resume the table.",
      401,
    );
  }
  return trimmed;
}

function authHeaders(apiKey: string, contentTypeJson = false): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${requireApiKey(apiKey)}`);
  // OpenRouter attribution headers (optional but recommended)
  headers.set("HTTP-Referer", typeof location !== "undefined" ? location.origin : "http://localhost:5173");
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
      "then leave the table and create a new one so it picks up the new key. " +
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

export interface ChatCompletionProgress {
  receivedBytes: number;
  receivedChars: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ImageGenerationProgress {
  receivedBytes: number;
  /** SSE partial render count when the provider streams image previews. */
  partialFrames?: number;
  done: boolean;
}

async function readResponseBytes(
  response: Response,
  onBytes?: (receivedBytes: number) => void,
): Promise<{ text: string; receivedBytes: number }> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    onBytes?.(new TextEncoder().encode(text).byteLength);
    return { text, receivedBytes: new TextEncoder().encode(text).byteLength };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    receivedBytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onBytes?.(receivedBytes);
  }
  text += decoder.decode();
  return { text, receivedBytes };
}

function* iterateSseDataPayloads(chunkText: string, carry: { buffer: string }): Generator<string> {
  carry.buffer += chunkText;
  for (;;) {
    const newline = carry.buffer.indexOf("\n");
    if (newline < 0) {
      return;
    }
    let line = carry.buffer.slice(0, newline);
    carry.buffer = carry.buffer.slice(newline + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      yield line.slice(5).trimStart();
    }
  }
}

function imageDataUrlFromB64(b64: string, mediaType: string | undefined): string {
  if (!b64) {
    throw new OpenRouterError("OpenRouter returned no image data");
  }
  const resolved =
    typeof mediaType === "string" && mediaType.startsWith("image/")
      ? mediaType
      : "image/png";
  return `data:${resolved};base64,${b64}`;
}

export async function generateImage(params: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  onProgress?: (progress: ImageGenerationProgress) => void;
}): Promise<{ dataUrl: string }> {
  const model = params.model.trim();
  if (!model) {
    throw new OpenRouterError("Image model is required", 400);
  }

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio ?? "1:1",
    stream: true,
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

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const bodyStream = response.body;
    if (!bodyStream) {
      throw new OpenRouterError("OpenRouter image stream returned an empty body");
    }

    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    const carry = { buffer: "" };
    let receivedBytes = 0;
    let partialFrames = 0;
    let dataUrl: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      for (const payload of iterateSseDataPayloads(text, carry)) {
        if (payload === "[DONE]") {
          continue;
        }
        const event = JSON.parse(payload) as {
          type?: string;
          b64_json?: string;
          media_type?: string;
          error?: { message?: string };
          data?: Array<{ b64_json?: string; media_type?: string }>;
        };
        if (event.error?.message) {
          throw new OpenRouterError(event.error.message);
        }
        if (event.type === "image_generation.partial_image" && event.b64_json) {
          partialFrames += 1;
          params.onProgress?.({
            receivedBytes,
            partialFrames,
            done: false,
          });
          continue;
        }
        if (event.type === "image_generation.completed" && event.b64_json) {
          dataUrl = imageDataUrlFromB64(event.b64_json, event.media_type);
          params.onProgress?.({
            receivedBytes,
            partialFrames,
            done: true,
          });
          continue;
        }
        // Some providers may still emit chat-style image payloads on the stream.
        const b64 = event.b64_json ?? event.data?.[0]?.b64_json;
        if (typeof b64 === "string" && b64.length > 0) {
          dataUrl = imageDataUrlFromB64(b64, event.media_type ?? event.data?.[0]?.media_type);
        }
      }
      params.onProgress?.({
        receivedBytes,
        partialFrames: partialFrames > 0 ? partialFrames : undefined,
        done: false,
      });
    }

    for (const payload of iterateSseDataPayloads("\n", carry)) {
      if (payload === "[DONE]") {
        continue;
      }
      const event = JSON.parse(payload) as {
        type?: string;
        b64_json?: string;
        media_type?: string;
        data?: Array<{ b64_json?: string; media_type?: string }>;
      };
      if (event.type === "image_generation.completed" && event.b64_json) {
        dataUrl = imageDataUrlFromB64(event.b64_json, event.media_type);
      } else {
        const b64 = event.b64_json ?? event.data?.[0]?.b64_json;
        if (typeof b64 === "string" && b64.length > 0) {
          dataUrl = imageDataUrlFromB64(b64, event.media_type ?? event.data?.[0]?.media_type);
        }
      }
    }

    if (!dataUrl) {
      throw new OpenRouterError("OpenRouter image stream ended without an image");
    }
    params.onProgress?.({
      receivedBytes,
      partialFrames: partialFrames > 0 ? partialFrames : undefined,
      done: true,
    });
    return { dataUrl };
  }

  const { text, receivedBytes } = await readResponseBytes(response, (bytes) => {
    params.onProgress?.({ receivedBytes: bytes, done: false });
  });

  const data = JSON.parse(text) as {
    data?: Array<{ b64_json?: string; media_type?: string }>;
    b64_json?: string;
    media_type?: string;
  };

  const image = data.data?.[0];
  const b64 = image?.b64_json ?? data.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new OpenRouterError("OpenRouter returned no image data");
  }

  const dataUrl = imageDataUrlFromB64(b64, image?.media_type ?? data.media_type);
  params.onProgress?.({ receivedBytes, done: true });
  return { dataUrl };
}

export async function chatCompletion(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: "json_object";
  onProgress?: (progress: ChatCompletionProgress) => void;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    stream: true,
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

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Provider ignored stream — still report download bytes.
    const { text, receivedBytes } = await readResponseBytes(response, (bytes) => {
      params.onProgress?.({
        receivedBytes: bytes,
        receivedChars: 0,
      });
    });
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new OpenRouterError("OpenRouter returned empty completion content");
    }
    params.onProgress?.({
      receivedBytes,
      receivedChars: content.length,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    });
    return content.trim();
  }

  const bodyStream = response.body;
  if (!bodyStream) {
    throw new OpenRouterError("OpenRouter chat stream returned an empty body");
  }

  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  const carry = { buffer: "" };
  let receivedBytes = 0;
  let content = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    receivedBytes += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    for (const payload of iterateSseDataPayloads(text, carry)) {
      if (payload === "[DONE]") {
        continue;
      }
      const event = JSON.parse(payload) as {
        error?: { message?: string };
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      if (event.error?.message) {
        throw new OpenRouterError(event.error.message);
      }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
      }
      if (event.usage) {
        promptTokens = event.usage.prompt_tokens ?? promptTokens;
        completionTokens = event.usage.completion_tokens ?? completionTokens;
        totalTokens = event.usage.total_tokens ?? totalTokens;
      }
    }
    params.onProgress?.({
      receivedBytes,
      receivedChars: content.length,
      promptTokens,
      completionTokens,
      totalTokens,
    });
  }

  for (const payload of iterateSseDataPayloads("\n", carry)) {
    if (payload === "[DONE]") {
      continue;
    }
    const event = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      content += delta;
    }
    if (event.usage) {
      promptTokens = event.usage.prompt_tokens ?? promptTokens;
      completionTokens = event.usage.completion_tokens ?? completionTokens;
      totalTokens = event.usage.total_tokens ?? totalTokens;
    }
  }

  if (content.trim().length === 0) {
    throw new OpenRouterError("OpenRouter returned empty completion content");
  }

  params.onProgress?.({
    receivedBytes,
    receivedChars: content.length,
    promptTokens,
    completionTokens,
    totalTokens,
  });
  return content.trim();
}
