import { Box3, MathUtils, Spherical, Vector3 } from "three";

/** A camera pose: where the camera is and what OrbitControls orbits around. Always animated together. */
export type CameraState = { position: Vector3; target: Vector3 };

const envNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(parsed) ? MathUtils.clamp(parsed, min, max) : fallback;
};

/** Every framing / timing tunable of the viewer. Nothing else in the viewer hard-codes these. */
export const CAMERA_CONFIG = {
  /** Room / overview / fit transitions. NEXT_PUBLIC_CAMERA_TRANSITION_MS (500-1000 recommended). */
  transitionMs: envNumber(process.env.NEXT_PUBLIC_CAMERA_TRANSITION_MS, 700, 0, 3000),
  /** The slightly longer ease-in when the viewer first opens. */
  introMs: 1000,
  /** The intro starts this much farther away than the overview and eases in. */
  introDistanceFactor: 1.35,
  overview: { azimuthDeg: 40, elevationDeg: 32, distanceMultiplier: 1.0 },
  top: { elevationDeg: 89.4, distanceMultiplier: 1.05 },
  room: {
    /** NEXT_PUBLIC_ROOM_CAMERA_DISTANCE_MULTIPLIER: 1 = room's bounding sphere exactly fills the view. */
    distanceMultiplier: envNumber(process.env.NEXT_PUBLIC_ROOM_CAMERA_DISTANCE_MULTIPLIER, 1.7, 1, 4),
    /**
     * Elevation is solved per room: the wall nearest the camera hides a floor strip `wallHeight / tan(elevation)`
     * deep, so small rooms need a steeper look than large ones. We ask for at most this share of the room's
     * narrower side to be hidden, then clamp to a comfortable range.
     */
    maxHiddenFloorShare: 0.4,
    minElevationDeg: 38,
    maxElevationDeg: 78,
    /** Orbit target height as a fraction of the room height (~ seated eye level in a 3 m room). */
    targetHeightRatio: 0.35,
    /** Never closer than this, however small the room (metres). */
    minDistance: 4,
    /** Room meshes are flat floor finishes; when the villa gives no usable height, assume this (metres). */
    fallbackHeight: 2.8,
  },
} as const;

/** Distance at which a sphere of `radius` fits the narrower of the two view angles. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, multiplier: number): number {
  const halfVertical = MathUtils.degToRad(fovDeg) / 2;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
  return (radius / Math.sin(Math.min(halfVertical, halfHorizontal))) * multiplier;
}

/** Azimuth is measured from +Z towards +X (glTF axes), elevation up from the horizon. */
export function stateFromAngles(target: Vector3, distance: number, azimuthDeg: number, elevationDeg: number): CameraState {
  const azimuth = MathUtils.degToRad(azimuthDeg);
  const elevation = MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(elevation) * distance;
  return {
    target: target.clone(),
    position: new Vector3(target.x + Math.sin(azimuth) * horizontal, target.y + Math.sin(elevation) * distance, target.z + Math.cos(azimuth) * horizontal),
  };
}

export function overviewState(villa: Box3, fovDeg: number, aspect: number, top = false): CameraState {
  const center = villa.getCenter(new Vector3());
  const radius = Math.max(villa.getSize(new Vector3()).length() / 2, 0.01);
  const view = top ? CAMERA_CONFIG.top : CAMERA_CONFIG.overview;
  return stateFromAngles(center, fitDistance(radius, fovDeg, Math.max(aspect, 0.1), view.distanceMultiplier), CAMERA_CONFIG.overview.azimuthDeg * (top ? 0 : 1), view.elevationDeg);
}

/** Cached per room when the model loads. `camera` is the pose for the default (overview) viewing direction. */
export type RoomFraming = { box: Box3; center: Vector3; size: Vector3; target: Vector3; distance: number; elevationDeg: number; camera: CameraState };

