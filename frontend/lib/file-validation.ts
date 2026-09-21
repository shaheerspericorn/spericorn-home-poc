export type FileValidationConfig = { supportedFormats: string[]; maxUploadBytes: number };

export function extensionOf(fileName: string): string {
  const segments = fileName.toLowerCase().split(".");
  return segments.length > 1 ? segments.at(-1) || "" : "";
}

export function validateModelFile(file: File, config: FileValidationConfig): string | undefined {
  const extension = extensionOf(file.name);
  if (!config.supportedFormats.includes(extension)) {
    return `Unsupported file type. Choose one of: ${config.supportedFormats.map((item) => `.${item}`).join(", ")}.`;
  }
  if (file.size > config.maxUploadBytes) {
    return `The file is too large. Maximum size is ${formatBytes(config.maxUploadBytes)}.`;
  }
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}
