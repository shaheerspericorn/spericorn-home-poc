import { writeFile } from "node:fs/promises";
import { FileSystemStorage } from "../../services/storage/file-system-storage.js";
import type { CadConversionService } from "../../types/conversion.js";
import type { ConversionProgress, ConversionResult, ModelRecord } from "../../types/model.js";
import { SAMPLE_VILLA_GLB } from "./sample-villa-glb.js";

/** Development-only converter for validating upload, job polling, and the browser viewer. */
export class SampleModeConversionService implements CadConversionService {
  readonly provider = "sample" as const;
  readonly isSampleMode = true;

  constructor(private readonly storage: FileSystemStorage) {}

  async convert(
    model: ModelRecord,
    onProgress: (progress: ConversionProgress) => Promise<void>,
  ): Promise<ConversionResult> {
    await onProgress({ status: "processing", progress: 45, stage: "sample_model_ready" });
    const outputPath = await this.storage.prepareOutput(model.id);
    await onProgress({ status: "post_processing", progress: 80, stage: "generating_sample_glb" });
    await writeFile(outputPath, SAMPLE_VILLA_GLB);

    return {
      success: true,
      modelId: model.id,
      sourceFormat: model.sourceFormat,
      outputFormat: "glb",
      outputPath,
      outputUrl: `/api/models/${model.id}/model.glb`,
      outputBytes: SAMPLE_VILLA_GLB.length,
      hierarchy: {
        preserved: true,
        note: "Sample Mode: this is the built-in Sample Villa GLB hierarchy, not hierarchy extracted from the uploaded CAD/BIM file.",
      },
    };
  }
}
