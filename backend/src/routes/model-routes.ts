import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { appConfig } from "../config.js";
import { ModelController } from "../controllers/model-controller.js";

export function modelRoutes(controller: ModelController): Router {
  const upload = multer({
    dest: path.join(appConfig.uploadDir, ".incoming"),
    limits: { fileSize: appConfig.maxUploadBytes, files: 1 },
  });
  const router = Router();
  router.get("/config", controller.config);
  router.post("/models/upload", upload.single("file"), controller.upload);
  router.post("/models/:id/convert", controller.convert);
  router.post("/models/:id/analyze", controller.analyze);
  router.get("/models/:id/analysis", controller.analysis);
  router.post("/models/:id/generate", controller.generate);
  router.get("/models/:id/configuration", controller.getConfiguration);
  router.put("/models/:id/configuration", controller.saveConfiguration);
  router.get("/models/:id/status", controller.status);
  router.get("/models/:id", controller.get);
  router.delete("/models/:id", controller.delete);
  router.get("/models/:id/model.glb", controller.downloadGlb);
  return router;
}
