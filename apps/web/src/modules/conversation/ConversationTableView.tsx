import { useState, type FormEvent } from "react";
import type { ClientAction, ParticipantId, TableState } from "@llm-table/shared";
import { useStickChatToBottom } from "../../lib/useStickChatToBottom";

export interface ConversationTableViewProps {
  state: TableState;
  localParticipantId: ParticipantId | null;
  onAction: (action: ClientAction) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

function seatPosition(index: number, total: number): { left: string; top: string } {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const x = 50 + Math.cos(angle) * 48;
  const y = 50 + Math.sin(angle) * 47;
  return { left: `${x}%`, top: `${y}%` };
}

export function ConversationTableView({
  state,
  localParticipantId,
  onAction,
  onStart,
  onPause,
  onResume,
  onStop,
}: ConversationTableViewProps) {
  const [draft, setDraft] = useState("");
  const lastMessage = state.messages.at(-1);
  const { chatRef, chatEndRef } = useStickChatToBottom([
    state.messages.length,
    lastMessage?.id,
    lastMessage?.content,
  ]);
  const canSpeak =
    localParticipantId !== null &&
    (state.phase === "running" || state.phase === "paused");
  const isMyTurn =
    localParticipantId !== null && state.activeSpeakerId === localParticipantId;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !canSpeak) {
      return;
    }
    onAction({ type: "chat.say", content });
    setDraft("");
  }

  return (
    <div className="table-screen">
      <div className="table-toolbar">
        <div>
          <h2>Conversation table</h2>
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
        <div className="table-felt">
          <div className="table-chat" ref={chatRef}>
            {state.messages.length === 0 ? (
              <p className="chat-empty">No messages yet. Start the conversation when ready.</p>
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
          return (
            <div
              key={p.id}
              className={active ? "seat seat-active" : "seat"}
              style={{ left: pos.left, top: pos.top }}
            >
              {p.persona?.portraitDataUrl ? (
                <img
                  className="seat-portrait"
                  src={p.persona.portraitDataUrl}
                  alt=""
                />
              ) : null}
              <span className="seat-name">{p.displayName}</span>
              <span className="seat-kind">{p.kind === "human" ? "Human" : "LLM"}</span>
            </div>
          );
        })}
      </div>

      {localParticipantId ? (
        <form className="human-input" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              !canSpeak
                ? "Start the table to join the conversation"
                : isMyTurn
                  ? "Your turn — speak, or stay silent to pass…"
                  : "Interrupt anytime…"
            }
            disabled={!canSpeak}
          />
          <button type="submit" className="btn" disabled={!canSpeak || !draft.trim()}>
            Speak
          </button>
        </form>
      ) : (
        <p className="spectator-note">LLM-only table — no human seat this round</p>
      )}
    </div>
  );
}
