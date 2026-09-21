"use client";

import { useEffect, useState } from "react";
import { modelApi, type ModelStatusResponse } from "./api";

const POLL_MS = 2200;
const RESTING: ModelStatusResponse["status"][] = ["completed", "failed", "awaiting_review"];

/** Polls the job status until it reaches a resting state. `runKey` restarts polling for a new run of the same model. */
export function useModelStatus(modelId: string, active: boolean, runKey = 0) {
  const [state, setState] = useState<ModelStatusResponse>();
  const [pollError, setPollError] = useState<string>();

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await modelApi.status(modelId);
        if (!alive) return;
        setState(next);
        if (!RESTING.includes(next.status)) timer = setTimeout(poll, POLL_MS);
      } catch (error) {
        if (alive) setPollError(error instanceof Error ? error.message : "Could not retrieve conversion status.");
      }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [modelId, active, runKey]);

  return { state, pollError };
}
