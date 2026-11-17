import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { selfMachineLabel } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";

const configured = (value: string) => ({ value, source: "file" as const });

describe("machine names on the Slack delivery path", () => {
  it.each([
    ["Local", "lead@team", "Local"],
    ["Mac mini & lab", "lead@team", "Mac mini &amp; lab"],
    ["&".repeat(400), "lead@team", "host-4a409197"],
    ["x".repeat(1983), "lead@team", "host-4a409197"],
    ["x".repeat(1983), "a@b", "x".repeat(1983)],
  ])("posts with a fitting machine label (case %#)", async (name, sender, expected) => {
    const home = mkdtempSync(path.join(tmpdir(), "slack-machine-"));
    const posts: unknown[] = [];
    try {
      const deliver = subsystemSlackDeliver({
        botToken: "xoxb-EXAMPLE-fake", channel: "C-TEST", sourceLabel: "vm",
        machine: () => selfMachineLabel(configured(name), "host-4a409197"),
        machineFallback: "host-4a409197",
        delivered: new SeenStore(path.join(home, "delivered.jsonl")),
        attempted: new SeenStore(path.join(home, "attempted.jsonl")),
        outboundSeen: new SeenStore(path.join(home, "seen.jsonl")),
        fetchImpl: async (_url, init) => {
          posts.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true, ts: "100.1" }), { status: 200 });
        },
      });
      const result = await deliver({
        kind: "outbound_decision", decisionId: "machine-post", op: OUTBOUND_OP, entityBindingRef: "person@external",
        payload: { qitemId: "q-machine", sourceSession: sender, summary: "Decide X", body: "The details." },
      });
      expect(result.ok).toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ text: expect.stringMatching(`^From ${sender} on ${expected}\\n`) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("posts with the durable host ID when a fitting label would overflow the complete message", async () => {
    // The label fits the sender line (well under its 2000-unit budget) but it
    // pushes the COMPLETE fallback past the text cap: the durable host ID is
    // tried before anything refuses, so an ordinary notice still posts.
    const home = mkdtempSync(path.join(tmpdir(), "slack-machine-overflow-"));
    const posts: unknown[] = [];
    try {
      const deliver = subsystemSlackDeliver({
        botToken: "xoxb-EXAMPLE-fake", channel: "C-TEST", sourceLabel: "vm",
        machine: () => selfMachineLabel(configured("x".repeat(1500)), "host-4a409197"),
        machineFallback: "host-4a409197",
        delivered: new SeenStore(path.join(home, "delivered.jsonl")),
        attempted: new SeenStore(path.join(home, "attempted.jsonl")),
        outboundSeen: new SeenStore(path.join(home, "seen.jsonl")),
        fetchImpl: async (_url, init) => {
          posts.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true, ts: "100.1" }), { status: 200 });
        },
      });
      const result = await deliver({
        kind: "outbound_decision", decisionId: "machine-overflow", op: OUTBOUND_OP, entityBindingRef: "person@external",
        payload: { qitemId: "q-overflow", sourceSession: "lead@team", summary: "Decide X", body: "b".repeat(2450) },
      });
      expect(result.ok).toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ text: expect.stringMatching(/^From lead@team on host-4a409197\n/) });
      expect(posts[0]).toMatchObject({ text: expect.not.stringMatching(/x{100}/) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("selfMachineLabel (Slack sender-line machine label)", () => {
  it("prefers the operator's display name over the generated id", () => {
    expect(selfMachineLabel(configured("uni-pc"), "host-4a409197")).toBe("uni-pc");
  });

  it("keeps a display name with spaces (rig host rename's own example)", () => {
    expect(selfMachineLabel(configured("Mac mini 2"), "host-4a409197")).toBe("Mac mini 2");
  });

  it("falls back to the self-host id when no display name is set", () => {
    expect(selfMachineLabel(configured(""), "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(configured("   "), "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(null, "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(undefined, "host-4a409197")).toBe("host-4a409197");
  });

  it.each(["Local", "Kernel", "localhost", "Mac mini 2"])("shows the chosen name %s even when it looks reserved", (name) => {
    const setting = new SettingsStore().resolveOne("host.name", { host: { name } });
    expect(selfMachineLabel(setting, "host-4a409197")).toBe(name);
  });

  it("falls back for an unconfigured default, using its source rather than its spelling", () => {
    const setting = new SettingsStore().resolveOne("host.name", {});
    expect(setting.source).toBe("default");
    expect(selfMachineLabel(setting, "host-4a409197")).toBe("host-4a409197");
  });

  it("shows the display name even before boot resolved an id, and omits the label when neither exists", () => {
    expect(selfMachineLabel(configured("uni-pc"), null)).toBe("uni-pc");
    expect(selfMachineLabel(configured(""), null)).toBeNull();
    expect(selfMachineLabel({ value: "localhost", source: "default" }, null)).toBeNull();
  });

  it("returns the id unchanged when the display name already seeded it", () => {
    expect(selfMachineLabel(configured("uni-pc"), "uni-pc")).toBe("uni-pc");
  });
});
