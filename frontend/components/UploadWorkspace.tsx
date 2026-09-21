"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiBaseUrl, modelApi, type UploadConfig } from "../lib/api";
import { formatBytes, validateModelFile } from "../lib/file-validation";
import { ConversionProgress } from "./ConversionProgress";

const fallbackConfig: UploadConfig = {
  supportedFormats: ["dwg", "ifc", "rvt", "step", "stp"],
  maxUploadBytes: 100 * 1024 * 1024,
  conversionProvider: "sample",
  isSampleMode: true,
};

type UploadResult = { modelId: string; status: string };

function uploadWithProgress(file: File, onProgress: (percent: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${apiBaseUrl}/api/models/upload`);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new ApiError("Upload failed. Check that the backend is running."));
    request.onload = () => {
      const response = request.response as UploadResult & { error?: string } | null;
      if (request.status >= 200 && request.status < 300 && response?.modelId) resolve(response);
      else reject(new ApiError(response?.error || "The upload could not be completed."));
    };
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

export function UploadWorkspace() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<UploadConfig>(fallbackConfig);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [modelId, setModelId] = useState<string>();

  useEffect(() => {
    modelApi.config().then(setConfig).catch(() => {
      setError("The backend is unavailable. Start it before uploading a model.");
    });
  }, []);

  function selectFile(nextFile: File | undefined) {
    setError(undefined);
    setFile(undefined);
    if (!nextFile) return;
    const validationError = validateModelFile(nextFile, config);
    if (validationError) {
      setError(validationError);
      return;
    }
    setFile(nextFile);
  }

  async function submit() {
    if (!file) return;
    setUploading(true);
    setError(undefined);
    try {
      const uploaded = await uploadWithProgress(file, setUploadProgress);
      await modelApi.convert(uploaded.modelId);
      setModelId(uploaded.modelId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload could not be completed.");
      setUploading(false);
    }
  }

  if (modelId) {
    return (
      <main className="page-shell compact-shell">
        <Brand />
        <ConversionProgress
          modelId={modelId}
          fileName={file?.name || "Villa model"}
          isSampleMode={config.isSampleMode}
          onComplete={() => router.push(`/viewer/${modelId}`)}
          onReview={config.supportsPlanReview ? () => router.push(`/review/${modelId}`) : undefined}
          onRetry={() => { setModelId(undefined); setUploading(false); setUploadProgress(0); }}
        />
      </main>
    );
  }

  return (
    <main className="page-shell compact-shell">
      <Brand />
      <section className="upload-card" aria-labelledby="upload-title">
        <p className="eyebrow">Technical proof of concept</p>
        <h1 id="upload-title">Upload Villa CAD Model</h1>
        <p className="subtle">Upload a source file and prepare a GLB for browser inspection.</p>
        {config.isSampleMode && (
          <div className="mode-notice sample-mode-notice" role="status">
            <strong>Sample Mode</strong>
            <span>A built-in Sample Villa GLB will be displayed. Your uploaded CAD/BIM file is stored but is <b>not</b> converted.</span>
          </div>
        )}
        {config.configurationError && <p className="form-error" role="alert">{config.configurationError}</p>}

        <button
          type="button"
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files.item(0) || undefined); }}
        >
          <span className="upload-icon" aria-hidden="true">↑</span>
          <strong>{config.supportsPlanReview ? "Drag & drop a 2D architectural DWG" : "Drag & drop a CAD/BIM model"}</strong>
          <span>or choose a file</span>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept={config.supportedFormats.map((item) => `.${item}`).join(",")}
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
        </button>

        <div className="upload-support">
          <span>Supported: {config.supportedFormats.map((item) => `.${item}`).join(", ")}</span>
          <span>Maximum: {formatBytes(config.maxUploadBytes)}</span>
        </div>

        {file && (
          <div className="file-summary" aria-live="polite">
            <span className="file-badge">{file.name.split(".").at(-1)?.toUpperCase()}</span>
            <div><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.type || "CAD/BIM file"}</small></div>
            <button type="button" className="text-button" onClick={() => { setFile(undefined); setError(undefined); }}>Remove</button>
          </div>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}
        {uploading && <div className="upload-meter"><div style={{ width: `${uploadProgress}%` }} /><span>Uploading {uploadProgress}%</span></div>}
        <button type="button" className="primary-button" disabled={!file || uploading || Boolean(config.configurationError)} onClick={submit}>
          {uploading ? "Uploading…" : config.isSampleMode ? "Upload & Open Sample Viewer" : config.supportsPlanReview ? "Upload & Analyse Drawing" : "Upload & Convert"}
        </button>
        <p className="poc-note">{config.isSampleMode ? "Sample Mode validates the upload flow and 3D viewer only; it does not validate CAD conversion or 2D-vs-3D detection." : config.supportsPlanReview ? "Local pipeline: a 2D architectural DWG/DXF is analysed on this server, reviewed in 2D, then reconstructed as a basic 3D villa. Results depend on the drawing following common layer conventions." : "2D drawings are rejected after APS confirms no 3D view is available."}</p>
      </section>
    </main>
  );
}

function Brand() {
  return <header className="brand"><span className="brand-mark">S</span><div><strong>Spericorn Homes</strong><span>Villa 3D POC</span></div></header>;
}
