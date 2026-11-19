import { expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostBindings, recordHostObservation } from "../src/host-bindings.js";

it.runIf(process.platform === "win32")("persists and retains conflicts with a valid long sidecar filename", () => {
  const root = mkdtempSync(join(tmpdir(), "host-bindings-native-"));
  const basename = "h".repeat(245) + ".json";
  const path = join(root, basename);
  try {
    expect(recordHostObservation({ path, alias: "owned", observedHostId: "host-original" }).outcome).toBe("bound");
    expect(recordHostObservation({ path, alias: "owned", observedHostId: "host-other" }).outcome).toBe("conflict");
    expect(loadHostBindings(path).bindings.owned).toMatchObject({
      hostId: "host-original", conflict: { hostId: "host-other" },
    });
    expect(readdirSync(root)).toEqual([basename]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
