"use client";

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, OrbitControls, useGLTF } from "@react-three/drei";
import { Box3, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3, type Object3D } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAMERA_CONFIG, overviewState, roomFraming, roomStateFromDirection, type CameraState, type RoomFraming } from "../lib/camera-framing";
import { useCameraTransition } from "./useCameraTransition";

export type Dimensions = { width: number; height: number; depth: number };

/** Imperative camera API handed to the page through `controllerRef`. It is not tied to any UI component. */
export type ViewerController = {
  /** Returns false when the GLB has no such room (nothing moves). */
  focusOnRoom: (roomId: string) => boolean;
  /** Back to the overview pose stored when the model was loaded. */
  resetToOverview: () => void;
  /** Re-frames the whole villa for the *current* viewport shape (after a resize / fullscreen). */
  fitVilla: () => void;
  topView: () => void;
};

type Props = {
  url: string;
  onDimensions: (dimensions: Dimensions) => void;
  onLoad: (loadTimeMs: number) => void;
  /** Frames rendered during the last second. Rendering is on demand, so 0 means "idle", not "slow". */
  onFps: (fps: number) => void;
  controllerRef?: MutableRefObject<ViewerController | null>;
  /**
   * Keep the GLB's own coordinate frame instead of re-centring it. Required when other objects (furniture)
   * are positioned in GLB coordinates: the local pipeline already centres the villa on the origin with the
   * finished floor at Y = 0, so world coordinates == GLB coordinates == plan (x, 0, -y).
   */
  preserveOrigin?: boolean;
  /** A room floor was clicked (not fired after an orbit drag). */
  onRoomPick?: (roomId: string) => void;
  /** A click that hit nothing interactive. */
  onBackgroundClick?: () => void;
  highlightRoomId?: string;
  /** Cutaway: squash walls/doors/windows to this fraction of their height and hide lintels, so interiors are visible. 1 = full height. */
  wallScale?: number;
  /** Rendered inside the scene, in the same frame as the model. */
  children?: React.ReactNode;
};

const CAMERA_FOV = 52;
const CLICK_TRAVEL_PX = 3;  // more pointer travel than this between down and up was an orbit, not a click

export function ModelViewer(props: Props) {
  const { onLoad, onBackgroundClick } = props;
  const startedAt = useRef(typeof performance === "undefined" ? 0 : performance.now());
  const [ready, setReady] = useState(false);
  const handleLoad = useCallback((elapsed: number) => { setReady(true); onLoad(elapsed); }, [onLoad]);

  return (
    <div className={ready ? "canvas-shell is-ready" : "canvas-shell"}>
      {/* frameloop="demand": a still villa costs no GPU time; controls, transitions and edits invalidate explicitly. */}
      <Canvas frameloop="demand" dpr={[1, 2]} camera={{ fov: CAMERA_FOV, position: [8, 6, 8] }} gl={{ antialias: true }} onPointerMissed={onBackgroundClick}>
        <color attach="background" args={["#e9eef1"]} />
        <hemisphereLight args={["#ffffff", "#90a1ad", 2.5]} />
        <directionalLight position={[8, 12, 8]} intensity={2.2} />
        <Suspense fallback={null}>
          <ModelScene {...props} onLoad={handleLoad} startedAt={startedAt.current} />
        </Suspense>
      </Canvas>
      {!ready && (
        // The loading manager only reports whole files, and a villa is a single GLB - so there is no honest
        // percentage to show. Indeterminate by design.
        <div className="viewer-loader" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Loading 3D villa…</span>
        </div>
      )}
    </div>
  );
}

const SELECTED = { color: new Color("#ffb347"), intensity: 0.5 };
const HOVERED = { color: new Color("#ffd9a0"), intensity: 0.22 };
const CUTAWAY_GROUPS = new Set(["Walls", "Doors", "Windows", "Openings"]);

type RoomMesh = Mesh & { material: MeshStandardMaterial };

