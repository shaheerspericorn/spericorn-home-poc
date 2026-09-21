"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { modelApi, modelAssetUrl, type ModelInfo } from "../lib/api";
import type { CadAnalysis } from "../lib/cad-analysis";
import { createPlacement, movePlacement, roomSuitability, rotatePlacement, ROTATION_STEP, type FurniturePlacement } from "../lib/configuration";
import type { FurnitureAsset } from "../lib/furniture-catalog";
import { FurniturePanel } from "./FurniturePanel";
// Types only: a value import here would pull three.js into the page chunk and defeat the dynamic() split below.
import type { Dimensions, ViewerController } from "./ModelViewer";
import { RoomNav } from "./RoomNav";

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
  const [glbFailed, setGlbFailed] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<ViewerController | null>(null);
  // The FPS readout is written straight into the DOM: a once-a-second React render of the whole workspace
  // (and of everything inside the Canvas) is not worth a diagnostics number.
  const fpsRef = useRef<HTMLElement>(null);
  const showFps = useCallback((frames: number) => {
    if (fpsRef.current) fpsRef.current.textContent = frames > 0 ? `${frames} fps` : "idle (renders on demand)";
  }, []);

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
    modelApi.analysis(modelId).then(setAnalysis).catch(() => setMessage("Room data could not be loaded; furniture will be placed at the origin."));
    void reloadConfiguration();
  }, [configurable, modelId, reloadConfiguration]);

  const change = useCallback((update: (items: FurniturePlacement[]) => FurniturePlacement[]) => { setPlacements(update); setDirty(true); }, []);

  // With nothing selected, furniture goes to the largest room (usually the living space).
  const targetRoom = rooms.find((item) => item.id === selectedRoomId) ?? rooms.reduce<typeof rooms[number] | undefined>((best, room) => (!best || room.area > best.area ? room : best), undefined);

  function addFurniture(asset: FurnitureAsset) {
    const room = targetRoom;
    if (room && room.id !== selectedRoomId) selectRoom(room.id);
    const placement = createPlacement(asset, room, placements);
    change((items) => [...items, placement]);
    setSelectedId(placement.instanceId);
    setMessage(roomSuitability(asset, room) ?? `${asset.name} placed${room ? ` in ${room.name}` : ""}.`);
  }

  // Drag: FurnitureLayer asks `constrainMove` on every pointer event (pure, no state) and commits once on release.
  const constrainMove = useCallback((item: FurniturePlacement, x: number, z: number) => movePlacement(item, x, z, rooms, keepInRoom), [rooms, keepInRoom]);
  const commitMove = useCallback((instanceId: string, x: number, z: number) => {
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

  // One path for sidebar clicks and 3D clicks: update UI state, highlight, and fly the camera there.
  const selectRoom = useCallback((roomId: string) => {
    setSelectedRoomId(roomId);
    setSelectedId(undefined);
    viewer.current?.focusOnRoom(roomId);
  }, []);
  const clearFurnitureSelection = useCallback(() => setSelectedId(undefined), []);
  const showOverview = useCallback(() => { setSelectedRoomId(undefined); viewer.current?.resetToOverview(); }, []);
  const resetView = useCallback(() => { setLowWalls(false); showOverview(); }, [showOverview]);

  const handleDimensions = useCallback((next: Dimensions) => setDimensions(next), []);
  const handleLoaded = useCallback((elapsed: number) => {
    setBrowserLoadMs(elapsed);
    setLoaded(true);
    console.info(`[metrics] model=${modelId} browserLoadMs=${Math.round(elapsed)}`);
  }, [modelId]);
  const handleModelError = useCallback((message: string) => {
    console.error(`[viewer] GLB failed to load for model ${modelId}:`, message);  // detail stays in the developer console
    setGlbFailed(true);
  }, [modelId]);
  async function retryModel() {
    if (model?.modelUrl) (await import("./ModelViewer")).clearModelCache(modelAssetUrl(model.modelUrl));
    setGlbFailed(false);
    setLoaded(false);
    setViewerKey((value) => value + 1);
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewerRef.current?.requestFullscreen();
    } catch {
      setMessage("Fullscreen is not available in this browser.");
    }
  }

  if (error) return <ViewerError message={error} />;
  if (!model?.modelUrl) return <main className="viewer-loading"><div className="viewer-loader inline" role="status"><span className="spinner" aria-hidden="true" /><span>Loading model details…</span></div></main>;

  const url = modelAssetUrl(model.modelUrl);
  const details = (
    <details className="viewer-details" open={!configurable}>
      <summary>Model details &amp; metrics</summary>
      <Info label="File" value={model.sourceFileName} />
      <Info label="Format" value={model.isSampleModel ? "Built-in Sample GLB" : `${model.sourceFormat.toUpperCase()} → GLB`} />
      <Info label="Dimensions" value={dimensions ? `${dimensions.width.toFixed(2)} × ${dimensions.height.toFixed(2)} × ${dimensions.depth.toFixed(2)} ${configurable ? "m" : "model units"}` : "Calculating…"} />
      {model.analysis && <>
        <Info label="Detected from 2D drawing" value={`${model.analysis.walls} walls · ${model.analysis.rooms} rooms · ${model.analysis.doors} doors · ${model.analysis.windows} windows`} />
        <Link href={`/review/${modelId}`} className="text-link">Open 2D review / diagnostics →</Link>
      </>}
      <Info label="Source / GLB" value={`${formatBytes(model.metrics.sourceBytes)} / ${formatBytes(model.metrics.outputBytes)}`} />
      <Info label="Conversion" value={model.metrics.conversionDurationMs ? `${(model.metrics.conversionDurationMs / 1000).toFixed(1)} sec` : "—"} />
      {Object.entries(model.metrics.details ?? {}).map(([key, value]) => <Info key={key} label={key.replace(/Ms$/, "")} value={`${(value / 1000).toFixed(2)} sec`} />)}
      <Info label="Browser load" value={browserLoadMs ? `${(browserLoadMs / 1000).toFixed(2)} sec` : "Measuring…"} />
      <div className="info-row"><span>Viewer frame rate</span><strong ref={fpsRef}>Measuring…</strong></div>
      <p className="hierarchy-note">{model.hierarchy.note}</p>
    </details>
  );

  return (
    <main className="viewer-page explore">
      <header className="viewer-topbar">
        <Link href="/" className="back-link" aria-label="Back to upload">← <span>Villa</span></Link>
        <div className="viewer-title"><h1>{model.name}</h1><p>3D Villa Preview</p></div>
        <span className={`status-chip ${loaded ? "ready" : ""}`}>{glbFailed ? "Unavailable" : loaded ? model.isSampleModel ? "Sample model" : "Ready" : "Loading"}</span>
      </header>
      {model.isSampleModel && (
        <div className="mode-notice sample-mode-notice viewer-mode-notice" role="status">
          <strong>Sample Mode — Viewer validation only</strong>
          <span>This is the built-in Sample Villa GLB. <b>{model.sourceFileName}</b> was uploaded but was not converted from {model.sourceFormat.toUpperCase()}.</span>
        </div>
      )}
      <section className="explore-layout">
        <aside className="explore-sidebar" aria-label="Villa navigation">
          {configurable && <RoomNav rooms={rooms} selectedRoomId={selectedRoomId} onSelect={selectRoom} />}
          {configurable && (
            <FurniturePanel
              rooms={rooms} targetRoomName={targetRoom?.name}
              placements={placements} selectedId={selectedId} onSelect={setSelectedId}
              onAdd={addFurniture} onRotate={rotateSelected} onRemove={removeSelected}
              keepInRoom={keepInRoom} onKeepInRoom={setKeepInRoom}
              onSave={saveConfiguration} onReload={reloadConfiguration} dirty={dirty} message={message} savedAt={savedAt}
            />
          )}
          {details}
        </aside>
        <div className="viewer-stage" ref={viewerRef}>
          {glbFailed ? (
            <div className="viewer-error" role="alert">
              <h2>Unable to load villa</h2>
              <p>The 3D model could not be displayed.</p>
              <div className="button-row">
                <button type="button" className="primary-button" onClick={retryModel}>Try again</button>
                <Link href="/" className="secondary-button">Back</Link>
              </div>
            </div>
          ) : (
            <ModelErrorBoundary key={viewerKey} onError={handleModelError}>
              {configurable ? (
                <ThreeViewer url={url} controllerRef={viewer} onDimensions={handleDimensions} onLoad={handleLoaded} onFps={showFps} preserveOrigin onRoomPick={selectRoom} onBackgroundClick={clearFurnitureSelection} highlightRoomId={selectedRoomId} wallScale={lowWalls ? 0.3 : 1}>
                  <FurnitureLayer placements={placements} selectedId={selectedId} onSelect={setSelectedId} constrain={constrainMove} onMoveEnd={commitMove} />
                </ThreeViewer>
              ) : (
                <ThreeViewer url={url} controllerRef={viewer} onDimensions={handleDimensions} onLoad={handleLoaded} onFps={showFps} />
              )}
            </ModelErrorBoundary>
          )}
          {!glbFailed && (
            <div className="viewer-controls" role="toolbar" aria-label="Camera controls">
              <button type="button" onClick={showOverview}>Overview</button>
              <button type="button" onClick={() => viewer.current?.fitVilla()}>Fit villa</button>
              <button type="button" onClick={() => viewer.current?.topView()}>Top</button>
              {configurable && <button type="button" aria-pressed={lowWalls} onClick={() => setLowWalls((value) => !value)}>{lowWalls ? "Full walls" : "Low walls"}</button>}
              <button type="button" onClick={resetView}>Reset</button>
              <button type="button" aria-pressed={isFullscreen} onClick={fullscreen}>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
            </div>
          )}
          {!glbFailed && loaded && <p className="canvas-hint">Drag to orbit · scroll or pinch to zoom · right-drag or two fingers to pan{configurable ? " · click a room to visit it" : ""}</p>}
        </div>
      </section>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function ViewerError({ message }: { message: string }) {
  return <main className="viewer-loading"><div className="viewer-error standalone" role="alert"><h1>Viewer unavailable</h1><p>{message}</p><Link href="/" className="primary-button inline-button">Return to upload</Link></div></main>;
}
