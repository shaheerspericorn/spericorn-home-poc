import { afterEach, describe, expect, it, vi } from "vitest";

describe("conversion provider factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the sample adapter in sample mode, with no APS configuration required", async () => {
    // The developer's local .env may legitimately select APS. Set the provider
    // before importing configuration so this unit test verifies sample mode alone.
    vi.resetModules();
    vi.stubEnv("CAD_CONVERSION_PROVIDER", "sample");
    const [{ SampleModeConversionService }, { createCadConversionService }] = await Promise.all([
      import("../src/infrastructure/sample/sample-mode-conversion-service.js"),
      import("../src/services/conversion/create-cad-conversion-service.js"),
    ]);
    const storage = {};
    const converter = createCadConversionService(storage as never);
    expect(converter).toBeInstanceOf(SampleModeConversionService);
    expect(converter).toMatchObject({ provider: "sample", isSampleMode: true });
  });
});
