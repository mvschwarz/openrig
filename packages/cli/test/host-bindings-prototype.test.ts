import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHostObservation, loadHostBindings } from "../src/host-bindings.js";
import { validateHostRegistry } from "../src/host-registry.js";

describe("host bindings for prototype-named aliases", () => {
  it.each(["constructor", "toString", "valueOf"])("records and reloads the first observation for %s", (alias) => {
    const dir = mkdtempSync(join(tmpdir(), "host-binding-alias-"));
    try {
      expect(validateHostRegistry({ hosts: [{ id: alias, transport: "http", url: "http://example.test" }] }, "test").ok).toBe(true);
      const path = join(dir, "host-bindings.json");
      expect(recordHostObservation({ alias, observedHostId: "host-123", path }).outcome).toBe("bound");
      expect(loadHostBindings(path).bindings[alias]?.hostId).toBe("host-123");
      expect(recordHostObservation({ alias, observedHostId: "host-123", path }).outcome).toBe("confirmed");
      expect(recordHostObservation({ alias, observedHostId: "host-456", path }).outcome).toBe("conflict");
      expect(loadHostBindings(path).bindings[alias]?.conflict?.hostId).toBe("host-456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
