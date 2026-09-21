import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ViewerWorkspace } from "./ViewerWorkspace";

vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="three-viewer" /> }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

afterEach(() => vi.unstubAllGlobals());

describe("viewer states", () => {
  it("shows a loading state followed by a safe API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Model not found." }) } as Response));
    render(<ViewerWorkspace modelId="missing" />);
    expect(screen.getByText("Loading model details…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Viewer unavailable")).toBeTruthy());
    expect(screen.getByText("Model not found.")).toBeTruthy();
  });
});