/** Everything that needs a scene traversal is found exactly once per model, here. */
function prepareModel(source: Object3D) {
  const scene = source.clone(true);
  scene.updateMatrixWorld(true);
  const villaBox = new Box3().setFromObject(scene);
  if (villaBox.isEmpty()) throw new Error("The GLB does not contain renderable geometry.");

  const rooms = new Map<string, RoomMesh>();
  const footprints = new Map<string, Box3>();
  const cutawayGroups: Object3D[] = [];
  const lintels: Object3D[] = [];
  scene.traverse((object) => {
    // Rooms are identified by the generator's node extras (Room_* nodes carry kind/roomId) - never "any mesh".
    if (object instanceof Mesh && object.userData.kind === "room" && typeof object.userData.roomId === "string" && object.material instanceof MeshStandardMaterial) {
      // Own material instance: one room can glow without tinting the others. The original is never modified.
      object.material = object.material.clone();
      rooms.set(object.userData.roomId, object as RoomMesh);
      footprints.set(object.userData.roomId, new Box3().setFromObject(object));
    }
    if (CUTAWAY_GROUPS.has(object.name)) cutawayGroups.push(object);
    if (object.name.endsWith("_Lintel")) lintels.push(object);
  });

  // The rooms group is rendered as its own primitive so pointer events raycast ~20 flat floor meshes instead of
  // the whole villa, and walls standing in front of a room do not swallow the click.
  const first = rooms.values().next().value;
  const roomsGroup = first?.parent && [...rooms.values()].every((room) => room.parent === first.parent) ? first.parent : undefined;
  roomsGroup?.removeFromParent();
  return { scene, villaBox, rooms, footprints, roomsGroup, cutawayGroups, lintels };
}

