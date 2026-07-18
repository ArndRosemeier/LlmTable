import { useMemo, useState } from "react";
import type { OpenRouterModel } from "@llm-table/shared";

export interface ModelSelectProps {
  models: OpenRouterModel[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
  placeholder = "Select model",
}: ModelSelectProps) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) {
      return models;
    }
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [filter, models]);

  return (
    <div className="model-select">
      <input
        type="search"
        className="model-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter models…"
        disabled={disabled}
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || filtered.length === 0}
      >
        <option value="">{placeholder}</option>
        {filtered.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
      </select>
    </div>
  );
}
