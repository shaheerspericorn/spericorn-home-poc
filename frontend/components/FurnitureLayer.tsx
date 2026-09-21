"use client";

import { memo, Suspense, useMemo, useRef } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { Plane, Vector3, type Group } from "three";
import type { FurniturePlacement } from "../lib/configuration";
import { FLOOR_LEVEL } from "../lib/configuration";
import { findAsset, type FurnitureAsset } from "../lib/furniture-catalog";

type Props = {
  placements: FurniturePlacement[];
  selectedId?: string;
  onSelect: (instanceId: string) => void;
  /** Pure: where may this item go if the pointer asks for (x, z)? Returns the item unchanged when the move is refused. */
  constrain: (placement: FurniturePlacement, x: number, z: number) => FurniturePlacement;
  /** Called once, when the drag ends, with the final accepted position (GLB scene coordinates). */
  onMoveEnd: (instanceId: string, x: number, z: number) => void;
};

const FLOOR_PLANE = new Plane(new Vector3(0, 1, 0), -FLOOR_LEVEL);

/** Must be rendered inside the model's frame (ModelViewer children) so positions are GLB coordinates. */
export function FurnitureLayer({ placements, selectedId, onSelect, constrain, onMoveEnd }: Props) {
  return (
    <>
      {placements.map((placement) => {
        const asset = findAsset(placement.assetId);
        if (!asset) return null;
        // Own Suspense boundary: loading a furniture GLB must not re-suspend (and remount) the villa itself.
        return (
          <Suspense key={placement.instanceId} fallback={null}>
            <FurnitureItem placement={placement} asset={asset} selected={placement.instanceId === selectedId} onSelect={onSelect} constrain={constrain} onMoveEnd={onMoveEnd} />
          </Suspense>
        );
      })}
    </>
  );
}

type ItemProps = { placement: FurniturePlacement; asset: FurnitureAsset; selected: boolean } & Pick<Props, "onSelect" | "constrain" | "onMoveEnd">;

const FurnitureItem = memo(function FurnitureItem({ placement, asset, selected, onSelect, constrain, onMoveEnd }: ItemProps) {
  const gltf = useGLTF(asset.modelUrl);
  const object = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const controls = useThree((state) => state.controls) as { enabled: boolean } | null;
  const invalidate = useThree((state) => state.invalidate);
  const group = useRef<Group>(null);
  // While dragging, the item is moved by mutating the three.js object directly; React state is committed once on
  // release. A drag therefore costs zero React renders per pointer event.
  const drag = useRef<{ dx: number; dz: number; current: FurniturePlacement } | undefined>(undefined);
  const hit = useRef(new Vector3());

  function floorPoint(event: ThreeEvent<PointerEvent>) {
    // Intersect the pointer ray with the floor plane directly: independent of what geometry is under the cursor.
    return event.ray.intersectPlane(FLOOR_PLANE, hit.current);
  }

  function onPointerDown(event: ThreeEvent<PointerEvent>) {
    event.stopPropagation();
    onSelect(placement.instanceId);
    const point = floorPoint(event);
    if (!point) return;
    drag.current = { dx: placement.position.x - point.x, dz: placement.position.z - point.z, current: placement };
    if (controls) controls.enabled = false;
    (event.target as Element).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ThreeEvent<PointerEvent>) {
    const state = drag.current;
    if (!state || !group.current) return;
    event.stopPropagation();
    const point = floorPoint(event);
    if (!point) return;
    state.current = constrain(state.current, point.x + state.dx, point.z + state.dz);
    group.current.position.set(state.current.position.x, FLOOR_LEVEL, state.current.position.z);
    invalidate();
  }

  function onPointerUp(event: ThreeEvent<PointerEvent>) {
    const state = drag.current;
    if (!state) return;
    drag.current = undefined;
    if (controls) controls.enabled = true;
    (event.target as Element).releasePointerCapture(event.pointerId);
    if (state.current !== placement) onMoveEnd(placement.instanceId, state.current.position.x, state.current.position.z);
  }

  return (
    <group
      ref={group}
      name={`Furniture_${placement.instanceId}`}
      // Never below the floor, whatever a stored configuration says.
      position={[placement.position.x, Math.max(FLOOR_LEVEL, placement.position.y), placement.position.z]}
      rotation={[placement.rotation.x, placement.rotation.y, placement.rotation.z]}
      scale={[placement.scale.x, placement.scale.y, placement.scale.z]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = "grab"; }}
      onPointerOut={() => { document.body.style.cursor = ""; }}
      onClick={(event) => event.stopPropagation()}
    >
      <primitive object={object} />
      {selected && (
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[asset.width + 0.16, asset.depth + 0.16]} />
          <meshBasicMaterial color="#ff8a00" transparent opacity={0.35} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
});
