"use client";

import type { CadRoom } from "../lib/cad-analysis";
import { canPlaceInRoom, ROTATION_STEP, type FurniturePlacement } from "../lib/configuration";
import { FURNITURE_CATALOG, findAsset, type FurnitureAsset } from "../lib/furniture-catalog";

type Props = {
  /** Used for names only; room selection lives in RoomNav. */
  rooms: CadRoom[];
  /** Where the next item will be placed. */
  targetRoom?: CadRoom;
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
  savedName?: string;
  savedAt?: string;
};

export function FurniturePanel(props: Props) {
  const { rooms, placements, selectedId } = props;
  const selected = placements.find((item) => item.instanceId === selectedId);
  const selectedAsset = selected && findAsset(selected.assetId);
  const roomName = (roomId: string | null) => rooms.find((room) => room.id === roomId)?.name ?? "outside any room";

  return (
    <section className="furniture-panel" aria-label="Furniture">
      <h2>Furniture</h2>
      <p className="subtle">{props.targetRoom ? `Adds to ${props.targetRoom.name}.` : "Select a room, then add an item."}</p>
      <div className="catalog">
        {FURNITURE_CATALOG.map((asset) => {
          // Stays clickable when it does not fit: the click explains why, which a dead button could not.
          const fits = canPlaceInRoom(asset, props.targetRoom);
          return (
            <button
              key={asset.id}
              type="button"
              className={fits ? "secondary-button" : "secondary-button does-not-fit"}
              aria-disabled={!fits}
              title={fits ? undefined : `Too large for ${props.targetRoom?.name ?? "this room"}`}
              onClick={() => props.onAdd(asset)}
            >
              {asset.name}<small>{asset.width} × {asset.depth} × {asset.height} m{fits ? "" : " · does not fit"}</small>
            </button>
          );
        })}
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
        <p className="subtle">{placements.length ? "Click a furniture item to select it." : "Items appear at the centre of the room."}</p>
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
        <button type="button" className="primary-button" onClick={props.onSave} disabled={!props.dirty}>Save configuration…</button>
        <button type="button" className="secondary-button" onClick={props.onReload}>Reload saved</button>
      </div>
      {props.message && <p className="subtle" role="status">{props.message}</p>}
      {props.savedAt && <small className="subtle">Saved as “{props.savedName}” · {new Date(props.savedAt).toLocaleString()}</small>}
    </section>
  );
}
