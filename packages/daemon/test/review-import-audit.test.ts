// OPR.0.4.6.MH5 C5 — the arch-P1 IMPORT-AUDIT static test (the FAC-1
// commit-4 pattern): the C1 module boundary made MECHANICAL so it survives
// every future editor.
//
// The Q2 purity discipline: the local review composer is a PURE function
// over LOCAL state — network I/O never enters the review domain. MH-5's
// fleet composer is the ONE sanctioned exception (the sibling aggregate's
// fan-out shell), so: every module under domain/review/ EXCEPT the fleet
// module must import NO hosts TRANSPORT/REGISTRY module and no node
// network primitive.
//
// ALLOWLISTED for everyone: domain/hosts/fanout-contract.js — a ZERO-I/O
// shared CONTRACT module whose own header pins "defined ONCE, imported
// everywhere, never retyped" (types.ts imports PerHostStatus from it; the
// boundary this audit defends is network I/O + registry reads, not a
// types-only contract).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const REVIEW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/domain/review");
const FLEET_MODULE = "fleet-compose.ts";

/** Transport/registry/I-O import specifiers forbidden in the pure review
 *  domain. fanout-contract is deliberately NOT here (see header). */
const FORBIDDEN_SPECIFIERS = [
  "hosts/remote-daemon-http",
  "hosts/hosts-registry-reader",
  "hosts/read-through",
  "node:http",
  "node:https",
  "node:net",
  "undici",
];

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe("MH-5 P1 — the review-domain import boundary (static audit)", () => {
  const files = readdirSync(REVIEW_DIR).filter((f) => f.endsWith(".ts"));

  it("the review dir is non-empty and carries the fleet module (the audit is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain(FLEET_MODULE);
  });

  it("every review-domain module EXCEPT the fleet module imports no hosts transport/registry or network primitive", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === FLEET_MODULE) continue;
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      for (const spec of specs) {
        if (FORBIDDEN_SPECIFIERS.some((f) => spec.includes(f))) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the fleet module IS the transport importer (the boundary is real, not a dead rule)", () => {
    const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, FLEET_MODULE), "utf-8"));
    expect(specs.some((s) => s.includes("hosts/remote-daemon-http"))).toBe(true);
    expect(specs.some((s) => s.includes("hosts/hosts-registry-reader"))).toBe(true);
  });

  it("outside the fleet module, hosts/ imports are AT MOST the zero-I/O fanout contract", () => {
    for (const file of files) {
      if (file === FLEET_MODULE) continue;
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      const hostsImports = specs.filter((s) => s.includes("/hosts/") || s.startsWith("hosts/"));
      for (const spec of hostsImports) {
        expect(spec).toContain("hosts/fanout-contract");
      }
    }
  });
});
