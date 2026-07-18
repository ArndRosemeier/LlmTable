import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClientAction, ParticipantId, TableState } from "@llm-table/shared";
import { isRpgState, type RpgState } from "@llm-table/rpg";

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
}

function seatPosition(index: number, total: number): { left: string; top: string } {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const x = 50 + Math.cos(angle) * 48;
  const y = 50 + Math.sin(angle) * 47;
  return { left: `${x}%`, top: `${y}%` };
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
}: RpgTableViewProps) {
  const [draft, setDraft] = useState("");
  const [asAction, setAsAction] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const rpg: RpgState | null = isRpgState(state.moduleState) ? state.moduleState : null;
  const advance = rpg?.advance ?? { speakerId: null, mode: "idle" as const };
  const canSpeak =
    localParticipantId !== null &&
    (state.phase === "running" || state.phase === "paused");
  const canAdvance =
    state.phase === "running" &&
    typeof onAdvance === "function" &&
    (advance.mode === "preparing" || advance.mode === "ready");
  const nextSpeakerName =
    advance.speakerId != null
      ? (state.participants.find((p) => p.id === advance.speakerId)?.displayName ?? "speaker")
      : null;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !canSpeak) {
      return;
    }
    onAction({ type: "rpg.say", content, isAction: asAction });
    setDraft("");
    setAsAction(false);
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
          {canAdvance ? (
            <button type="button" className="btn" onClick={onAdvance}>
              {advance.mode === "preparing"
                ? `Preparing${nextSpeakerName ? ` ${nextSpeakerName}` : ""}…`
                : `Next${nextSpeakerName ? `: ${nextSpeakerName}` : ""}`}
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

          <div className="table-chat">
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
                    <img
                      className="chat-line-image"
                      src={m.imageDataUrl}
                      alt="Scene"
                    />
                  ) : null}
                  <span>{m.content}</span>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {state.participants.map((p) => {
          const pos = seatPosition(p.seatIndex, state.participants.length);
          const active = state.activeSpeakerId === p.id;
          const isGm = p.tableRole === "gm";
          return (
            <div
              key={p.id}
              className={[
                "seat",
                active ? "seat-active" : "",
                isGm ? "seat-gm" : "",
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
            </div>
          );
        })}
      </div>

      {canAdvance ? (
        <div className="rpg-advance-bar">
          <button type="button" className="btn btn-lg" onClick={onAdvance}>
            {advance.mode === "preparing"
              ? `Preparing${nextSpeakerName ? ` ${nextSpeakerName}` : ""}…`
              : `Next${nextSpeakerName ? `: ${nextSpeakerName}` : ""}`}
          </button>
        </div>
      ) : null}

      {localParticipantId ? (
        <form className="human-input rpg-human-input" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              !canSpeak
                ? "Start the adventure to join in"
                : asAction
                  ? "What do you attempt? (speaks now; discards pending Next)"
                  : "Your line… (speaks now; discards pending Next)"
            }
            disabled={!canSpeak}
          />
          <label className="checkbox-row rpg-action-toggle">
            <input
              type="checkbox"
              checked={asAction}
              onChange={(e) => setAsAction(e.target.checked)}
              disabled={!canSpeak}
            />
            <span>Action</span>
          </label>
          <button type="submit" className="btn" disabled={!canSpeak || !draft.trim()}>
            {asAction ? "Attempt" : "Say"}
          </button>
        </form>
      ) : (
        <p className="spectator-note">Spectating — press Next to advance the table</p>
      )}
    </div>
  );
}
