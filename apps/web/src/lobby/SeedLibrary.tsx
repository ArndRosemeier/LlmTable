import { useMemo, useState } from "react";
import type { AdventureSeed } from "@llm-table/shared";
import {
  ADVENTURE_SEEDS,
  blankCustomSeed,
  isBuiltinAdventureSeedId,
  validateAdventureSeed,
} from "@llm-table/rpg";

export interface SeedLibraryProps {
  customSeeds: AdventureSeed[];
  selectedId: string;
  onCustomSeedsChange: (seeds: AdventureSeed[]) => void;
  onSelect: (seedId: string) => void;
}

interface SeedEditorDraft {
  id: string;
  title: string;
  tone: string;
  premise: string;
  secret: string;
  clockEnabled: boolean;
  clockName: string;
  clockMax: string;
  clockStart: string;
  /** Free-text while editing — parsed only on save. */
  locationsText: string;
  npcsText: string;
  setPiecesText: string;
}

function formatNameBlurbLines(
  rows: Array<{ name: string; blurb?: string; motive?: string }>,
  detailKey: "blurb" | "motive",
): string {
  return rows
    .map((row) => {
      const detail = detailKey === "blurb" ? row.blurb : row.motive;
      return detail ? `${row.name} — ${detail}` : row.name;
    })
    .join("\n");
}

function parseNameDetailLines(
  text: string,
  detailKey: "blurb" | "motive",
): Array<{ name: string; blurb?: string; motive?: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.includes(" — ") ? " — " : line.includes(" - ") ? " - " : null;
      if (!sep) {
        return detailKey === "blurb"
          ? { name: line, blurb: "(describe this place)" }
          : { name: line, motive: "(what they want)" };
      }
      const [name, ...rest] = line.split(sep);
      const detail = rest.join(sep).trim() || (detailKey === "blurb" ? "(describe this place)" : "(what they want)");
      return detailKey === "blurb"
        ? { name: name.trim(), blurb: detail }
        : { name: name.trim(), motive: detail };
    });
}

function seedToDraft(seed: AdventureSeed): SeedEditorDraft {
  return {
    id: seed.id,
    title: seed.title,
    tone: seed.tone,
    premise: seed.premise,
    secret: seed.secret,
    clockEnabled: Boolean(seed.clock),
    clockName: seed.clock?.name ?? "",
    clockMax: String(seed.clock?.max ?? 6),
    clockStart: String(seed.clock?.start ?? 0),
    locationsText: formatNameBlurbLines(seed.locations, "blurb"),
    npcsText: formatNameBlurbLines(seed.npcs, "motive"),
    setPiecesText: (seed.setPieces ?? []).join("\n"),
  };
}

function blankDraft(): SeedEditorDraft {
  return seedToDraft(blankCustomSeed());
}

