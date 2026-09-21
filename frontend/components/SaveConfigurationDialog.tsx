"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  /** Name of the layout already saved for this villa, if any. Saving replaces it. */
  existingName?: string;
  existingSavedAt?: string;
  itemCount: number;
  saving?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
};

export function SaveConfigurationDialog({ open, existingName, existingSavedAt, itemCount, saving, onConfirm, onCancel }: Props) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    setName(existingName ?? "");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, existingName, onCancel]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  if (!open) return null;
  const trimmed = name.trim();

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="save-configuration-title">
        <h2 id="save-configuration-title">Save configuration</h2>
        <p className="subtle">Stores the villa, the furniture models and their positions{itemCount ? ` — ${itemCount} item${itemCount === 1 ? "" : "s"}` : ", though nothing is placed yet"}.</p>
        <form onSubmit={(event) => { event.preventDefault(); if (trimmed) onConfirm(trimmed); }}>
          <label className="field-row stacked">Name
            <input ref={input} type="text" maxLength={80} value={name} placeholder="e.g. Ground floor - client review" onChange={(event) => setName(event.target.value)} />
          </label>
          {existingName && (
            <p className="mode-notice warning-notice" role="status">
              <strong>Replaces the saved layout</strong>
              <span>“{existingName}”{existingSavedAt ? `, saved ${new Date(existingSavedAt).toLocaleString()}` : ""}. Each villa keeps one layout, so this overwrites it.</span>
            </p>
          )}
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={!trimmed || saving}>{saving ? "Saving…" : existingName ? "Replace" : "Save"}</button>
            <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
