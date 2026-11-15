import assert from "node:assert/strict";
import { test } from "node:test";
import { packEntries, packEntry } from "./npm-pack-json.mjs";

const entry = { id: "@openrig/cli@1.2.3", name: "@openrig/cli", version: "1.2.3", filename: "openrig-cli-1.2.3.tgz",
  files: [{ path: "LICENSE" }, { path: "package.json" }] };

test("npm 10 and 11: an array of entries", () => {
  assert.deepEqual(packEntries(JSON.stringify([entry])), [entry]);
  assert.deepEqual(packEntry(JSON.stringify([entry])), entry);
});

test("npm 12: an object of entries keyed by package name", () => {
  assert.deepEqual(packEntries(JSON.stringify({ "@openrig/cli": entry })), [entry]);
  assert.deepEqual(packEntry(JSON.stringify({ "@openrig/cli": entry })), entry);
});

test("both shapes keep every entry in order, and a parsed value reads like its text", () => {
  const other = { ...entry, name: "@openrig/acp", filename: "openrig-acp-1.2.3.tgz" };
  assert.deepEqual(packEntries([entry, other]), [entry, other]);
  assert.deepEqual(packEntries({ "@openrig/cli": entry, "@openrig/acp": other }), [entry, other]);
});

test("packEntry refuses any count but one", () => {
  assert.throws(() => packEntry("[]"), /0 entries/);
  assert.throws(() => packEntry("{}"), /0 entries/);
  assert.throws(() => packEntry(JSON.stringify([entry, entry])), /2 entries/);
});

test("output that is neither shape throws", () => {
  for (const output of ["null", "\"text\"", "3", JSON.stringify(entry), JSON.stringify([[entry]]), JSON.stringify({ a: null })]) {
    assert.throws(() => packEntries(output), /neither an array of entries nor an object of per-package entries/, output);
  }
  assert.throws(() => packEntries("not json"), SyntaxError);
});
