import { z } from "zod";

const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });

/** Scene coordinates: glTF metres, Y up, same frame as the generated GLB (plan (x, y) -> (x, 0, -y)). */
export const furniturePlacementSchema = z.object({
  instanceId: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64),
  roomId: z.string().max(64).nullable(),
  /** Denormalised for humans reading the file; roomId stays the real link. */
  roomName: z.string().max(80).optional(),
  position: vector,
  rotation: vector,
  scale: vector,
});

/** The furniture models a layout uses, embedded so the file stays readable if the catalogue later changes. */
export const furnitureAssetRefSchema = z.object({
  assetId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  source: z.enum(["builtin", "upload"]).default("builtin"),
  modelUrl: z.string().min(1).max(512),
  size: z.object({ width: z.number().positive(), depth: z.number().positive(), height: z.number().positive() }),
});

/** What the client sends. The server derives `villa`, `coordinates` and the timestamps from the model record. */
export const villaConfigurationSchema = z.object({
  name: z.string().min(1).max(80),
  villaModelId: z.string().min(1).max(64),
  furniture: z.array(furniturePlacementSchema).max(200),
  assets: z.array(furnitureAssetRefSchema).max(100).default([]),
  roomNames: z.record(z.string().max(64), z.string().max(80)).optional(),
});

export const CONFIGURATION_SCHEMA_VERSION = 1;

export type VillaConfigurationInput = z.infer<typeof villaConfigurationSchema>;

/** The stored document. One per villa: saving replaces it, so it carries no id of its own. */
export type VillaConfiguration = {
  schemaVersion: number;
  name: string;
  savedAt: string;
  updatedAt: string;
  villa: { modelId: string; name: string; sourceFileName: string; sourceFormat: string; conversionProvider: string; modelUrl?: string };
  coordinates: { units: "meters"; up: "Y"; note: string };
  assets: z.infer<typeof furnitureAssetRefSchema>[];
  furniture: z.infer<typeof furniturePlacementSchema>[];
  roomNames?: Record<string, string>;
};

export const generationOptionsSchema = z.object({
  build: z.object({
    wallHeight: z.number().min(0.5).max(20).optional(),
    wallThickness: z.number().min(0.02).max(2).optional(),
  }).optional(),
  unitsOverride: z.enum(["millimeters", "centimeters", "meters", "inches", "feet"]).optional(),
  layerRoles: z.record(z.string().max(255), z.enum(["wall", "door", "window", "furniture", "roomLabel", "ignore", "other"])).optional(),
  roomNames: z.record(z.string().max(64), z.string().max(80)).optional(),
}).strict();