function ModelScene({ url, onDimensions, onLoad, onFps, startedAt, controllerRef, preserveOrigin, onRoomPick, highlightRoomId, wallScale = 1, children }: Props & { startedAt: number }) {
  const gltf = useGLTF(url);
  const model = useMemo(() => prepareModel(gltf.scene), [gltf.scene]);
  const invalidate = useThree((state) => state.invalidate);
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  const controls = useRef<OrbitControlsImpl>(null);
  const transition = useCameraTransition(controls);

  // World frame of the model: re-centred for foreign GLBs, untouched for generated villas (see preserveOrigin).
  const { offset, villaBox, radius } = useMemo(() => {
    const center = model.villaBox.getCenter(new Vector3());
    const shift = preserveOrigin ? new Vector3() : center.clone().negate();
    const box = model.villaBox.clone().translate(shift);
    return { offset: shift, villaBox: box, radius: Math.max(box.getSize(new Vector3()).length() / 2, 0.01) };
  }, [model, preserveOrigin]);

  // Room bounds + camera poses, computed once per model / viewport shape - never on click, never per frame.
  const framings = useMemo(() => {
    const map = new Map<string, RoomFraming>();
    for (const [roomId, footprint] of model.footprints) map.set(roomId, roomFraming(footprint.clone().translate(offset), villaBox, CAMERA_FOV, aspect, wallScale));
    return map;
  }, [model, offset, villaBox, aspect, wallScale]);
  const framingsRef = useRef(framings);
  framingsRef.current = framings;
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;

  // Overview pose: fixed when the model loads (deliberately NOT recomputed on resize - a resize must never move the camera).
  const overview = useRef<CameraState | null>(null);
  useEffect(() => {
    const home = overviewState(villaBox, CAMERA_FOV, aspectRef.current);
    overview.current = home;
    camera.near = Math.max(radius / 2000, 0.02);
    camera.far = Math.max(radius * 200, 1000);
    camera.updateProjectionMatrix();
    // Open slightly pulled back and ease in, instead of popping into place.
    const start = { target: home.target, position: home.position.clone().sub(home.target).multiplyScalar(CAMERA_CONFIG.introDistanceFactor).add(home.target) };
    transition.jumpTo(start);
    transition.transitionTo(home, { duration: CAMERA_CONFIG.introMs });
  }, [camera, radius, transition, villaBox]);

  useEffect(() => {
    if (!controllerRef) return undefined;
    controllerRef.current = {
      focusOnRoom: (roomId) => {
        const framing = framingsRef.current.get(roomId);
        if (framing) transition.transitionTo(roomStateFromDirection(framing, camera.position, controls.current?.target ?? framing.target));
        return Boolean(framing);
      },
      resetToOverview: () => { if (overview.current) transition.transitionTo(overview.current); },
      fitVilla: () => transition.transitionTo(overviewState(villaBox, CAMERA_FOV, aspectRef.current)),
      topView: () => transition.transitionTo(overviewState(villaBox, CAMERA_FOV, aspectRef.current, true)),
    };
    return () => { controllerRef.current = null; };
  }, [camera, controllerRef, transition, villaBox]);

  useEffect(() => {
    // Development aid only: lets browser tests sample the real camera / orbit target per frame.
    if (process.env.NODE_ENV === "production") return undefined;
    const debug = { camera, controls, isAnimating: transition.isAnimating, framings: framingsRef };
    (window as unknown as { __villaViewer?: typeof debug }).__villaViewer = debug;
    return () => { delete (window as unknown as { __villaViewer?: typeof debug }).__villaViewer; };
  }, [camera, transition]);

  useEffect(() => {
    const size = villaBox.getSize(new Vector3());
    onDimensions({ width: size.x, height: size.y, depth: size.z });
    onLoad(performance.now() - startedAt);
  }, [villaBox, onDimensions, onLoad, startedAt]);

  // Highlight: touches only the rooms whose state changed, via the cached map.
  const hoveredRoomId = useRef<string | undefined>(undefined);
  const highlightRoomIdRef = useRef(highlightRoomId);
  const paint = useCallback((roomId: string | undefined) => {
    const room = roomId ? model.rooms.get(roomId) : undefined;
    if (!room) return;
    const style = roomId === highlightRoomIdRef.current ? SELECTED : roomId === hoveredRoomId.current ? HOVERED : undefined;
    room.material.emissive.copy(style?.color ?? BLACK);
    room.material.emissiveIntensity = style?.intensity ?? 0;
    invalidate();
  }, [invalidate, model]);
  useEffect(() => {
    const previous = highlightRoomIdRef.current;
    highlightRoomIdRef.current = highlightRoomId;
    paint(previous);
    paint(highlightRoomId);
  }, [highlightRoomId, paint]);

  useEffect(() => {
    // Relies on the node naming contract of the generated GLB (Walls / Doors / Windows / Openings groups, *_Lintel meshes).
    for (const group of model.cutawayGroups) group.scale.y = wallScale;
    for (const lintel of model.lintels) lintel.visible = wallScale === 1;
    invalidate();
  }, [invalidate, model, wallScale]);

  const domElement = useThree((state) => state.gl.domElement);
  const hover = useCallback((roomId: string | undefined) => {
    if (hoveredRoomId.current === roomId) return;
    const previous = hoveredRoomId.current;
    hoveredRoomId.current = roomId;
    paint(previous);
    paint(roomId);
    domElement.style.cursor = roomId ? "pointer" : "";
  }, [domElement, paint]);
  useEffect(() => () => { domElement.style.cursor = ""; }, [domElement]);

  const roomIdOf = (event: ThreeEvent<PointerEvent | MouseEvent>) => event.object.userData.roomId as string | undefined;

  return (
    <>
      <group position={offset}>
        <primitive object={model.scene} />
        {model.roomsGroup && (
          <primitive
            object={model.roomsGroup}
            onPointerOver={onRoomPick ? (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); hover(roomIdOf(event)); } : undefined}
            onPointerOut={onRoomPick ? () => hover(undefined) : undefined}
            onClick={onRoomPick ? (event: ThreeEvent<MouseEvent>) => {
              if (event.delta > CLICK_TRAVEL_PX) return;
              event.stopPropagation();
              const roomId = roomIdOf(event);
              if (roomId) onRoomPick(roomId);
            } : undefined}
          />
        )}
        {children}
      </group>
      <Grid args={[Math.max(radius * 4, 10), Math.max(radius * 4, 10)]} cellSize={Math.max(radius / 4, 0.5)} cellThickness={0.5} sectionSize={Math.max(radius, 2)} sectionThickness={1} fadeDistance={Math.max(radius * 3, 15)} fadeStrength={1} infiniteGrid />
      {/* maxPolarAngle keeps the camera above the floor plane; pan/zoom/rotate and all touch gestures stay at their defaults. */}
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2 - 0.02} minDistance={Math.max(radius * 0.04, 0.5)} maxDistance={Math.max(radius * 25, 100)} />
      <FrameRate onFps={onFps} />
    </>
  );
}

const BLACK = new Color(0, 0, 0);

/** Counts rendered frames; reports once a second from a timer so an idle (non-rendering) viewer reports 0. */
function FrameRate({ onFps }: { onFps: (fps: number) => void }) {
  const frames = useRef(0);
  useFrame(() => { frames.current += 1; });
  useEffect(() => {
    const timer = setInterval(() => { onFps(frames.current); frames.current = 0; }, 1000);
    return () => clearInterval(timer);
  }, [onFps]);
  return null;
}

/** Drops the cached (possibly failed) load so "Try again" really refetches. */
export function clearModelCache(url: string): void {
  useGLTF.clear(url);
}

export class ModelErrorBoundary extends Component<{ children: React.ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) { this.props.onError(error.message || "The GLB could not be loaded."); }

  render() { return this.state.failed ? null : this.props.children; }
}
