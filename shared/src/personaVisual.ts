export type PersonaSex = "female" | "male" | "non-binary" | "unspecified";

const FEMALE_RE =
  /\b(she\/her|she\/hers|female|woman|girl|lady|witch|priestess|sorceress|queen|princess|maiden)\b/i;
const MALE_RE =
  /\b(he\/him|he\/his|male|man|boy|gentleman|wizard|warlock|king|prince|knight)\b/i;
const NONBINARY_RE =
  /\b(they\/them|non[-\s]?binary|enby|agender|genderqueer)\b/i;

/** Infer presented sex/gender cues from a persona definition. */
export function detectPersonaSex(systemPrompt: string): PersonaSex {
  const text = systemPrompt.trim();
  if (!text) {
    return "unspecified";
  }

  const nonBinary = NONBINARY_RE.test(text);
  const female = FEMALE_RE.test(text);
  const male = MALE_RE.test(text);
  const hits = Number(nonBinary) + Number(female) + Number(male);
  if (hits !== 1) {
    return "unspecified";
  }
  if (nonBinary) {
    return "non-binary";
  }
  if (female) {
    return "female";
  }
  return "male";
}

/**
 * Visual-facing excerpt from a persona definition: drop "You are Name" openers
 * and keep appearance / body / clothing / vibe cues for image models.
 */
export function personaVisualHints(systemPrompt: string, maxLen = 420): string {
  let text = systemPrompt.trim().replace(/\s+/g, " ");
  if (!text) {
    return "";
  }

  text = text
    .replace(/^you are\s+[^.,:;]+[,:]?\s*/i, "")
    .replace(/^i am\s+[^.,:;]+[,:]?\s*/i, "");

  if (text.length <= maxLen) {
    return text;
  }
  const sliced = text.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${(lastSpace > 40 ? sliced.slice(0, lastSpace) : sliced).trim()}…`;
}

/** One line for image-generation casting notes (no display names). */
export function formatPersonaVisualCastLine(systemPrompt: string): string {
  const sex = detectPersonaSex(systemPrompt);
  const hints = personaVisualHints(systemPrompt);
  if (!hints) {
    return `Sex: ${sex}.`;
  }
  return `Sex: ${sex}. Visual: ${hints}`;
}
