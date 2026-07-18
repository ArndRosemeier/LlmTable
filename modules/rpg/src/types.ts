import type { AdventureSeed, ParticipantId } from "@llm-table/shared";

export interface RpgPartyMember {
  participantId: ParticipantId;
  hp: number;
  maxHp: number;
  tags: string[];
}

export interface RpgPendingCheck {
  participantId: ParticipantId;
  label: string;
  dc: number;
  modifier: number;
}

export interface RpgLastRoll {
  sides: number;
  value: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  label: string;
  participantId: ParticipantId;
}

export interface RpgClockState {
  name: string;
  value: number;
  max: number;
}

export interface RpgPublicSeed {
  id: string;
  title: string;
  tone: string;
  premise: string;
}

export type RpgPreparationPhase =
  | "choosing_speaker"
  | "generating_turn"
  | "creating_image"
  | "finalizing";

/** Live prepare telemetry from the server (streaming chat / image). */
export interface RpgPreparationProgress {
  phase: RpgPreparationPhase;
  detail: string;
  receivedBytes?: number;
  receivedChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** SSE image preview frames when the image provider streams them. */
  imagePartialFrames?: number;
}

export interface RpgAdvanceState {
  /** Speaker whose line will be revealed on Next (or who must act if human). */
  speakerId: ParticipantId | null;
  /**
   * idle — nothing queued
   * preparing — LLM response being built
   * ready — LLM response ready; press Next to reveal
   * revealing — Next accepted; applying the prefetched line
   * awaiting_human — human must act (no Next)
   */
  mode: "idle" | "preparing" | "ready" | "revealing" | "awaiting_human";
  /** Present while mode is preparing; cleared when ready/idle. */
  progress?: RpgPreparationProgress;
}

export interface RpgState {
  seedId: string;
  publicSeed: RpgPublicSeed;
  /** Full seed for this session (built-in or custom); GM briefing uses this. */
  adventure: AdventureSeed;
  /** GM-only; must be stripped in redactState for non-GM viewers. */
  secret: string;
  sceneSummary: string;
  clock: RpgClockState | null;
  party: RpgPartyMember[];
  pendingCheck: RpgPendingCheck | null;
  lastRoll: RpgLastRoll | null;
  /** Prefer GM on the next coordinator pick when true. */
  preferGmNext: boolean;
  /**
   * Human PC who raised their hand. On the next non-GM (player) pick, they are
   * spotlighted instead of an LLM PC. Ignored while preferGmNext / GM is owed.
   */
  raisedHandParticipantId: ParticipantId | null;
  gmParticipantId: ParticipantId;
  /** Rolling transcript summary for LLM prompts only (UI keeps full messages). */
  transcriptSummary: string;
  /** How many messages are already folded into transcriptSummary. */
  summaryThroughMessageCount: number;
  /** Manual advance / prefetch status for the table UI. */
  advance: RpgAdvanceState;
}

export function isRpgState(value: unknown): value is RpgState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Partial<RpgState>;
  return (
    typeof v.seedId === "string" &&
    typeof v.gmParticipantId === "string" &&
    Array.isArray(v.party) &&
    typeof v.sceneSummary === "string"
  );
}
