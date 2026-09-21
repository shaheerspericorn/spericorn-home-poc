import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UploadWorkspace } from "./UploadWorkspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("upload screen", () => {
  it("renders configured upload controls and reports an invalid file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ supportedFormats: ["ifc"], maxUploadBytes: 100, conversionProvider: "sample", isSampleMode: true })));
    const view = render(<UploadWorkspace />);

    expect(screen.getByRole("heading", { name: "Upload Villa CAD Model" })).toBeTruthy();
    expect(screen.getByText("Sample Mode")).toBeTruthy();
    const input = view.container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["not CAD"], "villa.pdf", { type: "application/pdf" })] } });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unsupported file type"));
  });
});
