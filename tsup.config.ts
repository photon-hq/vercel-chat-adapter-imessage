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
    "@photon-ai/imessage-kit",
    "@photon-ai/advanced-imessage-kit",
  ],
});
