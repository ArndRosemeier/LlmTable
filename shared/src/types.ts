import type { AdventureSeed } from "./adventure.js";

export type ParticipantId = string;
export type SessionId = string;
export type ParticipantKind = "human" | "llm";
export type SessionPhase = "lobby" | "running" | "paused";
/** Seat role at an RPG table; omitted for non-RPG modules. */
export type TableRole = "gm" | "pc";

export interface PersonaDefinition {
  systemPrompt: string;
  model: string;
  /** data:image/...;base64,... portrait, when generated */
  portraitDataUrl?: string;
}

export interface Participant {
  id: ParticipantId;
  kind: ParticipantKind;
  displayName: string;
  persona?: PersonaDefinition;
  seatIndex: number;
  tableRole?: TableRole;
}

export interface ChatMessage {
  id: string;
  participantId: ParticipantId;
  displayName: string;
  content: string;
  createdAt: string;
  /** Optional inline image (data URL) shown with the message, e.g. GM scene art. */
  imageDataUrl?: string;
  /** Prompt used to generate imageDataUrl, when known. */
  imagePrompt?: string;
  /** Poker: hand number this line belongs to (for rolling chat windows). */
  handNumber?: number;
}

export interface TableState {
  sessionId: SessionId;
  moduleId: string;
  participants: Participant[];
  messages: ChatMessage[];
  activeSpeakerId: ParticipantId | null;
  phase: SessionPhase;
  moduleState: unknown;
  coordinatorModel: string;
  /** OpenRouter image model for GM scene art (RPG). */
  imageModel?: string;
  /** RPG: when false, GM must not request / receive scene pictures. */
  gmImagesEnabled?: boolean;
  error?: string | null;
  statusMessage?: string | null;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  /** Short price summary for selectors, e.g. "$0.15/$0.60 per 1M" or "$0.04/image" */
  priceLabel?: string;
}

export interface PersonaDraft {
  id: string;
  displayName: string;
  systemPrompt: string;
  model: string;
  /** data:image/...;base64,... portrait, when generated */
  portraitDataUrl?: string;
}

export interface CreateSessionRequest {
  apiKey: string;
  coordinatorModel: string;
  personas: PersonaDraft[];
  humanName?: string;
  moduleId: string;
  /** RPG module: adventure seed id (e.g. haunted-mill, blank). */
  adventureSeedId?: string;
  /**
   * RPG module: full seed payload (built-in or custom).
   * When set, used instead of looking up adventureSeedId in the built-in catalog.
   */
  adventureSeed?: AdventureSeed;
  /** RPG module: id of the invited persona who runs the table as GM. */
  gmPersonaId?: string;
  /** OpenRouter image model used when the GM shows a picture. */
  imageModel?: string;
  /** RPG: whether the GM is allowed to show pictures this session. */
  gmImagesEnabled?: boolean;
}
