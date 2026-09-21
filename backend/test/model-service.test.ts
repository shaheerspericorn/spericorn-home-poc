import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelService } from "../src/services/model/model-service.js";
import { ModelRepository } from "../src/services/model/model-repository.js";
import type { CadConversionService } from "../src/types/conversion.js";

// These tests describe provider-agnostic behaviour with .ifc uploads; pin the environment so the developer's
// local .env (e.g. CAD_CONVERSION_PROVIDER=local, which only accepts dwg/dxf) cannot change the outcome.
vi.hoisted(() => {
  process.env.CAD_CONVERSION_PROVIDER = "sample";
  process.env.SUPPORTED_SOURCE_FORMATS = "dwg,ifc,rvt,step,stp";
});

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function upload(name: string, size = 12) {
  return { originalname: name, size, path: "/tmp/incoming-file" } as Express.Multer.File;
}

async function createService(converter: CadConversionService) {
  directory = await mkdtemp(path.join(os.tmpdir(), "villa-service-"));
  const repository = new ModelRepository(directory);
  await repository.initialise();
  const storage = {
    storeUpload: vi.fn().mockResolvedValue("/safe/source.ifc"),
    deleteModel: vi.fn(),
  };
  return { service: new ModelService(repository, storage as never, converter), storage };
}

describe("model service", () => {
  it("creates a record and makes its status retrievable", async () => {
    const converter = { provider: "sample", isSampleMode: true, convert: vi.fn() } as unknown as CadConversionService;
    const { service, storage } = await createService(converter);
    const model = await service.createFromUpload(upload("villa.ifc", 123));

    expect(storage.storeUpload).toHaveBeenCalledOnce();
    expect(service.get(model.id)).toMatchObject({ id: model.id, status: "uploaded", sourceFormat: "ifc", conversionProvider: "sample", isSampleModel: true, metrics: { sourceBytes: 123 } });
  });

  it("rejects an invalid extension without invoking storage", async () => {
    const converter = { provider: "sample", isSampleMode: true, convert: vi.fn() } as unknown as CadConversionService;
    const { service, storage } = await createService(converter);

    await expect(service.createFromUpload(upload("villa.pdf"))).rejects.toThrow("not supported");
    expect(storage.storeUpload).not.toHaveBeenCalled();
  });

  it("marks a model failed when the conversion service returns an error", async () => {
    const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const converter: CadConversionService = {
      provider: "sample",
      isSampleMode: true,
      convert: async (model) => ({ success: false, modelId: model.id, sourceFormat: model.sourceFormat, outputFormat: "glb", error: "Derivative unavailable" }),
    };
    const { service } = await createService(converter);
    const model = await service.createFromUpload(upload("villa.ifc"));
    await service.startConversion(model.id);

    await vi.waitFor(() => expect(service.get(model.id)).toMatchObject({ status: "failed", error: "Derivative unavailable" }));
    errorLogger.mockRestore();
  });
});
