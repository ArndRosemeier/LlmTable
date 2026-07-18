/**
 * Extract text from the first <tag>...</tag> in a model response.
 * Prefers CDATA when present so natural language can include <>& freely.
 */
export function extractXmlTag(raw: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cdata = new RegExp(
    `<${escaped}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escaped}>`,
    "i",
  );
  const cdataMatch = raw.match(cdata);
  if (cdataMatch) {
    return cdataMatch[1] ?? "";
  }

  const plain = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i");
  const match = raw.match(plain);
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
