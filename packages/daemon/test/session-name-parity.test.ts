// OPR.0.4.6.MH1 FR-8 — the session-name parse contract, parity-pinned
// across all three packages (arch B2 ruling: workspaces do not
// cross-import, so daemon/cli/ui each carry a copy; THIS shared vector
// set is the pin — a divergence here means a copy drifted).
//
// The three arch teeth are NAMED tests below:
//   TOOTH 1 — human-seat classification runs BEFORE any parse at the
//             queue-destination gate (zero rig lookups for human seats).
//   TOOTH 2 — a three-part "member@rig@x" keeps parsing with the greedy
//             rig ("rig@x"), so the registry lookup misses and the queue
//             gate rejects with the SAME unknown_destination_rig error as
//             before the contract existed (BR-1: host never in-band).
//   TOOTH 3 — the legacy r{NN}-suffix grammar keeps validating as a
//             session name (and keeps carrying NO rig binding).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { HUMAN_SEAT_SESSION_PATTERN } from "../src/domain/human-route-enforcer.js";
import * as daemonCopy from "../src/domain/session-name.js";
import * as cliCopy from "../../cli/src/session-name.js";
import * as uiCopy from "../../ui/src/lib/session-name.js";

type ContractCopy = {
  parseSessionName: typeof daemonCopy.parseSessionName;
  isHumanSeatSessionRef: typeof daemonCopy.isHumanSeatSessionRef;
  sessionMemberLabel: typeof daemonCopy.sessionMemberLabel;
  sessionRigOf: typeof daemonCopy.sessionRigOf;
};

const COPIES: Array<[string, ContractCopy]> = [
  ["daemon", daemonCopy],
  ["cli", cliCopy],
  ["ui", uiCopy],
];

const malformed = (input: string) =>
  ({ kind: "malformed", error: "malformed_session_name", input }) as const;

// ONE vector set, run against every copy. `memberLabel`/`rigOf` pin the
// display helpers; `human` pins classification.
const SHARED_VECTORS = [
  {
    label: "canonical pod-member session",
    input: "dev46-driver2@openrig-delivery",
    parsed: { kind: "canonical", member: "dev46-driver2", rig: "openrig-delivery" },
    human: false, memberLabel: "dev46-driver2", rigOf: "openrig-delivery",
  },
  {
    label: "canonical simple member@rig",
    input: "member@rig",
    parsed: { kind: "canonical", member: "member", rig: "rig" },
    human: false, memberLabel: "member", rigOf: "rig",
  },
  {
    label: "TOOTH 2 (parse leg): member@rig@x parses with the GREEDY rig 'rig@x'",
    input: "member@rig@x",
    parsed: { kind: "canonical", member: "member", rig: "rig@x" },
    human: false, memberLabel: "member", rigOf: "rig@x",
  },
  {
    label: "TOOTH 3: legacy r{NN}-suffix keeps validating (non-canonical, no rig binding)",
    input: "r03-worker",
    parsed: { kind: "legacy", name: "r03-worker" },
    human: false, memberLabel: "r03-worker", rigOf: undefined,
  },
  {
    label: "TOOTH 1 (classification leg): human@kernel is a human seat",
    input: "human@kernel",
    parsed: { kind: "canonical", member: "human", rig: "kernel" },
    human: true, memberLabel: "human", rigOf: "kernel",
  },
  {
    label: "suffixed human seat on host",
    input: "human-mvs@host",
    parsed: { kind: "canonical", member: "human-mvs", rig: "host" },
    human: true, memberLabel: "human-mvs", rigOf: "host",
  },
  {
    label: "human@<ordinary-rig> is NOT a human seat",
    input: "human@some-rig",
    parsed: { kind: "canonical", member: "human", rig: "some-rig" },
    human: false, memberLabel: "human", rigOf: "some-rig",
  },
  {
    label: "humanoid@kernel is NOT a human seat (prefix must be exact)",
    input: "humanoid@kernel",
    parsed: { kind: "canonical", member: "humanoid", rig: "kernel" },
    human: false, memberLabel: "humanoid", rigOf: "kernel",
  },
  {
    label: "malformed: bare non-legacy id",
    input: "bare",
    parsed: malformed("bare"),
    human: false, memberLabel: "bare", rigOf: undefined,
  },
  {
    label: "malformed: empty member (@rig)",
    input: "@rig",
    parsed: malformed("@rig"),
    human: false, memberLabel: "", rigOf: undefined,
  },
  {
    label: "malformed: empty rig (member@)",
    input: "member@",
    parsed: malformed("member@"),
    human: false, memberLabel: "member", rigOf: undefined,
  },
  {
    label: "malformed: empty string",
    input: "",
    parsed: malformed(""),
    human: false, memberLabel: "", rigOf: undefined,
  },
  {
    label: "malformed: r3-worker (legacy needs exactly two digits)",
    input: "r3-worker",
    parsed: malformed("r3-worker"),
    human: false, memberLabel: "r3-worker", rigOf: undefined,
  },
] as const;

