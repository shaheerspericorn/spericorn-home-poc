import { roomAtScenePoint, pointInPolygon, type CadRoom, type PlanPoint } from "./cad-analysis";
import { findAsset, type FurnitureAsset } from "./furniture-catalog";

type Vector = { x: number; y: number; z: number };

/** All vectors are in the GLB scene frame (metres, Y up; plan (x, y) == scene (x, 0, -y)). */
export type FurniturePlacement = { instanceId: string; assetId: string; roomId: string | null; roomName?: string; position: Vector; rotation: Vector; scale: Vector };

/** The furniture models a layout uses, embedded so the file stays readable if the catalogue later changes. */
export type FurnitureAssetRef = {
  assetId: string;
  name: string;
  source: "builtin" | "upload";
  modelUrl: string;
  size: { width: number; depth: number; height: number };
};

/** What the client sends to PUT /api/models/:id/configuration. */
export type VillaConfigurationInput = {
  name: string;
  villaModelId: string;
  furniture: FurniturePlacement[];
  assets: FurnitureAssetRef[];
  roomNames?: Record<string, string>;
};

/** The stored document. One per villa, so saving replaces it and it carries no id of its own. */
export type VillaConfiguration = {
  schemaVersion: number;
  name: string;
  savedAt: string;
  updatedAt: string;
  villa: { modelId: string; name: string; sourceFileName: string; sourceFormat: string; conversionProvider: string; modelUrl?: string };
  coordinates: { units: "meters"; up: "Y"; note: string };
  assets: FurnitureAssetRef[];
  furniture: FurniturePlacement[];
  roomNames?: Record<string, string>;
};

export const FLOOR_LEVEL = 0;
export const ROTATION_STEP = Math.PI / 12;

/** Orientations tried when spawning, in order: lying as authored, then turned a quarter so it fits a narrow room. */
const SPAWN_ANGLES = [0, Math.PI / 2];

/**
 * Whether the room is big enough to hold this item at all, tested at its centre in either orientation.
 * Deliberately ignores the stacking nudge and other furniture, so the answer is a property of the room
 * and the item rather than of the order things were added.
 */
export function canPlaceInRoom(asset: FurnitureAsset, room: CadRoom | undefined): boolean {
  if (!room) return true;  // no room data: furniture goes to the origin, unconstrained
  return SPAWN_ANGLES.some((angle) => footprintFits(asset, room.center3d.x, room.center3d.z, angle, room.polygon3d));
}

/** Undefined when the item cannot fit the room at any tried spot or orientation - the caller must report that. */
export function createPlacement(asset: FurnitureAsset, room: CadRoom | undefined, existing: FurniturePlacement[]): FurniturePlacement | undefined {
  const base = {
    instanceId: `${asset.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    assetId: asset.id,
    roomId: room?.id ?? null,
    scale: { x: 1, y: 1, z: 1 },
  };
  if (!room) return { ...base, position: { x: 0, y: FLOOR_LEVEL, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  // Nudge repeated items so they do not stack exactly on the room centre, but fall back to the centre
  // rather than refusing when the nudge would push the footprint into a wall.
  const nudge = existing.filter((item) => item.roomId === room.id).length * 0.4;
  const spots = [[room.center3d.x + nudge, room.center3d.z + nudge], [room.center3d.x, room.center3d.z]];
  for (const angle of SPAWN_ANGLES) {
    for (const [x, z] of spots) {
      if (footprintFits(asset, x, z, angle, room.polygon3d)) {
        return { ...base, position: { x, y: FLOOR_LEVEL, z }, rotation: { x: 0, y: angle, z: 0 } };
      }
    }
  }
  return undefined;
}

/** Corners and edge midpoints of the rotated footprint, in scene coordinates. Midpoints matter for L-shaped rooms. */
function footprintPoints(asset: FurnitureAsset, x: number, z: number, angle: number): PlanPoint[] {
  const halfW = asset.width / 2;
  const halfD = asset.depth / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: PlanPoint[] = [[-halfW, -halfD], [0, -halfD], [halfW, -halfD], [halfW, 0], [halfW, halfD], [0, halfD], [-halfW, halfD], [-halfW, 0]];
  return local.map(([lx, lz]) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos]);
}

function footprintFits(asset: FurnitureAsset, x: number, z: number, angle: number, polygon: PlanPoint[]): boolean {
  return footprintPoints(asset, x, z, angle).every(([px, pz]) => pointInPolygon(px, pz, polygon));
}

/** Whether the whole footprint sits inside the room. Unknown assets fall back to a centre-point test. */
function footprintInside(item: FurniturePlacement, x: number, z: number, angle: number, polygon: PlanPoint[]): boolean {
  const asset = findAsset(item.assetId);
  if (!asset) return pointInPolygon(x, z, polygon);
  return footprintFits(asset, x, z, angle, polygon);
}

/**
 * Applies a drag. Furniture never leaves the floor plane. With `keepInRoom`, the item stays locked to its own
 * room and its whole footprint must fit inside it, so it can never end up embedded in a wall - no collision physics.
 */
export function movePlacement(item: FurniturePlacement, x: number, z: number, rooms: CadRoom[], keepInRoom: boolean): FurniturePlacement {
  const home = rooms.find((room) => room.id === item.roomId);
  if (keepInRoom && home) {
    const fits = (nx: number, nz: number) => footprintInside(item, nx, nz, item.rotation.y, home.polygon3d);
    // Blocked diagonally: keep whichever axis still fits, so the item slides along the wall instead of sticking.
    const next = fits(x, z) ? [x, z] : fits(x, item.position.z) ? [x, item.position.z] : fits(item.position.x, z) ? [item.position.x, z] : undefined;
    // An unchanged position returns the same object: FurnitureLayer compares by reference to decide whether a
    // drag actually moved anything, and a fresh object each frame would commit a no-op on every refused drag.
    if (!next || (next[0] === item.position.x && next[1] === item.position.z)) return item;
    return { ...item, roomId: home.id, position: { x: next[0], y: FLOOR_LEVEL, z: next[1] } };
  }
  const roomId = roomAtScenePoint(rooms, x, z)?.id ?? null;
  return { ...item, roomId, position: { x, y: FLOOR_LEVEL, z } };
}

/** With `keepInRoom`, a turn that would swing the footprint into a wall is rejected. */
export function rotatePlacement(item: FurniturePlacement, delta: number, rooms: CadRoom[] = [], keepInRoom = false): FurniturePlacement {
  const turn = Math.PI * 2;
  const angle = (((item.rotation.y + delta) % turn) + turn) % turn;
  const home = rooms.find((room) => room.id === item.roomId);
  if (keepInRoom && home && !footprintInside(item, item.position.x, item.position.z, angle, home.polygon3d)) return item;
  return { ...item, rotation: { ...item.rotation, y: angle } };
}

