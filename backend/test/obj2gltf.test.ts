import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import obj2gltf from "obj2gltf";

describe("GLB post-processing", () => {
  it("converts an OBJ derivative into a binary glTF", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "villa-obj-"));
    try {
      const objPath = path.join(directory, "villa.obj");
      await writeFile(objPath, "o Villa\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
      const glb = await obj2gltf(objPath, { binary: true, secure: true });
      expect(Buffer.isBuffer(glb)).toBe(true);
      expect((glb as Buffer).subarray(0, 4).toString()).toBe("glTF");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
