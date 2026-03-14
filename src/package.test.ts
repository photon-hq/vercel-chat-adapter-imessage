import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("declares OpenTelemetry packages required by published typings", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["@opentelemetry/api"]).toBeTruthy();
    expect(packageJson.dependencies?.["@opentelemetry/api-logs"]).toBeTruthy();
  });
});
