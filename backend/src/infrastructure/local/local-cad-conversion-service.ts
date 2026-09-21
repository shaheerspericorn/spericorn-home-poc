import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../../config.js";
import { FileSystemStorage } from "../../services/storage/file-system-storage.js";
import type { PlanReviewCapable, ProgressCallback } from "../../types/conversion.js";
import type { AnalysisResult, AnalysisSummary, ConversionProgress, ConversionResult, GenerationOptions, ModelRecord } from "../../types/model.js";
import { PythonCadWorker, type WorkerProgress, type WorkerResult } from "./python-cad-worker.js";

const STAGES = new Set<ConversionProgress["status"]>(["converting_dwg", "parsing_dxf", "detecting_geometry", "generating_3d", "exporting_glb"]);

/**
 * Local pipeline: 2D DWG/DXF -> ODA File Converter -> ezdxf -> rule-based detection -> trimesh -> GLB.
 * All CAD/geometry logic lives in the Python worker (cad-worker/); this class only orchestrates it.
 * It needs no APS credentials and makes no network calls.
 */
export class LocalCadConversionService implements PlanReviewCapable {
  readonly provider = "local" as const;
  readonly isSampleMode = false;
  readonly supportedFormats = ["dwg", "dxf"] as const;

  constructor(
    private readonly storage: FileSystemStorage,
    private readonly worker: Pick<PythonCadWorker, "run"> = new PythonCadWorker(appConfig.local),
    private readonly workRoot: string = appConfig.local.workDir,
  ) {}

  /** One private directory per job, keyed by the server-generated model id - never by the uploaded filename. */
  private async workDir(modelId: string): Promise<string> {
    const directory = path.join(this.workRoot, modelId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  analysisPath(modelId: string): string {
    return path.join(this.workRoot, modelId, "analysis.json");
  }

  async analyze(model: ModelRecord, onProgress: ProgressCallback, options: GenerationOptions = {}): Promise<AnalysisResult> {
    const workdir = await this.workDir(model.id);
    // The worker decides the file type from the extension, so hand it a neutral, generated name.
    const input = await this.storage.stageSource(model, await mkdtemp(path.join(workdir, "src-")));
    const result = await this.worker.run("analyze", { input, workdir, options: JSON.stringify(options) }, this.relay(onProgress));
    return { analysis: summarise(result), metricDetails: result.timings };
  }

  async convert(model: ModelRecord, onProgress: ProgressCallback, options: GenerationOptions = {}): Promise<ConversionResult> {
    const workdir = await this.workDir(model.id);
    const outputPath = await this.storage.prepareOutput(model.id);
    const result = await this.worker.run("generate", { workdir, output: outputPath, options: JSON.stringify(options) }, this.relay(onProgress));
    const outputBytes = await this.storage.fileSize(outputPath);
    return {
      success: true,
      modelId: model.id,
      sourceFormat: model.sourceFormat,
      outputFormat: "glb",
      outputPath,
      outputUrl: `/api/models/${model.id}/model.glb`,
      outputBytes,
      analysis: summarise(result),
      metricDetails: result.timings,
      hierarchy: {
        preserved: true,
        note: `Reconstructed from 2D linework: ${result.model3d?.wallsGenerated ?? 0} walls and ${result.model3d?.floorsGenerated ?? 0} floor meshes as individually named nodes (Wall_001, Room_*, Door_001, Window_001).`,
      },
    };
  }

  private relay(onProgress: ProgressCallback) {
    return (update: WorkerProgress) => {
      if (STAGES.has(update.stage as ConversionProgress["status"])) {
        void onProgress({ status: update.stage as ConversionProgress["status"], progress: update.progress, stage: update.stage });
      }
    };
  }
}

function summarise(result: WorkerResult): AnalysisSummary {
  return {
    status: result.status,
    units: result.units.used,
    walls: result.detection.candidateWalls,
    rooms: result.detection.candidateRooms,
    doors: result.detection.candidateDoors,
    windows: result.detection.candidateWindows,
    warnings: result.warnings.slice(0, 12),
  };
}
