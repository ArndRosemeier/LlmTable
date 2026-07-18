import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { ClientAction, ParticipantId, TableState } from "@llm-table/shared";
import {
  isRpgState,
  type RpgPreparationPhase,
  type RpgPreparationProgress,
  type RpgState,
} from "@llm-table/rpg";
import { useStickChatToBottom } from "../../lib/useStickChatToBottom";

export interface RpgTableViewProps {
  state: TableState;
  localParticipantId: ParticipantId | null;
  onAction: (action: ClientAction) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onNextHand?: () => void;
  onAdvance?: () => void;
  onSetGmImages?: (enabled: boolean) => void;
}

const PHASE_SHORT: Record<RpgPreparationPhase, string> = {
  choosing_speaker: "Picking…",
  generating_turn: "Writing…",
  creating_image: "Image…",
  finalizing: "Finishing…",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function seatPosition(index: number, total: number): { left: string; top: string } {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const x = 50 + Math.cos(angle) * 48;
  const y = 50 + Math.sin(angle) * 47;
  return { left: `${x}%`, top: `${y}%` };
}

function ChatSceneImage({
  src,
  prompt,
}: {
  src: string;
  prompt: string | undefined;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !prompt || !wrapRef.current) {
      return;
    }

    function updatePosition(): void {
      const el = wrapRef.current;
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      setCoords({
        left: rect.left + rect.width / 2,
        top: rect.top,
        width: Math.min(rect.width, 28 * 16),
      });
    }

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, prompt]);

  return (
    <div
      ref={wrapRef}
      className="chat-line-image-wrap"
      tabIndex={prompt ? 0 : undefined}
      onMouseEnter={() => {
        if (prompt) {
          setOpen(true);
        }
      }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => {
        if (prompt) {
          setOpen(true);
        }
      }}
      onBlur={() => setOpen(false)}
    >
      <img
        className="chat-line-image"
        src={src}
        alt={prompt ? `Scene: ${prompt}` : "Scene"}
      />
      {open && prompt && coords
        ? createPortal(
            <div
              className="chat-line-image-prompt"
              role="tooltip"
              style={{
                left: coords.left,
                top: coords.top,
                width: coords.width,
              }}
            >
              {prompt}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SeatPreparingBadge({ progress }: { progress: RpgPreparationProgress | undefined }) {
  const phase = progress?.phase ?? "generating_turn";
  let metric = "";
  if (progress?.receivedChars != null && progress.receivedChars > 0) {
    metric = `${progress.receivedChars}c`;
  } else if (progress?.receivedBytes != null && progress.receivedBytes > 0) {
    metric = formatBytes(progress.receivedBytes);
  } else if (progress?.completionTokens != null) {
    metric = `${progress.completionTokens} tok`;
  } else if (progress?.imagePartialFrames != null && progress.imagePartialFrames > 0) {
    metric = `${progress.imagePartialFrames}f`;
  }

  return (
    <div className="seat-preparing" aria-live="polite">
      <span className="seat-preparing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="seat-preparing-label">{PHASE_SHORT[phase]}</span>
      {metric ? <span className="seat-preparing-metric">{metric}</span> : null}
    </div>
  );
}

export function RpgTableView({
  state,
  localParticipantId,
  onAction,
  onStart,
  onPause,
  onResume,
  onStop,
  onAdvance,
  onSetGmImages,
}: RpgTableViewProps) {
  const [draft, setDraft] = useState("");
  const lastMessage = state.messages.at(-1);
  const { chatRef, chatEndRef } = useStickChatToBottom([
    state.messages.length,
    lastMessage?.id,
    lastMessage?.content,
    lastMessage?.imageDataUrl,
  ]);

  const rpg: RpgState | null = isRpgState(state.moduleState) ? state.moduleState : null;
  const advance = rpg?.advance ?? { speakerId: null, mode: "idle" as const };
  const canSpeak =
    localParticipantId !== null &&
    (state.phase === "running" || state.phase === "paused");
  const isPreparing = advance.mode === "preparing";
  const isRevealing = advance.mode === "revealing";
  const isAwaitingHuman = advance.mode === "awaiting_human";
  const awaitingLocal =
    isAwaitingHuman &&
    localParticipantId != null &&
    advance.speakerId === localParticipantId;
  const handRaised =
    localParticipantId != null && rpg?.raisedHandParticipantId === localParticipantId;
  const canSignalHand =
    canSpeak && state.phase === "running" && localParticipantId != null;
  const showAdvanceButton =
    state.phase === "running" && typeof onAdvance === "function" && !isAwaitingHuman;
  const canPressNext = showAdvanceButton && advance.mode === "ready" && !isRevealing;
  const nextSpeakerName =
    advance.speakerId != null
      ? (state.participants.find((p) => p.id === advance.speakerId)?.displayName ?? "speaker")
      : null;
  const preparingSpeakerId = isPreparing ? advance.speakerId : null;
  const showChoosingBadge =
    isPreparing && preparingSpeakerId == null && advance.progress?.phase === "choosing_speaker";
  const gmImagesEnabled = state.gmImagesEnabled === true;
  const showImagesToggle =
    state.phase !== "lobby" && typeof onSetGmImages === "function";

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !canSpeak) {
      return;
    }
    onAction({ type: "rpg.say", content, isAction: false });
    setDraft("");
  }

  function handleHandToggle(): void {
    if (!canSignalHand) {
      return;
    }
    if (handRaised || awaitingLocal) {
      onAction({ type: "rpg.lowerHand" });
      return;
    }
    onAction({ type: "rpg.raiseHand" });
  }

  function handleAdvanceClick(): void {
    if (!onAdvance) {
      return;
    }
    if (!canPressNext) {
      return;
    }
    onAdvance();
  }

  return (
    <div className="table-screen rpg-screen">
      <div className="table-toolbar">
        <div>
          <h2>{rpg?.publicSeed.title ?? "Roleplaying"}</h2>
          <p className="status-line">
            {state.error ? (
              <span className="error-text">{state.error}</span>
            ) : (
              state.statusMessage ?? `Phase: ${state.phase}`
            )}
          </p>
        </div>
        <div className="toolbar-actions">
          {state.phase === "lobby" ? (
            <button type="button" className="btn" onClick={onStart}>
              Start
            </button>
          ) : null}
          {state.phase === "running" ? (
            <button type="button" className="btn btn-secondary" onClick={onPause}>
              Pause
            </button>
          ) : null}
          {state.phase === "paused" ? (
            <button type="button" className="btn" onClick={onResume}>
              Resume
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={onStop}>
            Stop
          </button>
        </div>
      </div>

      <div className="table-stage">
        <div className="table-felt rpg-felt">
          <div className="rpg-scene">
            <p className="rpg-scene-summary">
              {rpg?.sceneSummary ?? "The adventure has not begun."}
            </p>
            {rpg?.clock ? (
              <p className="rpg-clock">
                {rpg.clock.name}: {rpg.clock.value}/{rpg.clock.max}
              </p>
            ) : null}
            {rpg?.lastRoll ? (
              <p className="rpg-last-roll">
                Last roll — {rpg.lastRoll.label}: {rpg.lastRoll.total} vs DC {rpg.lastRoll.dc}{" "}
                ({rpg.lastRoll.success ? "success" : "failure"})
              </p>
            ) : null}
            {rpg?.party.length ? (
              <ul className="rpg-party">
                {rpg.party.map((m) => {
                  const name =
                    state.participants.find((p) => p.id === m.participantId)?.displayName ??
                    m.participantId;
                  return (
                    <li key={m.participantId}>
                      {name}: {m.hp}/{m.maxHp} HP
                      {m.tags.length ? ` · ${m.tags.join(", ")}` : ""}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="table-chat" ref={chatRef}>
            {state.messages.length === 0 ? (
              <p className="chat-empty">
                Start when ready, then press Next — the GM persona opens the scene.
              </p>
            ) : (
              state.messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.participantId === localParticipantId
                      ? "chat-line chat-line-self"
                      : "chat-line"
                  }
                >
                  <strong>{m.displayName}</strong>
                  {m.imageDataUrl ? (
                    <ChatSceneImage src={m.imageDataUrl} prompt={m.imagePrompt} />
                  ) : null}
                  <span>{m.content}</span>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {showChoosingBadge ? (
          <div className="rpg-choosing-badge" aria-live="polite">
            <SeatPreparingBadge progress={advance.progress} />
          </div>
        ) : null}

        {state.participants.map((p) => {
          const pos = seatPosition(p.seatIndex, state.participants.length);
          const active = state.activeSpeakerId === p.id;
          const isGm = p.tableRole === "gm";
          const isPreparingHere = preparingSpeakerId === p.id;
          const handUpHere =
            rpg?.raisedHandParticipantId === p.id ||
            (isAwaitingHuman && advance.speakerId === p.id);
          return (
            <div
              key={p.id}
              className={[
                "seat",
                active ? "seat-active" : "",
                isGm ? "seat-gm" : "",
                handUpHere ? "seat-hand-up" : "",
                isPreparingHere ? "seat-preparing-host" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ left: pos.left, top: pos.top }}
            >
              {p.persona?.portraitDataUrl ? (
                <img className="seat-portrait" src={p.persona.portraitDataUrl} alt="" />
              ) : null}
              <span className="seat-name">{p.displayName}</span>
              <span className="seat-kind">{isGm ? "GM" : p.kind === "human" ? "Human" : "PC"}</span>
              {isGm && showImagesToggle ? (
                <label className="seat-gm-images">
                  <input
                    type="checkbox"
                    checked={gmImagesEnabled}
                    onChange={(e) => onSetGmImages?.(e.target.checked)}
                  />
                  <span>Pictures</span>
                </label>
              ) : null}
              {p.id === localParticipantId ? (
                <button
                  type="button"
                  className={[
                    "seat-hand-btn",
                    handRaised || awaitingLocal ? "seat-hand-btn-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={handleHandToggle}
                  disabled={!canSignalHand}
                  aria-pressed={handRaised || awaitingLocal}
                  title={
                    rpg?.preferGmNext && (handRaised || awaitingLocal)
                      ? "Hand raised — waiting until after the GM"
                      : handRaised || awaitingLocal
                        ? "Lower hand"
                        : "Raise hand to be picked on the next player turn"
                  }
                >
                  {handRaised || awaitingLocal ? "✋ Lower hand" : "✋ Raise hand"}
                </button>
              ) : handUpHere ? (
                <span className="seat-hand-raised">✋ Hand up</span>
              ) : null}
              {isPreparingHere ? <SeatPreparingBadge progress={advance.progress} /> : null}
            </div>
          );
        })}
      </div>

      <div className="rpg-footer-slot">
        <div
          className={[
            "rpg-advance-bar",
            showAdvanceButton ? "" : "rpg-advance-bar-idle",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <button
            type="button"
            className="btn btn-lg"
            onClick={handleAdvanceClick}
            disabled={!canPressNext}
            aria-busy={isRevealing || isPreparing}
          >
            {isRevealing
              ? `Revealing${nextSpeakerName ? `: ${nextSpeakerName}` : ""}…`
              : isPreparing
                ? `Preparing${nextSpeakerName ? `: ${nextSpeakerName}` : ""}…`
                : `Next${nextSpeakerName ? `: ${nextSpeakerName}` : ""}`}
          </button>
        </div>
      </div>

      {localParticipantId ? (
        <form className="human-input rpg-human-input" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              !canSpeak
                ? "Start the adventure to join in"
                : awaitingLocal
                  ? "Your turn — type your line"
                  : handRaised
                    ? "Hand raised — you'll be picked on the next player turn"
                    : "Your line… (speaks now; discards pending Next)"
            }
            disabled={!canSpeak}
          />
          <button type="submit" className="btn" disabled={!canSpeak || !draft.trim()}>
            Say
          </button>
        </form>
      ) : (
        <p className="spectator-note">LLM-only table — press Next to advance</p>
      )}
    </div>
  );
}
