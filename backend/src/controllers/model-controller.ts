import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { NextFunction, Request, Response } from "express";
import { appConfig } from "../config.js";
import { ModelService } from "../services/model/model-service.js";
import { generationOptionsSchema, villaConfigurationSchema } from "../types/configuration.js";
import { UserFacingError } from "../utils/errors.js";

function publicModel(model: ReturnType<ModelService["get"]>) {
  if (!model) return undefined;
  const { sourcePath: _sourcePath, outputPath: _outputPath, ...safe } = model;
  return safe;
}

function modelId(request: Request): string {
  const id = request.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function parseBody<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new UserFacingError(`Invalid request: ${issue.path.map(String).join(".") || "body"} - ${issue.message}`);
}

export class ModelController {
  constructor(private readonly models: ModelService) {}

  config = (_request: Request, response: Response): void => {
    response.json({
      supportedFormats: appConfig.supportedFormats,
      maxUploadBytes: appConfig.maxUploadBytes,
      conversionProvider: appConfig.cadConversionProvider,
      isSampleMode: appConfig.cadConversionProvider === "sample",
      supportsPlanReview: appConfig.cadConversionProvider === "local",
      buildDefaults: appConfig.local.defaults,
      configurationError: appConfig.apsConfigurationError,
    });
  };

  upload = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.file) throw new UserFacingError("Choose a CAD/BIM file before uploading.");
      const model = await this.models.createFromUpload(request.file);
      response.status(201).json({ modelId: model.id, status: model.status });
    } catch (error) {
      // Multer has already written an incoming file when service validation fails.
      // Remove it so rejected extensions do not accumulate on disk.
      if (request.file) await rm(request.file.path, { force: true }).catch(() => undefined);
      next(error);
    }
  };

  convert = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const model = await this.models.startConversion(modelId(request));
      response.status(202).json({ modelId: model.id, status: model.status });
    } catch (error) {
      next(error);
    }
  };

  status = (request: Request, response: Response, next: NextFunction): void => {
    try {
      const model = this.models.get(modelId(request));
      if (!model) throw new UserFacingError("Model not found.", 404);
      response.json({ id: model.id, status: model.status, progress: model.progress, stage: model.stage, error: model.error, analysisAvailable: Boolean(model.analysis) });
    } catch (error) {
      next(error);
    }
  };

  get = (request: Request, response: Response, next: NextFunction): void => {
    try {
      const model = publicModel(this.models.get(modelId(request)));
      if (!model) throw new UserFacingError("Model not found.", 404);
      response.json(model);
    } catch (error) {
      next(error);
    }
  };

  /** Re-runs the 2D analysis with corrected units / layer roles from the review screen. */
  analyze = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const options = parseBody(generationOptionsSchema, request.body);
      const model = await this.models.startConversion(modelId(request), options);
      response.status(202).json({ modelId: model.id, status: model.status });
    } catch (error) {
      next(error);
    }
  };

  analysis = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      response.json(await this.models.getAnalysis(modelId(request)));
    } catch (error) {
      next(error);
    }
  };

  generate = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const model = await this.models.generate(modelId(request), parseBody(generationOptionsSchema, request.body ?? {}));
      response.status(202).json({ modelId: model.id, status: model.status });
    } catch (error) {
      next(error);
    }
  };

  getConfiguration = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      // Wrapped rather than sent bare: the client must tell "nothing saved yet" apart from a saved empty layout.
      response.json({ configuration: (await this.models.getConfiguration(modelId(request))) ?? null });
    } catch (error) {
      next(error);
    }
  };

  saveConfiguration = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      response.json(await this.models.saveConfiguration(modelId(request), parseBody(villaConfigurationSchema, request.body)));
    } catch (error) {
      next(error);
    }
  };

  downloadGlb = (request: Request, response: Response, next: NextFunction): void => {
    try {
      const model = this.models.get(modelId(request));
      if (!model?.outputPath || model.status !== "completed" || !existsSync(model.outputPath)) {
        throw new UserFacingError("The generated GLB is not available.", 404);
      }
      response.type("model/gltf-binary").sendFile(model.outputPath);
    } catch (error) {
      next(error);
    }
  };

  delete = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await this.models.remove(modelId(request)))) throw new UserFacingError("Model not found.", 404);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  };
}
