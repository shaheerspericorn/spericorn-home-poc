export const MODEL_STATUSES = [
  "uploaded",
  "queued",
  "processing",
  "converting",
  "post_processing",
  // Local 2D pipeline stages (CAD_CONVERSION_PROVIDER=local)
  "converting_dwg",
  "parsing_dxf",
  "detecting_geometry",
  "awaiting_review",
  "generating_3d",
  "exporting_glb",
  "completed",
  "failed",
] as const;

export type ModelStatus = (typeof MODEL_STATUSES)[number];
export type CadConversionProvider = "aps" | "sample" | "local";

export const IN_PROGRESS_STATUSES: readonly ModelStatus[] = [
  "queued", "processing", "converting", "post_processing",
  "converting_dwg", "parsing_dxf", "detecting_geometry", "generating_3d", "exporting_glb",
];

export type ModelDimensions = {
  width: number;
  height: number;
  depth: number;
  unit: "model units";
};

export type ModelMetrics = {
  sourceBytes: number;
  outputBytes?: number;
  conversionDurationMs?: number;
  /** Provider-specific measurements, e.g. dxfBytes, dwgToDxfMs, dxfParsingMs (local pipeline). */
  details?: Record<string, number>;
};

/** Small summary of a plan analysis; the full report is served from /api/models/:id/analysis. */
export type AnalysisSummary = {
  status: "analyzed" | "no_walls" | "generated";
  units?: string;
  walls: number;
  rooms: number;
  doors: number;
  windows: number;
  warnings: string[];
};

export type ModelRecord = {
  id: string;
  name: string;
  sourceFileName: string;
  sourceFormat: string;
  sourcePath: string;
  conversionProvider: CadConversionProvider;
  isSampleModel: boolean;
  status: ModelStatus;
  progress: number;
  stage: string;
  outputPath?: string;
  modelUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  metrics: ModelMetrics;
  dimensions?: ModelDimensions;
  /** Present once a provider that supports plan review has analysed the drawing (even if it found no walls). */
  analysis?: AnalysisSummary;
  hierarchy: {
    preserved: boolean;
    note: string;
  };
};

export type ConversionResult = {
  success: boolean;
  modelId: string;
  sourceFormat: string;
  outputFormat: "glb";
  outputPath?: string;
  outputUrl?: string;
  outputBytes?: number;
  error?: string;
  hierarchy?: ModelRecord["hierarchy"];
  analysis?: AnalysisSummary;
  metricDetails?: Record<string, number>;
};

export type AnalysisResult = {
  analysis: AnalysisSummary;
  metricDetails?: Record<string, number>;
};

/** User-adjustable reconstruction inputs from the 2D review screen. Validated at the API boundary. */
export type GenerationOptions = {
  build?: { wallHeight?: number; wallThickness?: number };
  unitsOverride?: string;
  layerRoles?: Record<string, string>;
  roomNames?: Record<string, string>;
};

export type ConversionProgress = {
  status: Exclude<ModelStatus, "uploaded" | "queued" | "awaiting_review" | "completed" | "failed">;
  progress: number;
  stage: string;
};
