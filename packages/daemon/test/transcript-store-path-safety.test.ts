import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { TranscriptStore } from "../src/domain/transcript-store.js";

function expectContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  expect(rel).not.toBe("");
  expect(rel).not.toBe("..");
  expect(rel.startsWith(`..${sep}`)).toBe(false);
  expect(isAbsolute(rel)).toBe(false);
}

describe("TranscriptStore unsafe fallback path", () => {
  it("contains POSIX traversal in the _unsafe directory", () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-path-posix-"));
    try {
      const store = new TranscriptStore({ transcriptsRoot: root });
      const path = store.getTranscriptPath("..", "../../escape");

      expect(path).toBe(join(root, "_unsafe", ".._.._escape.log"));
      expectContained(root, path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flattens POSIX separators in an unsafe session name", () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-path-posix-sep-"));
    try {
      const store = new TranscriptStore({ transcriptsRoot: root });
      const path = store.getTranscriptPath("..", "nested/session");

      expect(path).toBe(join(root, "_unsafe", "nested_session.log"));
      expectContained(root, path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains Windows-style traversal in the _unsafe directory", () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-path-win-"));
    try {
      const store = new TranscriptStore({ transcriptsRoot: root });
      const path = store.getTranscriptPath("..", "..\\..\\escape");

      expect(path).toBe(join(root, "_unsafe", ".._.._escape.log"));
      expectContained(root, path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flattens Windows separators in an unsafe session name", () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-path-win-sep-"));
    try {
      const store = new TranscriptStore({ transcriptsRoot: root });
      const path = store.getTranscriptPath("..", "nested\\session");

      expect(path).toBe(join(root, "_unsafe", "nested_session.log"));
      expectContained(root, path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
