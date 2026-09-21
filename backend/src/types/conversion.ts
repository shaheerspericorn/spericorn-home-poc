import type { AnalysisResult, CadConversionProvider, ConversionProgress, ConversionResult, GenerationOptions, ModelRecord } from "./model.js";

export type ProgressCallback = (progress: ConversionProgress) => Promise<void>;

export interface CadConversionService {
  readonly provider: CadConversionProvider;
  readonly isSampleMode: boolean;
  /** Source extensions this provider can handle; undefined means "whatever SUPPORTED_SOURCE_FORMATS allows". */
  readonly supportedFormats?: readonly string[];
  convert(model: ModelRecord, onProgress: ProgressCallback, options?: GenerationOptions): Promise<ConversionResult>;
}

/**
 * Optional capability: a provider that can show what it understood *before* building 3D.
 * The model service pauses such jobs at "awaiting_review"; it never checks provider names.
 */
export interface PlanReviewCapable extends CadConversionService {
  analyze(model: ModelRecord, onProgress: ProgressCallback, options?: GenerationOptions): Promise<AnalysisResult>;
  analysisPath(modelId: string): string;
}

export function supportsPlanReview(service: CadConversionService): service is PlanReviewCapable {
  return typeof (service as Partial<PlanReviewCapable>).analyze === "function";
}
