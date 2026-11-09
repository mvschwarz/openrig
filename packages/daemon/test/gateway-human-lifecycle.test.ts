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

describe("gateway human lifecycle (S12, amended A1: single-human surface): list / show / set / remove", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "s12-lifecycle-"));
    seedMike(home); // A1: receipts run against ONE seeded human
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // ── list (A1: singular surface) ──
  it("list renders THE configured human with loudness, availability and binding state — no advisory", () => {
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.humans.map((h) => h.entityId)).toEqual(["mike"]);
    expect(res.advisory).toBeUndefined();
    const mike = res.humans[0]!;
    expect(mike.deliveryClass).toBe("B");
    expect(mike.away).toBe(false); // default applied, surfaced as the effective value
    expect(mike.bindings.count).toBe(1);
    expect(mike.bindings.primary).toEqual({ kind: "slack", connectorRef: "main" });
    expect(mike.bindings.inboundResolvable).toBe(false); // handle-less = outbound-only
    expect(mike.fragmentPath).toBe(join(humansDir(home), "mike.yaml"));
  });

  it("list at zero humans is an ok empty result (the teaching empty-state is the CLI's)", () => {
    const empty = mkdtempSync(join(tmpdir(), "s12-empty-"));
    try {
      const res = listHumans(empty);
      expect(res.ok).toBe(true);
      if (res.ok) { expect(res.humans).toEqual([]); expect(res.advisory).toBeUndefined(); }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("several people list as a supported registry, sorted, with no single-person advisory (0.7.3 participants)", () => {
    seedAna(home);
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.humans.map((h) => h.entityId)).toEqual(["ana", "mike"]);
    const ana = res.humans[0]!;
    expect(ana.deliveryClass).toBe("A");
    expect(ana.away).toBe(true);
    expect(ana.bindings.count).toBe(2);
    expect(ana.bindings.inboundResolvable).toBe(true);
    expect(res).not.toHaveProperty("advisory");
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
    seedAna(home);
    const ana = showHuman("ana", home);
    expect(ana.ok).toBe(true);
    if (ana.ok) expect(ana.record.prefs.away).toEqual({ value: true, source: "authored" });
  });

  it("show on an unknown human teaches with the known set", () => {
    const res = showHuman("ghost", home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("ghost");
    expect(res.error).toContain("mike"); // the known human is named — teaching, not a bare 404
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

  it("set slack-subscription: the default is every-ask, urgent-only is authored, unset returns to the default, and anything else is refused", () => {
    expect(showHuman("mike", home)).toMatchObject({ ok: true, record: { slackSubscription: { value: "every-ask", source: "default" } } });
    expect(setHumanField("mike", "slack-subscription", "urgent-only", home).ok).toBe(true);
    expect(showHuman("mike", home)).toMatchObject({ ok: true, record: { slackSubscription: { value: "urgent-only", source: "authored" } } });
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities.find((e) => e.entityId === "mike")!.subscriptions)
      .toEqual([{ destination: { connector: "slack" }, filter: { preset: "urgent-only" } }]);
    const bad = setHumanField("mike", "slack-subscription", "some", home);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("every-ask|urgent-only");
    expect(setHumanField("mike", "slack-subscription", "unset", home).ok).toBe(true);
    expect(showHuman("mike", home)).toMatchObject({ ok: true, record: { slackSubscription: { value: "every-ask", source: "default" } } });
  });

  it("a hand-written preset that isn't a plain string is refused, never projected as a quiet subscription", () => {
    // Hand-edit the fragment, then any set re-validates and re-projects it.
    const fragment = join(humansDir(home), "mike.yaml");
    writeFileSync(fragment, `${readFileSync(fragment, "utf8")}subscriptions:\n  - destination: { connector: slack }\n    filter: { preset: [every-ask] }\n`);
    const res = setHumanField("mike", "display-name", "Mike M", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must be { preset: every-ask|urgent-only }");
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
    // same cross-field invariant add enforces. (Two-binding mechanics are retained under A1.)
    seedAna(home);
    const res = setHumanField("ana", "binding.1", "slack:alt:vault://slack/ana-alt:primary", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("primary");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true); // registry still coherent
  });

  it("set binding.<n> unset removes a secondary binding, shifts remaining slot indexes, and reports remainingBindings + note", () => {
    const seeded = addHumanFragment(
      {
        entityId: "dana",
        class: "human",
        displayName: "Dana",
        address: "dana@external",
        connectorBindings: [
          { kind: "slack", connectorRef: "secondary-first", secretsRef: "vault://slack/dana-s1", role: "secondary" },
          { kind: "slack", connectorRef: "main", secretsRef: "vault://slack/dana-main", role: "primary", handle: "U0DANA" },
          { kind: "relay", connectorRef: "bridge", secretsRef: "file:/etc/openrig/relay.env", role: "secondary" },
        ],
        prefs: { deliveryClass: "A", away: true },
      },
      home,
    );
    expect(seeded.ok).toBe(true);
    const res = setHumanField("dana", "binding.0", "unset", home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.remainingBindings).toEqual([
      { slot: "binding.0", kind: "slack", connectorRef: "main", role: "primary", handle: "U0DANA", inboundResolvable: true },
      { slot: "binding.1", kind: "relay", connectorRef: "bridge", role: "secondary", inboundResolvable: false },
    ]);
    expect(JSON.stringify(res.remainingBindings)).not.toContain("vault://");
    expect(res.note).toContain("Removed binding.0 (slack:secondary-first role=secondary)");
    expect(res.note).toContain("Remaining binding(s): binding.0: slack:main role=primary handle=U0DANA, binding.1: relay:bridge role=secondary [outbound-only]");
    expect(res.note).toContain("Binding slot indexes shift after removal, so do not blindly retry binding.0 unset");
    const shown = showHuman("dana", home);
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.record.prefs.deliveryClass.value).toBe("A");
      expect(shown.record.prefs.away).toEqual({ value: true, source: "authored" });
      expect(shown.record.connectorBindings.map((b) => [b.kind, b.connectorRef, b.role])).toEqual([
        ["slack", "main", "primary"],
        ["relay", "bridge", "secondary"],
      ]);
    }
    const fresh = projectHumans(home);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(readFileSync(projectionPath(home), "utf8")).toBe(fresh.body);
  });

  it("set binding.<n> unset on a sole primary binding leaves connectorBindings empty and explains inactive delivery episode semantics", () => {
    const res = setHumanField("mike", "binding.0", "unset", home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fragment.connectorBindings).toEqual([]);
    expect(res.remainingBindings).toEqual([]);
    expect(res.note).toContain("Remaining bindings: none (this person now has no connector binding and is reached in the Feed and Steering only)");
    expect(res.note).toContain("Removing the last binding makes the current delivery episode inactive, so new missing-post findings stop (an already-open recovery item for an undelivered notice may remain)");
    expect(res.note).toContain("the current delivery-outcome display may disappear too, while historical receipt notes remain");
    expect(res.note).toContain("It does not answer, close or cancel open questions, cancel or reroute already-prepared deliveries, or retract anything a bridge has already accepted");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const mike = loaded.entities.find((e) => e.entityId === "mike")!;
      expect(mike.connectorBindings).toEqual([]);
      expect(mike.prefs.deliveryClass).toBe("B");
    }
  });

  it("set binding.<n> unset refuses removing primary while secondary bindings remain, naming the settings-preserving replace/promote/remove paths", () => {
    seedAna(home);
    const fragBefore = sha(join(humansDir(home), "ana.yaml"));
    const projBefore = sha(projectionPath(home));
    const res = setHumanField("ana", "binding.0", "unset", home);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('cannot unset binding.0 (role "primary") while 1 other binding(s) remain (binding.1)');
      expect(res.error).toContain("no replacement is chosen silently");
      expect(res.error).toContain('To replace the primary, set binding.0 to the new primary spec: rig gateway human set ana binding.0 "<kind:connectorRef:secretsRef:primary[:handle=<id>]>"');
      expect(res.error).toContain("To promote one of the other bindings (binding.1), first save that binding's full spec (kind:connectorRef:secretsRef:role[:handle=<id>]) from rig gateway human show ana --json, then unset that secondary slot, then find the primary's current slot in remainingBindings (or rig gateway human show ana --json, since unsetting a lower slot shifts the primary down) and set it to the saved spec with role primary (promotion replaces the former primary binding; its connector reference and inbound handle are not retained as a secondary).");
      expect(res.error).toContain("To remove every binding, unset the secondary bindings first using their current slot indexes from remainingBindings or rig gateway human show ana, then finish at binding.0 (once all secondaries are gone, the primary is at binding.0).");
      expect(res.error).not.toContain("--replace");
    }
    expect(sha(join(humansDir(home), "ana.yaml"))).toBe(fragBefore);
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  it("primary at nonzero slot (binding.1): refusal names current slots, promote route saves spec from show --json before unsetting and shifts primary to binding.0, and remove-all route finishes at binding.0", () => {
    expect(
      addHumanFragment(
        {
          entityId: "kai",
          class: "human",
          displayName: "Kai",
          address: "kai@external",
          connectorBindings: [
            { kind: "relay", connectorRef: "bridge-a", secretsRef: "file:/etc/a.env", role: "secondary", handle: "kai-a" },
            { kind: "slack", connectorRef: "main", secretsRef: "file:/etc/s.env", role: "primary", handle: "U0KAI" },
            { kind: "relay", connectorRef: "bridge-b", secretsRef: "file:/etc/b.env", role: "secondary", handle: "kai-b" },
          ],
          prefs: { deliveryClass: "A", availability: "focus" },
          subscriptions: [{ destination: { connector: "slack" }, filter: { preset: "urgent-only" } }],
        },
        home,
      ).ok,
    ).toBe(true);

    // 1. Refuse unsetting primary at binding.1 while secondaries at binding.0 and binding.2 remain
    const refused = setHumanField("kai", "binding.1", "unset", home);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain('cannot unset binding.1 (role "primary") while 2 other binding(s) remain (binding.0, binding.2)');
      expect(refused.error).toContain('To replace the primary, set binding.1 to the new primary spec: rig gateway human set kai binding.1 "<kind:connectorRef:secretsRef:primary[:handle=<id>]>"');
      expect(refused.error).toContain("To promote one of the other bindings (binding.0, binding.2), first save that binding's full spec (kind:connectorRef:secretsRef:role[:handle=<id>]) from rig gateway human show kai --json, then unset that secondary slot, then find the primary's current slot in remainingBindings (or rig gateway human show kai --json, since unsetting a lower slot shifts the primary down) and set it to the saved spec with role primary (promotion replaces the former primary binding; its connector reference and inbound handle are not retained as a secondary).");
      expect(refused.error).toContain("To remove every binding, unset the secondary bindings first using their current slot indexes from remainingBindings or rig gateway human show kai, then finish at binding.0 (once all secondaries are gone, the primary is at binding.0).");
    }

    // 2. Promote route from binding.0 when primary started at binding.1:
    //    Step 1: save binding.0's full spec (including secretsRef) from showHuman (rig gateway human show kai --json)
    const beforePromote = showHuman("kai", home);
    expect(beforePromote.ok).toBe(true);
    if (!beforePromote.ok) return;
    const savedSecondary = beforePromote.record.connectorBindings[0]!;
    expect(savedSecondary.secretsRef).toBe("file:/etc/a.env");
    const promotedSpec = `${savedSecondary.kind}:${savedSecondary.connectorRef}:${savedSecondary.secretsRef}:primary${savedSecondary.handle ? `:handle=${savedSecondary.handle}` : ""}`;

    //    Step 2: unset secondary binding.0 -> primary shifts down from binding.1 to binding.0
    const promoteUnset = setHumanField("kai", "binding.0", "unset", home);
    expect(promoteUnset.ok).toBe(true);
    if (!promoteUnset.ok) return;
    expect(promoteUnset.remainingBindings?.map((b) => [b.slot, b.connectorRef, b.role])).toEqual([
      ["binding.0", "main", "primary"],
      ["binding.1", "bridge-b", "secondary"],
    ]);
    const currentPrimarySlot = promoteUnset.remainingBindings!.find((b) => b.role === "primary")!.slot;
    expect(currentPrimarySlot).toBe("binding.0");

    //    Step 3: set primary's current slot (binding.0, NOT old binding.1) to the saved spec with role primary
    const promoteSet = setHumanField("kai", currentPrimarySlot, promotedSpec, home);
    expect(promoteSet.ok).toBe(true);
    const afterPromote = showHuman("kai", home);
    expect(afterPromote.ok).toBe(true);
    if (afterPromote.ok) {
      expect(afterPromote.record.connectorBindings.map((b) => [b.kind, b.connectorRef, b.secretsRef, b.role, b.handle])).toEqual([
        ["relay", "bridge-a", "file:/etc/a.env", "primary", "kai-a"],
        ["relay", "bridge-b", "file:/etc/b.env", "secondary", "kai-b"],
      ]);
      expect(afterPromote.record.slackSubscription).toEqual({ value: "urgent-only", source: "authored" });
      expect(afterPromote.record.prefs.deliveryClass).toEqual({ value: "A", source: "authored" });
    }
    const loadedAfterPromote = loadHumanRegistry(home);
    expect(loadedAfterPromote.ok).toBe(true);
    if (loadedAfterPromote.ok) {
      expect(loadedAfterPromote.entities.find((e) => e.entityId === "kai")?.prefs.availability).toBe("focus");
    }

    // 3. Remove-all route when primary is at a nonzero slot ([secondary binding.0, primary binding.1, secondary binding.2]):
    expect(
      addHumanFragment(
        {
          entityId: "kai",
          class: "human",
          displayName: "Kai",
          address: "kai@external",
          connectorBindings: [
            { kind: "relay", connectorRef: "bridge-a", secretsRef: "file:/etc/a.env", role: "secondary", handle: "kai-a" },
            { kind: "slack", connectorRef: "main", secretsRef: "file:/etc/s.env", role: "primary", handle: "U0KAI" },
            { kind: "relay", connectorRef: "bridge-b", secretsRef: "file:/etc/b.env", role: "secondary", handle: "kai-b" },
          ],
          prefs: { deliveryClass: "A", availability: "focus" },
        },
        home,
        { replace: true },
      ).ok,
    ).toBe(true);
    const rem1 = setHumanField("kai", "binding.0", "unset", home);
    expect(rem1.ok).toBe(true);
    if (rem1.ok) {
      expect(rem1.remainingBindings?.map((b) => [b.slot, b.role])).toEqual([
        ["binding.0", "primary"],
        ["binding.1", "secondary"],
      ]);
    }
    const rem2 = setHumanField("kai", "binding.1", "unset", home);
    expect(rem2.ok).toBe(true);
    if (rem2.ok) {
      expect(rem2.remainingBindings?.map((b) => [b.slot, b.role])).toEqual([["binding.0", "primary"]]);
    }
    const rem3 = setHumanField("kai", "binding.0", "unset", home);
    expect(rem3.ok).toBe(true);
    if (rem3.ok) {
      expect(rem3.remainingBindings).toEqual([]);
      expect(rem3.fragment.connectorBindings).toEqual([]);
    }
  });

  it("two-step promotion (unset secondary binding.<k> first, then set primary slot to its spec with role primary) keeps subscription, deliveryClass, and availability intact", () => {
    expect(
      addHumanFragment(
        {
          entityId: "ana",
          class: "human",
          displayName: "Ana",
          address: "ana@external",
          connectorBindings: [
            { kind: "slack", connectorRef: "main", secretsRef: "file:/etc/s.env", role: "primary", handle: "U0ANA" },
            { kind: "relay", connectorRef: "bridge", secretsRef: "file:/etc/r.env", role: "secondary", handle: "ana-ops" },
            { kind: "relay", connectorRef: "other", secretsRef: "file:/etc/o.env", role: "secondary", handle: "ana-2" },
          ],
          prefs: { deliveryClass: "A", availability: "focus" },
          subscriptions: [{ destination: { connector: "slack" }, filter: { preset: "urgent-only" } }],
        },
        home,
      ).ok,
    ).toBe(true);

    const s1 = setHumanField("ana", "binding.1", "unset", home);
    expect(s1.ok).toBe(true);
    const s2 = setHumanField("ana", "binding.0", "relay:bridge:file:/etc/r.env:primary:handle=ana-ops", home);
    expect(s2.ok).toBe(true);

    const shown = showHuman("ana", home);
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.record.connectorBindings.map((b) => [b.kind, b.connectorRef, b.role, b.handle])).toEqual([
        ["relay", "bridge", "primary", "ana-ops"],
        ["relay", "other", "secondary", "ana-2"],
      ]);
      expect(shown.record.slackSubscription).toEqual({ value: "urgent-only", source: "authored" });
      expect(shown.record.prefs.deliveryClass).toEqual({ value: "A", source: "authored" });
    }
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const ana = loaded.entities.find((e) => e.entityId === "ana")!;
      expect(ana.prefs.availability).toBe("focus");
    }
  });

  // ── remove ──
  it("remove with NO in-flight items archives the fragment (never deletes bytes) and re-projects", () => {
    const fragBytes = readFileSync(join(humansDir(home), "mike.yaml"), "utf8");
    const res = removeHumanFragment("mike", { inflight: [] }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(false);
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(readFileSync(res.archivedPath, "utf8")).toBe(fragBytes); // bytes preserved verbatim
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities).toEqual([]);
  });

  it("remove REFUSES while in-flight items exist, enumerating each with kind+id and teaching --force", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const res = removeHumanFragment("mike", { inflight }, home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("dec-123");
    expect(res.error).toContain("qitem-777");
    expect(res.error).toContain("open-conversation");
    expect(res.error).toContain("queue-row");
    expect(res.error).toContain("--force");
    // Nothing moved:
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  it("remove --force archives AND writes an orphan record naming EVERY stranded item (silent-orphan ABSENCE)", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const before = inflight.map((i) => i.id).sort();
    const res = removeHumanFragment("mike", { force: true, inflight }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(res.orphanRecordPath).toBeDefined();
    const orphans = JSON.parse(readFileSync(res.orphanRecordPath!, "utf8")) as { entityId: string; orphaned: InflightItem[] };
    expect(orphans.entityId).toBe("mike");
    // Reconciliation: the recorded set IS the before set — no open item simply vanished.
    expect(orphans.orphaned.map((i) => i.id).sort()).toEqual(before);
    // Registry no longer projects mike:
    const loaded = loadHumanRegistry(home);
    if (loaded.ok) expect(loaded.entities.some((e) => e.entityId === "mike")).toBe(false);
  });

  it("fix-r1 F2 fs-half receipt: 501 in-flight items force-remove to 501 recorded orphans — the registry layer never truncates", () => {
    const inflight: InflightItem[] = Array.from({ length: 501 }, (_, i) => ({
      kind: "queue-row" as const,
      id: `qitem-load-${i}`,
      detail: `pending row qitem-load-${i}`,
    }));
    const res = removeHumanFragment("mike", { force: true, inflight }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const orphans = JSON.parse(readFileSync(res.orphanRecordPath!, "utf8")) as { orphaned: InflightItem[] };
    expect(orphans.orphaned).toHaveLength(501);
    expect(orphans.orphaned.some((i) => i.id === "qitem-load-500")).toBe(true);
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
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true); regeneratorShaped();
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
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true);
    seedMike(home);
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true);
    const archiveDir = join(humansDir(home), ".archive");
    const archived = readdirSync(archiveDir).filter((f) => f.includes("mike") && f.endsWith(".yaml"));
    expect(archived.length).toBe(2);
  });
});
