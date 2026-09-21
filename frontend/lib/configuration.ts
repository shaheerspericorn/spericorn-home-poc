import { roomAtScenePoint, pointInPolygon, type CadRoom } from "./cad-analysis";
import type { FurnitureAsset } from "./furniture-catalog";

type Vector = { x: number; y: number; z: number };

/** All vectors are in the GLB scene frame (metres, Y up; plan (x, y) == scene (x, 0, -y)). */
export type FurniturePlacement = { instanceId: string; assetId: string; roomId: string | null; position: Vector; rotation: Vector; scale: Vector };
export type VillaConfiguration = { villaModelId: string; furniture: FurniturePlacement[]; roomNames?: Record<string, string>; updatedAt?: string };

export const FLOOR_LEVEL = 0;
export const ROTATION_STEP = Math.PI / 12;

export function createPlacement(asset: FurnitureAsset, room: CadRoom | undefined, existing: FurniturePlacement[]): FurniturePlacement {
  const sameRoom = existing.filter((item) => item.roomId === (room?.id ?? null)).length;
  // Nudge repeated items so they do not stack exactly on the room centre.
  const offset = sameRoom * 0.4;
  return {
    instanceId: `${asset.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    assetId: asset.id,
    roomId: room?.id ?? null,
    position: { x: (room?.center3d.x ?? 0) + offset, y: FLOOR_LEVEL, z: (room?.center3d.z ?? 0) + offset },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

/**
 * Applies a drag. Furniture never leaves the floor plane. With `keepInRoom`, a move whose centre would
 * leave the item's room is rejected (the item keeps its last valid position) - no collision physics.
 */
export function movePlacement(item: FurniturePlacement, x: number, z: number, rooms: CadRoom[], keepInRoom: boolean): FurniturePlacement {
  const home = rooms.find((room) => room.id === item.roomId);
  if (keepInRoom && home && !pointInPolygon(x, z, home.polygon3d)) return item;
  const roomId = keepInRoom && home ? home.id : roomAtScenePoint(rooms, x, z)?.id ?? null;
  return { ...item, roomId, position: { x, y: FLOOR_LEVEL, z } };
}

export function rotatePlacement(item: FurniturePlacement, delta: number): FurniturePlacement {
  const turn = Math.PI * 2;
  return { ...item, rotation: { ...item.rotation, y: (((item.rotation.y + delta) % turn) + turn) % turn } };
}

export function roomSuitability(asset: FurnitureAsset, room: CadRoom | undefined): string | undefined {
  if (!room || room.type === "unknown" || asset.allowedRooms.includes(room.type)) return undefined;
  return `${asset.name} is intended for ${asset.allowedRooms.join(" / ")}; "${room.name}" is a ${room.type}.`;
}