describe("session-name contract — three-copy parity (shared vectors)", () => {
  for (const [pkg, copy] of COPIES) {
    describe(`${pkg} copy`, () => {
      for (const v of SHARED_VECTORS) {
        it(v.label, () => {
          expect(copy.parseSessionName(v.input)).toEqual(v.parsed);
          expect(copy.isHumanSeatSessionRef(v.input)).toBe(v.human);
          expect(copy.sessionMemberLabel(v.input)).toBe(v.memberLabel);
          expect(copy.sessionRigOf(v.input)).toBe(v.rigOf);
        });
      }
    });
  }

  it("cli and ui copies are byte-identical files (the verbatim-mirror pin)", () => {
    const cliSrc = readFileSync(resolve(import.meta.dirname, "../../cli/src/session-name.ts"), "utf8");
    const uiSrc = readFileSync(resolve(import.meta.dirname, "../../ui/src/lib/session-name.ts"), "utf8");
    expect(cliSrc).toBe(uiSrc);
  });

  it("the contract's human-seat predicate agrees with the read-only human-route-enforcer pattern on every vector", () => {
    // human-route-enforcer.ts is READ-ONLY this slice (PRD constraint) and
    // keeps its own pattern; this read-only import pins the contract copy
    // against it so neither can drift silently.
    for (const v of SHARED_VECTORS) {
      expect(daemonCopy.isHumanSeatSessionRef(v.input)).toBe(HUMAN_SEAT_SESSION_PATTERN.test(v.input));
    }
  });
});

describe("session-name contract — the queue-destination gate teeth", () => {
  // The gate composition EXACTLY as packages/daemon/src/startup.ts wires it
  // (topologyValidateRig): human classification first, then the shared
  // parse, then the rig-registry lookup.
  function gateWith(findRigsByName: (rigName: string) => unknown[]) {
    return (sessionRef: string): boolean => {
      if (daemonCopy.isHumanSeatSessionRef(sessionRef)) return true;
      const parsed = daemonCopy.parseSessionName(sessionRef);
      if (parsed.kind !== "canonical") return false;
      return findRigsByName(parsed.rig).length > 0;
    };
  }

  it("TOOTH 1: human-seat classification runs BEFORE any parse — zero rig lookups for human seats", () => {
    const lookups: string[] = [];
    const gate = gateWith((rigName) => { lookups.push(rigName); return []; });
    expect(gate("human@kernel")).toBe(true);
    expect(gate("human-mvs@host")).toBe(true);
    expect(lookups).toEqual([]);
  });

  it("TOOTH 2 (lookup leg): member@rig@x looks up EXACTLY the greedy rig 'rig@x' and fails the gate", () => {
    const lookups: string[] = [];
    const gate = gateWith((rigName) => { lookups.push(rigName); return []; });
    expect(gate("member@rig@x")).toBe(false);
    expect(lookups).toEqual(["rig@x"]);
  });

  it("TOOTH 3 (gate leg): a legacy r{NN} name stays valid AS A NAME but carries no rig binding — the gate rejects it exactly as before", () => {
    expect(daemonCopy.validateSessionName("r03-worker")).toBe(true);
    const gate = gateWith(() => [{ id: "any" }]);
    expect(gate("r03-worker")).toBe(false);
  });

  describe("TOOTH 2 (error leg): the queue rejects member@rig@x with the SAME unknown_destination_rig", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = createDb();
      migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    });

    afterEach(() => db.close());

    it("rejects the three-part destination; accepts the same member@rig when the rig exists", async () => {
      const known = new Set(["rig"]);
      const eventBus = new EventBus(db);
      const queueRepo = new QueueRepository(db, eventBus, {
        validateRig: gateWith((rigName) => (known.has(rigName) ? [{ id: "r-1" }] : [])),
      });

      await expect(
        queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig@x", body: "x" }),
      ).rejects.toMatchObject({ code: "unknown_destination_rig" });
      await expect(
        queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig@x", body: "x" }),
      ).rejects.toBeInstanceOf(QueueRepositoryError);

      const item = await queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig", body: "ok" });
      expect(item.destinationSession).toBe("member@rig");
    });
  });
});
