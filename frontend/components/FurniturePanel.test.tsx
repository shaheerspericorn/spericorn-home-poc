import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CadRoom } from "../lib/cad-analysis";
import { createPlacement } from "../lib/configuration";
import { FURNITURE_CATALOG } from "../lib/furniture-catalog";
import { FurniturePanel } from "./FurniturePanel";

const room: CadRoom = { id: "room-001", name: "Living Room", type: "living-room", labelSource: "cad-text", area: 12, polygon: [], center: [2, 1.5], polygon3d: [[0, 0], [4, 0], [4, -3], [0, -3]], center3d: { x: 2, y: 0, z: -1.5 } };

function setup(overrides: Partial<React.ComponentProps<typeof FurniturePanel>> = {}) {
  const props = {
    rooms: [room], targetRoomName: "Living Room", placements: [], selectedId: undefined, onSelect: vi.fn(), onAdd: vi.fn(), onRotate: vi.fn(), onRemove: vi.fn(),
    keepInRoom: true, onKeepInRoom: vi.fn(), onSave: vi.fn(), onReload: vi.fn(), dirty: false, ...overrides,
  };
  render(<FurniturePanel {...props} />);
  return props;
}

afterEach(cleanup);

describe("furniture panel", () => {
  it("offers exactly the three sample assets and adds the clicked one", () => {
    const props = setup();
    expect(FURNITURE_CATALOG.map((asset) => asset.name)).toEqual(["Sofa", "Bed", "Dining Table"]);
    fireEvent.click(screen.getByRole("button", { name: /^Sofa/ }));
    expect(props.onAdd).toHaveBeenCalledWith(FURNITURE_CATALOG[0]);
    expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rotates, removes and saves the selected item", () => {
    const placed = createPlacement(FURNITURE_CATALOG[0], room, []);
    const props = setup({ placements: [placed], selectedId: placed.instanceId, dirty: true });
    expect(screen.getByText(/Living Room · x 2.00, z -1.50 · 0°/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(props.onRotate).toHaveBeenCalledWith(Math.PI / 12);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(props.onRemove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(props.onSave).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved" }));
    expect(props.onReload).toHaveBeenCalled();
  });
});
