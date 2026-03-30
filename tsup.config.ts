import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  minify: true,
  treeshake: true,
  outDir: "dist",
  external: ["ts-node"],
});
