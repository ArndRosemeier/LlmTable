import type {
  ClientToServerMessage,
  ParticipantId,
  ServerToClientMessage,
  SessionId,
  TableState,
} from "@llm-table/shared";

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export type SessionSocketHandlers = {
  onState: (state: TableState, localParticipantId: ParticipantId | null) => void;
  onError: (message: string) => void;
  onClose: () => void;
};

export class SessionSocket {
  private ws: WebSocket | null = null;

  connect(
    sessionId: SessionId,
    apiKey: string,
    participantId: ParticipantId | null,
    handlers: SessionSocketHandlers,
  ): void {
    this.close();
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      const join: ClientToServerMessage = {
        type: "session.join",
        sessionId,
        apiKey,
        participantId: participantId ?? undefined,
      };
      ws.send(JSON.stringify(join));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerToClientMessage;
      if (msg.type === "session.updated" || msg.type === "session.created") {
        handlers.onState(msg.state, msg.localParticipantId);
        return;
      }
      if (msg.type === "session.error") {
        handlers.onError(msg.message);
      }
    };

    ws.onerror = () => {
      handlers.onError("WebSocket connection error");
    };

    ws.onclose = () => {
      handlers.onClose();
    };
  }

  send(message: ClientToServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
