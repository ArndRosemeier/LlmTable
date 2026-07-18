import type { OpenRouterModel } from "@llm-table/shared";
import { ModelSelect } from "../components/ModelSelect";

export interface OpenRouterSettingsProps {
  apiKey: string;
  coordinatorModel: string;
  imageModel: string;
  models: OpenRouterModel[];
  imageModels: OpenRouterModel[];
  loadingModels: boolean;
  savedFlash: boolean;
  backupBusy: boolean;
  onApiKeyChange: (value: string) => void;
  onCoordinatorModelChange: (value: string) => void;
  onImageModelChange: (value: string) => void;
  onRefreshModels: () => void;
  onSaveAll: () => void;
  onLoadAll: () => void;
}

export function OpenRouterSettings({
  apiKey,
  coordinatorModel,
  imageModel,
  models,
  imageModels,
  loadingModels,
  savedFlash,
  backupBusy,
  onApiKeyChange,
  onCoordinatorModelChange,
  onImageModelChange,
  onRefreshModels,
  onSaveAll,
  onLoadAll,
}: OpenRouterSettingsProps) {
  return (
    <div className="settings-bar">
      <label className="field">
        <span>OpenRouter API key</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder="sk-or-…"
        />
      </label>
      <label className="field field-grow">
        <span>Coordinator model</span>
        <ModelSelect
          models={models}
          value={coordinatorModel}
          onChange={onCoordinatorModelChange}
          disabled={models.length === 0}
          placeholder={loadingModels ? "Loading models…" : "Select model"}
        />
      </label>
      <label className="field field-grow">
        <span>Image model</span>
        <ModelSelect
          models={imageModels}
          value={imageModel}
          onChange={onImageModelChange}
          disabled={imageModels.length === 0}
          placeholder={loadingModels ? "Loading models…" : "Select image model"}
        />
      </label>
      <div className="settings-actions">
        <button
          type="button"
          className="btn"
          onClick={onSaveAll}
          disabled={backupBusy}
          title="Save settings, chats, sessions, seeds — everything in IndexedDB — to a JSON file"
        >
          {backupBusy ? "Working…" : savedFlash ? "Saved" : "Save all"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onLoadAll}
          disabled={backupBusy}
          title="Replace all local IndexedDB data from a JSON backup"
        >
          Load all
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onRefreshModels}
          disabled={backupBusy || loadingModels}
          title="Fetch the OpenRouter model lists for the selectors"
        >
          {loadingModels ? "Loading…" : "Refresh models"}
        </button>
      </div>
    </div>
  );
}