/**
 * Camera framing for one room, derived only from its bounding box, the wall height and the viewport.
 *
 * Heuristic, NOT collision detection: the camera ends up above the wall tops looking down into the room, so it can
 * never sit inside a wall or under the floor, but walls between camera and room are not ray-tested.
 * `wallScale` is the cutaway factor (1 = full walls): with low walls a flatter, more natural angle is enough.
 */
export function roomFraming(footprint: Box3, villa: Box3, fovDeg: number, aspect: number, wallScale = 1): RoomFraming {
  const config = CAMERA_CONFIG.room;
  const floor = footprint.max.y;
  const villaHeight = villa.max.y - floor;
  const height = villaHeight > 1 ? villaHeight : config.fallbackHeight;
  const box = new Box3(new Vector3(footprint.min.x, floor, footprint.min.z), new Vector3(footprint.max.x, floor + height, footprint.max.z));
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());

  const narrowSide = Math.max(Math.min(size.x, size.z), 0.1);
  const needed = MathUtils.radToDeg(Math.atan((height * wallScale) / (config.maxHiddenFloorShare * narrowSide)));
  const elevationDeg = MathUtils.clamp(needed, config.minElevationDeg, config.maxElevationDeg);

  const target = new Vector3(center.x, floor + height * wallScale * config.targetHeightRatio, center.z);
  const distance = Math.max(fitDistance(size.length() / 2, fovDeg, Math.max(aspect, 0.1), config.distanceMultiplier), config.minDistance);
  return { box, center, size, target, distance, elevationDeg, camera: stateFromAngles(target, distance, CAMERA_CONFIG.overview.azimuthDeg, elevationDeg) };
}

/**
 * The pose actually flown to: the cached framing seen from the user's *current* viewing direction, so hopping
 * between rooms glides and zooms but never spins the building around. Pure trigonometry - no scene access.
 */
export function roomStateFromDirection(framing: RoomFraming, cameraPosition: Vector3, orbitTarget: Vector3): CameraState {
  const dx = cameraPosition.x - orbitTarget.x;
  const dz = cameraPosition.z - orbitTarget.z;
  // Looking (almost) straight down has no meaningful heading: keep the plan's "north up" heading.
  const azimuthDeg = Math.hypot(dx, dz) < 1e-3 * cameraPosition.distanceTo(orbitTarget) ? 0 : MathUtils.radToDeg(Math.atan2(dx, dz));
  return stateFromAngles(framing.target, framing.distance, azimuthDeg, framing.elevationDeg);
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Used when a running transition is redirected: it is already moving, so it must not slow to a stop first. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const fromOffset = new Spherical();
const toOffset = new Spherical();
const blended = new Spherical();
const scratch = new Vector3();
const POLE_MARGIN = 0.01;

/**
 * Writes the pose at eased progress `k` (0..1) into `outPosition` / `outTarget` without allocating.
 * The target moves linearly; the camera's offset from the target is interpolated in spherical
 * coordinates (radius, polar, shortest-arc azimuth). Unlike a straight position lerp this never
 * drags the camera through the target, never flips it over the pole, and keeps the horizon level.
 */
export function interpolateCameraState(from: CameraState, to: CameraState, k: number, outPosition: Vector3, outTarget: Vector3): void {
  outTarget.lerpVectors(from.target, to.target, k);
  fromOffset.setFromVector3(scratch.subVectors(from.position, from.target));
  toOffset.setFromVector3(scratch.subVectors(to.position, to.target));
  let deltaTheta = toOffset.theta - fromOffset.theta;
  if (deltaTheta > Math.PI) deltaTheta -= 2 * Math.PI;
  else if (deltaTheta < -Math.PI) deltaTheta += 2 * Math.PI;
  blended.radius = MathUtils.lerp(fromOffset.radius, toOffset.radius, k);
  blended.phi = MathUtils.clamp(MathUtils.lerp(fromOffset.phi, toOffset.phi, k), POLE_MARGIN, Math.PI - POLE_MARGIN);
  blended.theta = fromOffset.theta + deltaTheta * k;
  outPosition.setFromSpherical(blended).add(outTarget);
}
