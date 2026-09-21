declare module "obj2gltf" {
  type Options = { binary?: boolean; secure?: boolean };
  export default function obj2gltf(input: string, options?: Options): Promise<Buffer | Record<string, unknown>>;
}
