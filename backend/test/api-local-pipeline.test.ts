import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real end-to-end API test of the local provider: Express -> Python worker -> ezdxf/Shapely/trimesh -> GLB.
 * Uses a DXF fixture so it does not depend on ODA File Converter. Skipped when the worker venv is absent.
 */
const python = path.resolve(process.cwd(), "../cad-worker/.venv/bin/python");
const fixture = path.resolve(process.cwd(), "test/fixtures/simple-plan.dxf");

describe.skipIf(!existsSync(python))("API: local 2D pipeline", () => {
  let base = "";
  let directory = "";
  let close: () => Promise<void>;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-api-"));
    vi.resetModules();
    vi.stubEnv("CAD_CONVERSION_PROVIDER", "local");
    vi.stubEnv("UPLOAD_DIR", path.join(directory, "uploads"));
    vi.stubEnv("OUTPUT_DIR", path.join(directory, "models"));
    vi.stubEnv("CAD_OUTPUT_DIR", "");
    vi.stubEnv("CAD_WORK_DIR", path.join(directory, "work"));
    const { createApp } = await import("../src/app.js");
    const server = (await createApp()).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close?.();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function uploadFile(name: string, content: Buffer) {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    return fetch(`${base}/api/models/upload`, { method: "POST", body: form });
  }

  async function waitForStatus(id: string, wanted: string[]) {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const status = await (await fetch(`${base}/api/models/${id}/status`)).json() as { status: string; error?: string; analysisAvailable: boolean };
      seen.add(status.status);
      if (wanted.includes(status.status)) return { ...status, seen };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${wanted.join("/")}; saw ${[...seen].join(", ")}`);
  }

  it("upload -> job -> analysis -> review -> generate -> GLB -> configuration", async () => {
    const config = await (await fetch(`${base}/api/config`)).json();
    expect(config).toMatchObject({ conversionProvider: "local", isSampleMode: false, supportsPlanReview: true, supportedFormats: ["dwg", "dxf"] });
    expect(JSON.stringify(config)).not.toMatch(/secret|client_id/i);

    const uploaded = await uploadFile("My Villa (final).dxf", await readFile(fixture));
    expect(uploaded.status).toBe(201);
    const { modelId } = await uploaded.json() as { modelId: string };

    expect((await fetch(`${base}/api/models/${modelId}/convert`, { method: "POST" })).status).toBe(202);  // returns before processing ends
    expect((await waitForStatus(modelId, ["awaiting_review", "failed"])).status).toBe("awaiting_review");
    expect((await fetch(`${base}/api/models/${modelId}/model.glb`)).status).toBe(404);  // nothing is served before generation

    const analysis = await (await fetch(`${base}/api/models/${modelId}/analysis`)).json();
    expect(analysis).toMatchObject({ source: { fileName: "My Villa (final).dxf" }, units: { used: "millimeters" }, detection: { candidateDoors: 1, candidateWindows: 1, candidateRooms: 1 } });
    expect(analysis.rooms[0]).toMatchObject({ name: "Living Room", type: "living-room" });
    expect(JSON.stringify(analysis)).not.toContain(directory);

    const rejected = await fetch(`${base}/api/models/${modelId}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ build: { wallHeight: 99 } }) });
    expect(rejected.status).toBe(400);

    const started = await fetch(`${base}/api/models/${modelId}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ build: { wallHeight: 2.6 } }) });
    expect(started.status).toBe(202);
    expect((await waitForStatus(modelId, ["completed", "failed"])).status).toBe("completed");

    const glb = Buffer.from(await (await fetch(`${base}/api/models/${modelId}/model.glb`)).arrayBuffer());
    expect(glb.subarray(0, 4).toString()).toBe("glTF");
    const names = (JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()) as { nodes: Array<{ name?: string }> }).nodes.map((node) => node.name);
    expect(names).toEqual(expect.arrayContaining(["Villa_Floor", "Wall_001", "Room_LivingRoom", "Door_001", "Window_001"]));

    const model = await (await fetch(`${base}/api/models/${modelId}`)).json();
    expect(model).toMatchObject({ status: "completed", conversionProvider: "local", isSampleModel: false, analysis: { status: "generated", rooms: 1 } });
    expect(model.metrics.details).toMatchObject({ dxfParsingMs: expect.any(Number), generation3dMs: expect.any(Number), glbExportMs: expect.any(Number) });
    expect(model.sourcePath).toBeUndefined();

    expect(await (await fetch(`${base}/api/models/${modelId}/configuration`)).json()).toEqual({ configuration: null });
    const placement = { instanceId: "i1", assetId: "sofa-001", roomId: "room-001", roomName: "Living Room", position: { x: 0.5, y: 0, z: -0.2 }, rotation: { x: 0, y: 1.57, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const asset = { assetId: "sofa-001", name: "Sofa", source: "builtin", modelUrl: "/furniture/sofa.glb", size: { width: 2.2, depth: 0.9, height: 0.8 } };
    const body = { name: "Ground floor", villaModelId: modelId, furniture: [placement], assets: [asset] };
    const saved = await fetch(`${base}/api/models/${modelId}/configuration`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/api/models/${modelId}/configuration`)).json()).toMatchObject({
      configuration: { schemaVersion: 1, name: "Ground floor", villa: { modelId }, assets: [asset], furniture: [placement] },
    });
    const invalid = await fetch(`${base}/api/models/${modelId}/configuration`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, furniture: [{ assetId: 5 }] }) });
    expect(invalid.status).toBe(400);
    const unnamed = await fetch(`${base}/api/models/${modelId}/configuration`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, name: "" }) });
    expect(unnamed.status).toBe(400);
  }, 60000);

  it("a corrupt DWG fails with a clear message and no model", async () => {
    const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { modelId } = await (await uploadFile("broken.dwg", Buffer.from("this is not a dwg file at all"))).json() as { modelId: string };
    await fetch(`${base}/api/models/${modelId}/convert`, { method: "POST" });
    const status = await waitForStatus(modelId, ["failed", "awaiting_review", "completed"]);
    expect(status).toMatchObject({ status: "failed", analysisAvailable: false });
    expect(status.error).toContain("not a valid DWG");
    expect((await fetch(`${base}/api/models/${modelId}/model.glb`)).status).toBe(404);
    errorLogger.mockRestore();
  }, 30000);

  it("rejects unsupported uploads and unknown models", async () => {
    expect((await uploadFile("tower.rvt", Buffer.from("x"))).status).toBe(400);
    expect((await fetch(`${base}/api/models/nope/status`)).status).toBe(404);
    expect((await fetch(`${base}/api/models/nope/analysis`)).status).toBe(404);
  });
});
