import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: false,
  splitting: false,
  clean: true,
  minify: "terser",
  treeshake: true,
  outDir: "dist",
  external: ["ts-node"],
});
