import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { appConfig } from "../../config.js";
import { supportsPlanReview, type CadConversionService } from "../../types/conversion.js";
import type { VillaConfiguration } from "../../types/configuration.js";
import { IN_PROGRESS_STATUSES, type GenerationOptions, type ModelRecord } from "../../types/model.js";
import { displayNameFromFile, extensionOf } from "../../utils/files.js";
import { UserFacingError } from "../../utils/errors.js";
import { FileSystemStorage } from "../storage/file-system-storage.js";
import { ModelRepository } from "./model-repository.js";

const NO_WALLS_MESSAGE = "DWG was parsed successfully, but no wall geometry could be reliably detected. Please check the drawing layers or provide a drawing that follows the supported architectural CAD conventions.";

export class ModelService {
  constructor(
    private readonly repository: ModelRepository,
    private readonly storage: FileSystemStorage,
    private readonly conversionService: CadConversionService,
  ) {}

  async createFromUpload(file: Express.Multer.File): Promise<ModelRecord> {
    const sourceFormat = extensionOf(file.originalname);
    const accepted = this.conversionService.supportedFormats
      ? appConfig.supportedFormats.filter((format) => this.conversionService.supportedFormats?.includes(format))
      : appConfig.supportedFormats;
    if (!accepted.includes(sourceFormat)) {
      throw new UserFacingError(`.${sourceFormat || "unknown"} files are not supported. Upload one of: ${accepted.map((item) => `.${item}`).join(", ")}.`);
    }

    const id = randomUUID();
    const sourcePath = await this.storage.storeUpload(id, file);
    const now = new Date().toISOString();
    return this.repository.create({
      id,
      name: displayNameFromFile(file.originalname),
      sourceFileName: file.originalname.slice(0, 200),
      sourceFormat,
      sourcePath,
      conversionProvider: this.conversionService.provider,
      isSampleModel: this.conversionService.isSampleMode,
      status: "uploaded",
      progress: 10,
      stage: "file_uploaded",
      createdAt: now,
      updatedAt: now,
      metrics: { sourceBytes: file.size },
      hierarchy: {
        preserved: false,
        note: "Hierarchy is evaluated only after a successful conversion.",
      },
    });
  }

  get(id: string): ModelRecord | undefined {
    return this.repository.get(id);
  }

  /**
   * Starts background processing and returns immediately. Providers that support plan review stop at
   * "awaiting_review" after analysis; all others convert straight through to a GLB.
   */
  async startConversion(id: string, options?: GenerationOptions): Promise<ModelRecord> {
    const model = this.requireModel(id);
    if (IN_PROGRESS_STATUSES.includes(model.status)) return model;
    // A finished or reviewed model is only re-processed when the review screen sends corrected options.
    if ((model.status === "completed" || model.status === "awaiting_review") && !(options && supportsPlanReview(this.conversionService))) return model;

    const queued = await this.repository.update(id, { status: "queued", progress: 15, stage: "conversion_queued", error: undefined });
    if (!queued) throw new UserFacingError("Model not found.", 404);
    void (supportsPlanReview(this.conversionService) ? this.runAnalysis(id, options) : this.runConversion(id));
    return queued;
  }

  /** Builds the 3D model after the 2D review. Allowed again after completion so defaults can be corrected. */
  async generate(id: string, options: GenerationOptions): Promise<ModelRecord> {
    const model = this.requireModel(id);
    if (!supportsPlanReview(this.conversionService)) throw new UserFacingError("The active conversion provider does not have a review step.", 409);
    if (IN_PROGRESS_STATUSES.includes(model.status)) return model;
    if (!model.analysis) throw new UserFacingError("This model has not been analysed yet.", 409);

    const queued = await this.repository.update(id, { status: "generating_3d", progress: 70, stage: "generating_3d", error: undefined });
    if (!queued) throw new UserFacingError("Model not found.", 404);
    void this.runConversion(id, options);
    return queued;
  }

