import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  addHumanFragment,
  listHumans,
  showHuman,
  setHumanField,
  removeHumanFragment,
  pendingConversationsFor,
  humansDir,
  projectionPath,
  projectHumans,
  loadHumanRegistry,
  type InflightItem,
} from "../src/domain/gateway/human-registry.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";

// OPR.0.5.5.12 — fragment lifecycle beyond add: list / show / set / remove.
// RED-first: these pins are written against the seeded registry and fail while the
// lifecycle verbs are unimplemented (stubs return not-implemented; that IS the red).
// The projection-integrity ABSENCE pins are the slice's spine: no verb may write
// humans.generated.yaml except through the regenerator.

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedMike(home: string): void {
  // Minimal authored field set: no away, no handle — the defaults-vs-authored fixture.
  const res = addHumanFragment(
    {
      entityId: "mike",
      class: "human",
      displayName: "Mike",
      address: "mike@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://slack/mike", role: "primary" }],
      prefs: { deliveryClass: "B" },
    },
    home,
  );
  if (!res.ok) throw new Error(`seed mike failed: ${res.error}`);
}

function seedAna(home: string): void {
  // Fuller fragment: away authored, two bindings, inbound-resolvable primary.
  const res = addHumanFragment(
    {
      entityId: "ana",
      class: "human",
      displayName: "Ana",
      address: "ana@external",
      connectorBindings: [
        { kind: "slack", connectorRef: "main", secretsRef: "vault://slack/ana", role: "primary", handle: "U0ANA" },
        { kind: "slack", connectorRef: "alt", secretsRef: "vault://slack/ana-alt", role: "secondary" },
      ],
      prefs: { deliveryClass: "A", away: true },
    },
    home,
  );
  if (!res.ok) throw new Error(`seed ana failed: ${res.error}`);
}

