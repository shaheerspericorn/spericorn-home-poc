import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRepository } from "../src/services/model/model-repository.js";
import { ModelService } from "../src/services/model/model-service.js";
import type { PlanReviewCapable } from "../src/types/conversion.js";
import type { AnalysisSummary } from "../src/types/model.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const upload = (name: string) => ({ originalname: name, size: 10, path: "/tmp/incoming" }) as Express.Multer.File;
const summary = (status: AnalysisSummary["status"]): AnalysisSummary => ({ status, units: "meters", walls: status === "no_walls" ? 0 : 4, rooms: 1, doors: 1, windows: 1, warnings: [] });

async function createService(converter: Partial<PlanReviewCapable>) {
  directory = await mkdtemp(path.join(os.tmpdir(), "villa-review-"));
  const repository = new ModelRepository(directory);
  await repository.initialise();
  const files = new Map<string, unknown>();
  const storage = {
    storeUpload: vi.fn().mockResolvedValue("/safe/source.dwg"), deleteModel: vi.fn(),
    configurationPath: (id: string) => `config:${id}`,
    readJson: vi.fn(async (key: string) => files.get(key)), writeJson: vi.fn(async (key: string, value: unknown) => void files.set(key, value)),
  };
  const full = { provider: "local", isSampleMode: false, supportedFormats: ["dwg", "dxf"], analysisPath: (id: string) => `analysis:${id}`, ...converter } as PlanReviewCapable;
  return { service: new ModelService(repository, storage as never, full), files };
}

describe("plan review job flow", () => {
  it("pauses at awaiting_review, then generates on request with the reviewed options", async () => {
    const convert = vi.fn(async (model) => ({ success: true, modelId: model.id, sourceFormat: "dwg", outputFormat: "glb" as const, outputPath: "/out/model.glb", outputBytes: 2048, analysis: summary("generated") }));
    const { service } = await createService({ analyze: vi.fn(async () => ({ analysis: summary("analyzed"), metricDetails: { dxfParsingMs: 5 } })), convert });
    const model = await service.createFromUpload(upload("villa.dwg"));

    expect((await service.startConversion(model.id)).status).toBe("queued");
    await vi.waitFor(() => expect(service.get(model.id)).toMatchObject({ status: "awaiting_review", analysis: { walls: 4 } }));
    expect(convert).not.toHaveBeenCalled();

    await service.generate(model.id, { build: { wallHeight: 2.7 } });
    await vi.waitFor(() => expect(service.get(model.id)).toMatchObject({ status: "completed", progress: 100, modelUrl: `/api/models/${model.id}/model.glb`, metrics: { outputBytes: 2048, details: { dxfParsingMs: 5 } } }));
    expect(convert.mock.calls[0][2]).toEqual({ build: { wallHeight: 2.7 } });
  });

  it("fails honestly when no walls are found, but keeps diagnostics available", async () => {
    const { service, files } = await createService({ analyze: vi.fn(async () => ({ analysis: summary("no_walls") })), convert: vi.fn() });
    const model = await service.createFromUpload(upload("site.dwg"));
    files.set(`analysis:${model.id}`, { analysisPath: "/srv/private/analysis.json", source: { fileType: "DWG" }, layers: [{ name: "LAYER-17" }] });
    await service.startConversion(model.id);

    await vi.waitFor(() => expect(service.get(model.id)?.status).toBe("failed"));
    expect(service.get(model.id)?.error).toContain("no wall geometry could be reliably detected");
    expect(service.get(model.id)?.modelUrl).toBeUndefined();
    const analysis = await service.getAnalysis(model.id) as Record<string, unknown>;
    expect(analysis).toMatchObject({ layers: [{ name: "LAYER-17" }], source: { fileName: "site.dwg" } });
    expect(analysis.analysisPath).toBeUndefined();
  });

  it("marks the model failed with the worker's message", async () => {
    const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { UserFacingError } = await import("../src/utils/errors.js");
    const { service } = await createService({ analyze: vi.fn(async () => { throw new UserFacingError("ODA File Converter was not found."); }), convert: vi.fn() });
    const model = await service.createFromUpload(upload("villa.dwg"));
    await service.startConversion(model.id);
    await vi.waitFor(() => expect(service.get(model.id)).toMatchObject({ status: "failed", error: "ODA File Converter was not found." }));
    errorLogger.mockRestore();
  });

  it("rejects formats the local provider cannot read", async () => {
    const { service } = await createService({});
    await expect(service.createFromUpload(upload("tower.rvt"))).rejects.toThrow("not supported");
  });

  it("saves and reloads a furniture configuration", async () => {
    const { service } = await createService({});
    const model = await service.createFromUpload(upload("villa.dwg"));
    expect(await service.getConfiguration(model.id)).toEqual({ villaModelId: model.id, furniture: [] });
    const placement = { instanceId: "i1", assetId: "sofa-001", roomId: "room-001", position: { x: 2.1, y: 0, z: -3.4 }, rotation: { x: 0, y: 1.57, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    await service.saveConfiguration(model.id, { villaModelId: model.id, furniture: [placement] });
    expect(await service.getConfiguration(model.id)).toMatchObject({ villaModelId: model.id, furniture: [placement], updatedAt: expect.any(String) });
    await expect(service.saveConfiguration(model.id, { villaModelId: "other", furniture: [] })).rejects.toThrow("different villa");
  });
});