export function SeedLibrary({
  customSeeds,
  selectedId,
  onCustomSeedsChange,
  onSelect,
}: SeedLibraryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SeedEditorDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const catalog = useMemo(() => {
    const builtin = ADVENTURE_SEEDS.map((s) => ({
      ...s,
      source: "builtin" as const,
    }));
    const custom = customSeeds.map((s) => ({
      ...s,
      source: "custom" as const,
    }));
    return [...builtin, ...custom];
  }, [customSeeds]);

  const selected = catalog.find((s) => s.id === selectedId) ?? catalog[0];

  function startCreate(): void {
    const next = blankDraft();
    setDraft(next);
    setEditingId(next.id);
    setFormError(null);
  }

  function startEdit(seed: AdventureSeed): void {
    if (isBuiltinAdventureSeedId(seed.id)) {
      const copy: AdventureSeed = {
        ...structuredClone(seed),
        id: crypto.randomUUID(),
        title: `${seed.title} (custom)`,
      };
      setDraft(seedToDraft(copy));
      setEditingId(copy.id);
    } else {
      setDraft(seedToDraft(structuredClone(seed)));
      setEditingId(seed.id);
    }
    setFormError(null);
  }

  function cancelEdit(): void {
    setDraft(null);
    setEditingId(null);
    setFormError(null);
  }

  function saveEdit(): void {
    if (!draft) {
      return;
    }
    try {
      const locations = parseNameDetailLines(draft.locationsText, "blurb").map((row) => ({
        name: row.name,
        blurb: row.blurb ?? "",
      }));
      const npcs = parseNameDetailLines(draft.npcsText, "motive").map((row) => ({
        name: row.name,
        motive: row.motive ?? "",
      }));
      const setPieces = draft.setPiecesText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const clockMax = Number(draft.clockMax);
      const clockStart = Number(draft.clockStart);
      const clock =
        draft.clockEnabled && draft.clockName.trim()
          ? {
              name: draft.clockName.trim(),
              max: Number.isFinite(clockMax) ? Math.trunc(clockMax) : 6,
              start: Number.isFinite(clockStart) ? Math.trunc(clockStart) : 0,
            }
          : undefined;

      const validated = validateAdventureSeed({
        id: draft.id,
        title: draft.title,
        tone: draft.tone,
        premise: draft.premise,
        secret: draft.secret,
        locations,
        npcs,
        setPieces,
        clock,
      });
      if (isBuiltinAdventureSeedId(validated.id)) {
        throw new Error("Custom seeds cannot reuse a built-in id");
      }
      const next = [
        ...customSeeds.filter((s) => s.id !== editingId && s.id !== validated.id),
        validated,
      ];
      onCustomSeedsChange(next);
      onSelect(validated.id);
      setDraft(null);
      setEditingId(null);
      setFormError(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  function removeCustom(id: string): void {
    if (isBuiltinAdventureSeedId(id)) {
      return;
    }
    onCustomSeedsChange(customSeeds.filter((s) => s.id !== id));
    if (selectedId === id) {
      onSelect(ADVENTURE_SEEDS[0]?.id ?? "blank");
    }
    if (editingId === id) {
      cancelEdit();
    }
  }

  return (
    <section className="seed-library">
      <div className="seed-library-header">
        <h2>Adventure seeds</h2>
        <button type="button" className="btn btn-secondary" onClick={startCreate}>
          Add seed
        </button>
      </div>
      <p className="section-hint">
        Built-in seeds stay available. Your custom seeds are saved in this browser — duplicate a
        built-in to customize it.
      </p>

      <label className="field seed-picker">
        <span>Selected for next table</span>
        <select value={selectedId} onChange={(e) => onSelect(e.target.value)}>
          <optgroup label="Built-in">
            {ADVENTURE_SEEDS.map((seed) => (
              <option key={seed.id} value={seed.id}>
                {seed.title}
              </option>
            ))}
          </optgroup>
          {customSeeds.length > 0 ? (
            <optgroup label="Your collection">
              {customSeeds.map((seed) => (
                <option key={seed.id} value={seed.id}>
                  {seed.title}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {selected ? (
          <p className="section-hint seed-blurb">
            {selected.tone} — {selected.premise}
          </p>
        ) : null}
      </label>

      <ul className="seed-library-list">
        {catalog.map((seed) => (
          <li key={seed.id} className={seed.id === selectedId ? "seed-row seed-row-active" : "seed-row"}>
            <div>
              <strong>{seed.title}</strong>
              <span className="seed-row-meta">
                {seed.source === "builtin" ? "Built-in" : "Custom"}
              </span>
            </div>
            <div className="seed-row-actions">
              <button type="button" className="btn btn-secondary" onClick={() => onSelect(seed.id)}>
                Use
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => startEdit(seed)}>
                {seed.source === "builtin" ? "Duplicate" : "Edit"}
              </button>
              {seed.source === "custom" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => removeCustom(seed.id)}
                >
                  Delete
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="seed-editor">
          <h3>{customSeeds.some((s) => s.id === editingId) ? "Edit seed" : "New seed"}</h3>
          {formError ? <p className="error-banner error-banner-inline">{formError}</p> : null}
          <label className="field">
            <span>Title</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Tone</span>
            <input
              value={draft.tone}
              onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Premise (what the party knows)</span>
            <textarea
              rows={3}
              value={draft.premise}
              onChange={(e) => setDraft({ ...draft, premise: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Secret (GM only)</span>
            <textarea
              rows={3}
              value={draft.secret}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            />
          </label>

          <fieldset className="seed-clock-fieldset">
            <legend>Pressure clock (optional)</legend>
            <p className="section-hint">
              A simple countdown the GM can tick up as danger, time, or tension rises (for example
              &quot;The hunger's patience&quot; 0–6). Leave off if you do not want one.
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.clockEnabled}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    clockEnabled: e.target.checked,
                    clockName: e.target.checked
                      ? draft.clockName.trim() || "Pressure"
                      : draft.clockName,
                  })
                }
              />
              <span>Use a pressure clock</span>
            </label>
            {draft.clockEnabled ? (
              <div className="seed-editor-grid">
                <label className="field">
                  <span>Clock name</span>
                  <input
                    value={draft.clockName}
                    onChange={(e) => setDraft({ ...draft, clockName: e.target.value })}
                    placeholder="e.g. The hunger's patience"
                  />
                </label>
                <label className="field">
                  <span>Max</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.clockMax}
                    onChange={(e) => setDraft({ ...draft, clockMax: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Starts at</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.clockStart}
                    onChange={(e) => setDraft({ ...draft, clockStart: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
          </fieldset>

          <label className="field">
            <span>Locations (one per line: Name — what they see)</span>
            <textarea
              rows={4}
              value={draft.locationsText}
              onChange={(e) => setDraft({ ...draft, locationsText: e.target.value })}
              placeholder={"Village green — muddy square, nervous elders\nThe mill — boarded windows"}
            />
          </label>
          <label className="field">
            <span>NPCs (one per line: Name — what they want)</span>
            <textarea
              rows={4}
              value={draft.npcsText}
              onChange={(e) => setDraft({ ...draft, npcsText: e.target.value })}
              placeholder={"Marla Reed — wants the mill cleared\nOld Kem — warns them off"}
            />
          </label>
          <label className="field">
            <span>Set-pieces (one per line, optional)</span>
            <textarea
              rows={3}
              value={draft.setPiecesText}
              onChange={(e) => setDraft({ ...draft, setPiecesText: e.target.value })}
              placeholder="A memorable complication the GM can use"
            />
          </label>
          <div className="seed-editor-actions">
            <button type="button" className="btn" onClick={saveEdit}>
              Save to collection
            </button>
            <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