describe("gateway human lifecycle (S12): list / show / set / remove", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "s12-lifecycle-"));
    seedMike(home);
    seedAna(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // ── list ──
  it("list returns every registered human with loudness, availability and binding state, sorted", () => {
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.humans.map((h) => h.entityId)).toEqual(["ana", "mike"]);
    const ana = res.humans[0]!;
    expect(ana.deliveryClass).toBe("A");
    expect(ana.away).toBe(true);
    expect(ana.bindings.count).toBe(2);
    expect(ana.bindings.primary).toEqual({ kind: "slack", connectorRef: "main" });
    expect(ana.bindings.inboundResolvable).toBe(true);
    const mike = res.humans[1]!;
    expect(mike.away).toBe(false); // default applied, surfaced as the effective value
    expect(mike.bindings.inboundResolvable).toBe(false); // handle-less = outbound-only
    expect(mike.fragmentPath).toBe(join(humansDir(home), "mike.yaml"));
  });

  it("list is a READ: it does not touch the projection file (byte receipt)", () => {
    const before = sha(projectionPath(home));
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    expect(sha(projectionPath(home))).toBe(before);
  });

  // ── show ──
  it("show distinguishes authored values from defaults and names the fragment path (effective-record honesty)", () => {
    const res = showHuman("mike", home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.entityId).toBe("mike");
    expect(res.record.address).toBe("mike@external");
    expect(res.record.fragmentPath).toBe(join(humansDir(home), "mike.yaml"));
    // deliveryClass was authored; away was NOT — the default filled it.
    expect(res.record.prefs.deliveryClass).toEqual({ value: "B", source: "authored" });
    expect(res.record.prefs.away).toEqual({ value: false, source: "default" });
    // Ana authored away herself:
    const ana = showHuman("ana", home);
    expect(ana.ok).toBe(true);
    if (ana.ok) expect(ana.record.prefs.away).toEqual({ value: true, source: "authored" });
  });

  it("show on an unknown human teaches with the known set", () => {
    const res = showHuman("ghost", home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("ghost");
    expect(res.error).toContain("ana"); // the known humans are named — teaching, not a bare 404
  });

  // ── set ──
  it("set delivery-class edits the fragment and re-projects immediately (regenerator-shaped only)", () => {
    const res = setHumanField("mike", "delivery-class", "D", home);
    expect(res.ok).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true); // load-time drift pin passes => projection is regenerator-authored
    if (loaded.ok) {
      const mike = loaded.entities.find((e) => e.entityId === "mike")!;
      expect(mike.prefs.deliveryClass).toBe("D");
    }
    // The on-disk projection byte-matches a fresh regeneration — no hand-shaped write.
    const fresh = projectHumans(home);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(readFileSync(projectionPath(home), "utf8")).toBe(fresh.body);
  });

  it("set away accepts only true|false and applies as boolean", () => {
    const ok = setHumanField("mike", "away", "true", home);
    expect(ok.ok).toBe(true);
    const shown = showHuman("mike", home);
    if (shown.ok) expect(shown.record.prefs.away).toEqual({ value: true, source: "authored" });
    const bad = setHumanField("mike", "away", "maybe", home);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("true|false");
  });

  it("set with a bad enum fails loud NAMING the allowed set and leaves fragment AND projection byte-unchanged", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const projBefore = sha(projectionPath(home));
    const res = setHumanField("mike", "delivery-class", "X", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/A.*B.*C.*D/); // the allowed set, named
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  it("set with an unknown field teaches the settable field set and changes nothing", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const res = setHumanField("mike", "nickname", "Iron Mike", home);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("display-name");
      expect(res.error).toContain("delivery-class");
      expect(res.error).toContain("away");
      expect(res.error).toContain("binding.");
    }
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
  });

  it("set binding.<n> replaces that binding via the SAME parse+validate as add (handle gained => inbound-resolvable)", () => {
    const res = setHumanField("mike", "binding.0", "slack:main:vault://slack/mike:primary:handle=U0MIKE", home);
    expect(res.ok).toBe(true);
    const listed = listHumans(home);
    if (listed.ok) expect(listed.humans.find((h) => h.entityId === "mike")!.bindings.inboundResolvable).toBe(true);
  });

  it("set binding.<n> with a malformed spec fails loud with the spec shape and leaves both files byte-unchanged", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const projBefore = sha(projectionPath(home));
    const res = setHumanField("mike", "binding.0", "slack:only", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("kind:connectorRef:secretsRef:role");
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  it("set binding.<n> out of range teaches the valid indices", () => {
    const res = setHumanField("mike", "binding.5", "slack:main:vault://x:primary", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("binding.0");
  });

  it("set runs the FULL add-time validator: an edit that breaks exactly-one-primary is refused whole", () => {
    // ana: binding.1 is secondary; promoting it to a second primary must be refused by the
    // same cross-field invariant add enforces.
    const res = setHumanField("ana", "binding.1", "slack:alt:vault://slack/ana-alt:primary", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("primary");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true); // registry still coherent
  });

  // ── remove ──
  it("remove with NO in-flight items archives the fragment (never deletes bytes) and re-projects", () => {
    const fragBytes = readFileSync(join(humansDir(home), "ana.yaml"), "utf8");
    const res = removeHumanFragment("ana", { inflight: [] }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(join(humansDir(home), "ana.yaml"))).toBe(false);
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(readFileSync(res.archivedPath, "utf8")).toBe(fragBytes); // bytes preserved verbatim
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities.map((e) => e.entityId)).toEqual(["mike"]);
  });

  it("remove REFUSES while in-flight items exist, enumerating each with kind+id and teaching --force", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const res = removeHumanFragment("ana", { inflight }, home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("dec-123");
    expect(res.error).toContain("qitem-777");
    expect(res.error).toContain("open-conversation");
    expect(res.error).toContain("queue-row");
    expect(res.error).toContain("--force");
    // Nothing moved:
    expect(existsSync(join(humansDir(home), "ana.yaml"))).toBe(true);
  });

  it("remove --force archives AND writes an orphan record naming EVERY stranded item (silent-orphan ABSENCE)", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const before = inflight.map((i) => i.id).sort();
    const res = removeHumanFragment("ana", { force: true, inflight }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(res.orphanRecordPath).toBeDefined();
    const orphans = JSON.parse(readFileSync(res.orphanRecordPath!, "utf8")) as { entityId: string; orphaned: InflightItem[] };
    expect(orphans.entityId).toBe("ana");
    // Reconciliation: the recorded set IS the before set — no open item simply vanished.
    expect(orphans.orphaned.map((i) => i.id).sort()).toEqual(before);
    // Registry no longer projects ana:
    const loaded = loadHumanRegistry(home);
    if (loaded.ok) expect(loaded.entities.some((e) => e.entityId === "ana")).toBe(false);
  });

  it("remove on an unknown human teaches; the registry is untouched", () => {
    const projBefore = sha(projectionPath(home));
    const res = removeHumanFragment("ghost", { inflight: [] }, home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ghost"); // teaching names the unknown id
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  // ── projection integrity, the cross-verb ABSENCE pin ──
  it("across all four verbs the projection is only ever regenerator-shaped (hash receipts at every step)", () => {
    const regeneratorShaped = () => {
      const fresh = projectHumans(home);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(readFileSync(projectionPath(home), "utf8")).toBe(fresh.body);
    };
    expect(listHumans(home).ok).toBe(true); regeneratorShaped();
    expect(showHuman("mike", home).ok).toBe(true); regeneratorShaped();
    expect(setHumanField("mike", "delivery-class", "C", home).ok).toBe(true); regeneratorShaped();
    expect(removeHumanFragment("ana", { inflight: [] }, home).ok).toBe(true); regeneratorShaped();
  });

  it("the hand-edit path still refuses after lifecycle writes (drift pin unchanged)", () => {
    expect(setHumanField("mike", "delivery-class", "C", home).ok).toBe(true);
    writeFileSync(projectionPath(home), readFileSync(projectionPath(home), "utf8") + "# sneaky\n");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain("HAND-EDITED");
  });

  // ── open-conversation source (the dispatch buffer) ──
  it("pendingConversationsFor surfaces un-Acked outbound decisions bound to the entity, and only those", () => {
    const buf = new DispatchBuffer(home);
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-ana-1", op: "post", entityBindingRef: "ana@external", payload: {} });
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-ana-2", op: "post", entityBindingRef: "ana:slack:main", payload: {} });
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-bob-1", op: "post", entityBindingRef: "bob@external", payload: {} });
    const items = pendingConversationsFor("ana", home);
    expect(items.map((i) => i.id).sort()).toEqual(["dec-ana-1", "dec-ana-2"]);
    expect(items.every((i) => i.kind === "open-conversation")).toBe(true);
  });

  it("archive filenames are collision-safe: removing then re-adding then removing again preserves BOTH archives", () => {
    removeHumanFragment("ana", { inflight: [] }, home);
    seedAna(home);
    removeHumanFragment("ana", { inflight: [] }, home);
    const archiveDir = join(humansDir(home), ".archive");
    const archived = readdirSync(archiveDir).filter((f) => f.includes("ana") && f.endsWith(".yaml"));
    expect(archived.length).toBe(2);
  });
});
