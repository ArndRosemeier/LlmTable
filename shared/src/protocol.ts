import type { ParticipantId } from "./types.js";

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
      /** Queue the human PC for the next non-GM spotlight (coordinator pick). */
      type: "rpg.raiseHand";
    }
  | {
      /** Cancel a queued hand; if already spotlighted, yields the turn. */
      type: "rpg.lowerHand";
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
       * Optional image-generation prompt. Filled to imageDataUrl before apply
       * when an image model is configured and GM pictures are enabled.
       */
      imagePrompt?: string;
      /** data:image/...;base64,... produced for the party chat. */
      imageDataUrl?: string;
    };
