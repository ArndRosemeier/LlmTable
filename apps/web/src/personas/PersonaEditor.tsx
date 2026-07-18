import type { OpenRouterModel, PersonaDraft } from "@llm-table/shared";
import { ModelSelect } from "../components/ModelSelect";

export interface PersonaEditorProps {
  personas: PersonaDraft[];
  invitedIds: string[];
  models: OpenRouterModel[];
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
  onChange,
  onInvitedChange,
}: PersonaEditorProps) {
  const defaultModel = models[0]?.id ?? "";
  const invitedSet = new Set(invitedIds);

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
    const persona = emptyPersona(defaultModel);
    onChange([...personas, persona]);
    onInvitedChange([...invitedIds, persona.id]);
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
        personas are required.
      </p>

      <div className="persona-list">
        {personas.map((persona, index) => {
          const invited = invitedSet.has(persona.id);
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
                  <span>Invite{persona.displayName.trim() ? ` ${persona.displayName}` : ` persona ${index + 1}`}</span>
                </label>
                <button type="button" className="btn btn-ghost" onClick={() => remove(persona.id)}>
                  Remove
                </button>
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
