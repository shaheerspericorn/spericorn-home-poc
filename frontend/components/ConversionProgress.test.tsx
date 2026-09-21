import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ConversionProgress } from "./ConversionProgress";

afterEach(() => vi.unstubAllGlobals());

describe("conversion progress", () => {
  it("renders the server-reported CAD stage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "model-1", status: "processing", progress: 50, stage: "processing_cad" }) } as Response));
    const view = render(<ConversionProgress modelId="model-1" fileName="villa.ifc" isSampleMode={false} onComplete={vi.fn()} onRetry={vi.fn()} />);
    await waitFor(() => {
      const stage = screen.getAllByRole("listitem").find((item) => item.textContent?.includes("Processing CAD model"));
      expect(stage?.className).toContain("stage-current");
    });
    view.unmount();
  });

  it("shows local pipeline stages and hands over to the 2D review", async () => {
    const onReview = vi.fn();
    const onComplete = vi.fn();
    const responses = [{ id: "m", status: "parsing_dxf", progress: 35, stage: "parsing_dxf" }, { id: "m", status: "awaiting_review", progress: 65, stage: "awaiting_review" }];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true, json: async () => responses.length > 1 ? responses.shift() : responses[0] }) as Response));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<ConversionProgress modelId="m" fileName="villa.dwg" isSampleMode={false} onComplete={onComplete} onRetry={vi.fn()} onReview={onReview} />);
    await waitFor(() => expect(screen.getAllByRole("listitem").find((item) => item.textContent?.includes("Parsing DXF entities"))?.className).toContain("stage-current"));
    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(onReview).toHaveBeenCalled());
    expect(onComplete).not.toHaveBeenCalled();
    vi.useRealTimers();
    view.unmount();
  });

  it("offers drawing diagnostics when analysis failed to find walls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "m", status: "failed", progress: 100, stage: "failed", error: "DWG was parsed successfully, but no wall geometry could be reliably detected.", analysisAvailable: true }) } as Response));
    const view = render(<ConversionProgress modelId="m" fileName="site.dwg" isSampleMode={false} onComplete={vi.fn()} onRetry={vi.fn()} onReview={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no wall geometry could be reliably detected/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Inspect drawing diagnostics" })).toBeTruthy();
    view.unmount();
  });
});
