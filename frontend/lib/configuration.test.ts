import { describe, expect, it } from "vitest";
import { pointInPolygon, polygonPath, roomAtScenePoint, type CadRoom } from "./cad-analysis";
import { createPlacement, movePlacement, roomSuitability, rotatePlacement } from "./configuration";
import { FURNITURE_CATALOG } from "./furniture-catalog";

// Plan room (x 0..4, y 0..3)  ->  scene polygon (x 0..4, z -3..0): plan (x, y) == scene (x, 0, -y).
const living: CadRoom = {
  id: "room-001", name: "Living Room", type: "living-room", labelSource: "cad-text", area: 12,
  polygon: [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]], center: [2, 1.5],
  polygon3d: [[0, 0], [4, 0], [4, -3], [0, -3], [0, 0]], center3d: { x: 2, y: 0, z: -1.5 },
};
const bedroom: CadRoom = { ...living, id: "room-002", name: "Bedroom", type: "bedroom", polygon3d: [[5, 0], [9, 0], [9, -3], [5, -3], [5, 0]], center3d: { x: 7, y: 0, z: -1.5 } };
const [sofa, bed] = FURNITURE_CATALOG;

describe("coordinate contract", () => {
  it("room centre in the scene is (x, 0, -y) of the plan centre", () => {
    expect(living.center3d).toEqual({ x: living.center[0], y: 0, z: -living.center[1] });
    expect(pointInPolygon(living.center3d.x, living.center3d.z, living.polygon3d)).toBe(true);
    expect(roomAtScenePoint([living, bedroom], 7, -1)?.id).toBe("room-002");
    expect(roomAtScenePoint([living, bedroom], 4.5, -1)).toBeUndefined();
  });

  it("builds an SVG path with holes", () => {
    expect(polygonPath({ type: "polygon", coordinates: [[0, 0], [1, 0], [1, 1]], holes: [[[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]] })).toBe("M0 0L1 0L1 1ZM0.2 0.2L0.4 0.2L0.4 0.4Z");
  });
});

describe("furniture placement", () => {
  it("places new furniture on the floor at the selected room centre with unit scale", () => {
    const placed = createPlacement(sofa, living, []);
    expect(placed).toMatchObject({ assetId: "sofa-001", roomId: "room-001", position: { x: 2, y: 0, z: -1.5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    expect(createPlacement(sofa, living, [placed]).position).not.toEqual(placed.position);
    expect(createPlacement(sofa, undefined, [])).toMatchObject({ roomId: null, position: { x: 0, y: 0, z: 0 } });
  });

  it("moves on the floor plane and stays inside its room when restricted", () => {
    const placed = createPlacement(sofa, living, []);
    const moved = movePlacement(placed, 3, -2, [living, bedroom], true);
    expect(moved.position).toEqual({ x: 3, y: 0, z: -2 });
    expect(movePlacement(moved, 7, -1, [living, bedroom], true)).toBe(moved);  // rejected: outside the room
    expect(movePlacement(moved, 7, -1, [living, bedroom], false)).toMatchObject({ roomId: "room-002", position: { x: 7, y: 0, z: -1 } });
    expect(movePlacement(moved, 20, 20, [living, bedroom], false).roomId).toBeNull();
  });

  it("rotates about the vertical axis only, normalised to one turn", () => {
    const placed = createPlacement(sofa, living, []);
    expect(rotatePlacement(placed, Math.PI / 2).rotation).toEqual({ x: 0, y: Math.PI / 2, z: 0 });
    expect(rotatePlacement(placed, -Math.PI / 2).rotation.y).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("warns (without blocking) when a room type does not suit the asset", () => {
    expect(roomSuitability(bed, living)).toContain("intended for bedroom");
    expect(roomSuitability(sofa, living)).toBeUndefined();
    expect(roomSuitability(bed, { ...living, type: "unknown" })).toBeUndefined();
  });
});
