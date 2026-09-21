import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SampleModeConversionService } from "../src/infrastructure/sample/sample-mode-conversion-service.js";
import type { ModelRecord } from "../src/types/model.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("SampleModeConversionService", () => {
  it("writes the built-in GLB without calling a remote CAD provider", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-sample-"));
    const outputPath = path.join(directory, "sample-villa.glb");
    const storage = { prepareOutput: vi.fn().mockResolvedValue(outputPath) };
    const service = new SampleModeConversionService(storage as never);
    const model = {
      id: "sample-1", name: "Villa", sourceFileName: "villa.ifc", sourceFormat: "ifc", sourcePath: "/private/villa.ifc",
      conversionProvider: "sample", isSampleModel: true, status: "queued", progress: 15, stage: "conversion_queued",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metrics: { sourceBytes: 123 }, hierarchy: { preserved: false, note: "pending" },
    } satisfies ModelRecord;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await service.convert(model, vi.fn().mockResolvedValue(undefined));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outputPath, outputFormat: "glb", outputBytes: expect.any(Number) });
    const output = await readFile(outputPath);
    expect(output.subarray(0, 4).toString()).toBe("glTF");
    expect(output.readUInt32LE(8)).toBe(output.length);
    const jsonLength = output.readUInt32LE(12);
    expect(JSON.parse(output.subarray(20, 20 + jsonLength).toString().trim())).toMatchObject({
      asset: { version: "2.0" },
      nodes: [{ name: "Sample Villa" }],
    });
    fetchSpy.mockRestore();
  });
});
