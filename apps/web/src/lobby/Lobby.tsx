import { useEffect, useMemo, useState } from "react";
import type { AdventureSeed, OpenRouterModel, PersonaDraft } from "@llm-table/shared";
import {
  ADVENTURE_SEEDS,
  getAdventureSeed,
  isBuiltinAdventureSeedId,
  resolveAdventureSeed,
} from "@llm-table/rpg";
import { PersonaEditor } from "../personas/PersonaEditor";
import { createSession } from "../lib/api";
import {
  loadCustomAdventureSeeds,
  loadLobbyDraft,
  saveCustomAdventureSeeds,
  saveLobbyDraft,
} from "../lib/storage";
import { SeedLibrary } from "./SeedLibrary";

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
  const [adventureSeedId, setAdventureSeedId] = useState("haunted-mill");
  const [customSeeds, setCustomSeeds] = useState<AdventureSeed[]>([]);
  const [gmPersonaId, setGmPersonaId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedSeed = useMemo(() => {
    const custom = customSeeds.find((s) => s.id === adventureSeedId);
    if (custom) {
      return custom;
    }
    try {
      return getAdventureSeed(adventureSeedId);
    } catch {
      return ADVENTURE_SEEDS[0];
    }
  }, [adventureSeedId, customSeeds]);

  const invitedPersonas = useMemo(() => {
    const invited = new Set(invitedIds);
    return personas.filter((p) => invited.has(p.id));
  }, [personas, invitedIds]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [draft, seeds] = await Promise.all([
        loadLobbyDraft(),
        loadCustomAdventureSeeds(),
      ]);
      if (cancelled) {
        return;
      }
      setCustomSeeds(seeds);
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
        if (draft.adventureSeedId) {
          setAdventureSeedId(draft.adventureSeedId);
        }
        if (draft.gmPersonaId) {
          setGmPersonaId(draft.gmPersonaId);
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
      adventureSeedId,
      gmPersonaId,
    });
  }, [
    personas,
    invitedIds,
    joinAsHuman,
    humanName,
    moduleId,
    adventureSeedId,
    gmPersonaId,
    draftReady,
  ]);

  useEffect(() => {
    if (!draftReady) {
      return;
    }
    void saveCustomAdventureSeeds(customSeeds);
  }, [customSeeds, draftReady]);

  // Keep selected seed valid when customs change
  useEffect(() => {
    if (!draftReady) {
      return;
    }
    const known =
      isBuiltinAdventureSeedId(adventureSeedId) ||
      customSeeds.some((s) => s.id === adventureSeedId);
    if (!known) {
      setAdventureSeedId(ADVENTURE_SEEDS[0]?.id ?? "blank");
    }
  }, [adventureSeedId, customSeeds, draftReady]);

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

  // Keep GM selection among currently invited personas
  useEffect(() => {
    if (!draftReady || invitedPersonas.length === 0) {
      return;
    }
    const invited = new Set(invitedPersonas.map((p) => p.id));
    if (!gmPersonaId || !invited.has(gmPersonaId)) {
      setGmPersonaId(invitedPersonas[0].id);
    }
  }, [invitedPersonas, gmPersonaId, draftReady]);

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
    if (moduleId === "rpg") {
      if (!gmPersonaId || !invitedPersonas.some((p) => p.id === gmPersonaId)) {
        setError("Choose which invited persona is the GM");
        return;
      }
      const pcCount =
        invitedPersonas.filter((p) => p.id !== gmPersonaId).length + (joinAsHuman ? 1 : 0);
      if (pcCount < 1) {
        setError("Need at least one PC besides the GM (invite another persona or join as human)");
        return;
      }
    }

    setBusy(true);
    try {
      const adventureSeed =
        moduleId === "rpg"
          ? resolveAdventureSeed({
              adventureSeedId,
              adventureSeed: selectedSeed,
            })
          : undefined;
      const result = await createSession({
        apiKey: apiKey.trim(),
        coordinatorModel: coordinatorModel.trim(),
        personas: invitedPersonas,
        humanName: joinAsHuman ? humanName.trim() : undefined,
        moduleId,
        adventureSeedId: moduleId === "rpg" ? adventureSeedId : undefined,
        adventureSeed,
        gmPersonaId: moduleId === "rpg" ? gmPersonaId : undefined,
        imageModel: moduleId === "rpg" && imageModel.trim() ? imageModel.trim() : undefined,
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
        <div className="lobby-pickers">
          {moduleId === "rpg" ? (
            <label className="field gm-picker">
              <span>Game Master</span>
              <select
                value={gmPersonaId}
                onChange={(e) => setGmPersonaId(e.target.value)}
                disabled={invitedPersonas.length === 0}
              >
                {invitedPersonas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName.trim() || "Unnamed persona"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field module-picker">
            <span>Table module</span>
            <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
              <option value="conversation">Conversation</option>
              <option value="poker">Texas Hold&apos;em</option>
              <option value="rpg">Roleplaying</option>
            </select>
          </label>
        </div>
      </header>

      {modelsError ? <p className="error-banner">{modelsError}</p> : null}

      {moduleId === "rpg" ? (
        <SeedLibrary
          customSeeds={customSeeds}
          selectedId={adventureSeedId}
          onCustomSeedsChange={setCustomSeeds}
          onSelect={setAdventureSeedId}
        />
      ) : null}

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
