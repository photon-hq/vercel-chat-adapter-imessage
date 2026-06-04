import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "chat",
    "@chat-adapter/shared",
    "spectrum-ts",
    "spectrum-ts/providers/imessage",
  ],
});
