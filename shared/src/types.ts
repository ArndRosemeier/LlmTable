export type ParticipantId = string;
export type SessionId = string;
export type ParticipantKind = "human" | "llm";
export type SessionPhase = "lobby" | "running" | "paused";

export interface PersonaDefinition {
  systemPrompt: string;
  model: string;
}

export interface Participant {
  id: ParticipantId;
  kind: ParticipantKind;
  displayName: string;
  persona?: PersonaDefinition;
  seatIndex: number;
  connectionId?: string;
}

export interface ChatMessage {
  id: string;
  participantId: ParticipantId;
  displayName: string;
  content: string;
  createdAt: string;
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
  error?: string | null;
  statusMessage?: string | null;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
}

export interface PersonaDraft {
  id: string;
  displayName: string;
  systemPrompt: string;
  model: string;
}

export interface CreateSessionRequest {
  apiKey: string;
  coordinatorModel: string;
  personas: PersonaDraft[];
  humanName?: string;
  moduleId: string;
}
