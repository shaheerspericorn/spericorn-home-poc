import { z } from "zod";

const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });

/** Scene coordinates: glTF metres, Y up, same frame as the generated GLB (plan (x, y) -> (x, 0, -y)). */
export const furniturePlacementSchema = z.object({
  instanceId: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64),
  roomId: z.string().max(64).nullable(),
  position: vector,
  rotation: vector,
  scale: vector,
});

export const villaConfigurationSchema = z.object({
  villaModelId: z.string().min(1).max(64),
  furniture: z.array(furniturePlacementSchema).max(200),
  roomNames: z.record(z.string().max(64), z.string().max(80)).optional(),
});

export type VillaConfiguration = z.infer<typeof villaConfigurationSchema> & { updatedAt?: string };

export const generationOptionsSchema = z.object({
  build: z.object({
    wallHeight: z.number().min(0.5).max(20).optional(),
    wallThickness: z.number().min(0.02).max(2).optional(),
  }).optional(),
  unitsOverride: z.enum(["millimeters", "centimeters", "meters", "inches", "feet"]).optional(),
  layerRoles: z.record(z.string().max(255), z.enum(["wall", "door", "window", "furniture", "roomLabel", "ignore", "other"])).optional(),
  roomNames: z.record(z.string().max(64), z.string().max(80)).optional(),
}).strict();
