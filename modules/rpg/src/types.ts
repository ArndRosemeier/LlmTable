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

export interface RpgAdvanceState {
  /** Speaker whose line will be revealed on Next (or who must act if human). */
  speakerId: ParticipantId | null;
  /**
   * idle — nothing queued
   * preparing — LLM response being built
   * ready — LLM response ready; press Next to reveal
   * awaiting_human — human must act (no Next)
   */
  mode: "idle" | "preparing" | "ready" | "awaiting_human";
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
