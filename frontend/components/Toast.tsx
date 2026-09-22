"use client";

import { useEffect } from "react";

/** Raised messages carry an id so repeating the same text restarts the timer instead of looking stuck. */
export type ToastMessage = { id: number; text: string };

const DISMISS_AFTER_MS = 6000;

export function Toast({ toast, onDismiss }: { toast?: ToastMessage; onDismiss: () => void }) {
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return undefined;
    const timer = setTimeout(onDismiss, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);

  if (!toast) return null;
  return (
    <div className="toast" role="alert">
      <span>{toast.text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message">×</button>
    </div>
  );
}
