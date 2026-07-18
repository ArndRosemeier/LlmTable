import { useMemo, useState } from "react";
import type { OpenRouterModel } from "@llm-table/shared";

export interface ModelSelectProps {
  models: OpenRouterModel[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function modelOptionLabel(model: OpenRouterModel): string {
  const title = model.name.trim() || model.id;
  return model.priceLabel ? `${title} · ${model.priceLabel}` : title;
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
    return models.filter((m) => {
      const haystack = [m.id, m.name, m.priceLabel ?? ""].join(" ").toLowerCase();
      return haystack.includes(q);
    });
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
            {modelOptionLabel(m)}
          </option>
        ))}
      </select>
    </div>
  );
}
