// Slice-04 (OPR.0.5.0.4) C3 — Claude statusline provider_usage cache lane pins.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeProviderUsageCacheAtomic,
  collectClaudeStatuslineSignals,
  collectClaudeSignalsFromProviderUsageDirectory,
  type ProviderUsageCacheFs,
  type ProviderUsageCache,
  type ClaudeUsageReaderDeps,
} from "../src/domain/provider/claude-usage-reader.js";
import { CLAUDE_UNKNOWN_REASON } from "../src/domain/provider/provider-signals.js";

const ASOF = "2026-08-04T00:00:00.000Z";
const CACHE_ASOF = "2026-08-03T12:00:00.000Z";

function readerDeps(over: Partial<ClaudeUsageReaderDeps>): ClaudeUsageReaderDeps {
  return { listClaudeSeats: () => [], readCacheRaw: () => null, now: () => ASOF, ...over };
}

describe("writeProviderUsageCacheAtomic — tmp+rename (no torn read)", () => {
  it("writes a tmp sibling FIRST, then renames it over the target (never writes the target directly)", () => {
    const ops: string[] = [];
    const fs: ProviderUsageCacheFs = {
      readFile: () => "", exists: () => false,
      writeFile: (p) => ops.push(`write:${p}`),
      rename: (from, to) => ops.push(`rename:${from}->${to}`),
    };
    const cache: ProviderUsageCache = { seatSession: "dev-impl@rig", asOf: CACHE_ASOF };
    writeProviderUsageCacheAtomic(fs, "/cache/acct.json", cache);
    expect(ops).toHaveLength(2);
    expect(ops[0]!.startsWith("write:/cache/acct.json.tmp-")).toBe(true); // tmp, NOT the target
    expect(ops[1]).toBe(`rename:${ops[0]!.slice("write:".length)}->/cache/acct.json`);
    // The target is never written directly — a concurrent reader sees old-or-new, never torn.
    expect(ops.some((o) => o === "write:/cache/acct.json")).toBe(false);
  });
});

describe("collectClaudeStatuslineSignals — reader → provider_statusline / explicit unknown", () => {
  it("absent cache (pre-first-response) → explicit unknown(no_statusline_cache_yet)", () => {
    const sigs = collectClaudeStatuslineSignals(readerDeps({
      listClaudeSeats: () => [{ seatSession: "dev-impl@rig" }],
      readCacheRaw: () => null,
    }));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.sourceClass).toBe("unknown");
    expect(sigs[0]!.unknownReason).toBe(CLAUDE_UNKNOWN_REASON.no_statusline_cache_yet);
    expect(sigs[0]!.usedPercent).toBeUndefined(); // never a fabricated zero
    expect(sigs[0]!.seatSession).toBe("dev-impl@rig");
    expect(sigs[0]!.accountRef).toBeUndefined();
  });

  it("subscription + windows → provider_statusline rows (five_hour + weekly), asOf = the cache's asOf", () => {
    const cache: ProviderUsageCache = {
      seatSession: "dev-impl@rig", accountKind: "subscription", asOf: CACHE_ASOF,
      rateLimits: { five_hour: { usedPercent: 42, resetsAt: "2026-08-03T17:00:00Z" }, seven_day: { usedPercent: 10, resetsAt: "2026-08-10T00:00:00Z" } },
    };
    const sigs = collectClaudeStatuslineSignals(readerDeps({
      listClaudeSeats: () => [{ seatSession: "dev-impl@rig" }],
      readCacheRaw: () => JSON.stringify(cache),
    }));
    expect(sigs.every((s) => s.sourceClass === "provider_statusline")).toBe(true);
    expect(sigs.every((s) => s.asOf === CACHE_ASOF)).toBe(true); // captured-at, not now
    expect(sigs.map((s) => s.window).sort()).toEqual(["five_hour", "weekly"]);
    expect(sigs.find((s) => s.window === "five_hour")!.usedPercent).toBe(42);
    expect(sigs.every((s) => s.seatSession === "dev-impl@rig" && s.accountRef === undefined)).toBe(true);
  });

  it("cache present but no rate_limits → explicit unknown(empty_reading)", () => {
    const sigs = collectClaudeStatuslineSignals(readerDeps({
      listClaudeSeats: () => [{ seatSession: "dev-impl@rig" }],
      readCacheRaw: () => JSON.stringify({ seatSession: "dev-impl@rig", asOf: CACHE_ASOF }),
    }));
    expect(sigs[0]!.unknownReason).toBe(CLAUDE_UNKNOWN_REASON.empty_reading);
  });

  it("malformed cache JSON → unknown(empty_reading), never throws", () => {
    const sigs = collectClaudeStatuslineSignals(readerDeps({
      listClaudeSeats: () => [{ seatSession: "dev-impl@rig" }],
      readCacheRaw: () => "{ not json",
    }));
    expect(sigs[0]!.sourceClass).toBe("unknown");
    expect(sigs[0]!.unknownReason).toBe(CLAUDE_UNKNOWN_REASON.empty_reading);
  });
});

describe("0.5.8 provider-usage compatibility bridge", () => {
  it("prefers canonical caches and falls back per seat to the legacy root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bridge-"));
    const canonical = path.join(home, "state", "provider-usage");
    const legacy = path.join(home, "provider-usage");
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    const cache = (seatSession: string, usedPercent: number) => JSON.stringify({
      seatSession,
      accountKind: "subscription",
      asOf: CACHE_ASOF,
      rateLimits: { five_hour: { usedPercent, resetsAt: "2026-08-03T17:00:00Z" } },
    });
    fs.writeFileSync(path.join(legacy, "legacy@rig.json"), cache("legacy@rig", 22));
    fs.writeFileSync(path.join(legacy, "both@rig.json"), cache("both@rig", 33));
    fs.writeFileSync(path.join(canonical, "both@rig.json"), cache("both@rig", 77));

    const signals = collectClaudeSignalsFromProviderUsageDirectory(canonical, () => ASOF, legacy);
    expect(signals.find((signal) => signal.seatSession === "legacy@rig")?.usedPercent).toBe(22);
    expect(signals.find((signal) => signal.seatSession === "both@rig")?.usedPercent).toBe(77);

    fs.writeFileSync(path.join(canonical, "legacy@rig.json"), "not json");
    const malformedCanonical = collectClaudeSignalsFromProviderUsageDirectory(canonical, () => ASOF, legacy);
    expect(malformedCanonical.find((signal) => signal.seatSession === "legacy@rig")?.usedPercent).toBeUndefined();
    expect(malformedCanonical.find((signal) => signal.seatSession === "legacy@rig")?.unknownReason)
      .toBe(CLAUDE_UNKNOWN_REASON.empty_reading);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
