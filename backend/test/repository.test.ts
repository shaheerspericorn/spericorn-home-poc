import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRepository } from "../src/services/model/model-repository.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("model repository", () => {
  it("persists model creation and status updates", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-poc-"));
    const repository = new ModelRepository(directory);
    await repository.initialise();
    await repository.create({
      id: "model-1", name: "Villa", sourceFileName: "villa.ifc", sourceFormat: "ifc", sourcePath: "/tmp/villa.ifc",
      conversionProvider: "sample", isSampleModel: true,
      status: "uploaded", progress: 10, stage: "file_uploaded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      metrics: { sourceBytes: 42 }, hierarchy: { preserved: false, note: "pending" },
    });
    await repository.update("model-1", { status: "failed", error: "bad CAD" });
    expect(repository.get("model-1")).toMatchObject({ status: "failed", error: "bad CAD" });
  });
});
