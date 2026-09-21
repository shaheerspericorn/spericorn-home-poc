"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { modelApi } from "../lib/api";
import { LAYER_ROLES, UNIT_OPTIONS, polygonPath, type CadAnalysis, type GenerationOptions, type LayerRole } from "../lib/cad-analysis";
import { formatBytes } from "../lib/file-validation";
import { useModelStatus } from "../lib/use-model-status";

const ROOM_FILLS = ["#f3dfc1", "#d5e8d4", "#dae3f3", "#f5d9d5", "#e6e9c9", "#e3d7ee"];
const STAGE_LABELS: Record<string, string> = {
  conversion_queued: "Queued", converting_dwg: "Converting DWG → DXF", parsing_dxf: "Parsing DXF", detecting_geometry: "Detecting geometry",
  generating_3d: "Generating 3D geometry", exporting_glb: "Exporting GLB",
};

const seconds = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(2)} s`);

export function PlanReview({ modelId }: { modelId: string }) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<CadAnalysis>();
  const [error, setError] = useState<string>();
  const [wallHeight, setWallHeight] = useState("3");
  const [wallThickness, setWallThickness] = useState("0.2");
  const [units, setUnits] = useState("");
  const [layerRoles, setLayerRoles] = useState<Record<string, string>>({});
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [showSource, setShowSource] = useState(true);
  const [run, setRun] = useState<{ kind: "analyze" | "generate"; key: number }>();

  const load = useCallback(() => {
    modelApi.analysis(modelId).then((next) => {
      setAnalysis(next);
      setWallHeight(String(next.parameters.build.wallHeight));
      setWallThickness(String(next.parameters.build.wallThickness));
      setUnits(next.parameters.unitsOverride ?? "");
      setLayerRoles(next.parameters.layerRoles ?? {});
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the drawing analysis."));
  }, [modelId]);
  useEffect(load, [load]);

  const { state, pollError } = useModelStatus(modelId, Boolean(run), run?.key);
  useEffect(() => {
    if (!run || !state) return;
    if (state.status === "completed" && run.kind === "generate") router.push(`/viewer/${modelId}`);
    else if (state.status === "awaiting_review" || state.status === "failed") {
      if (state.status === "failed") setError(state.error || "Processing failed.");
      setRun(undefined);
      if (state.analysisAvailable) load();
    }
  }, [state, run, router, modelId, load]);

  const options = useMemo<GenerationOptions>(() => ({
    build: { wallHeight: Number(wallHeight), wallThickness: Number(wallThickness) },
    ...(units ? { unitsOverride: units } : {}),
    ...(Object.keys(layerRoles).length ? { layerRoles } : {}),
    ...(Object.keys(roomNames).length ? { roomNames } : {}),
  }), [wallHeight, wallThickness, units, layerRoles, roomNames]);

  const inputError = !(Number(wallHeight) >= 0.5 && Number(wallHeight) <= 20) ? "Wall height must be between 0.5 and 20 m."
    : !(Number(wallThickness) >= 0.02 && Number(wallThickness) <= 2) ? "Wall thickness must be between 0.02 and 2 m." : undefined;

  async function start(kind: "analyze" | "generate") {
    setError(undefined);
    try {
      await (kind === "analyze" ? modelApi.reanalyze(modelId, options) : modelApi.generate(modelId, options));
      setRun({ kind, key: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be started.");
    }
  }

  if (!analysis) {
    return <main className="viewer-loading"><p className="eyebrow">2D Plan Review</p><h1>{error ? "Analysis unavailable" : "Loading drawing analysis…"}</h1>{error && <p className="form-error">{error}</p>}<Link href="/" className="primary-button inline-button">Back to upload</Link></main>;
  }

  const detection = analysis.detection;
  const hasWalls = detection.candidateWalls > 0;
  const rolesChanged = JSON.stringify(layerRoles) !== JSON.stringify(analysis.parameters.layerRoles ?? {}) || units !== (analysis.parameters.unitsOverride ?? "");
  const busy = Boolean(run);

  return (
    <main className="viewer-page">
      <header className="viewer-header">
        <Link href="/" className="back-link">← Back to upload</Link>
        <div><p className="eyebrow">2D Architectural Plan — what the parser understood</p><h1>{analysis.source.fileName}</h1></div>
        <span className={`status-chip ${hasWalls ? "ready" : ""}`}>{hasWalls ? "Analysed" : "No walls detected"}</span>
      </header>

      {!hasWalls && (
        <div className="mode-notice danger-notice" role="alert">
          <strong>No reliable wall geometry was detected.</strong>
          <span>No 3D model will be generated from guesses. Inspect the layers below, assign the layer(s) that contain walls, then re-analyse — or provide a drawing that follows common architectural layer conventions.</span>
        </div>
      )}
      {analysis.warnings.length > 0 && (
        <div className="mode-notice warning-notice" role="status">
          <strong>Warnings</strong>
          <ul>{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}

      <section className="review-layout">
        <div className="plan-stage">
          <PlanSvg analysis={analysis} showSource={showSource} />
          <div className="plan-legend">
            <span><i style={{ background: "#2d3a42" }} />Walls</span><span><i style={{ background: "#f3dfc1" }} />Rooms</span>
            <span><i style={{ background: "#c8452f" }} />Doors</span><span><i style={{ background: "#2f7fd0" }} />Windows</span><span><i style={{ background: "#3d9a57" }} />Open passages</span>
            <label><input type="checkbox" checked={showSource} onChange={(event) => setShowSource(event.target.checked)} /> Source linework</label>
          </div>
        </div>

        <aside className="model-info review-panel" aria-label="Detection report">
          <h2>Detected</h2>
          <ul className="detected-list">
            <Detected count={detection.candidateWalls} label="walls" />
            <Detected count={detection.candidateRooms} label={`rooms (${detection.namedRooms} named from CAD text)`} />
            <Detected count={detection.candidateDoors} label={`doors${detection.doorsOnIntactWalls ? ` (${detection.doorsOnIntactWalls} on intact walls)` : ""}`} />
            <Detected count={detection.candidateWindows} label="windows" />
            <Detected count={detection.candidateOpenings} label="open passages" />
          </ul>

          <h3>Defaults</h3>
          <label className="field-row">Wall height (m)<input type="number" step="0.1" min="0.5" max="20" value={wallHeight} onChange={(event) => setWallHeight(event.target.value)} /></label>
          <label className="field-row" title="Used only where thickness cannot be measured from the drawing (door/window symbols on intact walls).">Fallback wall thickness (m)<input type="number" step="0.01" min="0.02" max="2" value={wallThickness} onChange={(event) => setWallThickness(event.target.value)} /></label>
          <label className="field-row">Drawing units
            <select value={units} onChange={(event) => setUnits(event.target.value)}>
              <option value="">Auto ({analysis.units.used})</option>
              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {inputError && <p className="form-error">{inputError}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {pollError && <p className="form-error">{pollError}</p>}
          {busy && <p className="subtle" aria-live="polite">{STAGE_LABELS[state?.stage ?? ""] ?? "Working"}… {state?.progress ?? 0}%</p>}
          {rolesChanged && <button type="button" className="secondary-button" disabled={busy} onClick={() => start("analyze")}>Re-analyse with changes</button>}
          <button type="button" className="primary-button" disabled={busy || !hasWalls || rolesChanged || Boolean(inputError)} onClick={() => start("generate")}>
            {busy && run?.kind === "generate" ? "Generating…" : "Generate 3D"}
          </button>
          {rolesChanged && <small className="subtle">Units or layer roles changed — re-analyse first so the preview matches what will be built.</small>}

          <hr />
          <h3>Source</h3>
          <Info label="File" value={`${analysis.source.fileType} · ${formatBytes(analysis.source.sizeBytes)}`} />
          {analysis.source.sourceVersionName && <Info label="DWG version" value={analysis.source.sourceVersionName} />}
          <Info label="DWG → DXF" value={`${analysis.source.conversion.status} (${analysis.source.conversion.tool})`} />
          <Info label="DXF" value={`${analysis.dxf.versionName}${analysis.dxf.sizeBytes ? ` · ${formatBytes(analysis.dxf.sizeBytes)}` : ""}`} />
          <Info label="Units" value={`${analysis.units.used} (${analysis.units.source}; header: ${analysis.units.declared})`} />
          <Info label="Plan size" value={`${(analysis.extents.modelMeters.max[0] - analysis.extents.modelMeters.min[0]).toFixed(2)} × ${(analysis.extents.modelMeters.max[1] - analysis.extents.modelMeters.min[1]).toFixed(2)} m`} />

          <h3>Entities</h3>
          {Object.entries(analysis.entities).map(([type, count]) => <Info key={type} label={type} value={String(count)} />)}
          <Info label="Block references" value={String(analysis.counts.blockReferences)} />
          <Info label="Text" value={String(analysis.counts.texts)} />
          <Info label="Hatches" value={String(analysis.counts.hatches)} />

          <h3>Wall strategies</h3>
          <Info label="1 · Closed polylines" value={String(detection.wallStrategies["closed-polyline"] ?? 0)} />
          <Info label="2 · Parallel line pairs" value={String(detection.wallStrategies["parallel-pair"] ?? 0)} />
          <Info label="3 · Line network faces" value={String(detection.wallStrategies["line-network"] ?? 0)} />

          <h3>Timings</h3>
          <Info label="DWG → DXF" value={seconds(analysis.timings.dwgToDxfMs)} />
          <Info label="DXF parsing" value={seconds(analysis.timings.dxfParsingMs)} />
          <Info label="Geometry detection" value={seconds(analysis.timings.geometryDetectionMs)} />

          {analysis.rooms.length > 0 && <>
            <h3>Rooms <small>(rename to correct)</small></h3>
            {analysis.rooms.map((room) => (
              <label key={room.id} className="field-row room-row">
                <input type="text" maxLength={80} value={roomNames[room.id] ?? room.name} onChange={(event) => setRoomNames((current) => ({ ...current, [room.id]: event.target.value }))} />
                <span>{room.area.toFixed(1)} m²</span>
              </label>
            ))}
          </>}

          <h3>Layers <small>(assign roles to add rules)</small></h3>
          <div className="layer-table">
            {analysis.layers.filter((layer) => layer.entityCount > 0).map((layer) => (
              <label key={layer.name} className="field-row layer-row">
                <span title={Object.entries(layer.types).map(([type, count]) => `${type}: ${count}`).join(", ")}>{layer.name} <small>{layer.entityCount}</small></span>
                <select value={layerRoles[layer.name] ?? layer.role} onChange={(event) => setLayerRoles((current) => ({ ...current, [layer.name]: event.target.value as LayerRole }))}>
                  {LAYER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </label>
            ))}
          </div>

          <h3>Assumptions</h3>
          <ul className="assumption-list">{analysis.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
        </aside>
      </section>
    </main>
  );
}

function PlanSvg({ analysis, showSource }: { analysis: CadAnalysis; showSource: boolean }) {
  const { min, max } = analysis.extents.modelMeters;
  const margin = Math.max(max[0] - min[0], max[1] - min[1]) * 0.04 + 0.5;
  // The plan is drawn in CAD axes inside a group flipped once (SVG y grows downwards); labels are placed unflipped.
  const viewBox = `${min[0] - margin} ${-(max[1] + margin)} ${max[0] - min[0] + 2 * margin} ${max[1] - min[1] + 2 * margin}`;
  const stroke = Math.max(max[0] - min[0], max[1] - min[1]) / 900;
  return (
    <svg className="plan-svg" viewBox={viewBox} role="img" aria-label="Detected 2D plan" preserveAspectRatio="xMidYMid meet">
      <g transform="scale(1,-1)">
        {showSource && analysis.previewEntities.map((entity, index) => (
          <polyline key={index} points={entity.points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="#b9c4c9" strokeWidth={stroke} />
        ))}
        {analysis.rooms.map((room, index) => <polygon key={room.id} data-room={room.id} points={room.polygon.map(([x, y]) => `${x},${y}`).join(" ")} fill={ROOM_FILLS[index % ROOM_FILLS.length]} fillOpacity={0.85} />)}
        {analysis.walls.map((wall) => <path key={wall.id} data-wall={wall.id} d={polygonPath(wall.geometry2d)} fill="#2d3a42" fillRule="evenodd" />)}
        {analysis.openings.map((item) => <path key={item.id} d={polygonPath(item.geometry2d)} fill="#3d9a57" />)}
        {analysis.windows.map((item) => <path key={item.id} data-window={item.id} d={polygonPath(item.geometry2d)} fill="#2f7fd0" fillOpacity={item.hostCut ? 1 : 0.5} />)}
        {analysis.doors.map((item) => <path key={item.id} data-door={item.id} d={polygonPath(item.geometry2d)} fill="#c8452f" fillOpacity={item.hostCut ? 1 : 0.5} />)}
      </g>
      {analysis.rooms.map((room) => (
        <text key={room.id} x={room.center[0]} y={-room.center[1]} fontSize={Math.min(0.5, Math.max(0.22, Math.sqrt(room.area) / 9))} textAnchor="middle" dominantBaseline="middle" fill="#16232c">{room.name}</text>
      ))}
    </svg>
  );
}

function Detected({ count, label }: { count: number; label: string }) {
  return <li className={count ? "found" : "missing"}><span aria-hidden="true">{count ? "✓" : "✕"}</span> <strong>{count}</strong> {label}</li>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}
