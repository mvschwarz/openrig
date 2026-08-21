// B7 r2 HIGH-2 repair — the CLI's permission-policy semantics are BYTE-EQUIVALENT TWINS of the
// daemon's authoritative modules (the same twin-plus-parity arrangement as scaffold-placeholder):
//   packages/cli/src/lib/permission-policy/policy-ref.ts   ⇔ packages/daemon/src/domain/permission-policy/policy-ref.ts
//   packages/cli/src/lib/permission-policy/policy-spec.ts  ⇔ packages/daemon/src/domain/permission-policy/policy-spec.ts
//   packages/cli/src/lib/path-safety.ts                    ⇔ packages/daemon/src/domain/path-safety.ts
// One grammar, two packages, no divergence: if either side changes, change both or this fails.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PAIRS: Array<[string, string]> = [
  ["../src/lib/permission-policy/policy-ref.ts", "../../daemon/src/domain/permission-policy/policy-ref.ts"],
  ["../src/lib/permission-policy/policy-spec.ts", "../../daemon/src/domain/permission-policy/policy-spec.ts"],
  ["../src/lib/path-safety.ts", "../../daemon/src/domain/path-safety.ts"],
];

describe("permission-policy CLI/daemon twin parity (byte-equivalent)", () => {
  for (const [cliRel, daemonRel] of PAIRS) {
    it(`${cliRel} is byte-identical to its daemon twin`, () => {
      const cli = fs.readFileSync(fileURLToPath(new URL(cliRel, import.meta.url)), "utf-8");
      const daemon = fs.readFileSync(fileURLToPath(new URL(daemonRel, import.meta.url)), "utf-8");
      expect(cli).toBe(daemon);
    });
  }
});
