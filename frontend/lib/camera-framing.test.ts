import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CAMERA_CONFIG, easeInOutCubic, easeOutCubic, fitDistance, interpolateCameraState, overviewState, roomFraming, roomStateFromDirection, type CameraState } from "./camera-framing";

const FOV = 52;
const villa = new Box3(new Vector3(-14, -0.15, -7), new Vector3(14, 3, 7));
const floor = (x0: number, z0: number, x1: number, z1: number) => new Box3(new Vector3(x0, -0.005, z0), new Vector3(x1, 0, z1));

describe("framing", () => {
  it("fits by the narrower view angle, so portrait viewports back off further", () => {
    expect(fitDistance(5, FOV, 0.6, 1)).toBeGreaterThan(fitDistance(5, FOV, 1.8, 1));
    expect(fitDistance(5, FOV, 1.8, 1)).toBeCloseTo(5 / Math.sin((FOV * Math.PI) / 360));
  });

  it("derives the overview from the villa box only", () => {
    const state = overviewState(villa, FOV, 1.6);
    expect(state.target.toArray()).toEqual(villa.getCenter(new Vector3()).toArray());
    expect(state.position.y).toBeGreaterThan(villa.max.y);
    const top = overviewState(villa, FOV, 1.6, true);
    expect(top.position.x).toBeCloseTo(state.target.x);
    expect(top.position.y - top.target.y).toBeGreaterThan(30);
  });

  it("frames rooms of different sizes and places from their own bounds", () => {
    const small = roomFraming(floor(-10, 2, -8.5, 3.5), villa, FOV, 1.6);      // 1.5 m bathroom, top-left
    const large = roomFraming(floor(2, -6, 8, 6), villa, FOV, 1.6);             // 6 x 12 m living space, right
    const distance = (f: typeof small) => f.camera.position.distanceTo(f.camera.target);

    expect(small.size.y).toBeCloseTo(3);                                        // flat floor mesh -> room volume up to wall height
    expect(distance(large)).toBeGreaterThan(distance(small));
    expect(distance(small)).toBeGreaterThanOrEqual(CAMERA_CONFIG.room.minDistance);
    for (const framing of [small, large]) {
      expect(framing.camera.target.x).toBeCloseTo(framing.center.x);
      expect(framing.camera.target.y).toBeCloseTo(3 * CAMERA_CONFIG.room.targetHeightRatio);
      expect(framing.camera.position.y).toBeGreaterThan(villa.max.y);            // above the walls: never inside one, never under the floor
      expect(distance(framing)).toBeLessThan(villa.getSize(new Vector3()).length());  // and not "extremely far away"
    }
  });

  it("looks steeper into small rooms than large ones, and flatter when walls are cut away", () => {
    const small = roomFraming(floor(-10, 2, -8.5, 3.5), villa, FOV, 1.6);
    const large = roomFraming(floor(2, -6, 8, 6), villa, FOV, 1.6);
    expect(small.elevationDeg).toBe(CAMERA_CONFIG.room.maxElevationDeg);
    expect(large.elevationDeg).toBeLessThan(small.elevationDeg);
    expect(large.elevationDeg).toBeGreaterThanOrEqual(CAMERA_CONFIG.room.minElevationDeg);
    // The near wall hides at most the configured share of the narrow side.
    expect(3 / Math.tan((large.elevationDeg * Math.PI) / 180)).toBeLessThanOrEqual(CAMERA_CONFIG.room.maxHiddenFloorShare * 6 + 1e-9);
    expect(roomFraming(floor(2, -6, 8, 6), villa, FOV, 1.6, 0.3).elevationDeg).toBeLessThan(large.elevationDeg);
  });

  it("keeps the user's viewing direction when flying to a room", () => {
    const framing = roomFraming(floor(2, -6, 8, 6), villa, FOV, 1.6);
    const fromWest = roomStateFromDirection(framing, new Vector3(-30, 15, 0), new Vector3(0, 1, 0));
    expect(fromWest.position.x).toBeLessThan(framing.target.x);
    expect(fromWest.position.z).toBeCloseTo(framing.target.z);
    expect(fromWest.position.distanceTo(fromWest.target)).toBeCloseTo(framing.distance);
    const fromTop = roomStateFromDirection(framing, new Vector3(0, 40, 0.0001), new Vector3(0, 1, 0));
    expect(fromTop.position.x).toBeCloseTo(framing.target.x);  // heading falls back to north-up
  });
});

describe("transition path", () => {
  const from: CameraState = { position: new Vector3(20, 12, 20), target: new Vector3(0, 1, 0) };
  const to: CameraState = { position: new Vector3(-16, 7, -2), target: new Vector3(-10, 1, 3) };

  it("starts and ends exactly on the requested poses, moving position and target together", () => {
    const position = new Vector3();
    const target = new Vector3();
    interpolateCameraState(from, to, 0, position, target);
    expect(position.distanceTo(from.position)).toBeLessThan(1e-9);
    interpolateCameraState(from, to, 1, position, target);
    expect(position.distanceTo(to.position)).toBeLessThan(1e-9);
    expect(target.distanceTo(to.target)).toBeLessThan(1e-9);
    interpolateCameraState(from, to, 0.5, position, target);
    expect(target.x).toBeCloseTo(-5);
  });

  it("never dips below the target, flips over the pole, or passes through the target (opposite-side move)", () => {
    const position = new Vector3();
    const target = new Vector3();
    let previous = Infinity;
    for (let step = 0; step <= 100; step += 1) {
      interpolateCameraState(from, to, easeInOutCubic(step / 100), position, target);
      expect(position.y).toBeGreaterThan(target.y);
      expect(position.distanceTo(target)).toBeGreaterThan(6);
      const radius = position.distanceTo(target);
      expect(radius).toBeLessThanOrEqual(previous + 1e-9);  // monotonic zoom-in: no overshoot
      previous = radius;
    }
  });

  it("takes the short way round the azimuth seam", () => {
    const a: CameraState = { position: new Vector3(Math.sin(3.0) * 10, 5, Math.cos(3.0) * 10), target: new Vector3() };
    const b: CameraState = { position: new Vector3(Math.sin(-3.0) * 10, 5, Math.cos(-3.0) * 10), target: new Vector3() };
    const position = new Vector3();
    interpolateCameraState(a, b, 0.5, position, new Vector3());
    expect(position.z).toBeLessThan(-9);  // passes behind (theta = pi), not all the way round the front
  });

  it("eases in and out", () => {
    expect([easeInOutCubic(0), easeInOutCubic(0.5), easeInOutCubic(1)]).toEqual([0, 0.5, 1]);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
    expect(easeOutCubic(0.1)).toBeGreaterThan(0.1);  // already moving: no slow start
  });
});
