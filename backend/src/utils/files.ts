import path from "node:path";

export function extensionOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

export function displayNameFromFile(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  return stem.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Villa model";
}

export function safeFileName(fileName: string): string {
  return path
    .basename(fileName)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 160);
}
