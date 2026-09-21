/** Shape of GET /api/models/:id/analysis (written by cad-worker/cadworker/pipeline.py). Plan coordinates are local metres. */
export type PlanPoint = [number, number];
export type PlanPolygon = { type: "polygon"; coordinates: PlanPoint[]; holes: PlanPoint[][] };
export type ScenePoint = { x: number; y: number; z: number };

export type LayerRole = "wall" | "door" | "window" | "furniture" | "roomLabel" | "ignore" | "other";
export const LAYER_ROLES: LayerRole[] = ["other", "wall", "door", "window", "furniture", "roomLabel", "ignore"];
export const UNIT_OPTIONS = ["millimeters", "centimeters", "meters", "inches", "feet"] as const;

export type CadLayer = { name: string; role: LayerRole; entityCount: number; types: Record<string, number> };
export type CadWall = { id: string; strategy: string; layer: string; thickness: number; height: number; geometry2d: PlanPolygon; node?: string };
export type CadOpening = { id: string; kind: "door" | "window" | "opening"; geometry2d: PlanPolygon; center: PlanPoint; center3d: ScenePoint; width: number; hostCut: boolean; evidence: string; node?: string };
export type CadRoom = {
  id: string; name: string; type: string; labelSource: "cad-text" | "generated" | "user";
  polygon: PlanPoint[]; area: number; center: PlanPoint;
  /** Same polygon/centre in GLB scene coordinates: [x, z] with z = -y. */
  polygon3d: PlanPoint[]; center3d: ScenePoint; node?: string;
};

export type CadAnalysis = {
  status: "analyzed" | "no_walls" | "generated";
  source: { fileName: string; fileType: string; sizeBytes: number; sourceVersionName?: string; conversion: { tool: string; status: string; durationMs: number } };
  dxf: { version: string; versionName: string; sizeBytes?: number };
  units: { declared: string; used: string; source: "header" | "inferred" | "override" | "measurement-flag"; metersPerUnit: number };
  extents: { drawingUnits: { min: PlanPoint; max: PlanPoint }; modelMeters: { min: PlanPoint; max: PlanPoint } };
  layers: CadLayer[];
  entities: Record<string, number>;
  counts: { lines: number; polylines: number; blockReferences: number; texts: number; hatches: number };
  blocks: Array<{ name: string; count: number }>;
  detectedLayers: Record<string, string[]>;
  detection: { wallStrategies: Record<string, number>; candidateWalls: number; candidateDoors: number; candidateWindows: number; candidateOpenings: number; candidateRooms: number; doorsOnIntactWalls: number; namedRooms: number };
  walls: CadWall[]; doors: CadOpening[]; windows: CadOpening[]; openings: CadOpening[]; rooms: CadRoom[];
  previewEntities: Array<{ layer: string; role: string; points: PlanPoint[] }>;
  parameters: { build: { wallHeight: number; wallThickness: number; floorThickness: number }; layerRoles: Record<string, string>; unitsOverride: string | null };
  assumptions: string[];
  warnings: string[];
  timings: Record<string, number>;
  model3d?: { wallsGenerated: number; floorsGenerated: number; doorsGenerated: number; windowsGenerated: number; glbBytes: number; triangleCount: number };
};

export type GenerationOptions = {
  build?: { wallHeight?: number; wallThickness?: number };
  unitsOverride?: string;
  layerRoles?: Record<string, string>;
  roomNames?: Record<string, string>;
};

/** Ray-casting point-in-polygon; works for plan (x, y) and scene (x, z) pairs alike. */
export function pointInPolygon(x: number, y: number, polygon: PlanPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function roomAtScenePoint(rooms: CadRoom[], x: number, z: number): CadRoom | undefined {
  return rooms.find((room) => pointInPolygon(x, z, room.polygon3d));
}

/** SVG path for a plan polygon with holes. The caller flips Y once on the enclosing <g>. */
export function polygonPath(polygon: PlanPolygon): string {
  const ring = (points: PlanPoint[]) => points.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join("") + "Z";
  return [polygon.coordinates, ...polygon.holes].map(ring).join("");
}
