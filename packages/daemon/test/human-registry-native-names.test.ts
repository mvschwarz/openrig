import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { addHumanFragment, listHumans, showHuman, setHumanField, readHumanAvailability, removeHumanFragment, projectHumans } from "../src/domain/gateway/human-registry.js";

it.runIf(process.platform === "win32").each(["con", "aux.person", "h".repeat(240)])("preserves the full native registry lifecycle for %s", entityId => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-native-name-"));
  try {
    const raw = { entityId, class: "human", displayName: "Owned fixture", address: `${entityId}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "owned", secretsRef: "env:OWNED_TEST_ONLY", role: "primary" }], prefs: { deliveryClass: "B" } };
    const added = addHumanFragment(raw, home);
    expect(added).toMatchObject({ ok: true });
    if (added.ok && entityId.length > 200) {
      const legacy = path.join(path.dirname(added.path), `${entityId}.yaml`);
      fs.copyFileSync(added.path, legacy);
      fs.unlinkSync(added.path);
      // Existing valid long-name fragments stay authoritative; only the
      // archive and sidecar filenames need the bounded storage stem.
    }
    expect(addHumanFragment(raw, home)).toMatchObject({ ok: false });
    expect(listHumans(home)).toMatchObject({ ok: true, humans: [{ entityId }] });
    expect(showHuman(entityId, home)).toMatchObject({ ok: true, record: { entityId } });
    expect(setHumanField(entityId, "display-name", "Changed fixture", home)).toMatchObject({ ok: true });
    expect(setHumanField(entityId, "availability", "away", home)).toMatchObject({ ok: true });
    expect(readHumanAvailability(entityId, home)).toMatchObject({ ok: true, availability: "away", changeId: expect.any(String) });
    const missing = showHuman("missing-owned", home);
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining(entityId) });
    const removed = removeHumanFragment(entityId, { force: true, inflight: [{ kind: "queue-row", id: "owned", detail: "synthetic" }] }, home);
    expect(removed).toMatchObject({ ok: true });
    if (removed.ok) {
      expect(fs.existsSync(removed.archivedPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(removed.orphanRecordPath!, "utf8"))).toMatchObject({ entityId });
    }
    expect(projectHumans(home)).toMatchObject({ ok: true, entities: [] });
    expect(addHumanFragment(raw, home)).toMatchObject({ ok: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
