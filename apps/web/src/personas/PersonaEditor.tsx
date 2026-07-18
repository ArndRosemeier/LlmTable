import { useState } from "react";
import type { OpenRouterModel, PersonaDraft } from "@llm-table/shared";
import { ModelSelect } from "../components/ModelSelect";
import { generatePersonaPortrait } from "../lib/api";

export interface PersonaEditorProps {
  personas: PersonaDraft[];
  invitedIds: string[];
  models: OpenRouterModel[];
  apiKey: string;
  imageModel: string;
  onChange: (personas: PersonaDraft[]) => void;
  onInvitedChange: (invitedIds: string[]) => void;
}

function emptyPersona(defaultModel: string): PersonaDraft {
  return {
    id: crypto.randomUUID(),
    displayName: "",
    systemPrompt: "",
    model: defaultModel,
  };
}

export function PersonaEditor({
  personas,
  invitedIds,
  models,
  apiKey,
  imageModel,
  onChange,
  onInvitedChange,
}: PersonaEditorProps) {
  const invitedSet = new Set(invitedIds);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [portraitError, setPortraitError] = useState<string | null>(null);

  function update(id: string, patch: Partial<PersonaDraft>): void {
    onChange(personas.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function remove(id: string): void {
    onChange(personas.filter((p) => p.id !== id));
    onInvitedChange(invitedIds.filter((x) => x !== id));
  }

  function toggleInvite(id: string, invited: boolean): void {
    if (invited) {
      if (invitedSet.has(id)) {
        return;
      }
      onInvitedChange([...invitedIds, id]);
      return;
    }
    onInvitedChange(invitedIds.filter((x) => x !== id));
  }

  function addPersona(): void {
    const lastModel = personas[personas.length - 1]?.model.trim();
    const persona = emptyPersona(lastModel || models[0]?.id || "");
    onChange([...personas, persona]);
    onInvitedChange([...invitedIds, persona.id]);
  }

  async function generatePortrait(persona: PersonaDraft): Promise<void> {
    setPortraitError(null);
    if (!apiKey.trim()) {
      setPortraitError("Save an OpenRouter API key before generating portraits");
      return;
    }
    if (!imageModel.trim()) {
      setPortraitError("Choose an image model in settings first");
      return;
    }
    if (!persona.displayName.trim() || !persona.systemPrompt.trim()) {
      setPortraitError("Each persona needs a name and definition before generating a portrait");
      return;
    }

    setGeneratingId(persona.id);
    try {
      const portraitDataUrl = await generatePersonaPortrait({
        apiKey: apiKey.trim(),
        model: imageModel.trim(),
        displayName: persona.displayName,
        systemPrompt: persona.systemPrompt,
      });
      update(persona.id, { portraitDataUrl });
    } catch (err) {
      setPortraitError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingId(null);
    }
  }

  return (
    <section className="persona-editor">
      <header className="section-header">
        <h2>Personas</h2>
        <button type="button" className="btn btn-secondary" onClick={addPersona}>
          Add persona
        </button>
      </header>
      <p className="section-hint">
        Build your roster, then tick who is invited to this table. At least 2 invited LLM
        personas are required. Portraits use the image model from settings.
      </p>
      {portraitError ? <p className="error-banner error-banner-inline">{portraitError}</p> : null}

      <div className="persona-list">
        {personas.map((persona, index) => {
          const invited = invitedSet.has(persona.id);
          const generating = generatingId === persona.id;
          return (
            <article
              key={persona.id}
              className={invited ? "persona-card persona-card-invited" : "persona-card"}
            >
              <div className="persona-card-top">
                <label className="checkbox-row persona-invite">
                  <input
                    type="checkbox"
                    checked={invited}
                    onChange={(e) => toggleInvite(persona.id, e.target.checked)}
                  />
                  <span>
                    Invite
                    {persona.displayName.trim()
                      ? ` ${persona.displayName}`
                      : ` persona ${index + 1}`}
                  </span>
                </label>
                <button type="button" className="btn btn-ghost" onClick={() => remove(persona.id)}>
                  Remove
                </button>
              </div>

              <div className="persona-portrait-row">
                <div className="persona-portrait-frame">
                  {persona.portraitDataUrl ? (
                    <img
                      className="persona-portrait"
                      src={persona.portraitDataUrl}
                      alt={
                        persona.displayName.trim()
                          ? `Portrait of ${persona.displayName}`
                          : "Persona portrait"
                      }
                    />
                  ) : (
                    <span className="persona-portrait-placeholder">No portrait</span>
                  )}
                </div>
                <div className="persona-portrait-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={generating || generatingId !== null}
                    onClick={() => void generatePortrait(persona)}
                  >
                    {generating ? "Generating…" : persona.portraitDataUrl ? "Regenerate" : "Generate portrait"}
                  </button>
                  {persona.portraitDataUrl ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={generating}
                      onClick={() => update(persona.id, { portraitDataUrl: undefined })}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>

              <label className="field">
                <span>Name</span>
                <input
                  value={persona.displayName}
                  onChange={(e) => update(persona.id, { displayName: e.target.value })}
                  placeholder="e.g. Mara the skeptic"
                />
              </label>
              <label className="field">
                <span>Model</span>
                <ModelSelect
                  models={models}
                  value={persona.model}
                  onChange={(model) => update(persona.id, { model })}
                  disabled={models.length === 0}
                />
              </label>
              <label className="field">
                <span>Definition</span>
                <textarea
                  rows={5}
                  value={persona.systemPrompt}
                  onChange={(e) => update(persona.id, { systemPrompt: e.target.value })}
                  placeholder="Who they are, how they speak, what they care about…"
                />
              </label>
            </article>
          );
        })}
      </div>
    </section>
  );
}
