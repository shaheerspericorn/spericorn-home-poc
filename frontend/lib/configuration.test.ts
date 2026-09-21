import { describe, expect, it } from "vitest";
import { pointInPolygon, polygonPath, roomAtScenePoint, type CadRoom } from "./cad-analysis";
import { canPlaceInRoom, createPlacement, movePlacement, rotatePlacement, type FurniturePlacement } from "./configuration";
import { FURNITURE_CATALOG, type FurnitureAsset } from "./furniture-catalog";

// Plan room (x 0..4, y 0..3)  ->  scene polygon (x 0..4, z -3..0): plan (x, y) == scene (x, 0, -y).
const living: CadRoom = {
  id: "room-001", name: "Living Room", type: "living-room", labelSource: "cad-text", area: 12,
  polygon: [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]], center: [2, 1.5],
  polygon3d: [[0, 0], [4, 0], [4, -3], [0, -3], [0, 0]], center3d: { x: 2, y: 0, z: -1.5 },
};
const bedroom: CadRoom = { ...living, id: "room-002", name: "Bedroom", type: "bedroom", polygon3d: [[5, 0], [9, 0], [9, -3], [5, -3], [5, 0]], center3d: { x: 7, y: 0, z: -1.5 } };
const [sofa, bed, diningTable] = FURNITURE_CATALOG;

/** createPlacement may refuse; these cases all expect a fit, so failing to get one is a test failure, not a branch. */
function place(asset: FurnitureAsset, room: CadRoom, existing: FurniturePlacement[] = []): FurniturePlacement {
  const placement = createPlacement(asset, room, existing);
  if (!placement) throw new Error(`${asset.name} unexpectedly did not fit in ${room.name}`);
  return placement;
}

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
    const placed = place(sofa, living);
    expect(placed).toMatchObject({ assetId: "sofa-001", roomId: "room-001", position: { x: 2, y: 0, z: -1.5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    expect(place(sofa, living, [placed]).position).not.toEqual(placed.position);
    expect(createPlacement(sofa, undefined, [])).toMatchObject({ roomId: null, position: { x: 0, y: 0, z: 0 } });
  });

  it("refuses to place an item the room cannot hold", () => {
    // A 1.2 x 1.2 m sit-out: smaller than the dining table's 1.6 m length whichever way it is turned.
    const sitOut: CadRoom = { ...living, id: "room-003", name: "Sit Out", type: "balcony", area: 1.44,
      polygon3d: [[0, 0], [1.2, 0], [1.2, -1.2], [0, -1.2], [0, 0]], center3d: { x: 0.6, y: 0, z: -0.6 } };
    expect(canPlaceInRoom(diningTable, sitOut)).toBe(false);
    expect(createPlacement(diningTable, sitOut, [])).toBeUndefined();
    // The same room does take something small enough.
    expect(canPlaceInRoom(diningTable, living)).toBe(true);
    expect(createPlacement(diningTable, living, [])).toBeDefined();
  });

  it("turns a spawning item a quarter to make it fit a narrow room", () => {
    // 3.0 wide x 1.2 deep: the 2.2 m sofa fits lying along x, and would not fit across z.
    const corridor: CadRoom = { ...living, id: "room-004", name: "Corridor", area: 3.6,
      polygon3d: [[0, 0], [3, 0], [3, -1.2], [0, -1.2], [0, 0]], center3d: { x: 1.5, y: 0, z: -0.6 } };
    expect(place(sofa, corridor).rotation.y).toBe(0);
    // 1.2 wide x 3.0 deep: now only the turned orientation fits.
    const shaft: CadRoom = { ...corridor, id: "room-005", polygon3d: [[0, 0], [1.2, 0], [1.2, -3], [0, -3], [0, 0]], center3d: { x: 0.6, y: 0, z: -1.5 } };
    expect(place(sofa, shaft).rotation.y).toBeCloseTo(Math.PI / 2);
  });

  it("falls back to the room centre when the stacking nudge would hit a wall", () => {
    // Four beds deep, the 0.4 m-per-item nudge would push the footprint through a wall; it centres instead.
    const existing = [place(bed, living), place(bed, living), place(bed, living)];
    expect(place(bed, living, existing).position).toEqual({ x: 2, y: 0, z: -1.5 });
  });

  it("moves on the floor plane and keeps the whole footprint inside its room when restricted", () => {
    const placed = place(sofa, living);
    const moved = movePlacement(placed, 2.5, -2, [living, bedroom], true);
    expect(moved.position).toEqual({ x: 2.5, y: 0, z: -2 });
    // Aimed at the bedroom: never leaves its own room, though the legal z part of the motion still applies.
    expect(movePlacement(moved, 7, -1, [living, bedroom], true)).toMatchObject({ roomId: "room-001", position: { x: 2.5, y: 0, z: -1 } });
    expect(movePlacement(moved, 7, -5, [living, bedroom], true)).toBe(moved);  // rejected: neither axis is legal
    expect(movePlacement(moved, 7, -1, [living, bedroom], false)).toMatchObject({ roomId: "room-002", position: { x: 7, y: 0, z: -1 } });
    expect(movePlacement(moved, 20, 20, [living, bedroom], false).roomId).toBeNull();
  });

  it("refuses a move that would embed the footprint in a wall, but still slides along it", () => {
    const placed = place(sofa, living);  // 2.2 x 0.9 sofa at (2, -1.5) in a room spanning x 0..4, z -3..0
    // Centre x = 3 is inside the room, but the sofa's right edge would reach 4.1 - 100 mm into the wall.
    expect(movePlacement(placed, 3, -1.5, [living, bedroom], true)).toBe(placed);
    expect(movePlacement(placed, 3, -1.5, [living, bedroom], false).position).toEqual({ x: 3, y: 0, z: -1.5 });
    // Blocked in x but free in z: the sofa slides along the wall instead of sticking in place.
    expect(movePlacement(placed, 3, -2, [living, bedroom], true).position).toEqual({ x: 2, y: 0, z: -2 });
  });

  it("keeps the bed's larger footprint out of the walls too", () => {
    const placed = place(bed, { ...living, id: "room-001" });  // 1.6 x 2.1 bed at (2, -1.5)
    // Only 0.9 m of clearance to the z = -3 wall, so the 2.1 m depth cannot move much further back.
    expect(movePlacement(placed, 2, -2.5, [living], true)).toBe(placed);
    expect(movePlacement(placed, 2, -1.9, [living], true).position).toEqual({ x: 2, y: 0, z: -1.9 });
  });

  it("rotates about the vertical axis only, normalised to one turn", () => {
    const placed = place(sofa, living);
    expect(rotatePlacement(placed, Math.PI / 2).rotation).toEqual({ x: 0, y: Math.PI / 2, z: 0 });
    expect(rotatePlacement(placed, -Math.PI / 2).rotation.y).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("refuses a rotation that would swing the footprint into a wall when restricted", () => {
    const placed = movePlacement(place(sofa, living), 2, -0.5, [living], true);
    expect(placed.position).toEqual({ x: 2, y: 0, z: -0.5 });  // 450 mm from the z = 0 wall: fine lying flat
    // A quarter turn puts the 2.2 m length across z, reaching z = +0.6 through that wall.
    expect(rotatePlacement(placed, Math.PI / 2, [living], true)).toBe(placed);
    expect(rotatePlacement(placed, Math.PI / 2, [living], false).rotation.y).toBeCloseTo(Math.PI / 2);
  });

});
