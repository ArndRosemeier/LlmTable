import { useEffect, useMemo, useState } from "react";
import type { OpenRouterModel, PersonaDraft } from "@llm-table/shared";
import { PersonaEditor } from "../personas/PersonaEditor";
import { createSession } from "../lib/api";
import { loadLobbyDraft, saveLobbyDraft } from "../lib/storage";

function defaultPersonas(defaultModel: string): PersonaDraft[] {
  return [
    {
      id: crypto.randomUUID(),
      displayName: "Avery",
      systemPrompt:
        "You are Avery, a warm, curious conversationalist who asks good follow-up questions and notices small details.",
      model: defaultModel,
    },
    {
      id: crypto.randomUUID(),
      displayName: "Blake",
      systemPrompt:
        "You are Blake, dry-witted and slightly contrarian. You challenge assumptions playfully without being cruel.",
      model: defaultModel,
    },
  ];
}

export interface LobbyProps {
  apiKey: string;
  coordinatorModel: string;
  imageModel: string;
  models: OpenRouterModel[];
  modelsError: string | null;
  onSessionCreated: (payload: {
    sessionId: string;
    localParticipantId: string | null;
    apiKey: string;
  }) => void;
}

export function Lobby({
  apiKey,
  coordinatorModel,
  imageModel,
  models,
  modelsError,
  onSessionCreated,
}: LobbyProps) {
  const [draftReady, setDraftReady] = useState(false);
  const [personas, setPersonas] = useState<PersonaDraft[]>([]);
  const [invitedIds, setInvitedIds] = useState<string[]>([]);
  const [humanName, setHumanName] = useState("");
  const [joinAsHuman, setJoinAsHuman] = useState(false);
  const [moduleId, setModuleId] = useState("conversation");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invitedPersonas = useMemo(() => {
    const invited = new Set(invitedIds);
    return personas.filter((p) => invited.has(p.id));
  }, [personas, invitedIds]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const draft = await loadLobbyDraft();
      if (cancelled) {
        return;
      }
      if (draft && draft.personas.length >= 1) {
        setPersonas(draft.personas);
        const validIds = new Set(draft.personas.map((p) => p.id));
        const restoredInvites =
          draft.invitedIds?.filter((id) => validIds.has(id)) ??
          draft.personas.map((p) => p.id);
        setInvitedIds(restoredInvites.length > 0 ? restoredInvites : draft.personas.map((p) => p.id));
        setJoinAsHuman(draft.joinAsHuman);
        setHumanName(draft.humanName);
        if (draft.moduleId) {
          setModuleId(draft.moduleId);
        }
      } else {
        const defaults = defaultPersonas("");
        setPersonas(defaults);
        setInvitedIds(defaults.map((p) => p.id));
      }
      setDraftReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!draftReady) {
      return;
    }
    void saveLobbyDraft({
      personas,
      invitedIds,
      joinAsHuman,
      humanName,
      moduleId,
    });
  }, [personas, invitedIds, joinAsHuman, humanName, moduleId, draftReady]);

  useEffect(() => {
    const fallback = models[0]?.id ?? coordinatorModel;
    if (!fallback || !draftReady) {
      return;
    }
    setPersonas((current) =>
      current.map((p) => (p.model.trim() ? p : { ...p, model: fallback })),
    );
  }, [models, coordinatorModel, draftReady]);

  // Drop invite ids that no longer exist
  useEffect(() => {
    if (!draftReady) {
      return;
    }
    const valid = new Set(personas.map((p) => p.id));
    setInvitedIds((current) => {
      const next = current.filter((id) => valid.has(id));
      return next.length === current.length ? current : next;
    });
  }, [personas, draftReady]);

  async function handleCreate(): Promise<void> {
    setError(null);

    if (!apiKey.trim()) {
      setError("Set an OpenRouter API key in settings first");
      return;
    }
    if (!coordinatorModel.trim()) {
      setError("Choose a coordinator model in settings");
      return;
    }
    if (invitedPersonas.length < 2) {
      setError("Invite at least 2 personas to the table");
      return;
    }
    for (const p of invitedPersonas) {
      if (!p.displayName.trim() || !p.systemPrompt.trim() || !p.model.trim()) {
        setError("Each invited persona needs a name, definition, and model");
        return;
      }
    }
    if (joinAsHuman && !humanName.trim()) {
      setError("Enter a name to join as human");
      return;
    }

    setBusy(true);
    try {
      const result = await createSession({
        apiKey: apiKey.trim(),
        coordinatorModel: coordinatorModel.trim(),
        personas: invitedPersonas,
        humanName: joinAsHuman ? humanName.trim() : undefined,
        moduleId,
      });
      onSessionCreated({
        sessionId: result.sessionId,
        localParticipantId: result.localParticipantId,
        apiKey: apiKey.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!draftReady) {
    return <p className="section-hint">Loading lobby…</p>;
  }

  return (
    <div className="lobby">
      <header className="lobby-hero">
        <div>
          <h1>LlmTable</h1>
          <p>
            Build a persona roster, invite who sits this round, then pick a module. Rules layer on
            top of the same personas.
          </p>
          <p className="section-hint">
            Invited to this table: {invitedPersonas.length} / {personas.length}
          </p>
        </div>
        <label className="field module-picker">
          <span>Table module</span>
          <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            <option value="conversation">Conversation</option>
            <option value="poker">Texas Hold&apos;em</option>
          </select>
        </label>
      </header>

      {modelsError ? <p className="error-banner">{modelsError}</p> : null}

      <PersonaEditor
        personas={personas}
        invitedIds={invitedIds}
        models={models}
        apiKey={apiKey}
        imageModel={imageModel}
        onChange={setPersonas}
        onInvitedChange={setInvitedIds}
      />

      {error ? <p className="error-banner error-banner-inline">{error}</p> : null}

      <div className="lobby-footer">
        <section className="human-join">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={joinAsHuman}
              onChange={(e) => setJoinAsHuman(e.target.checked)}
            />
            <span>Join as human (optional)</span>
          </label>
          {joinAsHuman ? (
            <label className="field">
              <span>Your name</span>
              <input
                value={humanName}
                onChange={(e) => setHumanName(e.target.value)}
                placeholder="Your name at the table"
              />
            </label>
          ) : null}
        </section>

        <button type="button" className="btn btn-lg" disabled={busy} onClick={() => void handleCreate()}>
          {busy ? "Creating…" : `Create table (${invitedPersonas.length} personas)`}
        </button>
      </div>
    </div>
  );
}
