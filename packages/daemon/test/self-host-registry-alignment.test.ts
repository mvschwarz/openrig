// 51-09 increment 2b — self-host id ↔ registry-id ALIGNMENT (arch ruling dfa65bfc).
//
// Ruling: interpretation (ii) — there is NO registry self-row (type-incoherent
// against the closed HostEntry union); the alignment property is that the minted
// self-host id must PASS THE REGISTRY-ID VALIDATORS + NON-RESERVED set so a
// REMOTE host can adopt it as a registry key (transport-carries-host). Validated
// at boot, fail-closed. The validator is a CLI/daemon LOCKSTEP TWIN
// (hosts-registry-reader.ts ↔ cli/host-registry.ts, parity-pinned).

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SelfHostIdentityStore } from "../src/domain/seat-identity-store.js";
import {
  reconcileSelfHostIdentity,
  assertSelfHostIdRegistryAligned,
} from "../src/domain/seat-identity-reconciler.js";
import { validateHostRegistry as daemonValidate } from "../src/domain/hosts/hosts-registry-reader.js";
import { validateHostRegistry as cliValidate } from "../../cli/src/host-registry.js";

describe("51-09 incr2b: self-host id ↔ registry-id alignment", () => {
  it("a registry-valid self-id passes the alignment assert (boot proceeds)", () => {
    for (const good of ["mars-01", "vm-a.local", "host-ab12cd34", "jupiter_02"]) {
      expect(() => assertSelfHostIdRegistryAligned(good), `'${good}' should pass`).not.toThrow();
    }
  });

  it("fail-closed: an invalid self-id (path-bearing / reserved / empty) throws loudly", () => {
    for (const bad of ["a/b", "../escape", ".hidden", "", "local", "kernel", "host"]) {
      expect(() => assertSelfHostIdRegistryAligned(bad), `'${bad}' must fail-closed`).toThrow(
        /registry-alignment|self-host id/,
      );
    }
  });

  it("reconcile fail-closes on a stored self-id that is not a valid registry id (pre-2b mint / DB tamper)", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    store.mint("bad/id", "2026-08-06T00:00:00.000Z"); // directly seed an invalid id, bypassing mint guards
    expect(() =>
      reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T01:00:00.000Z", hostNameCandidate: null }),
    ).toThrow(/registry-alignment/);
  });

  it("a format-invalid host.name seed is NOT adopted — falls back to a generated registry-valid id (no boot brick)", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T00:00:00.000Z",
      hostNameCandidate: "my/host",
    });
    expect(r.minted).toBe(true);
    expect(r.hostId).not.toBe("my/host");
    expect(r.hostId).toMatch(/^host-/); // generated fallback
    expect(() => assertSelfHostIdRegistryAligned(r.hostId)).not.toThrow(); // minted id is registry-valid
  });

  it("a registry-valid host.name seed is adopted verbatim (good path preserved)", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T00:00:00.000Z",
      hostNameCandidate: "mars-01",
    });
    expect(r.hostId).toBe("mars-01");
    expect(() => assertSelfHostIdRegistryAligned(r.hostId)).not.toThrow();
  });

  it("the alignment validator is the CLI/daemon TWIN — both agree verdict-for-verdict on self-id shapes", () => {
    const SELF_ID_SHAPES: Array<{ id: string; ok: boolean }> = [
      { id: "mars-01", ok: true },
      { id: "vm-a.local", ok: true },
      { id: "host-ab12cd34", ok: true },
      { id: "a/b", ok: false },
      { id: "../escape", ok: false },
      { id: ".hidden", ok: false },
      { id: "local", ok: false },
      { id: "kernel", ok: false },
    ];
    for (const { id, ok } of SELF_ID_SHAPES) {
      const probe = { hosts: [{ id, transport: "ssh", target: "self-alignment-probe" }] };
      const d = daemonValidate(probe, "<self>");
      const c = cliValidate(probe, "<self>");
      expect(d.ok, `daemon '${id}'`).toBe(ok);
      expect(c.ok, `cli '${id}'`).toBe(ok); // twin agreement
    }
  });
});
