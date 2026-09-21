"use client";

import { Component, Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls, useGLTF, useProgress } from "@react-three/drei";
import { Box3, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3, type Object3D } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

export type Dimensions = { width: number; height: number; depth: number };

type Props = {
  url: string;
  resetVersion: number;
  onDimensions: (dimensions: Dimensions) => void;
  onLoad: (loadTimeMs: number) => void;
  onFps: (fps: number) => void;
  /**
   * Keep the GLB's own coordinate frame instead of re-centring it. Required when other objects (furniture)
   * are positioned in GLB coordinates: the local pipeline already centres the villa on the origin with the
   * finished floor at Y = 0, so world coordinates == GLB coordinates == plan (x, 0, -y).
   */
  preserveOrigin?: boolean;
  /** Node extras (`userData`) of the clicked mesh, e.g. { kind: "room", roomId }. Not fired after an orbit drag. */
  onPick?: (userData: Record<string, unknown>) => void;
  highlightRoomId?: string;
  /** Cutaway: squash walls/doors/windows to this fraction of their height and hide lintels, so interiors are visible. 1 = full height. */
  wallScale?: number;
  /** Look straight down on the next camera reset. */
  topView?: boolean;
  /** Rendered inside the scene, in the same frame as the model. */
  children?: React.ReactNode;
};

type Bounds = { width: number; height: number; depth: number; radius: number };

export function ModelViewer({ url, resetVersion, onDimensions, onLoad, onFps, preserveOrigin, onPick, highlightRoomId, wallScale = 1, topView = false, children }: Props) {
  const startedAt = useRef(typeof performance === "undefined" ? 0 : performance.now());
  return (
    <div className="canvas-shell">
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 52, position: [8, 6, 8] }} gl={{ antialias: true }}>
        <color attach="background" args={["#e9eef1"]} />
        <hemisphereLight args={["#ffffff", "#90a1ad", 2.5]} />
        <directionalLight castShadow position={[8, 12, 8]} intensity={2.2} shadow-mapSize={[1024, 1024]} />
        <Suspense fallback={<Loader />}>
          <ModelScene url={url} resetVersion={resetVersion} onDimensions={onDimensions} onLoad={onLoad} onFps={onFps} startedAt={startedAt.current} preserveOrigin={preserveOrigin} onPick={onPick} highlightRoomId={highlightRoomId} wallScale={wallScale} topView={topView}>{children}</ModelScene>
        </Suspense>
      </Canvas>
      <p className="canvas-hint">Drag to orbit · scroll to zoom · right-drag to pan</p>
    </div>
  );
}

const HIGHLIGHT = new Color("#ffb347");
const NO_EMISSIVE = new Color(0, 0, 0);

const CUTAWAY_GROUPS = new Set(["Walls", "Doors", "Windows", "Openings"]);

