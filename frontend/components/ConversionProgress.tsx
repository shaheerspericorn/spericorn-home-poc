"use client";

import { useEffect, useState } from "react";
import { modelApi, type ModelStatusResponse } from "../lib/api";

const stages = [
  ["file_uploaded", "File uploaded"],
  ["conversion_queued", "Conversion job created"],
  ["processing_cad", "Processing CAD model"],
  ["extracting_3d_geometry", "Preparing 3D model"],
  ["generating_glb", "Finalizing GLB"],
] as const;

// Local 2D pipeline (CAD_CONVERSION_PROVIDER=local): ends at the 2D review, not at a GLB.
const planStages = [
  ["file_uploaded", "File uploaded"],
  ["conversion_queued", "Analysis job created"],
  ["converting_dwg", "Converting DWG → DXF"],
  ["parsing_dxf", "Parsing DXF entities"],
  ["detecting_geometry", "Detecting walls, rooms, doors, windows"],
  ["awaiting_review", "Ready for 2D review"],
] as const;

const stageIndex = (stage: string, list: ReadonlyArray<readonly [string, string]> = stages) => {
  const aliases: Record<string, string> = {
    uploading_to_aps: "processing_cad",
    sample_model_ready: "processing_cad",
    generating_sample_glb: "generating_glb",
  };
  const resolved = aliases[stage] || stage;
  return Math.max(0, list.findIndex(([key]) => key === resolved));
};

type Props = {
  modelId: string; fileName: string; isSampleMode: boolean; onComplete: () => void; onRetry: () => void;
  /** Set for providers with a 2D review step; called when analysis is ready or when diagnostics exist for a failure. */
  onReview?: () => void;
};

export function ConversionProgress({ modelId, fileName, isSampleMode, onComplete, onRetry, onReview }: Props) {
  const [state, setState] = useState<ModelStatusResponse>({ id: modelId, status: "queued", progress: 15, stage: "conversion_queued" });
  const [pollError, setPollError] = useState<string>();

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await modelApi.status(modelId);
        if (!active) return;
        setState(next);
        if (next.status === "completed") { onComplete(); return; }
        if (next.status === "awaiting_review") { onReview?.(); return; }
        if (next.status !== "failed") timer = setTimeout(poll, 2200);
      } catch (error) {
        if (active) setPollError(error instanceof Error ? error.message : "Could not retrieve conversion status.");
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [modelId, onComplete, onReview]);

  const list = onReview ? planStages : stages;
  const failed = state.status === "failed";
  // A failed job reports stage "failed"; keep the marker on the last stage that was actually reached.
  const [reached, setReached] = useState(0);
  useEffect(() => { if (state.stage !== "failed") setReached(stageIndex(state.stage, list)); }, [state.stage, list]);
  const current = failed ? reached : stageIndex(state.stage, list);
  return (
    <section className="progress-card" aria-live="polite">
      <p className="eyebrow">{failed ? "Conversion failed" : "Processing Villa Model"}</p>
      <h1>{failed ? "We could not prepare this model" : onReview ? "Analysing your 2D drawing" : "Preparing your 3D villa"}</h1>
      {isSampleMode && <div className="mode-notice sample-mode-notice"><strong>Sample Mode</strong><span>The built-in Sample Villa GLB is being prepared. The uploaded file is not being converted.</span></div>}
      <div className="processing-file"><span>File</span><strong>{fileName}</strong></div>
      <ol className="stage-list">
        {list.map(([key, title], index) => <li key={key} className={failed && index === current ? "stage-failed" : index < current || state.status === "completed" ? "stage-done" : index === current ? "stage-current" : ""}><span>{index < current || state.status === "completed" ? "✓" : index === current ? "◌" : "○"}</span>{title}</li>)}
      </ol>
      {!failed && <><div className="progress-bar"><span style={{ width: `${Math.max(8, state.progress)}%` }} /></div><p className="subtle">{onReview ? "The drawing is converted and analysed locally. Nothing is sent to a third-party service." : "Please wait — CAD translation can take a few minutes."}</p></>}
      {(state.error || pollError) && <p className="form-error">{state.error || pollError}</p>}
      {failed && state.analysisAvailable && onReview && <button type="button" className="secondary-button" onClick={onReview}>Inspect drawing diagnostics</button>}
      {failed && <button type="button" className="primary-button" onClick={onRetry}>Choose another model</button>}
    </section>
  );
}
