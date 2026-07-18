import type {
  Coordinator,
  CoordinatorDeps,
  Participant,
  ParticipantId,
  TableState,
} from "@llm-table/shared";
import { requireXmlTag } from "@llm-table/shared";
import { formatRpgPromptMemory, normalizeRpgState } from "./promptMemory.js";
import { isRpgState } from "./types.js";

const TRANSCRIPT_WINDOW = 24;

function eligibleLlmParticipants(state: TableState): Participant[] {
  // Humans are never spotlighted — they interrupt freely between manual advances.
  return state.participants.filter((p) => p.kind === "llm");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve a coordinator pick. Prefer display names; also accept raw ids and
 * common model mangling like "participant-<uuid>".
 */
function resolveSpeakerId(
  token: string,
  eligible: Participant[],
  gmParticipantId: ParticipantId,
): ParticipantId {
  let trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Coordinator returned an empty nextSpeakerId");
  }

  // Strip accidental wrappers models invent around ids/names.
  trimmed = trimmed
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(participant|id|speaker)\s*[=:]\s*/i, "")
    .replace(/^(participant|id|speaker)[-_]/i, "")
    .trim();

  if (!trimmed) {
    throw new Error("Coordinator returned an empty nextSpeakerId");
  }

  if (trimmed.toLowerCase() === "gm") {
    const gm = eligible.find((p) => p.id === gmParticipantId);
    if (gm) {
      return gm.id;
    }
    throw new Error(`Coordinator picked "gm" but no GM is eligible`);
  }

  const byId = eligible.find((p) => p.id === trimmed);
  if (byId) {
    return byId.id;
  }

  const lower = normalizeName(trimmed);
  const byName = eligible.filter((p) => normalizeName(p.displayName) === lower);
  if (byName.length === 1) {
    return byName[0].id;
  }
  if (byName.length > 1) {
    throw new Error(
      `Coordinator picked ambiguous name "${trimmed}" (${byName.length} matches). Give personas unique names.`,
    );
  }

  const allowed = eligible.map((p) => `${p.displayName}`).join(", ");
  throw new Error(
    `Coordinator picked unknown or ineligible speaker "${token.trim()}". Allowed names: ${allowed}`,
  );
}

function lastMessageIndexFor(
  participantId: ParticipantId,
  messages: TableState["messages"],
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].participantId === participantId) {
      return i;
    }
  }
  return -1;
}

export function createRpgCoordinator(deps: CoordinatorDeps): Coordinator {
  return {
    async pickNext(state: TableState): Promise<ParticipantId | null> {
      if (!isRpgState(state.moduleState)) {
        throw new Error("RPG moduleState is missing or invalid");
      }
      const rpg = normalizeRpgState(state.moduleState);
      const eligible = eligibleLlmParticipants(state);
      if (eligible.length === 0) {
        return null;
      }

      const gm = eligible.find((p) => p.id === rpg.gmParticipantId);

      // Hard rule — not a fallback: after a PC acts, GM narrates.
      if (rpg.preferGmNext) {
        if (!gm) {
          throw new Error("preferGmNext is set but the GM is not an eligible LLM participant");
        }
        return gm.id;
      }

      // Hard rule: after a roll line, the checked PC gets one beat.
      if (rpg.lastRoll) {
        const lastWasRoll = state.messages.at(-1)?.content.startsWith("🎲");
        if (lastWasRoll) {
          const checked = eligible.find((p) => p.id === rpg.lastRoll!.participantId);
          if (checked && checked.id !== rpg.gmParticipantId) {
            return checked.id;
          }
        }
      }

      const lastSpeakerId = state.messages.at(-1)?.participantId ?? null;
      const roster = eligible
        .map((p) => {
          const role = p.tableRole ?? "pc";
          const lastIdx = lastMessageIndexFor(p.id, state.messages);
          const flags = [
            `name=${p.displayName}`,
            `role=${role}`,
            lastIdx < 0 ? "never-spoke" : `last-spoke-at-message=${lastIdx}`,
          ];
          if (lastSpeakerId === p.id) {
            flags.push("spoke-last");
          }
          return `- ${flags.join("; ")}`;
        })
        .join("\n");

      const partyLine = rpg.party
        .map((m) => {
          const name =
            state.participants.find((p) => p.id === m.participantId)?.displayName ??
            m.participantId;
          return `${name} HP ${m.hp}/${m.maxHp}`;
        })
        .join("; ");

      const nameList = eligible.map((p) => p.displayName).join(", ");

      const system = [
        "You are the spotlight coordinator for a theater-of-the-mind RPG table.",
        "Choose which LLM should speak next: the GM or a PC persona.",
        "Never pick a human — humans interrupt whenever they want outside this choice.",
        "Prefer the GM after a PC acts, to narrate consequences — unless a PC was clearly addressed and should answer immediately.",
        "Prefer a PC when the GM just posed a question, offered a choice, or left space for action.",
        "Rotate among PC personas. Do not keep picking the same PC when others have spoken less recently (see never-spoke / last-spoke-at-message).",
        "Prefer not to pick who just spoke unless a direct follow-up is clearly needed.",
        `Put the exact persona name in <nextSpeakerId> (one of: ${nameList}).`,
        "Respond with XML only (no markdown fences):",
        "<choice>",
        "  <nextSpeakerId>Persona Name</nextSpeakerId>",
        "  <reason><![CDATA[brief reason]]></reason>",
        "</choice>",
      ].join("\n");

      const user = [
        `Scene: ${rpg.sceneSummary}`,
        rpg.clock ? `Clock ${rpg.clock.name}: ${rpg.clock.value}/${rpg.clock.max}` : "Clock: none",
        `Party: ${partyLine || "(none)"}`,
        "",
        "Participants:",
        roster,
        "",
        formatRpgPromptMemory(state, TRANSCRIPT_WINDOW),
      ].join("\n");

      // Fail loud — no silent fallback. Orchestrator will pause with the error.
      const raw = await deps.complete({
        apiKey: deps.apiKey,
        model: deps.coordinatorModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
      });

      const token = requireXmlTag(raw, "nextSpeakerId");
      requireXmlTag(raw, "reason");
      return resolveSpeakerId(token, eligible, rpg.gmParticipantId);
    },
  };
}
