"use client";

import { memo, useEffect, useRef } from "react";
import type { CadRoom } from "../lib/cad-analysis";

type Props = { rooms: CadRoom[]; selectedRoomId?: string; onSelect: (roomId: string) => void };

/** Keyboard-accessible room list. Room navigation never depends on being able to click the 3D model. */
export const RoomNav = memo(function RoomNav({ rooms, selectedRoomId, onSelect }: Props) {
  // A room picked in the 3D view may be outside the visible part of the list (or of the swipe row on tablets).
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedButton.current?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedRoomId]);

  return (
    <nav className="room-nav" aria-label="Rooms">
      <h2>Rooms</h2>
      {rooms.length === 0 ? (
        <p className="subtle">No enclosed rooms were detected in this drawing.</p>
      ) : (
        <ul>
          {rooms.map((room) => {
            const selected = room.id === selectedRoomId;
            return (
              <li key={room.id}>
                <button type="button" ref={selected ? selectedButton : undefined} className={selected ? "room-item selected" : "room-item"} aria-current={selected ? "true" : undefined} aria-label={`${room.name}, ${room.area.toFixed(1)} square metres${selected ? ", selected" : ""}`} onClick={() => onSelect(room.id)}>
                  <span className="room-name">{room.name}</span>
                  <span className="room-area">{room.area.toFixed(1)} m²</span>
                  <span className="room-check" aria-hidden="true">✓</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
});
