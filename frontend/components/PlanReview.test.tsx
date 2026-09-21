import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CadAnalysis } from "../lib/cad-analysis";
import { PlanReview } from "./PlanReview";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const square = (x: number, y: number, w: number, h: number) => ({ type: "polygon" as const, coordinates: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]] as [number, number][], holes: [] });

function analysis(overrides: Partial<CadAnalysis> = {}): CadAnalysis {
  return {
    status: "analyzed",
    source: { fileName: "villa.dwg", fileType: "DWG", sizeBytes: 91047, sourceVersionName: "AutoCAD 2018", conversion: { tool: "ODA File Converter", status: "success", durationMs: 370 } },
    dxf: { version: "AC1032", versionName: "2018", sizeBytes: 472384 },
    units: { declared: "millimeters", used: "meters", source: "inferred", metersPerUnit: 1 },
    extents: { drawingUnits: { min: [0, 0], max: [6, 4] }, modelMeters: { min: [-3, -2], max: [3, 2] } },
    layers: [{ name: "Muro1", role: "wall", entityCount: 258, types: { LWPOLYLINE: 258 } }, { name: "XX", role: "other", entityCount: 8, types: { LINE: 8 } }],
    entities: { LINE: 647, LWPOLYLINE: 270 }, counts: { lines: 647, polylines: 270, blockReferences: 11, texts: 0, hatches: 0 }, blocks: [],
    detectedLayers: { wall: ["Muro1"] },
    detection: { wallStrategies: { "closed-polyline": 0, "parallel-pair": 0, "line-network": 2 }, candidateWalls: 2, candidateDoors: 1, candidateWindows: 1, candidateOpenings: 0, candidateRooms: 1, doorsOnIntactWalls: 0, namedRooms: 0 },
    walls: [{ id: "wall-001", strategy: "line-network", layer: "Muro1", thickness: 0.24, height: 3, geometry2d: square(-3, -2, 6, 0.24) }, { id: "wall-002", strategy: "line-network", layer: "Muro1", thickness: 0.24, height: 3, geometry2d: square(-3, 1.76, 6, 0.24) }],
    doors: [{ id: "door-001", kind: "door", geometry2d: square(0, -2, 0.9, 0.24), center: [0.45, -1.88], center3d: { x: 0.45, y: 0, z: 1.88 }, width: 0.9, hostCut: true, evidence: "swing arc" }],
    windows: [{ id: "window-001", kind: "window", geometry2d: square(0, 1.76, 1.5, 0.24), center: [0.75, 1.88], center3d: { x: 0.75, y: 0, z: -1.88 }, width: 1.5, hostCut: true, evidence: "window layer" }],
    openings: [],
    rooms: [{ id: "room-001", name: "Room 1", type: "unknown", labelSource: "generated", polygon: [[-3, -1.76], [3, -1.76], [3, 1.76], [-3, 1.76]], area: 21.1, center: [0, 0], polygon3d: [], center3d: { x: 0, y: 0, z: 0 } }],
    previewEntities: [{ layer: "XX", role: "other", points: [[0, 0], [1, 1]] }],
    parameters: { build: { wallHeight: 3, wallThickness: 0.2, floorThickness: 0.15 }, layerRoles: {}, unitsOverride: null },
    assumptions: ["Wall height 3 m (not present in a 2D plan)."], warnings: ["Header declares millimeters, but that is implausible."], timings: { dwgToDxfMs: 370, dxfParsingMs: 210, geometryDetectionMs: 120 },
    ...overrides,
  };
}

function mockApi(report: CadAnalysis) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/analysis")) return { ok: true, json: async () => report } as Response;
    if (String(url).endsWith("/generate")) return { ok: true, json: async () => ({ modelId: "m1", status: "generating_3d" }) } as Response;
    if (String(url).endsWith("/status")) return { ok: true, json: async () => ({ id: "m1", status: "completed", progress: 100, stage: "complete" }) } as Response;
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

describe("2D plan review", () => {
  it("draws the detected plan, lists diagnostics and honest warnings", async () => {
    mockApi(analysis());
    const view = render(<PlanReview modelId="m1" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "villa.dwg" })).toBeTruthy());

    const svg = view.container.querySelector("svg.plan-svg") as SVGElement;
    expect(svg.querySelectorAll("[data-wall]").length).toBe(2);
    expect(svg.querySelectorAll("[data-room]").length).toBe(1);
    expect(svg.querySelectorAll("[data-door]").length).toBe(1);
    expect(svg.querySelectorAll("[data-window]").length).toBe(1);
    expect(svg.querySelector("g")?.getAttribute("transform")).toBe("scale(1,-1)");

    expect(screen.getByText(/meters \(inferred; header: millimeters\)/)).toBeTruthy();
    expect(screen.getByText(/implausible/)).toBeTruthy();
    expect(screen.getByText("ODA File Converter", { exact: false })).toBeTruthy();
    expect(screen.getByText("Muro1", { exact: false })).toBeTruthy();
  });

  it("sends the reviewed defaults and corrected room names, then opens the 3D viewer", async () => {
    const fetchMock = mockApi(analysis());
    render(<PlanReview modelId="m1" />);
    await waitFor(() => screen.getByRole("button", { name: "Generate 3D" }));

    fireEvent.change(screen.getByLabelText("Wall height (m)"), { target: { value: "2.7" } });
    fireEvent.change(screen.getByDisplayValue("Room 1"), { target: { value: "Living Room" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate 3D" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/viewer/m1"));
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/generate"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ build: { wallHeight: 2.7, wallThickness: 0.2 }, roomNames: { "room-001": "Living Room" } });
  });

  it("refuses to generate when no walls were detected and shows the diagnostics instead", async () => {
    mockApi(analysis({ status: "no_walls", walls: [], rooms: [], doors: [], windows: [], detection: { ...analysis().detection, candidateWalls: 0, candidateRooms: 0, candidateDoors: 0, candidateWindows: 0 } }));
    render(<PlanReview modelId="m1" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No reliable wall geometry was detected"));
    expect((screen.getByRole("button", { name: "Generate 3D" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Muro1", { exact: false })).toBeTruthy();  // layers stay inspectable

    fireEvent.change(screen.getAllByRole("combobox").at(-1) as HTMLSelectElement, { target: { value: "wall" } });
    expect(screen.getByRole("button", { name: "Re-analyse with changes" })).toBeTruthy();
  });
});
