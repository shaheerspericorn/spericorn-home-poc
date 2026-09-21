import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCadConversionService } from "../src/infrastructure/local/local-cad-conversion-service.js";
import { CadWorkerError, PythonCadWorker, type WorkerResult } from "../src/infrastructure/local/python-cad-worker.js";
import { supportsPlanReview } from "../src/types/conversion.js";
import type { ModelRecord } from "../src/types/model.js";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const model = {
  id: "m-1", name: "Villa", sourceFileName: "../../etc/passwd; rm -rf.dwg", sourceFormat: "dwg", sourcePath: "/uploads/m-1/source.dwg",
  conversionProvider: "local", isSampleModel: false, status: "queued", progress: 15, stage: "conversion_queued",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metrics: { sourceBytes: 1 }, hierarchy: { preserved: false, note: "" },
} satisfies ModelRecord;

const workerResult: WorkerResult = {
  status: "analyzed", analysisPath: "/x/analysis.json", units: { used: "meters", declared: "millimeters", source: "inferred" },
  detection: { candidateWalls: 19, candidateRooms: 20, candidateDoors: 16, candidateWindows: 14 }, timings: { dxfParsingMs: 120 }, warnings: ["units inferred"],
};

describe("LocalCadConversionService", () => {
  it("is selected by CAD_CONVERSION_PROVIDER=local and needs no APS credentials", async () => {
    vi.resetModules();
    vi.stubEnv("CAD_CONVERSION_PROVIDER", "local");
    vi.stubEnv("APS_CLIENT_ID", "");
    vi.stubEnv("APS_CLIENT_SECRET", "");
    const [{ createCadConversionService }, { appConfig }] = await Promise.all([
      import("../src/services/conversion/create-cad-conversion-service.js"), import("../src/config.js"),
    ]);
    const converter = createCadConversionService({} as never);
    expect(converter).toMatchObject({ provider: "local", isSampleMode: false });
    expect(supportsPlanReview(converter)).toBe(true);
    expect(appConfig.apsConfigurationError).toBeUndefined();
    expect(appConfig.supportedFormats).toEqual(["dwg", "dxf"]);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps APS selectable and without a review step", async () => {
    vi.resetModules();
    vi.stubEnv("CAD_CONVERSION_PROVIDER", "aps");
    const { createCadConversionService } = await import("../src/services/conversion/create-cad-conversion-service.js");
    const converter = createCadConversionService({} as never);
    expect(converter.provider).toBe("aps");
    expect(supportsPlanReview(converter)).toBe(false);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("analyses through the worker with a neutral staged filename and relays known stages only", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-local-"));
    const run = vi.fn(async (_command, _args, onProgress) => {
      onProgress({ stage: "parsing_dxf", progress: 35 });
      onProgress({ stage: "something_unknown", progress: 50 });
      return workerResult;
    });
    const storage = { stageSource: vi.fn(async (_model: ModelRecord, dir: string) => path.join(dir, "source.dwg")) };
    const service = new LocalCadConversionService(storage as never, { run }, directory);
    const progress = vi.fn().mockResolvedValue(undefined);

    const result = await service.analyze(model, progress, { unitsOverride: "meters" });

    const [command, args] = run.mock.calls[0];
    expect(command).toBe("analyze");
    expect(args.input.startsWith(path.join(directory, "m-1"))).toBe(true);
    expect(args.input).not.toContain("passwd");
    expect(JSON.parse(args.options)).toEqual({ unitsOverride: "meters" });
    expect(progress.mock.calls.map(([update]) => update.stage)).toEqual(["parsing_dxf"]);
    expect(result.analysis).toMatchObject({ status: "analyzed", walls: 19, rooms: 20, doors: 16, windows: 14, units: "meters" });
  });

  it("reports the GLB the worker actually wrote", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-local-"));
    const outputPath = path.join(directory, "model.glb");
    const run = vi.fn(async () => { await writeFile(outputPath, Buffer.from("glTF-bytes")); return { ...workerResult, status: "generated" as const, model3d: { glbBytes: 10, wallsGenerated: 19, floorsGenerated: 21 } }; });
    const storage = { prepareOutput: vi.fn().mockResolvedValue(outputPath), fileSize: vi.fn().mockResolvedValue(10) };
    const service = new LocalCadConversionService(storage as never, { run }, directory);

    const result = await service.convert(model, vi.fn(), { build: { wallHeight: 2.7 } });

    expect(run.mock.calls[0][0]).toBe("generate");
    expect(result).toMatchObject({ success: true, outputPath, outputBytes: 10, outputFormat: "glb", hierarchy: { preserved: true } });
  });
});

describe("PythonCadWorker", () => {
  const script = (body: string) => ({ pythonPath: process.execPath, workerDir: process.cwd(), timeoutMs: 4000, debug: false, body });

  // `node -m cadworker ...` is not valid, so point the "python" at a tiny node script via NODE_OPTIONS-free trick: a wrapper file.
  async function workerFor(body: string, timeoutMs = 4000) {
    directory = await mkdtemp(path.join(os.tmpdir(), "villa-worker-"));
    const wrapper = path.join(directory, "fake-python.mjs");
    await writeFile(wrapper, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    return new PythonCadWorker({ ...script(body), pythonPath: wrapper, timeoutMs });
  }

  it("parses progress and result events", async () => {
    const worker = await workerFor(`console.log(JSON.stringify({event:"progress",stage:"parsing_dxf",progress:35}));console.log("noise");console.log(JSON.stringify({event:"result",status:"analyzed",analysisPath:"/a",units:{},detection:{},timings:{},warnings:[]}));`);
    const stages: string[] = [];
    const result = await worker.run("analyze", { input: "x" }, (update) => stages.push(update.stage));
    expect(stages).toEqual(["parsing_dxf"]);
    expect(result.status).toBe("analyzed");
  });

  it("surfaces worker error codes as user-facing errors", async () => {
    const worker = await workerFor(`console.log(JSON.stringify({event:"error",code:"CONVERTER_NOT_FOUND",message:"ODA File Converter was not found.",details:{}}));process.exit(2);`);
    await expect(worker.run("analyze", {}, () => undefined)).rejects.toMatchObject({ code: "CONVERTER_NOT_FOUND", message: "ODA File Converter was not found." });
  });

  it("fails clearly when Python is missing, crashes, or hangs", async () => {
    const missing = new PythonCadWorker({ pythonPath: "/nonexistent/python", workerDir: process.cwd(), timeoutMs: 2000, debug: false });
    await expect(missing.run("analyze", {}, () => undefined)).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
    const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect((await workerFor(`process.exit(1);`)).run("analyze", {}, () => undefined)).rejects.toBeInstanceOf(CadWorkerError);
    errorLogger.mockRestore();
    await expect((await workerFor(`setTimeout(()=>{}, 60000);`, 300)).run("analyze", {}, () => undefined)).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
  });
});
