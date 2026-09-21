import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CadRoom } from "../lib/cad-analysis";
import { RoomNav } from "./RoomNav";

const room = (id: string, name: string, area: number): CadRoom => ({ id, name, type: "unknown", labelSource: "cad-text", area, polygon: [], center: [0, 0], polygon3d: [], center3d: { x: 0, y: 0, z: 0 } });
const rooms = [room("room-001", "Living Room", 43), room("room-002", "Kitchen", 11.3)];

afterEach(cleanup);

describe("room navigation", () => {
  it("lists rooms as real buttons, marks the selected one and reports clicks", () => {
    const onSelect = vi.fn();
    render(<RoomNav rooms={rooms} selectedRoomId="room-001" onSelect={onSelect} />);
    expect(screen.getByRole("navigation", { name: "Rooms" })).toBeTruthy();
    const living = screen.getByRole("button", { name: /Living Room.*selected/ });
    expect(living.getAttribute("aria-current")).toBe("true");
    const kitchen = screen.getByRole("button", { name: /^Kitchen, 11.3 square metres$/ });
    expect(kitchen.getAttribute("aria-current")).toBeNull();
    fireEvent.click(kitchen);
    expect(onSelect).toHaveBeenCalledWith("room-002");
  });

  it("explains an empty list", () => {
    render(<RoomNav rooms={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/No enclosed rooms/)).toBeTruthy();
  });
});
