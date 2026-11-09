import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { createInputDecoder, decodeInput } from "../src/input.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle } from "../src/theme.js";
import { healthDetailLines, healthListLines } from "../src/health/health-model.js";
import type { HealthRecord } from "../src/types.js";
import type { ConfigEntry } from "../src/config/config-model.js";

afterEach(() => vi.unstubAllEnvs());

describe("S06 installed presentation contracts", () => {
  it("does not color configuration provenance words as operational status", () => {
    const snap = emptySnapshot(), view = createViewState({ instanceId: "colors", getSnapshot: () => snap });
    const entry: ConfigEntry = { key: "host.name", group: "general", value: "running", defaultValue: "localhost", source: "file", visibility: "shown", reason: null, scope: "instance", application: "running application unverified" };
    snap.config = { home: "/fixture", observedAt: "now", readOnly: true, entries: [entry], sources: [], exclusions: [] };
    view.dispatch({ type: "config-setting", key: entry.key });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 42 });
    const lines = stylizeLines(screen, createStyle("truecolor"));
    const line = lines.find(l => l.includes("application unverified"))!;
    expect(line).toBeTruthy();
    expect(line).not.toContain("38;2;152;195;121");
    expect(line).toContain("\x1b[39m");
  });
  it.each([[140, 42], [80, 24]])("keeps every selected Help command and its registry example visible at %ix%i", (cols, rows) => {
    const snap = emptySnapshot();
    const view = createViewState({ instanceId: "help", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "config" });
    const before = view.get();
    view.dispatch({ type: "palette-open" });
    for (const context of ["standard", "unverified", "crash-cart"]) {
      for (let selection = 0; selection < COMMAND_REGISTRY.length; selection++) {
        const state = { ...view.get(), palette: { query: "", selection } };
        const screen = renderScreen(state, snap, { cols, rows, commandContext: context, unavailable: "prerequisite unavailable" });
        const body = screen.lines.join("\n");
        expect(body).toContain(`› ${COMMAND_REGISTRY[selection]!.name}`);
        expect(body.replace(/\s+/g, " ")).toContain(`Example: ${COMMAND_REGISTRY[selection]!.sample}`);
        expect(body).toContain("Esc return");
        expect(body).toContain("rig <command> --help");
        expect(body).toContain("S returns to Startup");
        expect(screen.lines).toHaveLength(rows);
        expect(screen.lines.every(l => l.length <= cols)).toBe(true);
      }
    }
    view.dispatch({ type: "palette-close" });
    expect(view.get()).toMatchObject({ section: before.section, selection: before.selection, history: before.history, contentOffset: before.contentOffset });
  });

  it("pulses idle focus on the rendering clock while typing and reduced motion stay steady", () => {
    const snap = emptySnapshot(), view = createViewState({ instanceId: "focus", getSnapshot: () => snap });
    for (const [time, visible] of [[0, true], [1500, true], [2000, false], [2500, false], [3000, true]] as const) {
      const screen = renderScreen(view.get(), snap, { nowMs: time });
      expect(screen.lines[0]!.includes("▊")).toBe(visible);
      expect(screen.commandMotionActive).toBe(true);
      expect(renderScreen(view.get(), snap, { nowMs: time }, "read wor").lines[0]).toContain("read wor▊");
      const styled = stylizeLines(screen, createStyle("truecolor"));
      expect(styled[0]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe(screen.lines[0]);
    }
    vi.stubEnv("OPENRIG_REDUCED_MOTION", "1");
    const reduced = renderScreen(view.get(), snap, { nowMs: 2500 });
    expect(reduced.lines[0]).toContain("▊");
    expect(reduced.commandMotionActive).toBe(false);
  });

  it.each(["\x1b[1~", "\x1b[H", "\x1bOH", "\x1b[4~", "\x1b[1;5H"])("consumes the whole unsupported key %j without Back or input residue", sequence => {
    const decoder = createInputDecoder();
    const events = [...sequence].flatMap(char => decoder.write(char));
    expect([...events, ...decoder.flush()]).toEqual([]);
    expect(decodeInput(sequence + "config")).toEqual([..."config"].map(ch => ({ type: "char", ch })));
    expect(decodeInput("\x1b")).toEqual([{ type: "key", key: "escape" }]);
  });

  it.each([[403, /Access denied/], [404, /endpoint was not found/], [500, /cause was not identified/]])("reports observed CONFIG failure %i without guessing daemon age", async (status, reason) => {
    const secret = "synthetic-secret-never-display";
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async () => new Response(secret, { status })) as typeof fetch });
    const view = createViewState({ instanceId: "config", getSnapshot: emptySnapshot });
    view.dispatch({ type: "jump", section: "config" });
    const snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
    expect(snap.config).toBeNull();
    expect(snap.configError).toMatch(reason);
    const body = renderScreen(view.get(), snap, { cols: 80, rows: 24 }).lines.join("\n");
    expect(body).toContain(`HTTP ${status}`);
    expect(body).not.toMatch(/older daemon|synthetic-secret/);
  });

  it("distinguishes not loaded, unavailable, stale and Unknown assessment while retaining INFO and full evidence", () => {
    const snap = emptySnapshot(), scope = { kind: "instance", local: true } as const;
    delete snap.health;
    expect(healthListLines(snap, scope, 130)[0]!.text).toContain("Not assessed");
    snap.health = { availability: "unavailable", records: [], total: 0, truncated: false, evaluatedAt: null };
    expect(healthListLines(snap, scope, 130)[0]!.text).toContain("Unavailable");
    const reason = "No current context-usage sample was served";
    const path = "/exact/" + "unbroken-source-reference".repeat(8);
    const record: HealthRecord = { schema: "openrig.health/v0alpha1", id: "fixture", detector: "context", category: "context", scope: { type: "instance", instanceId: "fixture" }, severity: "info", confidence: "medium", status: "indeterminate", startedAt: null, lastObservedAt: null,
      window: { source: "context-usage", startedAt: "2026-09-10T00:00:00Z", endedAt: "2026-09-10T01:00:00Z", limit: 10, retentionSeconds: 3600 },
      freshness: { state: "unavailable", evaluatedAt: "2026-09-10T01:00:00Z", newestSourceAt: null, maxAgeSeconds: 30, ageSeconds: null }, summary: "Context usage", evidence: [], threshold: "policy", explanation: reason, suggestedInspection: path, indeterminateReason: reason };
    snap.health = { availability: "loaded", records: [record], total: 1, truncated: false, evaluatedAt: record.freshness.evaluatedAt };
    const body = healthDetailLines(snap, record.id, 54).map(l => l.text).join("\n");
    expect(body).toContain("INFO Unknown");
    expect(body.replace(/\s+/g, " ")).toContain(reason);
    expect(body.replace(/\s/g, "")).toContain(path);
    expect(record.status).toBe("indeterminate");
    record.freshness.state = "stale";
    expect(healthListLines(snap, scope, 54).some(l => l.text.includes("STALE"))).toBe(true);
  });
});
