import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CadRoom } from "../lib/cad-analysis";
import { createPlacement } from "../lib/configuration";
import { FURNITURE_CATALOG } from "../lib/furniture-catalog";
import { FurniturePanel } from "./FurniturePanel";

const room: CadRoom = { id: "room-001", name: "Living Room", type: "living-room", labelSource: "cad-text", area: 12, polygon: [], center: [2, 1.5], polygon3d: [[0, 0], [4, 0], [4, -3], [0, -3]], center3d: { x: 2, y: 0, z: -1.5 } };

/** A 1.2 x 1.2 m balcony: too small for any catalogue item. */
const sitOut: CadRoom = { ...room, id: "room-003", name: "Sit Out", type: "balcony", area: 1.44, polygon3d: [[0, 0], [1.2, 0], [1.2, -1.2], [0, -1.2]], center3d: { x: 0.6, y: 0, z: -0.6 } };

function setup(overrides: Partial<React.ComponentProps<typeof FurniturePanel>> = {}) {
  const props = {
    rooms: [room], targetRoom: room, placements: [], selectedId: undefined, onSelect: vi.fn(), onAdd: vi.fn(), onRotate: vi.fn(), onRemove: vi.fn(),
    keepInRoom: true, onKeepInRoom: vi.fn(), onSave: vi.fn(), onReload: vi.fn(), dirty: false, ...overrides,
  };
  render(<FurniturePanel {...props} />);
  return props;
}

function placeIn(room: CadRoom) {
  const placement = createPlacement(FURNITURE_CATALOG[0], room, []);
  if (!placement) throw new Error("the sofa was expected to fit");
  return placement;
}

afterEach(cleanup);

describe("furniture panel", () => {
  it("offers exactly the three sample assets and adds the clicked one", () => {
    const props = setup();
    expect(FURNITURE_CATALOG.map((asset) => asset.name)).toEqual(["Sofa", "Bed", "Dining Table"]);
    fireEvent.click(screen.getByRole("button", { name: /^Sofa/ }));
    expect(props.onAdd).toHaveBeenCalledWith(FURNITURE_CATALOG[0]);
    expect((screen.getByRole("button", { name: "Save configuration…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks items the target room cannot hold, but still lets them be clicked", () => {
    const props = setup({ targetRoom: sitOut });
    const table = screen.getByRole("button", { name: /^Dining Table/ });
    expect(table.className).toContain("does-not-fit");
    expect(table.getAttribute("aria-disabled")).toBe("true");
    expect(table.getAttribute("title")).toBe("Too large for Sit Out");
    // Clicking still reports upward: the workspace raises the toast that explains why.
    fireEvent.click(table);
    expect(props.onAdd).toHaveBeenCalledWith(FURNITURE_CATALOG[2]);
  });

  it("leaves items unmarked when the target room can hold them", () => {
    setup({ targetRoom: room });
    for (const asset of FURNITURE_CATALOG) {
      expect(screen.getByRole("button", { name: new RegExp(`^${asset.name}`) }).className).not.toContain("does-not-fit");
    }
  });

  it("rotates, removes and saves the selected item", () => {
    const placed = placeIn(room);
    const props = setup({ placements: [placed], selectedId: placed.instanceId, dirty: true });
    expect(screen.getByText(/Living Room · x 2.00, z -1.50 · 0°/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(props.onRotate).toHaveBeenCalledWith(Math.PI / 12);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(props.onRemove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save configuration…" }));
    expect(props.onSave).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved" }));
    expect(props.onReload).toHaveBeenCalled();
  });
});
