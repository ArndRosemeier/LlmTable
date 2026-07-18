/**
 * Strip common markdown code fences so XML parsers can find tags.
 */
export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:xml|json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed.replace(/^```(?:xml|json|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Extract text from the first <tag>...</tag> in a model response.
 * Prefers CDATA when present so natural language can include <>& freely.
 */
export function extractXmlTag(raw: string, tag: string): string | null {
  const source = stripMarkdownFences(raw);
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cdata = new RegExp(
    `<${escaped}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escaped}>`,
    "i",
  );
  const cdataMatch = source.match(cdata);
  if (cdataMatch) {
    return cdataMatch[1] ?? "";
  }

  const plain = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i");
  const match = source.match(plain);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

export function requireXmlTag(raw: string, tag: string): string {
  const value = extractXmlTag(raw, tag);
  if (value === null) {
    throw new Error(`Missing <${tag}>…</${tag}> in model response: ${raw}`);
  }
  return value;
}
