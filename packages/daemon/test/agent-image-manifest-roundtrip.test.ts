import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { parseAgentImageManifest } from "../src/domain/agent-images/manifest-parser.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
it.each(["true", "123", "null", "model: fast", "#notes", "normal-name"])("round-trips the operator's image name %s and string metadata", (name) => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-roundtrip-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const manifest: AgentImageManifest = {
    name, version: "01", runtime: "claude-code", sourceSeat: "dev@fixture", sourceSessionId: "conversation",
    sourceResumeToken: "conversation", sourceCwd: "/tmp/fixture", createdAt: new Date().toISOString(), lineage: ["ancestor"],
    files: [{ path: "notes.md", role: "notes", summary: "fixture notes" }],
  };
  const dir = library.install(root, manifest, new Map([["notes.md", "fixture bytes"]]));
  const restored = parseAgentImageManifest(readFileSync(join(dir, "manifest.yaml"), "utf-8"), dir);
  expect(restored).toEqual(manifest);
  library.scan(); expect(library.list()).toHaveLength(1);
  expect(library.list()[0]!.id).toBe(`agent-image:${name}:01`);
});
it("preserves YAML-like strings in captured metadata and supplementary descriptors", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-roundtrip-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const manifest: AgentImageManifest = { name: "metadata", version: "1", runtime: "codex",
    sourceSeat: "true", sourceSessionId: "123", sourceResumeToken: "false", sourceCwd: "null",
    createdAt: new Date().toISOString(), lineage: ["null", "123"],
    files: [{ path: "notes.md", role: "true", summary: "123" }] };
  const dir = library.install(root, manifest, new Map([["notes.md", "fixture bytes"]]));
  expect(parseAgentImageManifest(readFileSync(join(dir, "manifest.yaml"), "utf-8"), dir)).toEqual(manifest);
});

it.each(["  indented first\noutdented second", "no trailing newline", "multiple trailing\n\n", "windows\r\nnotes\r\n", ""])("preserves notes exactly: %j", (notes) => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-notes-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const manifest: AgentImageManifest = { name: "notes", version: "1", runtime: "codex",
    sourceSeat: "dev@fixture", sourceSessionId: "session", sourceResumeToken: "session",
    createdAt: new Date().toISOString(), notes, files: [] };
  const dir = library.install(root, manifest, new Map());
  expect(parseAgentImageManifest(readFileSync(join(dir, "manifest.yaml"), "utf-8"), dir)).toEqual(manifest);
});
