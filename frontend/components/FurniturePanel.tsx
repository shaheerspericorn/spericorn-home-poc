"use client";

import type { CadRoom } from "../lib/cad-analysis";
import { ROTATION_STEP, type FurniturePlacement } from "../lib/configuration";
import { FURNITURE_CATALOG, findAsset, type FurnitureAsset } from "../lib/furniture-catalog";

type Props = {
  rooms: CadRoom[];
  selectedRoomId?: string;
  onSelectRoom: (roomId: string) => void;
  placements: FurniturePlacement[];
  selectedId?: string;
  onSelect: (instanceId: string | undefined) => void;
  onAdd: (asset: FurnitureAsset) => void;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  keepInRoom: boolean;
  onKeepInRoom: (value: boolean) => void;
  onSave: () => void;
  onReload: () => void;
  dirty: boolean;
  message?: string;
  savedAt?: string;
};

export function FurniturePanel(props: Props) {
  const { rooms, selectedRoomId, placements, selectedId } = props;
  const selected = placements.find((item) => item.instanceId === selectedId);
  const selectedAsset = selected && findAsset(selected.assetId);
  const roomName = (roomId: string | null) => rooms.find((room) => room.id === roomId)?.name ?? "outside any room";

  return (
    <aside className="model-info furniture-panel" aria-label="Furniture">
      <h2>Rooms</h2>
      {rooms.length === 0 && <p className="subtle">No enclosed rooms were detected. Furniture is placed at the model origin.</p>}
      <div className="room-chips">
        {rooms.map((room) => (
          <button key={room.id} type="button" className={room.id === selectedRoomId ? "chip active" : "chip"} aria-pressed={room.id === selectedRoomId} onClick={() => props.onSelectRoom(room.id)} title={`${room.area.toFixed(1)} m² · ${room.type}`}>
            {room.name}
          </button>
        ))}
      </div>
      <small className="subtle">Select a room here or click its floor in the 3D view.</small>

      <hr />
      <h2>Furniture</h2>
      <div className="catalog">
        {FURNITURE_CATALOG.map((asset) => (
          <button key={asset.id} type="button" className="secondary-button" onClick={() => props.onAdd(asset)}>
            {asset.name}<small>{asset.width} × {asset.depth} × {asset.height} m</small>
          </button>
        ))}
      </div>
      <label className="check-row"><input type="checkbox" checked={props.keepInRoom} onChange={(event) => props.onKeepInRoom(event.target.checked)} /> Keep furniture inside its room</label>

      {selected && selectedAsset ? (
        <div className="selection-box">
          <strong>{selectedAsset.name}</strong>
          <small>{roomName(selected.roomId)} · x {selected.position.x.toFixed(2)}, z {selected.position.z.toFixed(2)} · {Math.round((selected.rotation.y * 180) / Math.PI)}°</small>
          <div className="button-row">
            <button type="button" onClick={() => props.onRotate(ROTATION_STEP)} aria-label="Rotate left">⟲ 15°</button>
            <button type="button" onClick={() => props.onRotate(-ROTATION_STEP)} aria-label="Rotate right">⟳ 15°</button>
            <button type="button" className="danger" onClick={props.onRemove}>Remove</button>
          </div>
          <small className="subtle">Drag in the 3D view to move · R / Shift+R rotate · Delete removes</small>
        </div>
      ) : (
        <p className="subtle">{placements.length ? "Click a furniture item to select it." : "Pick an item to place it at the centre of the selected room."}</p>
      )}

      {placements.length > 0 && (
        <ul className="placement-list">
          {placements.map((item) => (
            <li key={item.instanceId}><button type="button" className={item.instanceId === selectedId ? "text-button active" : "text-button"} onClick={() => props.onSelect(item.instanceId)}>{findAsset(item.assetId)?.name ?? item.assetId} — {roomName(item.roomId)}</button></li>
          ))}
        </ul>
      )}

      <hr />
      <div className="button-row">
        <button type="button" className="primary-button" onClick={props.onSave} disabled={!props.dirty}>Save configuration</button>
        <button type="button" className="secondary-button" onClick={props.onReload}>Reload saved</button>
      </div>
      {props.message && <p className="subtle" role="status">{props.message}</p>}
      {props.savedAt && <small className="subtle">Last saved {new Date(props.savedAt).toLocaleString()}</small>}
    </aside>
  );
}
