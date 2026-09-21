import { describe, expect, it } from "vitest";
import { validateModelFile } from "./file-validation";

describe("model upload validation", () => {
  const config = { supportedFormats: ["ifc", "dwg"], maxUploadBytes: 100 };

  it("rejects an unsupported extension before upload", () => {
    expect(validateModelFile(new File(["test"], "drawing.pdf"), config)).toContain("Unsupported file type");
  });

  it("rejects files exceeding the configured maximum", () => {
    expect(validateModelFile(new File(["x".repeat(101)], "villa.ifc"), config)).toContain("too large");
  });

  it("accepts a supported file within the limit", () => {
    expect(validateModelFile(new File(["model"], "villa.IFC"), config)).toBeUndefined();
  });
});
