import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptStore } from "../src/domain/transcript-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([
  ["prefix-ab\b\bcorrected\n", "prefix-corrected\n"],
  ["prefix-😊\bcorrected\n", "prefix-corrected\n"],
  ["prefix-ab\bcorrected\n", "prefix-acorrected\n"],
  ["first-line\n\bsecond-line\n", "first-line\nsecond-line\n"],
])("normalizes consecutive and Unicode backspaces from owned transcript bytes", (raw, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-backspace-"));
  roots.push(root);
  const store = new TranscriptStore({ transcriptsRoot: root });
  expect(store.ensureTranscriptDir("owned-rig")).toBe(true);
  fs.writeFileSync(store.getTranscriptPath("owned-rig", "owned-seat"), raw);
  expect(store.readTail("owned-rig", "owned-seat", 10)).toBe(expected);
  expect(store.grep("owned-rig", "owned-seat", "corrected|line")).toEqual(expected.trimEnd().split("\n"));
});
