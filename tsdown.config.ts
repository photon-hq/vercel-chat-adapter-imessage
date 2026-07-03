import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Follow the package type ("module") so output stays .js/.d.ts, matching
  // the exports map — the node-platform default would emit .mjs/.d.mts.
  fixedExtension: false,
  deps: {
    neverBundle: [
      "chat",
      "@chat-adapter/shared",
      "mime-types",
      "spectrum-ts",
      "spectrum-ts/providers/imessage",
    ],
  },
});
