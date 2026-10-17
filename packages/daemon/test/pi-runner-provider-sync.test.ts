import { describe, expect, it } from "vitest";
import { PI_PROVIDER_ENV_VARS } from "../src/adapters/pi-runner-protocol.js";

describe("pi and omp multi-provider runner integration", () => {
  it("maps deepseek provider to DEEPSEEK_API_KEY environment variable", () => {
    expect(PI_PROVIDER_ENV_VARS["deepseek"]).toBe("DEEPSEEK_API_KEY");
  });

  it("exports known provider keys for multi-harness runtimes", () => {
    expect(PI_PROVIDER_ENV_VARS).toHaveProperty("deepseek");
    expect(PI_PROVIDER_ENV_VARS).toHaveProperty("minimax");
    expect(PI_PROVIDER_ENV_VARS).toHaveProperty("zai");
  });
});
