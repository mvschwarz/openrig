import { describe, it, expect } from "vitest";
import { checkAbi } from "../scripts/check-abi.mjs";

describe("postinstall ABI check", () => {
  it("passes on supported even-numbered LTS with working native addon", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("passes on Node 20 LTS", () => {
    const result = checkAbi({
      nodeVersion: "v20.18.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("passes on Node 24 LTS", () => {
    const result = checkAbi({
      nodeVersion: "v24.0.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("fails on odd-numbered Node 25 with honest error + fix command", () => {
    const result = checkAbi({
      nodeVersion: "v25.8.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("odd-numbered");
    expect(result.message).toContain("v25.8.0");
    expect(result.message).toContain("nvm install 22");
  });

  it("fails on odd-numbered Node 23 with honest error", () => {
    const result = checkAbi({
      nodeVersion: "v23.5.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("odd-numbered");
  });

  it("fails on Node below 20 with version-too-low error", () => {
    const result = checkAbi({
      nodeVersion: "v18.20.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires Node.js 20, 22, or 24");
    expect(result.message).toContain("nvm install 22");
  });

  it("fails with ABI mismatch error when native addon throws on supported version", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {
        throw new Error(
          "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
          "This version of Node.js requires NODE_MODULE_VERSION 131."
        );
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("native binary does not match");
    expect(result.message).toContain("npm rebuild better-sqlite3");
    expect(result.message).toContain("NODE_MODULE_VERSION");
  });

  it("skips native addon check entirely for odd versions (fast path)", () => {
    let addonCalled = false;
    const result = checkAbi({
      nodeVersion: "v25.8.0",
      loadNativeAddon: () => { addonCalled = true; },
    });
    expect(result.ok).toBe(false);
    // Version check short-circuits before trying to load the addon
    expect(addonCalled).toBe(false);
  });
});