  async getAnalysis(id: string): Promise<unknown> {
    const model = this.requireModel(id);
    if (!supportsPlanReview(this.conversionService) || !model.analysis) throw new UserFacingError("No drawing analysis is available for this model.", 404);
    const analysis = await this.storage.readJson<Record<string, unknown>>(this.conversionService.analysisPath(id));
    if (!analysis) throw new UserFacingError("No drawing analysis is available for this model.", 404);
    // Server paths are internal; the original filename is display-only metadata from the model record.
    const { analysisPath: _analysisPath, ...safe } = analysis;
    return { ...safe, source: { ...(safe.source as object), fileName: model.sourceFileName } };
  }

  async getConfiguration(id: string): Promise<VillaConfiguration> {
    this.requireModel(id);
    return (await this.storage.readJson<VillaConfiguration>(this.storage.configurationPath(id))) ?? { villaModelId: id, furniture: [] };
  }

  async saveConfiguration(id: string, configuration: VillaConfiguration): Promise<VillaConfiguration> {
    this.requireModel(id);
    if (configuration.villaModelId !== id) throw new UserFacingError("The configuration belongs to a different villa model.");
    const saved = { ...configuration, updatedAt: new Date().toISOString() };
    await this.storage.writeJson(this.storage.configurationPath(id), saved);
    return saved;
  }

  private requireModel(id: string): ModelRecord {
    const model = this.repository.get(id);
    if (!model) throw new UserFacingError("Model not found.", 404);
    return model;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.repository.delete(id);
    if (removed) await this.storage.deleteModel(id);
    return removed;
  }

  private async runAnalysis(id: string, options?: GenerationOptions): Promise<void> {
    const model = this.repository.get(id);
    if (!model || !supportsPlanReview(this.conversionService)) return;
    try {
      const { analysis, metricDetails } = await this.conversionService.analyze(model, async (update) => {
        await this.repository.update(id, update);
      }, options);
      const metrics = { ...model.metrics, details: { ...model.metrics.details, ...metricDetails } };
      if (analysis.status === "no_walls") {
        // Diagnostics stay available (analysis is recorded) but the job is a failure: nothing is fabricated.
        // When the worker knows *why* (e.g. the upload is a 3D model, not a 2D plan), lead with that.
        const reason = analysis.warnings.find((warning) => warning.startsWith("This file is a 3D model"));
        await this.repository.update(id, { status: "failed", progress: 100, stage: "failed", analysis, metrics, error: reason ?? NO_WALLS_MESSAGE });
        return;
      }
      await this.repository.update(id, { status: "awaiting_review", progress: 65, stage: "awaiting_review", analysis, metrics });
    } catch (error) {
      await this.fail(id, error);
    }
  }

  private async runConversion(id: string, options?: GenerationOptions): Promise<void> {
    const startedAt = Date.now();
    const model = this.repository.get(id);
    if (!model) return;
    try {
      const result = await this.conversionService.convert(model, async (update) => {
        await this.repository.update(id, update);
      }, options);
      if (!result.success || !result.outputPath || !result.outputBytes) {
        throw new UserFacingError(result.error || "The conversion provider did not produce a GLB file.");
      }
      await this.repository.update(id, {
        status: "completed",
        progress: 100,
        stage: "complete",
        outputPath: result.outputPath,
        modelUrl: `/api/models/${id}/model.glb`,
        hierarchy: result.hierarchy || { preserved: false, note: "No hierarchy information was returned." },
        analysis: result.analysis ?? model.analysis,
        metrics: { ...model.metrics, outputBytes: result.outputBytes, conversionDurationMs: Date.now() - startedAt, details: { ...model.metrics.details, ...result.metricDetails } },
      });
      this.logMetrics(id);
    } catch (error) {
      await this.fail(id, error);
    }
  }

  private async fail(id: string, error: unknown): Promise<void> {
    const message = error instanceof UserFacingError ? error.message : `Conversion failed. Check the server logs and the ${this.conversionService.provider} provider configuration.`;
    console.error(`Conversion failed for model ${id}:`, error);
    await this.repository.update(id, { status: "failed", progress: 100, stage: "failed", error: message });
  }

  private logMetrics(id: string): void {
    const model = this.repository.get(id);
    if (!model) return;
    console.log(`[metrics] model=${id} provider=${model.conversionProvider} ${JSON.stringify({ ...model.metrics, analysis: model.analysis && { ...model.analysis, warnings: undefined } })}`);
  }
}
