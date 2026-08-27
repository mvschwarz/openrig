import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInProcessWire, GatewaySubsystem, type SubsystemDeliveryOutcome } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

// S10 — the in-process wire must carry the SHIPPED durability contract unchanged (slice-11 /
// M1 semantics, re-homed): persisted BEFORE delivery, drained ONLY on delivered-ok, retained on
// failure, replayed on the next activation, and proof-9 (unadvertised op refused, never
// attempted) intact. These are the receipts that the re-homing did not weaken the contract.

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("S10 in-process gateway wire — durability contract receipts", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-wire-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("persists a decision durably BEFORE delivery resolves (durable-first)", async () => {
    let release: (o: SubsystemDeliveryOutcome) => void = () => {};
    const gate = new Promise<SubsystemDeliveryOutcome>((r) => { release = r; });
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: () => gate });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 1 });
    expect(res.ok).toBe(true);
    // Delivery has NOT resolved — the decision must already be durable on disk.
    const pending = new DispatchBuffer(home).pending();
    expect(pending.map((d) => d.decisionId)).toContain((res as { decisionId: string }).decisionId);
    release({ ok: true });
    await tick();
  });

  it("drains ONLY on delivered-ok (the in-process ack)", async () => {
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: true }) });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 2 });
    expect(res.ok).toBe(true);
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("RETAINS a failed delivery (never dropped) and names the failure", async () => {
    const logs: string[] = [];
    const wire = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async () => ({ ok: false, class: "http-500", detail: "slack burped" }),
      log: (m) => logs.push(m),
    });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 3 });
    expect(res.ok).toBe(true);
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1); // retained
    expect(logs.join("\n")).toContain("http-500"); // fail-visible, cause named
  });

  it("a throwing deliver is a failure class, not a crash — retained", async () => {
    const wire = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async () => { throw new Error("transport exploded"); },
    });
    wire.dispatcher.dispatch("post_message", "mike#slack", { t: 4 });
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
  });

  it("REPLAYS un-Acked decisions through delivery on the next activation (restart no-loss)", async () => {
    // Run 1: delivery down — decision retained.
    const w1 = buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: false, class: "transport" }) });
    const r1 = w1.dispatcher.dispatch("post_message", "mike#slack", { t: 5 });
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    // Run 2 (same home = same durable buffer): delivery back — replay (a network action)
    // fires on startServices(), the post-bind half of activation.
    const redelivered: OutboundDecision[] = [];
    const w2 = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async (d) => { redelivered.push(d); return { ok: true }; },
    });
    w2.startServices?.();
    await tick();
    expect(redelivered.map((d) => d.decisionId)).toContain((r1 as { decisionId: string }).decisionId);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("proof-9 holds in-process: an unadvertised op is REFUSED, never delivered", async () => {
    const delivered: OutboundDecision[] = [];
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: async (d) => { delivered.push(d); return { ok: true }; } });
    const res = wire.dispatcher.dispatch("upload_file", "mike#slack", {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not advertised");
    await tick();
    expect(delivered).toHaveLength(0);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0); // refused before durable-enqueue
  });

  it("subsystem dispatch() refuses honestly when failed, and restart() recovers", async () => {
    let attempts = 0;
    const subsystem = new GatewaySubsystem({
      home,
      wire: () => {
        attempts++;
        if (attempts === 1) throw new Error("first wiring dies");
        return buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: true }) });
      },
    });
    subsystem.start();
    expect(subsystem.status().state).toBe("failed");
    const refused = subsystem.dispatch("post_message", "mike#slack", {});
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain("failed");
    subsystem.restart(); // the recovery half of recovers-or-reports
    expect(subsystem.status().state).toBe("active");
    expect(subsystem.dispatch("post_message", "mike#slack", {}).ok).toBe(true);
  });
});
