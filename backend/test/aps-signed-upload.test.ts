import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApsCadConversionService } from "../src/infrastructure/aps/autodesk-aps-conversion-service.js";
import type { ModelRecord } from "../src/types/model.js";

let directory = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("ApsCadConversionService signed S3 uploads", () => {
  it("sends uploadKey in the completion JSON body required by APS", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-aps-upload-"));
    const sourcePath = path.join(directory, "villa.ifc");
    await writeFile(sourcePath, "IFC sample");
    const service = new ApsCadConversionService({} as never);
    const internals = service as unknown as {
      ensureBucket(bucketKey: string, token: string): Promise<void>;
      apsJson<T>(url: string, token: string, init?: RequestInit): Promise<T>;
      uploadToOss(model: ModelRecord, token: string): Promise<string>;
    };
    vi.spyOn(internals, "ensureBucket").mockResolvedValue(undefined);
    const apsJson = vi.spyOn(internals, "apsJson")
      .mockResolvedValueOnce({ uploadKey: "upload-key", urls: ["https://s3.example.test/upload"] })
      .mockResolvedValueOnce({ objectId: "urn:adsk.objects:os.object:bucket/villa.ifc" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const model = {
      id: "sample-model", name: "Villa", sourceFileName: "villa.ifc", sourceFormat: "ifc", sourcePath,
      conversionProvider: "aps", isSampleModel: false, status: "queued", progress: 15, stage: "conversion_queued",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metrics: { sourceBytes: 10 }, hierarchy: { preserved: false, note: "pending" },
    } satisfies ModelRecord;

    await internals.uploadToOss(model, "server-token");

    const completion = apsJson.mock.calls[1];
    expect(completion[0]).toMatch(/\/signeds3upload$/);
    expect(completion[0]).not.toContain("uploadKey=");
    expect(completion[2]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "x-ads-meta-Content-Type": "application/octet-stream",
      }),
      body: JSON.stringify({ uploadKey: "upload-key" }),
    });
  });

  it("uses the 3D model GUID returned by metadata for OBJ extraction", async () => {
    const service = new ApsCadConversionService({} as never);
    const internals = service as unknown as {
      apsJson<T>(url: string, token: string, init?: RequestInit): Promise<T>;
      waitForThreeDimensionalView(urn: string, token: string): Promise<string>;
    };
    const apsJson = vi.spyOn(internals, "apsJson")
      .mockResolvedValueOnce({
        status: "success",
        derivatives: [{
          outputType: "svf2",
          status: "success",
          children: [{
            guid: "manifest-geometry-guid",
            role: "3d",
            status: "success",
            type: "geometry",
          }],
        }],
      })
      .mockResolvedValueOnce({
        data: {
          metadata: [{ guid: "metadata-model-guid", name: "Main model", role: "3d" }],
        },
      });

    await expect(internals.waitForThreeDimensionalView("encoded-urn", "server-token"))
      .resolves.toBe("metadata-model-guid");

    expect(apsJson.mock.calls[0][0]).toMatch(/\/manifest$/);
    expect(apsJson.mock.calls[1][0]).toMatch(/\/metadata$/);
  });
});
