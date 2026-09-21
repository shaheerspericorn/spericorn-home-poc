import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { UserFacingError } from "../../utils/errors.js";

export type WorkerProgress = { stage: string; progress: number };

export type WorkerResult = {
  status: "analyzed" | "no_walls" | "generated";
  analysisPath: string;
  units: { used: string; declared: string; source: string };
  detection: { candidateWalls: number; candidateRooms: number; candidateDoors: number; candidateWindows: number };
  model3d?: { glbBytes: number; wallsGenerated: number; floorsGenerated: number } | null;
  timings: Record<string, number>;
  warnings: string[];
};

export class CadWorkerError extends UserFacingError {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message, 422);
    this.name = "CadWorkerError";
  }
}

export type CadWorkerOptions = { pythonPath: string; workerDir: string; timeoutMs: number; debug: boolean };

/**
 * Runs `python -m cadworker <command>` as an isolated child process.
 * Protocol: one JSON object per stdout line - progress events, then exactly one result or error.
 * Arguments are passed as an argv array (no shell), so file paths are never interpreted.
 */
export class PythonCadWorker {
  constructor(private readonly options: CadWorkerOptions) {}

  run(command: "analyze" | "generate", args: Record<string, string>, onProgress: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    const argv = ["-m", "cadworker", command, ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, value])];
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.pythonPath, argv, { cwd: this.options.workerDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let result: WorkerResult | undefined;
      let failure: CadWorkerError | undefined;
      let stderr = "";
      let settled = false;
      const settle = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(new CadWorkerError("WORKER_TIMEOUT", `CAD processing did not finish within ${Math.round(this.options.timeoutMs / 1000)} seconds.`)));
      }, this.options.timeoutMs);

      createInterface({ input: child.stdout }).on("line", (line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (event.event === "progress") onProgress({ stage: String(event.stage), progress: Number(event.progress) });
        else if (event.event === "result") result = event as unknown as WorkerResult;
        else if (event.event === "error") failure = new CadWorkerError(String(event.code), String(event.message), (event.details as Record<string, unknown>) || {});
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });

      child.on("error", (error: NodeJS.ErrnoException) => {
        const message = error.code === "ENOENT"
          ? `The Python CAD worker could not be started: '${this.options.pythonPath}' does not exist. Create the virtual environment (see cad-worker/README.md) or set CAD_PYTHON_PATH.`
          : `The Python CAD worker could not be started: ${error.message}`;
        settle(() => reject(new CadWorkerError("WORKER_UNAVAILABLE", message)));
      });
      child.on("close", (exitCode) => {
        if (this.options.debug && stderr) console.error(`[cad-worker ${command}] stderr:\n${stderr}`);
        settle(() => {
          if (failure) reject(failure);
          else if (exitCode === 0 && result) resolve(result);
          else {
            console.error(`[cad-worker ${command}] exited with ${exitCode}. stderr:\n${stderr}`);
            reject(new CadWorkerError("WORKER_CRASHED", "The CAD worker stopped unexpectedly. Check the server log for details."));
          }
        });
      });
    });
  }
}
