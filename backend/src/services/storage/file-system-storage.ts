import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import { appConfig } from "../../config.js";
import type { ModelRecord } from "../../types/model.js";
import { safeFileName } from "../../utils/files.js";

export class FileSystemStorage {
  async initialise(): Promise<void> {
    await Promise.all([mkdir(appConfig.uploadDir, { recursive: true }), mkdir(appConfig.outputDir, { recursive: true })]);
  }

  async storeUpload(modelId: string, file: Express.Multer.File): Promise<string> {
    const folder = path.join(appConfig.uploadDir, modelId);
    await mkdir(folder, { recursive: true });
    const destination = path.join(folder, `source-${safeFileName(file.originalname)}`);
    await rename(file.path, destination);
    return destination;
  }

  outputPath(modelId: string): string {
    return path.join(appConfig.outputDir, modelId, "model.glb");
  }

  async prepareOutput(modelId: string): Promise<string> {
    const outputPath = this.outputPath(modelId);
    await mkdir(path.dirname(outputPath), { recursive: true });
    return outputPath;
  }

  /** Copies the upload to `source.<validated extension>` so downstream tools never see the original filename. */
  async stageSource(model: ModelRecord, directory: string): Promise<string> {
    const staged = path.join(directory, `source.${model.sourceFormat.replace(/[^a-z0-9]/g, "")}`);
    await copyFile(model.sourcePath, staged);
    return staged;
  }

  configurationPath(modelId: string): string {
    return path.join(appConfig.outputDir, modelId, "configuration.json");
  }

  async readJson<T>(filePath: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, filePath);
  }

  async fileSize(filePath: string): Promise<number> {
    return (await stat(filePath)).size;
  }

  async deleteModel(modelId: string): Promise<void> {
    await Promise.all([
      rm(path.join(appConfig.uploadDir, modelId), { recursive: true, force: true }),
      rm(path.join(appConfig.outputDir, modelId), { recursive: true, force: true }),
      rm(path.join(appConfig.local.workDir, modelId), { recursive: true, force: true }),
    ]);
  }
}
