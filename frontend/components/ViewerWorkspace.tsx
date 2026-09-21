"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { modelApi, modelAssetUrl, type ModelInfo } from "../lib/api";
import type { CadAnalysis } from "../lib/cad-analysis";
import { createPlacement, movePlacement, roomSuitability, rotatePlacement, ROTATION_STEP, type FurniturePlacement } from "../lib/configuration";
import type { FurnitureAsset } from "../lib/furniture-catalog";
import { FurniturePanel } from "./FurniturePanel";
import type { Dimensions } from "./ModelViewer";

const ThreeViewer = dynamic(() => import("./ModelViewer").then((module) => module.ModelViewer), { ssr: false });
const FurnitureLayer = dynamic(() => import("./FurnitureLayer").then((module) => module.FurnitureLayer), { ssr: false });
const ModelErrorBoundary = dynamic(() => import("./ModelViewer").then((module) => module.ModelErrorBoundary), { ssr: false });

function formatBytes(bytes?: number): string {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function ViewerWorkspace({ modelId }: { modelId: string }) {
  const [model, setModel] = useState<ModelInfo>();
  const [error, setError] = useState<string>();
  const [dimensions, setDimensions] = useState<Dimensions>();
  const [loaded, setLoaded] = useState(false);
  const [browserLoadMs, setBrowserLoadMs] = useState<number>();
  const [fps, setFps] = useState<number>();
  const [resetVersion, setResetVersion] = useState(0);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    modelApi.get(modelId).then((next) => {
      if (next.status !== "completed" || !next.modelUrl) throw new Error(next.error || "This model is not ready to view.");
      setModel(next);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load model information."));
  }, [modelId]);

  // --- Furniture configurator: only for models that carry a plan analysis (local 2D pipeline) ---------------
  const [analysis, setAnalysis] = useState<CadAnalysis>();
  const [placements, setPlacements] = useState<FurniturePlacement[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [keepInRoom, setKeepInRoom] = useState(true);
  const [lowWalls, setLowWalls] = useState(false);
  const [topView, setTopView] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [message, setMessage] = useState<string>();
  const configurable = Boolean(model?.analysis);
  const rooms = analysis?.rooms ?? [];

  const reloadConfiguration = useCallback(async () => {
    try {
      const saved = await modelApi.configuration(modelId);
      setPlacements(saved.furniture);
      setSavedAt(saved.updatedAt);
      setSelectedId(undefined);
      setDirty(false);
      setMessage(saved.furniture.length ? `Loaded ${saved.furniture.length} saved item(s).` : "No saved configuration yet.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not load the configuration.");
    }
  }, [modelId]);

  useEffect(() => {
    if (!configurable) return;
    modelApi.analysis(modelId).then((next) => { setAnalysis(next); setSelectedRoomId((current) => current ?? next.rooms[0]?.id); }).catch(() => setMessage("Room data could not be loaded; furniture will be placed at the origin."));
    void reloadConfiguration();
  }, [configurable, modelId, reloadConfiguration]);

  const change = useCallback((update: (items: FurniturePlacement[]) => FurniturePlacement[]) => { setPlacements(update); setDirty(true); }, []);

  function addFurniture(asset: FurnitureAsset) {
    const room = rooms.find((item) => item.id === selectedRoomId);
    const placement = createPlacement(asset, room, placements);
    change((items) => [...items, placement]);
    setSelectedId(placement.instanceId);
    setMessage(roomSuitability(asset, room) ?? `${asset.name} placed${room ? ` in ${room.name}` : ""}.`);
  }

  const moveFurniture = useCallback((instanceId: string, x: number, z: number) => {
    change((items) => items.map((item) => (item.instanceId === instanceId ? movePlacement(item, x, z, rooms, keepInRoom) : item)));
  }, [change, rooms, keepInRoom]);

  const rotateSelected = useCallback((delta: number) => change((items) => items.map((item) => (item.instanceId === selectedId ? rotatePlacement(item, delta) : item))), [change, selectedId]);
  const removeSelected = useCallback(() => { change((items) => items.filter((item) => item.instanceId !== selectedId)); setSelectedId(undefined); }, [change, selectedId]);

  useEffect(() => {
    if (!configurable) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!selectedId || (event.target as HTMLElement | null)?.closest("input, select, textarea")) return;
      if (event.key === "r" || event.key === "R") rotateSelected(event.shiftKey ? -ROTATION_STEP : ROTATION_STEP);
      else if (event.key === "Delete" || event.key === "Backspace") removeSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configurable, selectedId, rotateSelected, removeSelected]);

  async function saveConfiguration() {
    try {
      const saved = await modelApi.saveConfiguration(modelId, { villaModelId: modelId, furniture: placements });
      setSavedAt(saved.updatedAt);
      setDirty(false);
      setMessage(`Saved ${saved.furniture.length} item(s).`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not save the configuration.");
    }
  }

  const handlePick = useCallback((userData: Record<string, unknown>) => {
    if (userData.kind === "room" && typeof userData.roomId === "string") setSelectedRoomId(userData.roomId);
    setSelectedId(undefined);
  }, []);

  const handleDimensions = useCallback((next: Dimensions) => setDimensions(next), []);
  const handleLoaded = useCallback((elapsed: number) => {
    setBrowserLoadMs(elapsed);
    setLoaded(true);
    console.info(`[metrics] model=${modelId} browserLoadMs=${Math.round(elapsed)}`);
  }, [modelId]);
  const handleModelError = useCallback((message: string) => setError(`Model loading failed: ${message}`), []);

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewerRef.current?.requestFullscreen();
    } catch {
      setError("Fullscreen is not available in this browser.");
    }
  }

  if (error) return <ViewerError message={error} />;
  if (!model?.modelUrl) return <main className="viewer-loading"><p className="eyebrow">Villa 3D Viewer</p><h1>Loading model details…</h1></main>;

  return (
    <main className="viewer-page">
      <header className="viewer-header">
        <Link href="/" className="back-link">← Back to upload</Link>
        <div><p className="eyebrow">Villa 3D Viewer</p><h1>{model.name}</h1></div>
        <span className={`status-chip ${loaded ? "ready" : ""}`}>{loaded ? model.isSampleModel ? "Sample model" : "Ready" : "Loading"}</span>
      </header>
      {model.isSampleModel && (
        <div className="mode-notice sample-mode-notice viewer-mode-notice" role="status">
          <strong>Sample Mode — Viewer validation only</strong>
          <span>This is the built-in Sample Villa GLB. <b>{model.sourceFileName}</b> was uploaded but was not converted from {model.sourceFormat.toUpperCase()}.</span>
        </div>
      )}
      <section className={configurable ? "viewer-layout with-configurator" : "viewer-layout"}>
        <aside className="model-info" aria-label="Model information">
          <h2>Villa Model</h2>
          <Info label="File" value={model.sourceFileName} />
          <Info label="Format" value={model.isSampleModel ? "Built-in Sample GLB" : `${model.sourceFormat.toUpperCase()} → GLB`} />
          <Info label="Status" value={model.isSampleModel ? "Sample viewer mode" : "Ready"} />
          <hr />
          <h3>Dimensions</h3>
          <p className="dimension-value">{dimensions ? `${dimensions.width.toFixed(2)} × ${dimensions.height.toFixed(2)} × ${dimensions.depth.toFixed(2)}` : "Calculating…"}</p>
          <small>{configurable ? `Metres (drawing units: ${model.analysis?.units ?? "unknown"})` : "Model units (verify units with source authoring software)"}</small>
          {model.analysis && <>
            <hr />
            <h3>Detected from 2D drawing</h3>
            <Info label="Walls" value={String(model.analysis.walls)} />
            <Info label="Rooms" value={String(model.analysis.rooms)} />
            <Info label="Doors" value={String(model.analysis.doors)} />
            <Info label="Windows" value={String(model.analysis.windows)} />
            <Link href={`/review/${modelId}`} className="text-link">Open 2D review / diagnostics →</Link>
          </>}
          <hr />
          <h3>POC metrics</h3>
          <Info label="Source" value={formatBytes(model.metrics.sourceBytes)} />
          <Info label="GLB" value={formatBytes(model.metrics.outputBytes)} />
          <Info label="Conversion" value={model.metrics.conversionDurationMs ? `${(model.metrics.conversionDurationMs / 1000).toFixed(1)} sec` : "—"} />
          {Object.entries(model.metrics.details ?? {}).map(([key, value]) => <Info key={key} label={key.replace(/Ms$/, "")} value={`${(value / 1000).toFixed(2)} sec`} />)}
          <Info label="Browser load" value={browserLoadMs ? `${(browserLoadMs / 1000).toFixed(2)} sec` : "Measuring…"} />
          <Info label="Viewer FPS" value={fps ? String(fps) : "Measuring…"} />
          <p className="hierarchy-note">{model.hierarchy.note}</p>
        </aside>
        <div className="viewer-stage" ref={viewerRef}>
          <ModelErrorBoundary onError={handleModelError}>
            {configurable ? (
              <ThreeViewer url={modelAssetUrl(model.modelUrl)} resetVersion={resetVersion} onDimensions={handleDimensions} onLoad={handleLoaded} onFps={setFps} preserveOrigin onPick={handlePick} highlightRoomId={selectedRoomId} wallScale={lowWalls ? 0.3 : 1} topView={topView}>
                <FurnitureLayer placements={placements} selectedId={selectedId} onSelect={setSelectedId} onMove={moveFurniture} />
              </ThreeViewer>
            ) : (
              <ThreeViewer url={modelAssetUrl(model.modelUrl)} resetVersion={resetVersion} onDimensions={handleDimensions} onLoad={handleLoaded} onFps={setFps} />
            )}
          </ModelErrorBoundary>
          <div className="viewer-actions">
            {configurable && <button type="button" aria-pressed={lowWalls} onClick={() => setLowWalls((value) => !value)}>{lowWalls ? "Full walls" : "Low walls"}</button>}
            {configurable && <button type="button" aria-pressed={topView} onClick={() => setTopView((value) => !value)}>{topView ? "3D view" : "Top view"}</button>}
            <button type="button" onClick={() => setResetVersion((value) => value + 1)}>Reset camera</button>
            <button type="button" onClick={() => setResetVersion((value) => value + 1)}>Fit model</button>
            <button type="button" onClick={fullscreen}>Fullscreen</button>
          </div>
        </div>
        {configurable && (
          <FurniturePanel
            rooms={rooms} selectedRoomId={selectedRoomId} onSelectRoom={setSelectedRoomId}
            placements={placements} selectedId={selectedId} onSelect={setSelectedId}
            onAdd={addFurniture} onRotate={rotateSelected} onRemove={removeSelected}
            keepInRoom={keepInRoom} onKeepInRoom={setKeepInRoom}
            onSave={saveConfiguration} onReload={reloadConfiguration} dirty={dirty} message={message} savedAt={savedAt}
          />
        )}
      </section>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function ViewerError({ message }: { message: string }) {
  return <main className="viewer-loading"><p className="eyebrow">Villa 3D Viewer</p><h1>Viewer unavailable</h1><p className="form-error">{message}</p><Link href="/" className="primary-button inline-button">Return to upload</Link></main>;
}
