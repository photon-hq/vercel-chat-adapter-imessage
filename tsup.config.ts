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
    "mime-types",
    "@spectrum-ts/core",
    "@spectrum-ts/imessage",
  ],
});
