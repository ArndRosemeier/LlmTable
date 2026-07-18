import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenRouterModel, ParticipantId, TableState } from "@llm-table/shared";
import { listImageModels, listModels } from "./lib/openrouter";
import { LocalSessionController } from "./lib/localSession";
import {
  BackupCancelledError,
  loadApiKey,
  loadBackupFromFile,
  loadCoordinatorModel,
  loadImageModel,
  saveApiKey,
  saveBackupToFile,
  saveCoordinatorModel,
  saveImageModel,
} from "./lib/storage";
import { Lobby } from "./lobby/Lobby";
import { getVisualization } from "./modules/registry";
import { OpenRouterSettings } from "./settings/OpenRouterSettings";

export function App() {
  const [settingsReady, setSettingsReady] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [coordinatorModel, setCoordinatorModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [imageModels, setImageModels] = useState<OpenRouterModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [localParticipantId, setLocalParticipantId] = useState<ParticipantId | null>(null);
  const [state, setState] = useState<TableState | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);

  const controllerRef = useRef(new LocalSessionController());
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const userEditedApiKeyRef = useRef(false);
  const restoredSessionRef = useRef(false);

  const syncFromController = useCallback(() => {
    const c = controllerRef.current;
    setSessionId(c.sessionId);
    setLocalParticipantId(c.humanParticipantId);
    setState(c.state);
    setReadOnly(c.readOnly);
    setSessionError(c.error);
  }, []);

  useEffect(() => {
    return controllerRef.current.subscribe(syncFromController);
  }, [syncFromController]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [key, model, imgModel] = await Promise.all([
        loadApiKey(),
        loadCoordinatorModel(),
        loadImageModel(),
      ]);
      if (cancelled) {
        return;
      }
      setApiKey((current) => (userEditedApiKeyRef.current || current.trim() ? current : key));
      setCoordinatorModel((current) => (current.trim() ? current : model));
      setImageModel((current) => (current.trim() ? current : imgModel));
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
      const storedKey = (await loadApiKey()).trim();
      const key = storedKey || apiKeyRef.current.trim();
      if (key) {
        controllerRef.current.setApiKey(key);
      }

      try {
        const loaded = await controllerRef.current.loadActive();
        if (cancelled) {
          return;
        }
        if (loaded) {
          restoredSessionRef.current = true;
          syncFromController();
        }
      } catch (err) {
        if (!cancelled) {
          setSessionError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settingsReady, syncFromController]);

  const reloadModels = useCallback(async (key: string) => {
    if (!key.trim()) {
      setModels([]);
      setImageModels([]);
      setModelsError("Enter an API key to load models");
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const [list, imageList] = await Promise.all([
        listModels(key.trim()),
        listImageModels(key.trim()),
      ]);
      setModels(list);
      setImageModels(imageList);
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
      setImageModel((current) => {
        if (current && imageList.some((m) => m.id === current)) {
          return current;
        }
        const first = imageList[0]?.id ?? "";
        if (first) {
          void saveImageModel(first);
        }
        return first;
      });
    } catch (err) {
      setModels([]);
      setImageModels([]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, reloadModels]);

  async function handleRefreshModels(): Promise<void> {
    const trimmed = apiKey.trim();
    userEditedApiKeyRef.current = true;
    await saveApiKey(trimmed);
    await saveCoordinatorModel(coordinatorModel);
    await saveImageModel(imageModel);
    setApiKey(trimmed);
    apiKeyRef.current = trimmed;
    controllerRef.current.setApiKey(trimmed);
    await reloadModels(trimmed);
  }

  async function handleSaveAll(): Promise<void> {
    setBackupBusy(true);
    setSessionError(null);
    try {
      const trimmed = apiKey.trim();
      await saveApiKey(trimmed);
      await saveCoordinatorModel(coordinatorModel);
      await saveImageModel(imageModel);
      setApiKey(trimmed);
      apiKeyRef.current = trimmed;
      controllerRef.current.setApiKey(trimmed);
      // Include the live table (messages, phase, module state) in the backup.
      await controllerRef.current.flushToStorage();
      await saveBackupToFile();
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      if (!(err instanceof BackupCancelledError)) {
        setSessionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleLoadAll(): Promise<void> {
    const confirmed = window.confirm(
      "Load all replaces every local setting, lobby draft, custom seed, and session with the backup file. Continue?",
    );
    if (!confirmed) {
      return;
    }

    setBackupBusy(true);
    setSessionError(null);
    try {
      if (sessionId) {
        await controllerRef.current.leave();
      }
      await loadBackupFromFile();
      window.location.reload();
    } catch (err) {
      if (!(err instanceof BackupCancelledError)) {
        setSessionError(err instanceof Error ? err.message : String(err));
      }
      setBackupBusy(false);
    }
  }

  async function handleSessionCreated(request: Parameters<LocalSessionController["create"]>[0]): Promise<void> {
    setSessionError(null);
    controllerRef.current.setApiKey(request.apiKey.trim());
    await controllerRef.current.create(request);
    restoredSessionRef.current = true;
    syncFromController();
  }

  async function leaveSession(): Promise<void> {
    await controllerRef.current.leave();
    setSessionError(null);
    syncFromController();
  }

  const Visualization = useMemo(
    () => (state ? getVisualization(state.moduleId) : null),
    [state],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand" onClick={() => (sessionId ? void leaveSession() : undefined)}>
          <span className="brand-mark">LlmTable</span>
        </div>
        <OpenRouterSettings
          apiKey={apiKey}
          coordinatorModel={coordinatorModel}
          imageModel={imageModel}
          models={models}
          imageModels={imageModels}
          loadingModels={loadingModels}
          savedFlash={savedFlash}
          backupBusy={backupBusy}
          onApiKeyChange={(value) => {
            userEditedApiKeyRef.current = true;
            setApiKey(value);
          }}
          onCoordinatorModelChange={(id) => {
            setCoordinatorModel(id);
            void saveCoordinatorModel(id);
          }}
          onImageModelChange={(id) => {
            setImageModel(id);
            void saveImageModel(id);
          }}
          onRefreshModels={() => {
            void handleRefreshModels();
          }}
          onSaveAll={() => {
            void handleSaveAll();
          }}
          onLoadAll={() => {
            void handleLoadAll();
          }}
        />
      </header>

      {modelsError && !sessionId ? <p className="error-banner">{modelsError}</p> : null}
      {sessionError ? <p className="error-banner">{sessionError}</p> : null}
      {readOnly && sessionId ? (
        <p className="error-banner">This session is open in another tab (read-only here).</p>
      ) : null}

      <main className={sessionId && state ? "app-main app-main-session" : "app-main"}>
        {!settingsReady || restoringSession ? (
          <p className="section-hint">Loading…</p>
        ) : !sessionId || !state || !Visualization ? (
          <Lobby
            apiKey={apiKey}
            coordinatorModel={coordinatorModel}
            imageModel={imageModel}
            models={models}
            modelsError={null}
            onSessionCreated={handleSessionCreated}
          />
        ) : (
          <div className="session-view">
            <Visualization
              state={state}
              localParticipantId={localParticipantId}
              onAction={(action) => {
                if (readOnly) {
                  return;
                }
                void controllerRef.current.submitAction(action).catch((err) => {
                  setSessionError(err instanceof Error ? err.message : String(err));
                });
              }}
              onStart={() => {
                if (!apiKeyRef.current.trim()) {
                  setSessionError("Save your OpenRouter API key before starting");
                  return;
                }
                if (readOnly) {
                  return;
                }
                controllerRef.current.setApiKey(apiKeyRef.current.trim());
                void controllerRef.current.start().catch((err) => {
                  setSessionError(err instanceof Error ? err.message : String(err));
                });
              }}
              onPause={() => {
                if (readOnly) {
                  return;
                }
                controllerRef.current.pause();
              }}
              onResume={() => {
                if (!apiKeyRef.current.trim()) {
                  setSessionError("Save your OpenRouter API key before resuming");
                  return;
                }
                if (readOnly) {
                  return;
                }
                controllerRef.current.setApiKey(apiKeyRef.current.trim());
                void controllerRef.current.resume().catch((err) => {
                  setSessionError(err instanceof Error ? err.message : String(err));
                });
              }}
              onStop={() => {
                void leaveSession();
              }}
              onNextHand={() => {
                if (readOnly) {
                  return;
                }
                void controllerRef.current.continuePokerNextHand().catch((err) => {
                  setSessionError(err instanceof Error ? err.message : String(err));
                });
              }}
              onAdvance={() => {
                if (readOnly) {
                  return;
                }
                void controllerRef.current.advanceRpg().catch((err) => {
                  setSessionError(err instanceof Error ? err.message : String(err));
                });
              }}
              onSetGmImages={(enabled) => {
                if (readOnly) {
                  return;
                }
                controllerRef.current.setGmImages(enabled, imageModel.trim() || undefined);
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
