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

  it("prepare(decision) runs synchronously BEFORE durable enqueue and replay sends the exact frozen payload without re-running prepare", async () => {
    let prepareCalls = 0;
    let bufferedDuringPrepare = -1;
    let releaseFirst: (o: SubsystemDeliveryOutcome) => void = () => {};
    const firstGate = new Promise<SubsystemDeliveryOutcome>((r) => { releaseFirst = r; });

    const w1 = buildInProcessWire({
      home,
      ops: ["post_message"],
      prepare: (decision) => {
        prepareCalls++;
        bufferedDuringPrepare = new DispatchBuffer(home).pending().length;
        const p = (decision.payload ?? {}) as Record<string, unknown>;
        return {
          ...decision,
          payload: {
            ...p,
            relayEnvelope: {
              v: 1,
              deliveryId: decision.decisionId,
              replyRef: `frozen-ref-${prepareCalls}`,
            },
          },
        };
      },
      deliver: () => firstGate,
    });

    const r1 = w1.dispatcher.dispatch("post_message", "sam@external", { qitemId: "q-freeze-1" }, { decisionId: "d-freeze-1" });
    expect(r1.ok).toBe(true);
    expect(prepareCalls).toBe(1);
    expect(bufferedDuringPrepare, "prepare must run BEFORE durable buffer.enqueue").toBe(0);

    // Durable buffer immediately holds the frozen payload before delivery resolves.
    const pendingBefore = new DispatchBuffer(home).pending();
    expect(pendingBefore).toHaveLength(1);
    expect((pendingBefore[0]!.payload as { relayEnvelope?: { replyRef?: string } }).relayEnvelope?.replyRef).toBe("frozen-ref-1");

    // Duplicate dispatch of same decisionId while pending does not re-run prepare or overwrite frozen payload.
    const dup = w1.dispatcher.dispatch("post_message", "sam@external", { qitemId: "q-freeze-1", mutated: true }, { decisionId: "d-freeze-1" });
    expect(dup.ok).toBe(true);
    expect(prepareCalls).toBe(1);

    // Fail first delivery so it stays in the buffer for replay.
    releaseFirst({ ok: false, class: "transport", detail: "bridge down" });
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);

    // Run 2: replayPending sends the exact frozen payload from the buffer without calling prepare again.
    const replayed: OutboundDecision[] = [];
    const w2 = buildInProcessWire({
      home,
      ops: ["post_message"],
      prepare: (decision) => {
        prepareCalls++;
        return {
          ...decision,
          payload: { ...(decision.payload as object), relayEnvelope: { v: 1, deliveryId: decision.decisionId, replyRef: "recomputed-ref" } },
        };
      },
      deliver: async (d) => {
        replayed.push(d);
        return { ok: true };
      },
    });
    w2.startServices?.();
    await tick();

    expect(prepareCalls, "replayPending must not re-run prepare").toBe(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.decisionId).toBe("d-freeze-1");
    expect((replayed[0]!.payload as { relayEnvelope?: { replyRef?: string } }).relayEnvelope?.replyRef).toBe("frozen-ref-1");
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  describe("dispatcher prepare hook rails", () => {
    it("preserves caller's advertised op, entityBindingRef, kind, and decisionId when prepare mutates argument in place and returns void", async () => {
      let dispatchedDecision: OutboundDecision | undefined;
      const wire = buildInProcessWire({
        home,
        ops: ["post_message"],
        prepare: (decision) => {
          // Attempt malicious/accidental mutation of rails in place and return void
          (decision as any).op = "unadvertised_bypassed_op";
          (decision as any).entityBindingRef = "hacked#channel";
          (decision as any).kind = "forged_kind";
          (decision as any).decisionId = "hacked_decision_id";
          // Valid payload preparation:
          const p = (decision.payload ?? {}) as Record<string, unknown>;
          p.preparedPayloadField = "frozen_value";
        },
        deliver: async (d) => {
          dispatchedDecision = d;
          return { ok: true };
        },
      });

      const res = wire.dispatcher.dispatch("post_message", "alice@external", { orig: 1 }, { decisionId: "d-fixed-1" });
      expect(res.ok).toBe(true);
      expect((res as { decisionId: string }).decisionId).toBe("d-fixed-1");
      await tick();

      expect(dispatchedDecision).toBeDefined();
      expect(dispatchedDecision!.op).toBe("post_message");
      expect(dispatchedDecision!.entityBindingRef).toBe("alice@external");
      expect(dispatchedDecision!.kind).toBe("outbound_decision");
      expect(dispatchedDecision!.decisionId).toBe("d-fixed-1");
      expect((dispatchedDecision!.payload as any).preparedPayloadField).toBe("frozen_value");
      expect((dispatchedDecision!.payload as any).orig).toBe(1);

      // Verify what was durably persisted in the buffer matches the rails
      const bufferEntries = new DispatchBuffer(home).pending();
      expect(bufferEntries).toHaveLength(0); // Drained because delivery returned ok: true
    });

    it("preserves caller's advertised op, entityBindingRef, kind, and decisionId when prepare returns a mutated decision object", async () => {
      let dispatchedDecision: OutboundDecision | undefined;
      const wire = buildInProcessWire({
        home,
        ops: ["post_message"],
        prepare: (decision) => {
          // Return new object attempting to alter op, entityBindingRef, kind, decisionId
          return {
            kind: "other_kind" as any,
            decisionId: "hijacked_id",
            op: "malicious_op",
            entityBindingRef: "attacker#ref",
            payload: {
              ...(decision.payload as object),
              frozenPayload: "persisted",
            },
          };
        },
        deliver: async (d) => {
          dispatchedDecision = d;
          return { ok: true };
        },
      });

      const res = wire.dispatcher.dispatch("post_message", "bob@external", { count: 42 }, { decisionId: "d-fixed-2" });
      expect(res.ok).toBe(true);
      expect((res as { decisionId: string }).decisionId).toBe("d-fixed-2");
      await tick();

      expect(dispatchedDecision).toBeDefined();
      expect(dispatchedDecision!.op).toBe("post_message");
      expect(dispatchedDecision!.entityBindingRef).toBe("bob@external");
      expect(dispatchedDecision!.kind).toBe("outbound_decision");
      expect(dispatchedDecision!.decisionId).toBe("d-fixed-2");
      expect((dispatchedDecision!.payload as any).frozenPayload).toBe("persisted");
      expect((dispatchedDecision!.payload as any).count).toBe(42);
    });

    it("refuses unadvertised original op before prepare or send is ever executed", async () => {
      let prepareCalled = false;
      let sendCalled = false;
      const wire = buildInProcessWire({
        home,
        ops: ["post_message"],
        prepare: () => {
          prepareCalled = true;
        },
        deliver: async () => {
          sendCalled = true;
          return { ok: true };
        },
      });

      const res = wire.dispatcher.dispatch("unsupported_op", "alice@external", {});
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toContain("not advertised");
      expect(prepareCalled).toBe(false);
      expect(sendCalled).toBe(false);
      expect(new DispatchBuffer(home).pending()).toHaveLength(0);
    });
  });
});
