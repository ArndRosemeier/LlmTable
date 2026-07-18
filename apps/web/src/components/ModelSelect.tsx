import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
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

function matchesContains(model: OpenRouterModel, query: string): boolean {
  const haystack = [model.id, model.name, model.priceLabel ?? ""].join(" ").toLowerCase();
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.every((token) => haystack.includes(token));
}

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
  placeholder = "Select model",
}: ModelSelectProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);

  const selected = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  const filtered = useMemo(
    () => models.filter((m) => matchesContains(m, filter)),
    [filter, models],
  );

  useEffect(() => {
    setHighlight(0);
  }, [filter, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function choose(modelId: string): void {
    onChange(modelId);
    setFilter("");
    setOpen(false);
  }

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const pick = filtered[highlight];
      if (pick) {
        choose(pick.id);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setFilter("");
    }
  }

  return (
    <div
      ref={rootRef}
      className={["model-select", open ? "model-select-open" : ""].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        className="model-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (disabled) {
            return;
          }
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <span className={selected ? "model-select-value" : "model-select-placeholder"}>
          {selected ? modelOptionLabel(selected) : placeholder}
        </span>
        <span className="model-select-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="model-select-dropdown">
          <input
            type="search"
            className="model-filter"
            value={filter}
            autoFocus
            disabled={disabled}
            placeholder="Type to filter…"
            aria-autocomplete="list"
            aria-controls={listId}
            onChange={(e) => {
              setFilter(e.target.value);
              setOpen(true);
            }}
            onKeyDown={onFilterKeyDown}
          />
          <ul id={listId} className="model-select-list" role="listbox">
            {filtered.length === 0 ? (
              <li className="model-select-empty">No models match</li>
            ) : (
              filtered.map((m, index) => {
                const active = m.id === value;
                const focused = index === highlight;
                return (
                  <li key={m.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      className={[
                        "model-select-option",
                        active ? "model-select-option-active" : "",
                        focused ? "model-select-option-focus" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => choose(m.id)}
                    >
                      <span className="model-select-option-title">
                        {m.name.trim() || m.id}
                      </span>
                      <span className="model-select-option-meta">
                        {m.id}
                        {m.priceLabel ? ` · ${m.priceLabel}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
