import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: path.resolve(process.cwd(), "../.env") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

const environment = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    UPLOAD_DIR: z.string().default("./data/uploads"),
    OUTPUT_DIR: z.string().default("./data/models"),
    MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().max(2048).default(100),
    SUPPORTED_SOURCE_FORMATS: z.string().default("dwg,ifc,rvt,step,stp"),
    CAD_CONVERSION_PROVIDER: z.enum(["sample", "aps", "local"]).default("sample"),
    // Local 2D pipeline (DWG -> DXF -> 3D). The DEFAULT_* / ODA_* / DEBUG_CAD values are read by the
    // Python worker straight from the inherited environment; Node only needs to know where things live.
    LOCAL_SUPPORTED_FORMATS: z.string().default("dwg,dxf"),
    CAD_WORK_DIR: z.string().default("./data/cad-work"),
    CAD_OUTPUT_DIR: z.string().optional(),
    CAD_WORKER_DIR: z.string().default("../cad-worker"),
    CAD_PYTHON_PATH: z.string().optional(),
    CAD_WORKER_TIMEOUT_MS: z.coerce.number().int().min(5000).default(300000),
    DEFAULT_WALL_HEIGHT_M: z.coerce.number().positive().default(3),
    DEFAULT_WALL_THICKNESS_M: z.coerce.number().positive().default(0.2),
    DEFAULT_FLOOR_THICKNESS_M: z.coerce.number().positive().default(0.15),
    DEBUG_CAD: z.string().default("false"),
    APS_CLIENT_ID: z.string().optional(),
    APS_CLIENT_SECRET: z.string().optional(),
    APS_BUCKET_KEY: z.string().optional(),
    APS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(3000),
    APS_REGION: z.enum(["US", "EMEA"]).default("US"),
  })
  .parse(process.env);

const formatList = (value: string) => value.split(",")
  .map((extension) => extension.trim().toLowerCase().replace(/^\./, ""))
  .filter(Boolean);

const cadWorkerDir = path.resolve(process.cwd(), environment.CAD_WORKER_DIR);

export const appConfig = {
  port: environment.PORT,
  uploadDir: path.resolve(process.cwd(), environment.UPLOAD_DIR),
  outputDir: path.resolve(process.cwd(), environment.CAD_OUTPUT_DIR || environment.OUTPUT_DIR),
  maxUploadBytes: environment.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  supportedFormats: formatList(environment.CAD_CONVERSION_PROVIDER === "local" ? environment.LOCAL_SUPPORTED_FORMATS : environment.SUPPORTED_SOURCE_FORMATS),
  local: {
    workDir: path.resolve(process.cwd(), environment.CAD_WORK_DIR),
    workerDir: cadWorkerDir,
    pythonPath: environment.CAD_PYTHON_PATH
      ? path.resolve(process.cwd(), environment.CAD_PYTHON_PATH)
      : path.join(cadWorkerDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    timeoutMs: environment.CAD_WORKER_TIMEOUT_MS,
    debug: ["1", "true", "yes"].includes(environment.DEBUG_CAD.toLowerCase()),
    defaults: {
      wallHeight: environment.DEFAULT_WALL_HEIGHT_M,
      wallThickness: environment.DEFAULT_WALL_THICKNESS_M,
      floorThickness: environment.DEFAULT_FLOOR_THICKNESS_M,
    },
  },
  cadConversionProvider: environment.CAD_CONVERSION_PROVIDER,
  aps: {
    clientId: environment.APS_CLIENT_ID,
    clientSecret: environment.APS_CLIENT_SECRET,
    bucketKey: environment.APS_BUCKET_KEY,
    pollIntervalMs: environment.APS_POLL_INTERVAL_MS,
    region: environment.APS_REGION,
  },
  apsConfigurationError:
    environment.CAD_CONVERSION_PROVIDER === "aps" && (!environment.APS_CLIENT_ID || !environment.APS_CLIENT_SECRET)
      ? "APS mode is selected but APS_CLIENT_ID and APS_CLIENT_SECRET are missing. Add both server-side values, then restart the backend."
      : undefined,
};
