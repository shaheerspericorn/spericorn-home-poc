import type { CadAnalysis, GenerationOptions } from "./cad-analysis";
import type { VillaConfiguration } from "./configuration";

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

export type UploadConfig = {
  supportedFormats: string[];
  maxUploadBytes: number;
  conversionProvider: ConversionProvider;
  isSampleMode: boolean;
  /** True when the provider pauses for a 2D review before building 3D (local pipeline). */
  supportsPlanReview?: boolean;
  buildDefaults?: { wallHeight: number; wallThickness: number; floorThickness: number };
  configurationError?: string;
};

export type ConversionProvider = "sample" | "aps" | "local";

export type ModelStatus =
  | "uploaded" | "queued" | "processing" | "converting" | "post_processing"
  | "converting_dwg" | "parsing_dxf" | "detecting_geometry" | "awaiting_review" | "generating_3d" | "exporting_glb"
  | "completed" | "failed";

export type ModelStatusResponse = {
  id: string;
  status: ModelStatus;
  progress: number;
  stage: string;
  error?: string;
  analysisAvailable?: boolean;
};

export type AnalysisSummary = { status: "analyzed" | "no_walls" | "generated"; units?: string; walls: number; rooms: number; doors: number; windows: number; warnings: string[] };

export type ModelInfo = {
  id: string;
  name: string;
  sourceFileName: string;
  sourceFormat: string;
  conversionProvider: ConversionProvider;
  isSampleModel: boolean;
  status: ModelStatus;
  progress: number;
  stage: string;
  modelUrl?: string;
  error?: string;
  metrics: { sourceBytes: number; outputBytes?: number; conversionDurationMs?: number; details?: Record<string, number> };
  analysis?: AnalysisSummary;
  hierarchy: { preserved: boolean; note: string };
};

export class ApiError extends Error {}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || "The server could not complete the request.");
  return body;
}

export const modelApi = {
  config: () => request<UploadConfig>("/api/config"),
  convert: (id: string) => request<{ modelId: string; status: ModelStatus }>(`/api/models/${id}/convert`, { method: "POST" }),
  status: (id: string) => request<ModelStatusResponse>(`/api/models/${id}/status`),
  get: (id: string) => request<ModelInfo>(`/api/models/${id}`),
  analysis: (id: string) => request<CadAnalysis>(`/api/models/${id}/analysis`),
  reanalyze: (id: string, options: GenerationOptions) => request<{ modelId: string; status: ModelStatus }>(`/api/models/${id}/analyze`, json("POST", options)),
  generate: (id: string, options: GenerationOptions) => request<{ modelId: string; status: ModelStatus }>(`/api/models/${id}/generate`, json("POST", options)),
  configuration: (id: string) => request<VillaConfiguration>(`/api/models/${id}/configuration`),
  saveConfiguration: (id: string, configuration: VillaConfiguration) => request<VillaConfiguration>(`/api/models/${id}/configuration`, json("PUT", configuration)),
};

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function modelAssetUrl(relativeUrl: string): string {
  return `${apiBaseUrl}${relativeUrl}`;
}
