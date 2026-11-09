import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { addHumanFragment, humansDir } from "../src/domain/gateway/human-registry.js";
import { participantsPath, updateParticipantsFile } from "../src/domain/gateway/participants.js";

describe("GET /api/gateway/participants", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "gateway-participants-route-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("returns an empty list and explains why no default is available", async () => {
    const response = await gatewayRoutes({ home }).request("/participants");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, participants: [], default: { id: null, reason: "no person is registered" } });
  });

  it("returns people, channels, policy and the chosen default without connector secret pointers", async () => {
    for (const id of ["mike", "sarah"]) {
      expect(addHumanFragment({ entityId: id, class: "human", displayName: id, address: `${id}@external`,
        connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://private-test", role: "primary" }],
        prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
    }
    expect(updateParticipantsFile((file) => {
      file.organizations.acme = { name: "Acme", policy: "Respond to customers." };
      file.participants.sarah = { kind: "person", organization: "acme" };
      file.participants.support = { kind: "shared-channel", displayName: "Support", organization: "acme",
        channel: { connector: "slack", connectorRef: "main", secretsRef: "vault://channel-test", channelId: "C123" } };
      file.default = "sarah";
      return file;
    }, home).ok).toBe(true);
    const response = await gatewayRoutes({ home }).request("/participants");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, default: { id: "sarah", source: "chosen" },
      organizations: { acme: { name: "Acme" } }, participants: [
        { id: "mike", kind: "person", address: "mike@external", default: false },
        { id: "sarah", kind: "person", default: true, organization: { id: "acme", name: "Acme" } },
        { id: "support", kind: "shared-channel", channel: { connector: "slack", channelId: "C123" } },
      ] });
    expect(JSON.stringify(result)).not.toContain("vault://");
    const filtered = await gatewayRoutes({ home }).request("/participants?organization=acme");
    expect((await filtered.json()).participants.map((person: { id: string }) => person.id)).toEqual(["sarah", "support"]);
  });

  it("exposes an unreadable participant file without inventing a default", async () => {
    expect(addHumanFragment({ entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      connectorBindings: [], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
    writeFileSync(participantsPath(home), "version: 1\norganizations: [invalid]\n");
    const response = await gatewayRoutes({ home }).request("/participants");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, participants: [{ id: "mike" }],
      participantFile: { error: expect.any(String) }, organizations: null, groups: null });
  });

  it("returns a clear error when the human registry cannot be read", async () => {
    expect(addHumanFragment({ entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      connectorBindings: [], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
    writeFileSync(join(humansDir(home), "mike.yaml"), "not: a-valid-human\n");
    const response = await gatewayRoutes({ home }).request("/participants");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "human_registry_unavailable", message: expect.any(String) });
  });
});
