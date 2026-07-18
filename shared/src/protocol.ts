import type { ParticipantId, SessionId, TableState } from "./types.js";

export type ClientToServerMessage =
  | {
      type: "session.join";
      sessionId: SessionId;
      apiKey: string;
      participantId?: ParticipantId;
    }
  | {
      type: "session.start";
      apiKey: string;
    }
  | {
      type: "action.submit";
      action: ClientAction;
    }
  | {
      type: "session.pause";
    }
  | {
      type: "session.resume";
      apiKey: string;
    }
  | {
      /** Poker: deal the next hand after the between-hands review pause. */
      type: "poker.nextHand";
    }
  | {
      /** RPG: reveal the next prefetched (or awaited) LLM line. */
      type: "rpg.advance";
    };

export type PokerBetAction = "fold" | "check" | "call" | "bet" | "raise";

export type ClientAction =
  | {
      type: "chat.say";
      content: string;
    }
  | {
      type: "poker.act";
      action: PokerBetAction;
      /** Absolute chips committed this street after the action (for bet/raise). */
      raiseTo?: number;
      /** Optional table talk spoken with the action. */
      tableTalk?: string;
    }
  | {
      type: "rpg.say";
      content: string;
      /** True when the line is a declared attempt/action, not pure dialogue. */
      isAction?: boolean;
    }
  | {
      type: "rpg.gm";
      narration: string;
      sceneSummary?: string;
      check?: {
        participantId: ParticipantId;
        label: string;
        dc: number;
        modifier: number;
      };
      hpUpdates?: Array<{ participantId: ParticipantId; hp: number }>;
      clockDelta?: number;
      /**
       * Optional image-generation prompt. Server fills imageDataUrl before apply
       * when an image model is configured.
       */
      imagePrompt?: string;
      /** data:image/...;base64,... produced by the server for the party chat. */
      imageDataUrl?: string;
    };

export type ServerToClientMessage =
  | {
      type: "session.updated";
      state: TableState;
      localParticipantId: ParticipantId | null;
    }
  | {
      type: "session.error";
      message: string;
    }
  | {
      type: "session.created";
      sessionId: SessionId;
      state: TableState;
      localParticipantId: ParticipantId | null;
    };
