import type { OpenRouterModel } from "@llm-table/shared";
import { ModelSelect } from "../components/ModelSelect";

export interface OpenRouterSettingsProps {
  apiKey: string;
  coordinatorModel: string;
  models: OpenRouterModel[];
  loadingModels: boolean;
  savedFlash: boolean;
  onApiKeyChange: (value: string) => void;
  onCoordinatorModelChange: (value: string) => void;
  onSave: () => void;
}

export function OpenRouterSettings({
  apiKey,
  coordinatorModel,
  models,
  loadingModels,
  savedFlash,
  onApiKeyChange,
  onCoordinatorModelChange,
  onSave,
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
      <button type="button" className="btn" onClick={onSave}>
        {savedFlash ? "Saved" : "Save & load models"}
      </button>
    </div>
  );
}
