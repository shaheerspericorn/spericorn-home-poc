import { describe, expect, it } from "vitest";
import { displayNameFromFile, extensionOf, safeFileName } from "../src/utils/files.js";

describe("upload validation helpers", () => {
  it("normalises the extension without trusting a path", () => {
    expect(extensionOf("../../Villa Model.IFC")).toBe("ifc");
    expect(safeFileName("../../Villa Model.IFC")).toBe("Villa_Model.IFC");
  });

  it("creates a readable model name", () => {
    expect(displayNameFromFile("green-valley_villa.rvt")).toBe("green valley villa");
  });
});
