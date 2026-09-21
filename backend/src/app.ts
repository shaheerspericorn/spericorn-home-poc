import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { appConfig } from "./config.js";
import { ModelController } from "./controllers/model-controller.js";
import { modelRoutes } from "./routes/model-routes.js";
import { createCadConversionService } from "./services/conversion/create-cad-conversion-service.js";
import { ModelRepository } from "./services/model/model-repository.js";
import { ModelService } from "./services/model/model-service.js";
import { FileSystemStorage } from "./services/storage/file-system-storage.js";
import { UserFacingError } from "./utils/errors.js";

export async function createApp() {
  const storage = new FileSystemStorage();
  await storage.initialise();
  const repository = new ModelRepository(appConfig.uploadDir);
  await repository.initialise();
  const converter = createCadConversionService(storage);
  const models = new ModelService(repository, storage, converter);
  const controller = new ModelController(models);

  const app = express();
  app.use(cors({ origin: ["http://localhost:3000"], methods: ["GET", "POST", "PUT", "DELETE"] }));
  app.use(express.json());
  app.get("/health", (_request, response) => response.json({ ok: true }));
  app.use("/api", modelRoutes(controller));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({ error: `The file is too large. Maximum size is ${Math.round(appConfig.maxUploadBytes / 1024 / 1024)} MB.` });
      return;
    }
    if (error instanceof UserFacingError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error("Unhandled request error:", error);
    response.status(500).json({ error: "The request could not be completed." });
  };
  app.use(errorHandler);
  return app;
}
