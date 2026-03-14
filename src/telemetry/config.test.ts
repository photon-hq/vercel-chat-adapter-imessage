import { describe, expect, it } from "vitest";

import { DEFAULT_OTEL_CONFIG } from "./config";

describe("DEFAULT_OTEL_CONFIG", () => {
  it("does not force a service name by default", () => {
    expect(DEFAULT_OTEL_CONFIG.serviceName).toBeUndefined();
  });
});
