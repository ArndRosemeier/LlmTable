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
