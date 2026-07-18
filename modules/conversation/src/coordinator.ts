import type {
  Coordinator,
  CoordinatorDeps,
  ParticipantId,
  TableState,
} from "@llm-table/shared";
import { requireXmlTag } from "@llm-table/shared";

const TRANSCRIPT_WINDOW = 30;

interface CoordinatorChoice {
  nextSpeakerId: string;
  reason: string;
}

function eligibleParticipants(state: TableState) {
  return state.participants.filter((p) => {
    if (p.kind === "llm") {
      return true;
    }
    // Connected humans can be invited to speak; they may pass by staying silent.
    return typeof p.connectionId === "string" && p.connectionId.length > 0;
  });
}

function formatTranscript(state: TableState): string {
  const recent = state.messages.slice(-TRANSCRIPT_WINDOW);
  if (recent.length === 0) {
    return "(no messages yet — pick someone to open the conversation)";
  }
  return recent.map((m) => `${m.displayName}: ${m.content}`).join("\n");
}

function parseChoice(raw: string, allowedIds: Set<string>): CoordinatorChoice {
  const nextSpeakerId = requireXmlTag(raw, "nextSpeakerId");
  const reason = requireXmlTag(raw, "reason");

  if (!allowedIds.has(nextSpeakerId)) {
    throw new Error(
      `Coordinator picked unknown or ineligible speaker "${nextSpeakerId}". Allowed: ${[...allowedIds].join(", ")}`,
    );
  }

  return { nextSpeakerId, reason };
}

export function createConversationCoordinator(deps: CoordinatorDeps): Coordinator {
  return {
    async pickNext(state: TableState): Promise<ParticipantId | null> {
      const eligible = eligibleParticipants(state);
      if (eligible.length === 0) {
        return null;
      }

      const lastSpeakerId = state.messages.at(-1)?.participantId ?? null;
      const roster = eligible
        .map(
          (p) =>
            `- id=${p.id}; name=${p.displayName}; kind=${p.kind}` +
            (lastSpeakerId === p.id ? " (spoke last)" : ""),
        )
        .join("\n");

      const system = [
        "You are the conversation coordinator at a gaming table.",
        "Choose the single participant who should speak next (LLM or human).",
        "Prefer natural turn-taking: someone who was addressed, has a strong reaction, or advances the conversation.",
        "Include the human when it would feel natural for them to respond, but do not always pick them.",
        "Avoid always picking the same speaker. Prefer not to pick who just spoke, unless the conversation clearly requires a follow-up from them.",
        "Respond with XML only (no markdown fences, no commentary outside tags):",
        "<choice>",
        "  <nextSpeakerId>participant-id</nextSpeakerId>",
        "  <reason><![CDATA[brief reason]]></reason>",
        "</choice>",
      ].join("\n");

      const user = [
        "Participants:",
        roster,
        "",
        "Recent transcript:",
        formatTranscript(state),
      ].join("\n");

      const raw = await deps.complete({
        apiKey: deps.apiKey,
        model: deps.coordinatorModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
      });

      const choice = parseChoice(
        raw,
        new Set(eligible.map((p) => p.id)),
      );

      return choice.nextSpeakerId;
    },
  };
}
