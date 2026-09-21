"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAMERA_CONFIG, easeInOutCubic, easeOutCubic, interpolateCameraState, type CameraState } from "../lib/camera-framing";

type Transition = { from: CameraState; to: CameraState; startedAt: number | undefined; duration: number; easing: (t: number) => number; onComplete?: () => void };

export type CameraTransition = {
  /** Eases camera position AND orbit target to `state`. A call during a running transition replaces it: latest wins. */
  transitionTo: (state: CameraState, options?: { duration?: number; onComplete?: () => void }) => void;
  /** Sets the pose immediately (initial placement only). */
  jumpTo: (state: CameraState) => void;
  cancel: () => void;
  isAnimating: () => boolean;
};

/**
 * The viewer's only camera animation system. All state lives in refs: nothing here triggers a React render.
 *
 * - One transition at a time. A new request starts from wherever the camera currently is (mid-flight
 *   included), so rapid room switching bends the path instead of queueing animations.
 * - OrbitControls is disabled only while a transition runs and is re-enabled on completion, on
 *   cancellation and on unmount - it cannot be left disabled.
 * - If the user grabs the view (pointer down / wheel) mid-transition, the transition is cancelled and
 *   the user is in control immediately.
 * - Works with `frameloop="demand"`: it invalidates exactly while it is animating.
 */
export function useCameraTransition(controls: RefObject<OrbitControlsImpl | null>): CameraTransition {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const domElement = useThree((state) => state.gl.domElement);
  const active = useRef<Transition | null>(null);
  // Scratch vectors reused every frame.
  const position = useRef(new Vector3());
  const target = useRef(new Vector3());

  const apply = useCallback((nextPosition: Vector3, nextTarget: Vector3) => {
    camera.position.copy(nextPosition);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.copy(nextTarget);
      orbit.update();  // also re-syncs OrbitControls' internal spherical state, so damping does not fight us
    } else {
      camera.lookAt(nextTarget);
    }
  }, [camera, controls]);

  const release = useCallback(() => {
    active.current = null;
    if (controls.current) controls.current.enabled = true;
  }, [controls]);

  const cancel = useCallback(() => { if (active.current) release(); }, [release]);

  const jumpTo = useCallback((state: CameraState) => {
    release();
    apply(state.position, state.target);
    invalidate();
  }, [apply, invalidate, release]);

  const transitionTo = useCallback<CameraTransition["transitionTo"]>((state, options) => {
    const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 0 : options?.duration ?? CAMERA_CONFIG.transitionMs;
    if (duration <= 0) {
      jumpTo(state);
      options?.onComplete?.();
      return;
    }
    const orbit = controls.current;
    // Start from the live pose. If a transition is running this is its current interpolated pose,
    // which is what makes "latest selection wins" seamless. The replaced transition's onComplete never fires.
    active.current = {
      from: { position: camera.position.clone(), target: orbit ? orbit.target.clone() : new Vector3() },
      to: { position: state.position.clone(), target: state.target.clone() },
      startedAt: undefined,  // stamped on the first rendered frame so a slow first frame cannot cause a jump
      duration,
      // Redirected mid-flight: the camera is already moving, so ease out only - no stop-and-restart hitch.
      easing: active.current ? easeOutCubic : easeInOutCubic,
      onComplete: options?.onComplete,
    };
    if (orbit) orbit.enabled = false;
    invalidate();
  }, [camera, controls, invalidate, jumpTo]);

  useFrame(() => {
    const transition = active.current;
    if (!transition) return;
    const now = performance.now();
    transition.startedAt ??= now;
    const progress = Math.min((now - transition.startedAt) / transition.duration, 1);
    if (progress >= 1) {
      apply(transition.to.position, transition.to.target);  // land exactly: no residual drift or overshoot
      release();
      transition.onComplete?.();
    } else {
      interpolateCameraState(transition.from, transition.to, transition.easing(progress), position.current, target.current);
      apply(position.current, target.current);
    }
    invalidate();
  });

  useEffect(() => {
    // Capture phase: runs before OrbitControls' own listeners, so the same gesture that interrupts
    // the transition already orbits / zooms.
    const interrupt = () => cancel();
    domElement.addEventListener("pointerdown", interrupt, { capture: true });
    domElement.addEventListener("wheel", interrupt, { capture: true, passive: true });
    return () => {
      domElement.removeEventListener("pointerdown", interrupt, { capture: true });
      domElement.removeEventListener("wheel", interrupt, { capture: true });
      release();
    };
  }, [cancel, domElement, release]);

  return useMemo(() => ({ transitionTo, jumpTo, cancel, isAnimating: () => active.current !== null }), [transitionTo, jumpTo, cancel]);
}