function ModelScene({ url, resetVersion, onDimensions, onLoad, onFps, startedAt, preserveOrigin, onPick, highlightRoomId, wallScale = 1, topView = false, children }: Props & { startedAt: number }) {
  const gltf = useGLTF(url);
  const { scene, bounds, center } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    // Rooms get their own material instance so one room can be highlighted without tinting the others.
    cloned.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.userData.kind === "room" && object.material instanceof MeshStandardMaterial) object.material = object.material.clone();
    });
    const box = new Box3().setFromObject(cloned);
    if (box.isEmpty()) throw new Error("The GLB does not contain renderable geometry.");
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    return {
      scene: cloned,
      bounds: { width: size.x, height: size.y, depth: size.z, radius: Math.max(size.length() / 2, 0.01) },
      center,
    };
  }, [gltf.scene]);

  useEffect(() => {
    onDimensions({ width: bounds.width, height: bounds.height, depth: bounds.depth });
    onLoad(performance.now() - startedAt);
  }, [bounds, onDimensions, onLoad, startedAt]);

  useEffect(() => {
    scene.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.userData.kind === "room" && object.material instanceof MeshStandardMaterial) {
        const selected = object.userData.roomId === highlightRoomId;
        object.material.emissive = selected ? HIGHLIGHT : NO_EMISSIVE;
        object.material.emissiveIntensity = selected ? 0.55 : 0;
      }
    });
  }, [scene, highlightRoomId]);

  useEffect(() => {
    // Relies on the node naming contract of the generated GLB (Walls / Doors / Windows / Openings groups, *_Lintel meshes).
    scene.traverse((object: Object3D) => {
      if (CUTAWAY_GROUPS.has(object.name)) object.scale.y = wallScale;
      if (object.name.endsWith("_Lintel")) object.visible = wallScale === 1;
    });
  }, [scene, wallScale]);

  const offset: [number, number, number] = preserveOrigin ? [0, 0, 0] : [-center.x, -center.y, -center.z];
  const target: [number, number, number] = preserveOrigin ? [center.x, center.y, center.z] : [0, 0, 0];

  return (
    <>
      <group position={offset}>
        <primitive
          object={scene}
          onClick={onPick ? (event: { delta: number; stopPropagation: () => void; object: Object3D }) => {
            if (event.delta > 3) return;  // the pointer travelled: that was an orbit, not a pick
            event.stopPropagation();
            onPick(event.object.userData as Record<string, unknown>);
          } : undefined}
        />
        {children}
      </group>
      <Grid args={[Math.max(bounds.radius * 4, 10), Math.max(bounds.radius * 4, 10)]} cellSize={Math.max(bounds.radius / 4, 0.5)} cellThickness={0.5} sectionSize={Math.max(bounds.radius, 2)} sectionThickness={1} fadeDistance={Math.max(bounds.radius * 3, 15)} fadeStrength={1} infiniteGrid />
      <CameraControls bounds={bounds} resetVersion={resetVersion} target={target} topView={topView} />
      <FrameRate onFps={onFps} />
    </>
  );
}

function FrameRate({ onFps }: { onFps: (fps: number) => void }) {
  const frames = useRef(0);
  const startedAt = useRef(performance.now());
  useFrame(() => {
    frames.current += 1;
    const elapsed = performance.now() - startedAt.current;
    if (elapsed >= 1000) {
      onFps(Math.round((frames.current * 1000) / elapsed));
      frames.current = 0;
      startedAt.current = performance.now();
    }
  });
  return null;
}

function CameraControls({ bounds, resetVersion, target, topView }: { bounds: Bounds; resetVersion: number; target: [number, number, number]; topView: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size } = useThree();
  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const fov = (perspective.fov * Math.PI) / 180;
    const aspectFactor = Math.max(1, perspective.aspect);
    const longestSide = Math.max(bounds.width / aspectFactor, bounds.height, bounds.depth);
    const distance = Math.max(longestSide / (2 * Math.tan(fov / 2)) * 1.55, bounds.radius * 2.6, 2);
    // Top view keeps a hair of Z offset: OrbitControls is undefined when looking exactly along its up axis.
    if (topView) camera.position.set(target[0], target[1] + distance * 1.15, target[2] + distance * 0.001);
    else camera.position.set(target[0] + distance * 0.9, target[1] + distance * 0.62, target[2] + distance);
    perspective.near = Math.max(distance / 1000, 0.001);
    perspective.far = Math.max(distance * 100, 1000);
    perspective.updateProjectionMatrix();
    controls.current?.target.set(target[0], target[1], target[2]);
    controls.current?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from bounds
  }, [bounds, camera, resetVersion, size, topView]);
  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={Math.max(bounds.radius * 0.12, 0.05)} maxDistance={Math.max(bounds.radius * 25, 100)} />;
}

function Loader() {
  const { progress } = useProgress();
  return <Html center><div className="model-loader">Loading 3D model {Math.round(progress)}%</div></Html>;
}

export class ModelErrorBoundary extends Component<{ children: React.ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) { this.props.onError(error.message || "The GLB could not be loaded."); }

  render() { return this.state.failed ? null : this.props.children; }
}
