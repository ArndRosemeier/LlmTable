import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ClientAction, ParticipantId, TableState } from "@llm-table/shared";
import {
  formatCard,
  isPokerState,
  legalActions,
  type PokerState,
} from "@llm-table/poker";
import { PlayingCard } from "./PlayingCard";

export interface PokerTableViewProps {
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
  const x = 50 + Math.cos(angle) * 42;
  const y = 50 + Math.sin(angle) * 40;
  return { left: `${x}%`, top: `${y}%` };
}

export function PokerTableView({
  state,
  localParticipantId,
  onAction,
  onStart,
  onPause,
  onResume,
  onStop,
}: PokerTableViewProps) {
  const [talk, setTalk] = useState("");
  const [raiseTo, setRaiseTo] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const poker: PokerState | null = isPokerState(state.moduleState) ? state.moduleState : null;
  const isMyTurn =
    localParticipantId !== null &&
    poker?.actingParticipantId === localParticipantId &&
    state.phase === "running";

  const legal = useMemo(() => {
    if (!poker || !localParticipantId || !isMyTurn) {
      return null;
    }
    try {
      return legalActions(poker, localParticipantId);
    } catch {
      return null;
    }
  }, [poker, localParticipantId, isMyTurn]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length]);

  useEffect(() => {
    if (legal?.minRaiseTo) {
      setRaiseTo(String(legal.minRaiseTo));
    }
  }, [legal?.minRaiseTo, state.activeSpeakerId]);

  function act(action: ClientAction): void {
    onAction(action);
    setTalk("");
  }

  function submitPoker(
    action: "fold" | "check" | "call" | "bet" | "raise",
    event?: FormEvent,
  ): void {
    event?.preventDefault();
    if (!isMyTurn) {
      return;
    }
    act({
      type: "poker.act",
      action,
      raiseTo: action === "bet" || action === "raise" ? Number(raiseTo) : undefined,
      tableTalk: talk.trim() || undefined,
    });
  }

  function submitRailTalk(event: FormEvent): void {
    event.preventDefault();
    const content = talk.trim();
    if (!content || !localParticipantId) {
      return;
    }
    act({ type: "chat.say", content });
    setTalk("");
  }

  return (
    <div className="table-screen poker-screen">
      <div className="table-toolbar">
        <div>
          <h2>Texas Hold&apos;em</h2>
          <p className="status-line">
            {state.error ? (
              <span className="error-text">{state.error}</span>
            ) : (
              <>
                {poker ? (
                  <span>
                    Hand #{poker.handNumber} · {poker.street} · pot {poker.pot}
                    {poker.lastActionSummary ? ` · ${poker.lastActionSummary}` : ""}
                  </span>
                ) : (
                  state.statusMessage ?? `Phase: ${state.phase}`
                )}
              </>
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
        <div className="table-felt poker-felt">
          <div className="poker-board">
            <div className="community-cards">
              {(poker?.communityCards ?? []).map((c, i) => (
                <PlayingCard key={`${formatCard(c)}-${i}`} card={c} size="lg" />
              ))}
              {poker && poker.communityCards.length === 0 ? (
                <span className="board-placeholder">Board</span>
              ) : null}
            </div>
            <div className="pot-chip">Pot {poker?.pot ?? 0}</div>
            {poker?.winners?.length ? (
              <div className="winners-banner">
                {poker.winners.map((w) => {
                  const name =
                    state.participants.find((p) => p.id === w.participantId)?.displayName ??
                    w.participantId;
                  return (
                    <div key={w.participantId}>
                      {name} wins {w.amount} — {w.handName}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="table-chat poker-chat">
            {state.messages.length === 0 ? (
              <p className="chat-empty">Table talk shows up here.</p>
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
          const ps = poker?.players.find((x) => x.participantId === p.id);
          const showCards =
            ps &&
            (ps.holeCards.length > 0 ||
              (poker &&
                poker.street !== "betweenHands" &&
                ps.status !== "folded"));
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
              <span className="seat-kind">
                {ps ? `${ps.stack} chips` : p.kind}{" "}
                {ps?.status === "folded" ? "· folded" : ""}
                {ps?.betThisStreet ? ` · bet ${ps.betThisStreet}` : ""}
              </span>
              {showCards ? (
                <div className="seat-cards">
                  {ps && ps.holeCards.length > 0 ? (
                    ps.holeCards.map((c, i) => (
                      <PlayingCard key={`${p.id}-${i}`} card={c} size="sm" />
                    ))
                  ) : (
                    <>
                      <PlayingCard faceDown size="sm" />
                      <PlayingCard faceDown size="sm" />
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {localParticipantId ? (
        <div className="poker-controls">
          {isMyTurn && legal ? (
            <>
              <div className="hole-preview">
                <span className="status-line">Your hand</span>
                <div className="hole-preview-cards">
                  {(
                    poker?.players.find((p) => p.participantId === localParticipantId)
                      ?.holeCards ?? []
                  ).map((c, i) => (
                    <PlayingCard key={`hole-${i}`} card={c} size="md" />
                  ))}
                </div>
              </div>
              <form
                className="human-input"
                onSubmit={(e) => {
                  e.preventDefault();
                }}
              >
                <input
                  value={talk}
                  onChange={(e) => setTalk(e.target.value)}
                  placeholder="Table talk with your action (optional)…"
                />
              </form>
              <div className="poker-action-row">
                <button type="button" className="btn btn-secondary" onClick={() => submitPoker("fold")}>
                  Fold
                </button>
                {legal.canCheck ? (
                  <button type="button" className="btn" onClick={() => submitPoker("check")}>
                    Check
                  </button>
                ) : null}
                {legal.canCall ? (
                  <button type="button" className="btn" onClick={() => submitPoker("call")}>
                    Call {legal.callAmount}
                  </button>
                ) : null}
                {(legal.canBet || legal.canRaise) && (
                  <>
                    <label className="raise-field">
                      <span>Raise to</span>
                      <input
                        type="number"
                        value={raiseTo}
                        min={legal.minRaiseTo}
                        max={legal.maxRaiseTo}
                        onChange={(e) => setRaiseTo(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => submitPoker(legal.canBet ? "bet" : "raise")}
                    >
                      {legal.canBet ? "Bet" : "Raise"}
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <form className="human-input" onSubmit={submitRailTalk}>
              <input
                value={talk}
                onChange={(e) => setTalk(e.target.value)}
                placeholder={
                  state.phase === "running" || state.phase === "paused"
                    ? "Comment anytime…"
                    : "Start the hand to play"
                }
                disabled={state.phase === "lobby"}
              />
              <button
                type="submit"
                className="btn"
                disabled={state.phase === "lobby" || !talk.trim()}
              >
                Say
              </button>
            </form>
          )}
        </div>
      ) : (
        <p className="spectator-note">Spectating</p>
      )}
    </div>
  );
}
