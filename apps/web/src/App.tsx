import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenRouterModel, ParticipantId, TableState } from "@llm-table/shared";
import { fetchModels, fetchSession } from "./lib/api";
import {
  clearActiveSession,
  loadActiveSession,
  loadApiKey,
  loadCoordinatorModel,
  saveActiveSession,
  saveApiKey,
  saveCoordinatorModel,
} from "./lib/storage";
import { SessionSocket } from "./lib/sessionSocket";
import { Lobby } from "./lobby/Lobby";
import { getVisualization } from "./modules/registry";
import { OpenRouterSettings } from "./settings/OpenRouterSettings";

export function App() {
  const [settingsReady, setSettingsReady] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [coordinatorModel, setCoordinatorModel] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [localParticipantId, setLocalParticipantId] = useState<ParticipantId | null>(null);
  const [state, setState] = useState<TableState | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);

  const socketRef = useRef(new SessionSocket());
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const userEditedApiKeyRef = useRef(false);
  const restoredSessionRef = useRef(false);

  const connectToSession = useCallback(
    (nextSessionId: string, nextLocalParticipantId: string | null, key: string) => {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        setSocketError("OpenRouter API key required to join. Save your key in settings first.");
        setSessionId(null);
        setState(null);
        setLocalParticipantId(null);
        return;
      }

      setSocketError(null);
      setSessionId(nextSessionId);
      setLocalParticipantId(nextLocalParticipantId);
      void saveActiveSession({
        sessionId: nextSessionId,
        localParticipantId: nextLocalParticipantId,
      });
      socketRef.current.connect(nextSessionId, trimmedKey, nextLocalParticipantId, {
        onState: (next, localId) => {
          setState(next);
          setLocalParticipantId(localId);
        },
        onError: (message) => {
          setSocketError(message);
          if (message.toLowerCase().includes("api key")) {
            setSessionId(null);
            setState(null);
            setLocalParticipantId(null);
            void clearActiveSession();
          }
        },
        onClose: () => setSocketError("Disconnected from session"),
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [key, model] = await Promise.all([loadApiKey(), loadCoordinatorModel()]);
      if (cancelled) {
        return;
      }
      // Never clobber a key the user already typed/saved in this session.
      setApiKey((current) => (userEditedApiKeyRef.current || current.trim() ? current : key));
      setCoordinatorModel((current) => (current.trim() ? current : model));
      setSettingsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady || restoredSessionRef.current) {
      if (settingsReady) {
        setRestoringSession(false);
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      // Read key from IDB at join time — avoid racing with mid-typing state.
      const storedKey = (await loadApiKey()).trim();
      const key = storedKey || apiKeyRef.current.trim();
      if (!key) {
        setRestoringSession(false);
        return;
      }

      const active = await loadActiveSession();
      if (cancelled) {
        return;
      }
      if (!active) {
        setRestoringSession(false);
        return;
      }

      try {
        await fetchSession(active.sessionId);
        if (cancelled) {
          return;
        }
        restoredSessionRef.current = true;
        connectToSession(active.sessionId, active.localParticipantId, key);
      } catch {
        await clearActiveSession();
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settingsReady, connectToSession]);

  const reloadModels = useCallback(async (key: string) => {
    if (!key.trim()) {
      setModels([]);
      setModelsError("Enter an API key to load models");
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await fetchModels(key.trim());
      setModels(list);
      setCoordinatorModel((current) => {
        if (current) {
          return current;
        }
        const first = list[0]?.id ?? "";
        if (first) {
          void saveCoordinatorModel(first);
        }
        return first;
      });
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    if (!settingsReady || !apiKey.trim()) {
      return;
    }
    void reloadModels(apiKey);
    // intentionally only on settingsReady — not on every apiKey keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, reloadModels]);

  useEffect(() => {
    return () => {
      socketRef.current.close();
    };
  }, []);

  async function handleSaveSettings(): Promise<void> {
    const trimmed = apiKey.trim();
    userEditedApiKeyRef.current = true;
    await saveApiKey(trimmed);
    await saveCoordinatorModel(coordinatorModel);
    setApiKey(trimmed);
    apiKeyRef.current = trimmed;
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
    await reloadModels(trimmed);
  }

  function handleSessionCreated(payload: {
    sessionId: string;
    localParticipantId: string | null;
    apiKey: string;
  }): void {
    connectToSession(payload.sessionId, payload.localParticipantId, payload.apiKey);
  }

  function leaveSession(): void {
    try {
      socketRef.current.send({ type: "session.pause" });
    } catch {
      // socket may already be closed
    }
    socketRef.current.close();
    setSessionId(null);
    setState(null);
    setLocalParticipantId(null);
    setSocketError(null);
    void clearActiveSession();
  }

  const Visualization = useMemo(
    () => (state ? getVisualization(state.moduleId) : null),
    [state],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand" onClick={() => (sessionId ? leaveSession() : undefined)}>
          <span className="brand-mark">LlmTable</span>
        </div>
        <OpenRouterSettings
          apiKey={apiKey}
          coordinatorModel={coordinatorModel}
          models={models}
          loadingModels={loadingModels}
          savedFlash={savedFlash}
          onApiKeyChange={(value) => {
            userEditedApiKeyRef.current = true;
            setApiKey(value);
          }}
          onCoordinatorModelChange={(id) => {
            setCoordinatorModel(id);
            void saveCoordinatorModel(id);
          }}
          onSave={() => {
            void handleSaveSettings();
          }}
        />
      </header>

      {modelsError && !sessionId ? <p className="error-banner">{modelsError}</p> : null}
      {socketError ? <p className="error-banner">{socketError}</p> : null}

      <main className={sessionId && state ? "app-main app-main-session" : "app-main"}>
        {!settingsReady || restoringSession ? (
          <p className="section-hint">Loading…</p>
        ) : !sessionId || !state || !Visualization ? (
          <Lobby
            apiKey={apiKey}
            coordinatorModel={coordinatorModel}
            models={models}
            modelsError={null}
            onSessionCreated={handleSessionCreated}
          />
        ) : (
          <div className="session-view">
            <Visualization
              state={state}
              localParticipantId={localParticipantId}
              onAction={(action) =>
                socketRef.current.send({ type: "action.submit", action })
              }
              onStart={() => {
                if (!apiKeyRef.current.trim()) {
                  setSocketError("Save your OpenRouter API key before starting");
                  return;
                }
                socketRef.current.send({
                  type: "session.start",
                  apiKey: apiKeyRef.current.trim(),
                });
              }}
              onPause={() => socketRef.current.send({ type: "session.pause" })}
              onResume={() => {
                if (!apiKeyRef.current.trim()) {
                  setSocketError("Save your OpenRouter API key before resuming");
                  return;
                }
                socketRef.current.send({
                  type: "session.resume",
                  apiKey: apiKeyRef.current.trim(),
                });
              }}
              onStop={leaveSession}
            />
          </div>
        )}
      </main>
    </div>
  );
}
